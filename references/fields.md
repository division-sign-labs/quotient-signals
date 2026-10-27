# Fields

The body of `GET /api/v2/pro/signals` is the Quotient API's `GET /api/v1/signals` contract:
`{ "signals": PublicTradeSignalItem[] }`. Two row kinds share most fields. Everything below is
read by the scripts; the OpenAPI document at https://app.quotient.social/api/v2/pro/openapi.json
has every field with its type.

## Every row

| Field | Type | Meaning |
|---|---|---|
| `id` | string | the signal id, stable for its life |
| `published_at` | ISO time | when the signal was published |
| `forecast_updated_at` | ISO time or null | when Q's latest forecast for the market was made; a later value is a reforecast |
| `is_active` | boolean | true while the signal is open; false only once retired |
| `in_play` | boolean | the game has started or the market passed `resolves_at`; still active, not an entry |
| `retired_reason` | `resolved` · `flipped` · `fading_q` · `expired` · `under_review` · null | why a retired signal closed |
| `entry_eligible` | boolean | an entry now: open, before play, live-priced, inside Quotient's price, edge, deadline and adverse-move limits |
| `entry_status` | `eligible` or the one check it fails | `in_play`, `retired`, `deadline_passed`, `no_quote`, `price_extreme`, `price_too_high`, `gap_too_small`, `gap_too_wide`, `deadline_too_far`, `moved_against`, `flip_hold`, `live_catalysts`, `unmapped`, `closed`, … |
| `conviction_tier` | 1, 2, 3 or null | the calibrated win rate of comparable calls on this side; 3 is highest; null when the estimate is unknown |
| `conviction` | `high` · `medium` · `low` · null | the same tier as a word |
| `thesis` | string or null | Q's one-sentence case |
| `resolves_at` | ISO time or null | kickoff for a game; the market's end otherwise |
| `capacity_usd_at_2c` | number or null | near-touch depth within 2¢, USD; refreshed about every 12 hours |
| `capacity_basis` | `depth-2c` · `volume-fallback` · null | `volume-fallback` means depth is unknown but 24-hour volume is at least $5,000 |
| `drawdown_risk_elevated` | boolean or null | the risk model flags a drawdown; null means no coverage |
| `key_factors`, `recent_evidence` | arrays | Q's factors and up to five sources for the latest forecast |

## Event signal (no `kind`)

| Field | Type | Meaning |
|---|---|---|
| `side` | `YES` · `NO` | the side to buy |
| `latest_q` | 0 to 1 | Q's latest probability of YES |
| `entry_q` | 0 to 100 | Q's probability of YES at publication |
| `entry_pm` | 0 to 100 | the venue's YES price at publication |
| `q_value_cents` | ¢ | what Q thinks the **side** is worth now |
| `current_cost_cents` | ¢ | what the **side** costs now |
| `entry_cost_cents` | ¢ | what the side cost at publication |
| `converge_upside_pct` | % or null | gain from the current cost if the price moves to Q |
| `live_priced`, `priced_at` | boolean, ISO time | the cost comes from a live book read |
| `forecast_status` | object or null | `state` (`converging`, `sideways`, `caution`, `warning`), `adverse_move_pct` |
| `venue_quote` | object | `yes_bid`, `yes_ask`, `yes_last`, `selected_probability`, `freshness` |
| `market.venue` | `polymarket` · `polymarket_us` · `kalshi` · `hl_outcomes` | where it trades |
| `market.slug`, `market.condition_id` | string | the Polymarket market |
| `market.nativeMarketId` | string | the Kalshi ticker, or the venue's market id |
| `market.marketKey` | string | `venue:id`, the id Quotient uses |
| `market.question`, `market.marketUrl` | string | the title as the venue prints it, and its page |

The edge of an event signal, in points: `q_value_cents - current_cost_cents`. For sizing,
`q = q_value_cents / 100` and `p = current_cost_cents / 100`.

## Game signal (`kind: "sports_game"`)

| Field | Type | Meaning |
|---|---|---|
| `pick.code`, `pick.label` | string | the team Q picks |
| `pick.probability` | 0 to 1 | Q's probability the pick wins, now |
| `pick.entry_probability` | 0 to 1 | the same at publication |
| `sports.sport`, `sports.league` | string | `football`, `nfl`; `football`, `cfb`; `basketball`, `nba`; … |
| `sports.game_title`, `sports.kickoff_at` | string, ISO time | the game and its start |
| `markets[]` | array | one listing per venue that trades the game |

Each listing in `markets[]` carries the market fields above (`venue`, `nativeMarketId`, `slug`,
`condition_id`, `question`, `marketUrl`) and:

| Field | Type | Meaning |
|---|---|---|
| `signal_side` | `YES` · `NO` · null | the side of **this contract** that pays if the pick wins; null when the contract cannot be oriented to the pick |
| `signal_available` | boolean | open, active and mapped to the pick |
| `entry_eligible`, `entry_status` | as above | this listing's own eligibility at its own price |
| `current_cost_cents` | ¢ | the cost of `signal_side` now |
| `edge_pp` | points | `pick.probability × 100 − current_cost_cents` |
| `entry_side_price` | 0 to 1 | the side's price at publication |
| `venue_quote` | object | `yes_bid`, `yes_ask`, `yes_last` as fractions of a dollar |
| `yes_outcome`, `outcomes[]` | objects | the team on YES; the outcome list, with `token_id` on Polymarket |
| `signal_outcome` | object or null | the Polymarket outcome to buy: `{ token_id, label }` |
| `capacity_usd_at_2c`, `capacity_basis` | as above | this listing's depth |

