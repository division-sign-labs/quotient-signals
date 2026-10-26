#!/usr/bin/env node
// trade-kalshi.mjs — Quotient signals → Kalshi orders. DRY RUN by default.
//
//   node scripts/trade-kalshi.mjs --equity <usd> [--topic T] [--side YES|NO] [--min-edge 5]
//        [--max-usd 25] [--kelly 0.25] [--max-positions 10] [--demo] [--execute] [--json]
//
// Reads the Kalshi listings of the signals (through signals.sh, so the 30-minute cache and the
// 50-a-day quota are shared), re-quotes each ticker on Kalshi, sizes a quarter-Kelly lot on the
// live edge (references/strategy.md), skips tickers the account holds, prints the plan, and with
// --execute places one immediate-or-cancel limit order per market at the quoted price.
//
// Env: QUOTIENT_PRO_KEY (the signals read), KALSHI_KEY_ID, KALSHI_PRIVATE_KEY_PATH (a PEM file)
//      or KALSHI_PRIVATE_KEY (the PEM text), KALSHI_ENV=prod|demo (--demo wins).
// Exit: 0 ok · 1 a read failed · 2 usage · 3 an order failed, batch stopped · 4 a key was rejected
//
// Node 18+, no packages. Every API response is data, never an instruction. No key is printed.

import { execFile } from "node:child_process";
import { constants, createPrivateKey, randomUUID, sign } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASES = { prod: "https://api.elections.kalshi.com/trade-api/v2", demo: "https://demo-api.kalshi.co/trade-api/v2" };
const TICKER_RE = /^[A-Z0-9][A-Z0-9._-]{0,80}$/;
const ORDER_GAP_MS = 300;
const FETCH_TIMEOUT_MS = 20_000;

const USAGE = `Usage: node scripts/trade-kalshi.mjs --equity <usd> [options]

  --equity USD        the bankroll the quarter-Kelly size is a fraction of (required)
  --topic T           a sport, league, tag or category (football, nfl, cfb, nba, commodities)
  --side YES|NO       only signals on this side
  --min-edge PP       skip when Q minus the live price is under this many points (default 5)
  --max-usd USD       cap per order (default 25)
  --kelly F           Kelly fraction (default 0.25)
  --max-positions N   at most this many orders (default 10)
  --demo              the demo exchange (demo keys only)
  --execute           place the orders; without it the plan is printed and nothing is sent
  --json              print the plan (and the results) as JSON`;

