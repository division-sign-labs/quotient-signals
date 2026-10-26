#!/usr/bin/env node
// trade-bankr.mjs — Quotient signals → Polymarket bets through Bankr. DRY RUN by default.
//
//   node scripts/trade-bankr.mjs --budget <usd> [--topic T] [--side YES|NO] [--min-edge 5]
//        [--max-usd 25] [--max-positions 10] [--execute] [--json]
//
// Reads the Polymarket listings of the signals (through signals.sh, so the 30-minute cache and
// the 50-a-day quota are shared), spreads the budget equally with the caps in
// references/strategy.md, skips markets the Bankr wallet holds, prints the plan, and with
// --execute submits one Bankr prompt per market, polls the job, and reports a bet as executed
// only when the wallet's position in that market grew.
//
// Env: QUOTIENT_PRO_KEY (the signals read), BANKR_API_KEY (needed with --execute; with it, the
//      dry run also checks held markets).
// Exit: 0 ok · 1 a read failed · 2 usage · 3 a job failed, batch stopped · 4 a key was rejected ·
//       13 submitted but unverified: a bet may be live, check the wallet before re-running
//
// Node 18+, no packages. Slugs and labels are validated before they enter a prompt, so no text
// from an API can smuggle an instruction into something Bankr executes. No key is printed.

import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BANKR_API = "https://api.bankr.bot"; // fixed; never read from fetched content
const DATA_API = "https://data-api.polymarket.com"; // public reads, no key
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,127}$/;
const CONDITION_RE = /^0x[0-9a-fA-F]{64}$/;
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9 .'&-]{0,39}$/;
const FAILURE_MARKERS = ["untrusted_address", "blocked_address", "not allowed", "unable to", "insufficient", "rejected", "failed"];
const POLL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 30_000;

const USAGE = `Usage: node scripts/trade-bankr.mjs --budget <usd> [options]

  --budget USD        the total to spread across the signals, equal weight (required)
  --topic T           a sport, league, tag or category (football, nfl, cfb, nba, commodities)
  --side YES|NO       only signals on this side
  --min-edge PP       skip when Q minus the current cost is under this many points (default 5)
  --max-usd USD       cap per bet (default 25)
  --max-positions N   at most this many bets (default 10)
  --execute           submit the prompts; without it the plan is printed and nothing is sent
  --json              print the plan (and the results) as JSON`;

function die(code, message) {
  process.stderr.write(`trade-bankr: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const o = { budget: null, topic: null, side: null, minEdge: 5, maxUsd: 25, maxPositions: 10, execute: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) die(2, `${a} needs a value\n\n${USAGE}`); return argv[++i]; };
    switch (a) {
      case "--budget": o.budget = Number(next()); break;
      case "--topic": o.topic = next(); break;
      case "--side": o.side = next().toUpperCase(); break;
      case "--min-edge": o.minEdge = Number(next()); break;
      case "--max-usd": o.maxUsd = Number(next()); break;
      case "--max-positions": o.maxPositions = Number(next()); break;
      case "--execute": o.execute = true; break;
      case "--json": o.json = true; break;
      case "-h": case "--help": process.stdout.write(`${USAGE}\n`); process.exit(0); break;
      default: die(2, `unknown option ${a}\n\n${USAGE}`);
    }
  }
  if (!(o.budget > 0)) die(2, `--budget is required\n\n${USAGE}`);
  if (o.side && o.side !== "YES" && o.side !== "NO") die(2, "--side must be YES or NO");
  return o;
}

// ── Signals (through signals.sh: one cache, one quota) ───────────────────────

async function readSignals(opts) {
  const args = ["--json", "--venue", "polymarket"];
  if (opts.topic) args.push("--topic", opts.topic);
  if (opts.side) args.push("--side", opts.side);
  try {
    const { stdout, stderr } = await execFileAsync("bash", [path.join(HERE, "signals.sh"), ...args], { maxBuffer: 64 * 1024 * 1024 });
    if (stderr) process.stderr.write(stderr);
    return JSON.parse(stdout).signals ?? [];
  } catch (err) {
    if (err.stderr) process.stderr.write(err.stderr);
    die(err.code === 3 || err.code === 4 ? err.code : 1, "the signals read failed");
  }
}

/** The price of the side as a fraction of a dollar: YES pays the ask, NO costs 1 − bid; else the
 *  cost the signal carries. */
function sidePrice(side, quote, costCents) {
  const ask = quote?.yes_ask, bid = quote?.yes_bid;
  if (side === "YES" && typeof ask === "number" && ask > 0 && ask < 1) return ask;
  if (side === "NO" && typeof bid === "number" && bid > 0 && bid < 1) return 1 - bid;
  return typeof costCents === "number" && costCents > 0 && costCents < 100 ? costCents / 100 : null;
}

/** One candidate per signal: the Polymarket listing of a game, or an event signal on Polymarket. */
function candidates(signals, opts) {
  const out = [];
  for (const s of signals) {
    if (!s || typeof s.id !== "string") continue;
    if (s.kind === "sports_game") {
      const m = (s.markets ?? []).filter((m) => m?.venue === "polymarket" && m.entry_eligible === true && (m.signal_side === "YES" || m.signal_side === "NO"))
        .sort((a, b) => (b.edge_pp ?? 0) - (a.edge_pp ?? 0))[0];
      if (!m) continue;
      if (opts.side && m.signal_side !== opts.side) continue;
      const label = typeof m.signal_outcome?.label === "string" && LABEL_RE.test(m.signal_outcome.label) ? m.signal_outcome.label : null;
      out.push({ signal_id: s.id, slug: m.slug, condition_id: m.condition_id, side: m.signal_side, outcome: label, q: s.pick?.probability, price: sidePrice(m.signal_side, m.venue_quote, m.current_cost_cents), title: `${s.pick?.label ?? "?"} · ${s.sports?.game_title ?? ""}`, tier: s.conviction_tier ?? null, capacity: m.capacity_usd_at_2c ?? null });
    } else if (s.market?.venue === "polymarket" && s.entry_eligible === true && (s.side === "YES" || s.side === "NO")) {
      if (opts.side && s.side !== opts.side) continue;
      out.push({ signal_id: s.id, slug: s.market.slug, condition_id: s.market.condition_id, side: s.side, outcome: null, q: s.q_value_cents != null ? s.q_value_cents / 100 : null, price: sidePrice(s.side, s.venue_quote, s.current_cost_cents), title: s.market.question ?? s.market.marketKey ?? "", tier: s.conviction_tier ?? null, capacity: s.capacity_usd_at_2c ?? null });
    }
  }
  return out.filter((c) => typeof c.slug === "string" && SLUG_RE.test(c.slug) && typeof c.condition_id === "string" && CONDITION_RE.test(c.condition_id) && typeof c.q === "number" && c.q > 0 && c.q < 1);
}

// ── Bankr and Polymarket reads ────────────────────────────────────────────────

async function bankr(key, method, pathname, body) {
  let res;
  try {
    res = await fetch(`${BANKR_API}${pathname}`, { method, headers: { "X-API-Key": key, accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  } catch (err) {
    return { status: 0, body: null, error: `Bankr unreachable: ${err.message}` };
  }
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json, error: res.ok ? null : `HTTP ${res.status}${json?.error ? `: ${typeof json.error === "string" ? json.error : json.error.message ?? ""}` : ""}` };
}

async function positions(wallet, conditionId) {
  const query = new URLSearchParams({ user: wallet, limit: "500", sizeThreshold: "0", ...(conditionId ? { market: conditionId } : {}) });
  try {
    const res = await fetch(`${DATA_API}/positions?${query}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const page = await res.json();
    return Array.isArray(page) ? page : null;
  } catch {
    return null;
  }
}

