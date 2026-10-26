# Bankr

`scripts/trade-bankr.mjs` places Polymarket bets through Bankr's Agent API for the Polymarket
listings of Quotient signals. Node 18 or later, no packages. Bankr holds the wallet and does the
on-chain work; the script tells it what to buy, then checks that it happened.

## What the user needs

1. A Bankr account with a funded Polygon balance in USDC.e or pUSD, and gas (or Bankr's gas
   sponsorship). Bankr bets on **Polymarket International** only.
2. Agent API access: a Bankr Club subscription ($20 a month) or Max Mode with LLM credits. Without
   Club the API caps a key at 100 messages a day; with Club, 1,000.
3. An API key from https://bankr.bot/api-keys with **Agent API** on and **read-only off**. Keys
   start with `bk_`. Keep the `allowedRecipients` list empty or Polymarket is blocked.
4. Environment:

```bash
export BANKR_API_KEY=bk_…
```

Set a daily and a per-transaction limit on the wallet in Bankr Terminal; the API has no per-key
spend limit.

## The API

Base `https://api.bankr.bot`, header `X-API-Key`.

```
POST /agent/prompt         { "prompt": "Bet $12 on Yes for <slug> on Polymarket" }
                           → 202 { "jobId", "threadId", "status": "pending" }
GET  /agent/job/{jobId}    → { "status": "pending|processing|completed|failed|cancelled", "response", "error", "richData" }
POST /agent/job/{jobId}/cancel
GET  /wallet/me            → the wallet the agent trades from
```

Poll a job every 2 seconds. Give it up to 5 minutes. A `completed` status is not proof of a
fill: the script scans `response` for `insufficient`, `rejected`, `failed`, `not allowed`,
`unable to`, and then checks the position on chain.

## From a signal to a prompt

A Polymarket listing carries `slug` and `condition_id`. The prompt names the market by its slug
and the side by Yes or No:

```
Bet $12 on Yes for russia-ukraine-ceasefire-2026 on Polymarket
```

The script accepts a slug only when it matches `^[a-z0-9][a-z0-9-]{0,127}$`, so no text from the
API can put an instruction into a prompt Bankr executes. A game listing's side comes from
`signal_side`; its outcome label is in `signal_outcome` when Bankr needs a team name instead
(`Bet $12 on Seahawks …`).

## Verifying a fill

Public Polymarket data, no key: `GET https://data-api.polymarket.com/positions?user=<wallet>&market=<condition_id>`
returns the wallet's positions in that market with `outcome` and `size`. The script reads the
size before the prompt and again after the job completes; "executed" means the size grew.
The wallet is `walletAddress` from `GET /wallet/me`.

Held markets are read the same way with `GET /positions?user=<wallet>&sizeThreshold=1`, so a
market the wallet already holds is skipped.

## Example prompts Bankr understands

- `what are the odds the eagles win this weekend?`
- `bet $5 on eagles to win tonight`
- `buy 100 shares of YES in the bitcoin market`
- `sell my YES shares in the bitcoin market`
- `show my Polymarket positions`
- `redeem my winning polymarket positions`

Docs: https://docs.bankr.bot/docs/agent-api/prompt-endpoint, /docs/agent-api/job-management,
/docs/features/polymarket, /docs/security/developer-api.