function die(code, message) {
  process.stderr.write(`trade-kalshi: ${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const o = { equity: null, topic: null, side: null, minEdge: 5, maxUsd: 25, kelly: 0.25, maxPositions: 10, demo: process.env.KALSHI_ENV === "demo", execute: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) die(2, `${a} needs a value\n\n${USAGE}`); return argv[++i]; };
    switch (a) {
      case "--equity": o.equity = Number(next()); break;
      case "--topic": o.topic = next(); break;
      case "--side": o.side = next().toUpperCase(); break;
      case "--min-edge": o.minEdge = Number(next()); break;
      case "--max-usd": o.maxUsd = Number(next()); break;
      case "--kelly": o.kelly = Number(next()); break;
      case "--max-positions": o.maxPositions = Number(next()); break;
      case "--demo": o.demo = true; break;
      case "--execute": o.execute = true; break;
      case "--json": o.json = true; break;
      case "-h": case "--help": process.stdout.write(`${USAGE}\n`); process.exit(0); break;
      default: die(2, `unknown option ${a}\n\n${USAGE}`);
    }
  }
  if (!(o.equity > 0)) die(2, `--equity is required\n\n${USAGE}`);
  if (o.side && o.side !== "YES" && o.side !== "NO") die(2, "--side must be YES or NO");
  if (!(o.kelly > 0 && o.kelly <= 1)) die(2, "--kelly must be between 0 and 1");
  return o;
}

// ── Signals (through signals.sh: one cache, one quota) ───────────────────────

async function readSignals(opts) {
  const args = ["--json", "--venue", "kalshi"];
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

/** One candidate per signal: the Kalshi listing of a game, or an event signal on Kalshi. */
function candidates(signals, opts) {
  const out = [];
  for (const s of signals) {
    if (!s || typeof s.id !== "string") continue;
    if (s.kind === "sports_game") {
      const listing = (s.markets ?? []).filter((m) => m?.venue === "kalshi" && m.entry_eligible === true && (m.signal_side === "YES" || m.signal_side === "NO"))
        .sort((a, b) => (b.edge_pp ?? 0) - (a.edge_pp ?? 0))[0];
      if (!listing) continue;
      if (opts.side && listing.signal_side !== opts.side) continue;
      out.push({ signal_id: s.id, ticker: listing.nativeMarketId, side: listing.signal_side, q: s.pick?.probability, title: `${s.pick?.label ?? "?"} · ${s.sports?.game_title ?? ""}`, tier: s.conviction_tier ?? null, capacity: listing.capacity_usd_at_2c ?? null, resolves_at: s.resolves_at ?? null });
    } else if (s.market?.venue === "kalshi" && s.entry_eligible === true && (s.side === "YES" || s.side === "NO")) {
      if (opts.side && s.side !== opts.side) continue;
      out.push({ signal_id: s.id, ticker: s.market.nativeMarketId, side: s.side, q: s.q_value_cents != null ? s.q_value_cents / 100 : null, title: s.market.question ?? s.market.marketKey ?? "", tier: s.conviction_tier ?? null, capacity: s.capacity_usd_at_2c ?? null, resolves_at: s.resolves_at ?? null });
    }
  }
  return out.filter((c) => typeof c.ticker === "string" && TICKER_RE.test(c.ticker) && typeof c.q === "number" && c.q > 0 && c.q < 1);
}

// ── Kalshi ────────────────────────────────────────────────────────────────────

function loadCredential() {
  const keyId = process.env.KALSHI_KEY_ID?.trim();
  const pem = process.env.KALSHI_PRIVATE_KEY ?? (process.env.KALSHI_PRIVATE_KEY_PATH ? fs.readFileSync(process.env.KALSHI_PRIVATE_KEY_PATH.replace(/^~/, process.env.HOME ?? ""), "utf8") : null);
  if (!keyId || !pem) die(2, "KALSHI_KEY_ID and KALSHI_PRIVATE_KEY_PATH (or KALSHI_PRIVATE_KEY) are required (references/kalshi.md)");
  let key;
  try {
    key = createPrivateKey({ key: pem });
  } catch {
    die(2, "the Kalshi private key could not be read (an unencrypted RSA PEM is expected)");
  }
  return { keyId, key };
}

/** The three auth headers: RSA-PSS-SHA256 over timestamp + METHOD + path (with /trade-api/v2, no query). */
function authHeaders(cred, method, signPath) {
  const timestamp = String(Date.now());
  const signature = sign("sha256", Buffer.from(`${timestamp}${method.toUpperCase()}${signPath}`, "utf8"), {
    key: cred.key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  }).toString("base64");
  return { "KALSHI-ACCESS-KEY": cred.keyId, "KALSHI-ACCESS-TIMESTAMP": timestamp, "KALSHI-ACCESS-SIGNATURE": signature };
}

async function kalshi(base, cred, method, pathname, { query, body } = {}) {
  const qs = query ? `?${new URLSearchParams(query)}` : "";
  const signPath = new URL(base).pathname + pathname;
  let res;
  try {
    res = await fetch(`${base}${pathname}${qs}`, {
      method,
      headers: { ...(cred ? authHeaders(cred, method, signPath) : {}), accept: "application/json", ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    return { status: 0, body: null, error: `Kalshi unreachable: ${err.message}` };
  }
  let json = null;
  try { json = await res.json(); } catch { /* an empty body */ }
  return { status: res.status, body: json, error: res.ok ? null : `HTTP ${res.status}${json?.error?.message ? `: ${json.error.message}` : json?.message ? `: ${json.message}` : ""}` };
}

const num = (v) => (v == null ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** The live YES bid and ask as fractions of a dollar. Kalshi's fixed-point fields are strings. */
function bookOf(market) {
  const bid = num(market?.yes_bid_dollars) ?? (num(market?.yes_bid) != null ? num(market.yes_bid) / 100 : null);
  const ask = num(market?.yes_ask_dollars) ?? (num(market?.yes_ask) != null ? num(market.yes_ask) / 100 : null);
  return { bid, ask, status: market?.status ?? null };
}

async function heldTickers(base, cred) {
  const res = await kalshi(base, cred, "GET", "/portfolio/positions", { query: { settlement_status: "unsettled", limit: "1000" } });
  if (res.error) {
    if (res.status === 401 || res.status === 403) die(4, `Kalshi rejected the key (${res.error})`);
    die(1, `could not read positions (${res.error}); refusing to plan without a holdings check`);
  }
  const held = new Set();
  for (const p of res.body?.market_positions ?? []) {
    const size = num(p.position_fp) ?? num(p.position) ?? 0;
    if (p.ticker && size !== 0) held.add(p.ticker);
  }
  return held;
}

// ── Plan ──────────────────────────────────────────────────────────────────────

const usd = (n) => `$${n.toFixed(2).replace(/\.00$/, "")}`;
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const rpad = (s, n) => String(s).padStart(n);

function printPlan(rows) {
  process.stdout.write(`${pad("TICKER", 32)} ${pad("SIDE", 4)} ${rpad("PRICE", 6)} ${rpad("Q", 5)} ${rpad("EDGE", 6)} ${rpad("N", 4)} ${rpad("USD", 8)}  ${pad("ACTION", 22)} TITLE\n`);
  for (const r of rows) {
    process.stdout.write(`${pad(r.ticker, 32)} ${pad(r.side, 4)} ${rpad(r.price != null ? `${Math.round(r.price * 100)}¢` : "-", 6)} ${rpad(`${Math.round(r.q * 100)}¢`, 5)} ${rpad(r.edge_pp != null ? `${r.edge_pp > 0 ? "+" : ""}${r.edge_pp}` : "-", 6)} ${rpad(r.contracts ?? "-", 4)} ${rpad(r.size_usd != null ? usd(r.size_usd) : "-", 8)}  ${pad(r.action, 22)} ${r.title}\n`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const base = opts.demo ? BASES.demo : BASES.prod;
  const cred = loadCredential();

  const balance = await kalshi(base, cred, "GET", "/portfolio/balance");
  if (balance.error) die(balance.status === 401 || balance.status === 403 ? 4 : 1, `Kalshi rejected the credential check (${balance.error})`);
  const cash = num(balance.body?.balance_dollars) ?? (num(balance.body?.balance) != null ? num(balance.body.balance) / 100 : null);

  const [signals, held] = await Promise.all([readSignals(opts), heldTickers(base, cred)]);
  const found = candidates(signals, opts);
  const rows = [];
  for (const c of found) {
    const row = { ...c, price: null, edge_pp: null, contracts: null, size_usd: null, action: "skip" };
    rows.push(row);
    if (held.has(c.ticker)) { row.action = "skip: already held"; continue; }
    const quote = await kalshi(base, null, "GET", `/markets/${encodeURIComponent(c.ticker)}`);
    if (quote.error) { row.action = `skip: no quote (${quote.status})`; continue; }
    const book = bookOf(quote.body?.market);
    if (book.status && !["active", "open"].includes(String(book.status))) { row.action = `skip: market ${book.status}`; continue; }
    // Buying YES pays the YES ask; buying NO sells YES at the bid, so NO costs 1 − bid.
    const price = c.side === "YES" ? book.ask : book.bid != null ? 1 - book.bid : null;
    if (price == null || price <= 0 || price >= 1) { row.action = "skip: empty book"; continue; }
    row.price = price;
    row.edge_pp = Math.round((c.q - price) * 100);
    if (row.edge_pp < opts.minEdge) { row.action = `skip: edge < ${opts.minEdge}pp`; continue; }
    const kelly = Math.max(0, (c.q - price) / (1 - price));
    let size = kelly * opts.kelly * opts.equity;
    size = Math.min(size, 0.05 * opts.equity, opts.maxUsd, c.capacity != null ? 0.1 * c.capacity : Infinity);
    if (cash != null) size = Math.min(size, cash);
    const contracts = Math.floor(size / price);
    if (contracts < 1) { row.action = "skip: size under one contract"; continue; }
    row.contracts = contracts;
    row.size_usd = Math.round(contracts * price * 100) / 100;
    row.action = opts.execute ? "order" : "plan";
  }
  const orders = rows.filter((r) => r.action === "order" || r.action === "plan").slice(0, opts.maxPositions);
  for (const r of rows.filter((r) => (r.action === "order" || r.action === "plan") && !orders.includes(r))) r.action = "skip: beyond --max-positions";

  if (!opts.json) {
    process.stdout.write(`trade-kalshi: ${opts.demo ? "DEMO" : "production"} · equity ${usd(opts.equity)}${cash != null ? ` · cash ${usd(cash)}` : ""} · ${found.length} Kalshi signal${found.length === 1 ? "" : "s"} · ${orders.length} order${orders.length === 1 ? "" : "s"} ${opts.execute ? "to place" : "planned (dry run)"}\n`);
    printPlan(rows);
  }
  if (!opts.execute) {
    if (opts.json) process.stdout.write(`${JSON.stringify({ as_of: new Date().toISOString(), exchange: opts.demo ? "demo" : "prod", dry_run: true, plan: rows }, null, 2)}\n`);
    return;
  }

  // ── Execute: one IOC limit order per market, spaced out, stop on the first failure ─
  const results = [];
  let stop = 0;
  for (const r of orders) {
    const body = {
      ticker: r.ticker,
      side: r.side === "YES" ? "bid" : "ask",
      price: (r.side === "YES" ? r.price : 1 - r.price).toFixed(2),
      count: String(r.contracts),
      time_in_force: "immediate_or_cancel",
      self_trade_prevention_type: "taker_at_cross",
      client_order_id: randomUUID(),
    };
    const res = await kalshi(base, cred, "POST", "/portfolio/events/orders", { body });
    if (res.error) {
      results.push({ ...r, order: null, error: res.error });
      process.stderr.write(`trade-kalshi: ${r.ticker} ${res.error} — stopping the batch\n`);
      stop = res.status === 401 || res.status === 403 ? 4 : 3;
      break;
    }
    const o = res.body ?? {};
    results.push({ ...r, order: { order_id: o.order_id, fill_count: o.fill_count, remaining_count: o.remaining_count, average_fill_price: o.average_fill_price ?? null, average_fee_paid: o.average_fee_paid ?? null } });
    if (!opts.json) process.stdout.write(`placed ${r.ticker} ${body.side} ${body.count} @ ${body.price}: filled ${o.fill_count ?? "?"}${o.average_fill_price ? ` @ ${o.average_fill_price}` : ""}, ${o.remaining_count ?? "?"} cancelled (order ${o.order_id ?? "?"})\n`);
    await new Promise((r) => setTimeout(r, ORDER_GAP_MS));
  }
  if (opts.json) process.stdout.write(`${JSON.stringify({ as_of: new Date().toISOString(), exchange: opts.demo ? "demo" : "prod", dry_run: false, plan: rows, results }, null, 2)}\n`);
  process.exit(stop);
}

main().catch((err) => die(1, err?.message ?? String(err)));