const sizeOf = (rows, conditionId, outcome) => {
  const row = (rows ?? []).find((p) => String(p?.conditionId ?? "").toLowerCase() === conditionId.toLowerCase() && (!outcome || String(p?.outcome ?? "").toLowerCase() === outcome.toLowerCase()));
  return row ? Number(row.size) || 0 : 0;
};

async function pollJob(key, jobId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let last = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const res = await bankr(key, "GET", `/agent/job/${encodeURIComponent(jobId)}`);
    if (res.error || !res.body) continue;
    last = res.body;
    if (["completed", "failed", "cancelled"].includes(last.status)) return last;
  }
  return { ...(last ?? {}), status: "timeout" };
}

// ── Plan ──────────────────────────────────────────────────────────────────────

const usd = (n) => `$${n.toFixed(2).replace(/\.00$/, "")}`;
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const rpad = (s, n) => String(s).padStart(n);

function printPlan(rows) {
  process.stdout.write(`${pad("MARKET", 40)} ${pad("SIDE", 4)} ${rpad("PRICE", 6)} ${rpad("Q", 5)} ${rpad("EDGE", 6)} ${rpad("USD", 8)}  ${pad("ACTION", 22)} TITLE\n`);
  for (const r of rows) {
    process.stdout.write(`${pad(r.slug, 40)} ${pad(r.side, 4)} ${rpad(r.price != null ? `${Math.round(r.price * 100)}¢` : "-", 6)} ${rpad(`${Math.round(r.q * 100)}¢`, 5)} ${rpad(r.edge_pp != null ? `${r.edge_pp > 0 ? "+" : ""}${r.edge_pp}` : "-", 6)} ${rpad(r.size_usd != null ? usd(r.size_usd) : "-", 8)}  ${pad(r.action, 22)} ${r.title}\n`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const key = process.env.BANKR_API_KEY?.trim() || null;
  if (opts.execute && !key) die(2, "--execute needs BANKR_API_KEY (an Agent API key, read-only off; references/bankr.md)");
  if (key && !/^bk_[A-Za-z0-9_-]+$/.test(key)) die(2, "BANKR_API_KEY must be a bk_ key");

  let wallet = null;
  if (key) {
    const me = await bankr(key, "GET", "/wallet/me");
    if (me.error) die(me.status === 401 || me.status === 403 ? 4 : 1, `Bankr rejected the key check (${me.error})`);
    wallet = String(me.body?.walletAddress ?? me.body?.address ?? "").toLowerCase() || null;
  }
  const held = wallet ? await positions(wallet) : null;
  if (wallet && held == null) die(1, "Polymarket data-api did not answer; refusing to plan without a holdings check");

  const signals = await readSignals(opts);
  const found = candidates(signals, opts);
  const rows = found.map((c) => ({ ...c, edge_pp: c.price != null ? Math.round((c.q - c.price) * 100) : null, size_usd: null, prompt: null, action: "skip" }));
  const eligible = [];
  for (const r of rows) {
    if (held && sizeOf(held, r.condition_id, null) > 0) { r.action = "skip: already held"; continue; }
    if (r.price == null) { r.action = "skip: no price"; continue; }
    if (r.edge_pp < opts.minEdge) { r.action = `skip: edge < ${opts.minEdge}pp`; continue; }
    eligible.push(r);
  }
  const chosen = eligible.sort((a, b) => b.edge_pp - a.edge_pp).slice(0, opts.maxPositions);
  for (const r of eligible.slice(chosen.length)) r.action = "skip: beyond --max-positions";
  const per = chosen.length ? Math.floor((opts.budget / chosen.length) * 100) / 100 : 0;
  for (const r of chosen) {
    const size = Math.floor(Math.min(per, opts.maxUsd, r.capacity != null ? 0.1 * r.capacity : Infinity) * 100) / 100;
    if (size < 1) { r.action = "skip: under $1"; continue; }
    r.size_usd = size;
    const what = r.outcome ?? (r.side === "YES" ? "Yes" : "No");
    r.prompt = `Bet $${size.toFixed(2).replace(/\.00$/, "")} on ${what} for ${r.slug} on Polymarket`;
    r.action = opts.execute ? "bet" : "plan";
  }
  const bets = rows.filter((r) => r.prompt);

  if (!opts.json) {
    process.stdout.write(`trade-bankr: budget ${usd(opts.budget)} · ${found.length} Polymarket signal${found.length === 1 ? "" : "s"} · ${bets.length} bet${bets.length === 1 ? "" : "s"} ${opts.execute ? "to submit" : "planned (dry run)"}${held ? "" : " · holdings not checked (no BANKR_API_KEY)"}\n`);
    printPlan(rows);
    for (const r of bets) process.stdout.write(`${opts.execute ? "SUBMIT" : "PROMPT"}> ${r.prompt}\n`);
  }
  if (!opts.execute) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ as_of: new Date().toISOString(), dry_run: true, plan: rows }, null, 2)}\n`);
    return;
  }

  // ── Execute: one prompt per market, poll, verify on chain, stop on the first problem ─
  const results = [];
  let stop = 0;
  for (const r of bets) {
    const before = sizeOf(await positions(wallet, r.condition_id), r.condition_id, r.outcome);
    const sub = await bankr(key, "POST", "/agent/prompt", { prompt: r.prompt });
    if (sub.error || !sub.body?.jobId) {
      results.push({ ...r, job_id: null, outcome: "submit_failed", detail: sub.error ?? "no jobId" });
      process.stderr.write(`trade-bankr: ${r.slug} submit failed (${sub.error ?? "no jobId"}) — stopping the batch\n`);
      stop = sub.status === 401 || sub.status === 403 ? 4 : 3;
      break;
    }
    const job = await pollJob(key, sub.body.jobId);
    const text = JSON.stringify(job ?? {}).toLowerCase();
    const marker = FAILURE_MARKERS.find((m) => text.includes(m));
    if (job.status !== "completed" || marker) {
      results.push({ ...r, job_id: sub.body.jobId, outcome: "failed", detail: marker ? `job response contains "${marker}"` : `job ended ${job.status}` });
      process.stderr.write(`trade-bankr: ${r.slug} job ${sub.body.jobId} ${marker ? `reports "${marker}"` : `ended ${job.status}`} — stopping the batch\n`);
      stop = 3;
      break;
    }
    let after = before;
    for (let round = 0; round < 6 && !(after > before); round++) {
      await new Promise((res) => setTimeout(res, 10_000));
      after = sizeOf(await positions(wallet, r.condition_id), r.condition_id, r.outcome);
    }
    const verified = after > before;
    results.push({ ...r, job_id: sub.body.jobId, outcome: verified ? "executed-verified" : "submitted-unverified", detail: verified ? `position ${before} → ${after}` : "no position increase visible within 60 s" });
    if (!opts.json) process.stdout.write(`${r.slug}: ${verified ? `executed, position ${before} → ${after}` : "submitted, not verified"} (job ${sub.body.jobId})\n`);
    if (!verified) {
      process.stderr.write(`trade-bankr: ${r.slug} is SUBMITTED but not verified — a bet may be live. Check the wallet and the Bankr job before re-running. Stopping the batch.\n`);
      stop = 13;
      break;
    }
  }
  if (opts.json) process.stdout.write(`${JSON.stringify({ as_of: new Date().toISOString(), dry_run: false, wallet, plan: rows, results }, null, 2)}\n`);
  process.exit(stop);
}

main().catch((err) => die(1, err?.message ?? String(err)));