For sizing a game listing, `q = pick.probability` and `p = current_cost_cents / 100`, or the
live ask of the side when you have one.

## Two rows, abridged

```json
{
  "signals": [
    {
      "id": "7c1e4b2a-0d3f-4e5a-8b6c-9d0e1f2a3b4c",
      "kind": "sports_game",
      "published_at": "2026-10-04T14:02:11Z",
      "forecast_updated_at": "2026-10-04T17:12:00Z",
      "is_active": true, "in_play": false, "entry_eligible": true, "entry_status": "eligible",
      "conviction_tier": 2,
      "pick": { "code": "sea", "label": "Seahawks", "probability": 0.52, "entry_probability": 0.52 },
      "sports": { "sport": "football", "league": "nfl", "game_title": "Seattle vs Washington", "kickoff_at": "2026-10-04T20:25:00Z" },
      "thesis": "Q favors Seattle's pass rush against Washington's injured offensive line.",
      "markets": [
        {
          "venue": "kalshi", "nativeMarketId": "KXNFLGAME-26OCT04SEAWAS-SEA", "slug": null, "condition_id": null,
          "question": "Seattle at Washington Winner?",
          "signal_side": "YES", "entry_eligible": true, "entry_status": "eligible",
          "current_cost_cents": 46, "edge_pp": 6,
          "venue_quote": { "yes_bid": 0.45, "yes_ask": 0.47, "yes_last": 0.46 },
          "capacity_usd_at_2c": 5200, "capacity_basis": "depth-2c"
        }
      ]
    },
    {
      "id": "3f9d2c1e-6b7a-4f7e-9c2d-1a2b3c4d5e6f",
      "published_at": "2026-09-30T12:00:00Z",
      "is_active": true, "in_play": false, "entry_eligible": true, "entry_status": "eligible",
      "side": "NO", "latest_q": 0.22, "q_value_cents": 78, "current_cost_cents": 58, "entry_cost_cents": 56,
      "conviction_tier": 3,
      "thesis": "Q sees the ceasefire conditions as unlikely to be met before year-end.",
      "market": {
        "venue": "polymarket", "slug": "russia-ukraine-ceasefire-2026", "condition_id": "0x1234…",
        "nativeMarketId": "789012", "question": "Will there be a Russia-Ukraine ceasefire in 2026?"
      }
    }
  ]
}
```

# Notifications

`GET /api/v2/pro/notifications` returns `{ "as_of", "unread", "pending", "items" }`. `unread`
counts items the member has not seen in the app; `pending` counts reforecasts still running.
Each item:

| Field | Type | Meaning |
|---|---|---|
| `id` | string | stable for the alert's life: dedupe on it |
| `kind` | `signal` · `reply` · `forecast_move` · `market_move` · `list_match` · `list_move` · `trader_trade` · `reforecast` · `position_move` · `position_q_move` | what happened |
| `status` | `published` · `finished` · `failed` · `pending` | `published` for everything but a reforecast job |
| `title` | string | the game's title or the market question |
| `href` | string | the page on app.quotient.social, path only |
| `at` | ISO time | when it happened |
| `unread` | boolean | not yet seen in the app |
| `message` | string or null | a reforecast's failure reason |
| `league`, `pick`, `against`, `marketCents`, `qCents` | signal | the league, what Q picked, the other side, both prices at post in ¢ |
| `deltaPp`, `previousPct`, `currentPct` | forecast_move, market_move | the move in points, from and to |
| `signalId`, `marketId` | string | the signal and market the alert is about |
| `listId`, `listName` | list_match, list_move | the list the market is on |
| `actor` | reply, trader_trade | `{ name, image }` |
| `venue`, `side`, `entryCents`, `nowCents`, `movePct` | position_move | the held side, its entry and now in ¢, the signed move in percent |
| `flipped` | position_q_move | Q crossed 50 against the held side |
| `qPct` | reforecast | the new Q, whole percent |

```json
{
  "as_of": "2026-10-26T18:30:00Z",
  "unread": 2,
  "pending": 0,
  "items": [
    { "id": "signal:7c1e4b2a-…", "kind": "signal", "status": "published", "title": "Seattle vs Washington", "href": "/signals/7c1e4b2a-…", "at": "2026-10-26T14:02:11Z", "unread": true, "paths": ["/markets/kalshi%3AKXNFLGAME-26OCT04SEAWAS-SEA"], "league": "nfl", "pick": "Seahawks", "against": "Commanders", "marketCents": 46, "qCents": 52 },
    { "id": "pos:0x1234…:no:3", "kind": "position_move", "status": "published", "title": "Will there be a Russia-Ukraine ceasefire in 2026?", "href": "/markets/789012", "at": "2026-10-26T13:10:00Z", "unread": true, "paths": ["/markets/789012"], "venue": "polymarket", "side": "NO", "entryCents": 56, "nowCents": 62, "movePct": 10.7 },
    { "id": "fm:3f9d2c1e-…:2", "kind": "forecast_move", "status": "published", "title": "Will there be a Russia-Ukraine ceasefire in 2026?", "href": "/signals/3f9d2c1e-…", "at": "2026-10-26T09:00:00Z", "unread": false, "paths": ["/markets/789012"], "deltaPp": 6, "previousPct": 22, "currentPct": 16, "signalId": "3f9d2c1e-…" }
  ]
}
```
