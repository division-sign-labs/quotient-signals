# Kalshi

`scripts/trade-kalshi.mjs` places orders on Kalshi for the Kalshi listings of Quotient signals.
Node 18 or later, no packages.

## What the user needs

1. A Kalshi account that may trade from where the script runs. Kalshi accepts API access from
   US IP addresses only.
2. An API key: kalshi.com → Account → API keys → Create. Kalshi shows a **key id** and gives a
   **private key** file (RSA, PEM) once. Save the file outside any repository.
3. Environment:

```bash
export KALSHI_KEY_ID=…                              # the key id Kalshi shows
export KALSHI_PRIVATE_KEY_PATH=~/.config/kalshi/key.pem
export KALSHI_ENV=prod                               # or demo
```

The demo exchange (`KALSHI_ENV=demo`, or `--demo`) has its own keys from
demo.kalshi.co; production keys do not work there and demo keys do not work in production.

## Base URLs

| Environment | REST base |
|---|---|
| production | `https://api.elections.kalshi.com/trade-api/v2` |
| demo | `https://demo-api.kalshi.co/trade-api/v2` |

## Signing

Every authenticated request carries three headers:

```
KALSHI-ACCESS-KEY:        <key id>
KALSHI-ACCESS-TIMESTAMP:  <epoch milliseconds>
KALSHI-ACCESS-SIGNATURE:  base64( RSA-PSS-SHA256( timestamp + METHOD + path ) )
```

The signed `path` includes the `/trade-api/v2` prefix and excludes the query string:
`1703123456789GET/trade-api/v2/portfolio/balance`. RSA-PSS uses SHA-256 with a salt the length
of the digest. The script signs with `node:crypto` (`RSA_PKCS1_PSS_PADDING`,
`RSA_PSS_SALTLEN_DIGEST`); a fresh timestamp is signed for every request.

## From a signal to an order

A Kalshi listing in a game signal's `markets[]` (or an event signal's `market` with
`venue: "kalshi"`) carries the ticker in `nativeMarketId`, e.g. `KXNFLGAME-26OCT04SEAWAS-SEA`,
and the side to buy in `signal_side` (`side` on an event signal).

The order API (V2, `POST /portfolio/events/orders`) quotes everything on the **YES** leg:
`side: "bid"` buys YES, `side: "ask"` sells YES. Buying NO is selling YES:

| Signal side | Order `side` | Order `price` |
|---|---|---|
| YES at the YES ask `a` | `bid` | `a` |
| NO at the NO ask `1 − b` (b = YES bid) | `ask` | `b` |

Prices and counts are fixed-point **strings** in dollars and contracts (`"0.47"`, `"21"`).

```json
POST /trade-api/v2/portfolio/events/orders
{
  "ticker": "KXNFLGAME-26OCT04SEAWAS-SEA",
  "side": "bid",
  "price": "0.47",
  "count": "21",
  "time_in_force": "immediate_or_cancel",
  "self_trade_prevention_type": "taker_at_cross",
  "client_order_id": "<uuid>"
}
```

The reply (`201`) carries `order_id`, `fill_count`, `remaining_count`, `ts_ms`, and when
anything filled `average_fill_price` and `average_fee_paid`. With `immediate_or_cancel` the
unfilled part is cancelled at once, so `remaining_count` is final.

## Reads the script makes

| Call | For |
|---|---|
| `GET /portfolio/balance` | the credential check and the cash on hand |
| `GET /markets/{ticker}` | the live book: `yes_bid_dollars`, `yes_ask_dollars` (strings), `status` |
| `GET /portfolio/positions?settlement_status=unsettled&limit=1000` | the tickers already held (`market_positions[].ticker`, `position_fp`) |

## Limits and fees

- Kalshi's basic API tier allows about 10 writes a second; the script spaces orders 300 ms apart
  and stops the batch on the first non-2xx reply.
- Fees are taken per contract on fills; the reply's `average_fee_paid` is the per-contract fee.
- A `401` means the key or signature is wrong; a `403` usually means the account cannot trade
  from this IP or needs verification.

## Why not `yes_price` and `action`

Those belong to the V1 order endpoint (`POST /portfolio/orders`), which Kalshi is retiring. The
script uses V2 only.
