# Acting on a signal

The rule Quotient's own studies and its bot (cassie) use. The scripts implement it; read this
when a user asks why a trade is sized the way it is, or wants to change a parameter.

## The side and the price

- **Side** = the signal's side. An event signal says `side`; a game listing says `signal_side`
  for that contract. Never trade the other side of a signal.
- **Price `p`** = the live cost of that side, as a fraction of a dollar. Buying YES costs the YES
  ask (`venue_quote.yes_ask`). Buying NO costs `1 − yes_bid`. Without a live quote, use
  `current_cost_cents / 100`.
- **Q's probability `q`** for the side: an event signal gives `q_value_cents / 100`; a game
  listing gives `pick.probability` (the pick wins when `signal_side` pays).

## The edge

`edge = q − p`, printed in points (`× 100`). An event row also carries it as
`q_value_cents − current_cost_cents`; a game listing carries it as `edge_pp`.

Trade only when the edge is positive after the live price. When the market has moved to or past
Q, skip: the signal was right and the price already has it. The default floor in the scripts is
5 points (`--min-edge 5`).

`status=active` already applies Quotient's entry policy at publication prices and the latest
quote: a cost above 70¢ is out, a YES price under 12.5¢ or over 87.5¢ is out, a gap under the
category floor or over its ceiling is out, a deadline past seven days (sports) is out, a price
that moved against the signal past the loss limit is out (`entry_status: moved_against`). Do not
recompute these; a listing with `entry_eligible: false` is not an entry.

## The size

Quarter Kelly on the live edge, as cassie's `portfolioKellyTargetUsd` and the
hold-to-resolution study size it:

```
full_kelly = max(0, (q − p) / (1 − p))
size_usd   = full_kelly × 0.25 × equity
size_usd   = min(size_usd, 0.05 × equity, --max-usd, 0.10 × capacity_usd_at_2c)
```

- `equity` is the bankroll the user names (`--equity` on Kalshi; `--budget` on Bankr is the total
  to spread, so each market gets `budget / n`, then the same caps).
- A zero Kelly is a skip, never a minimum ticket.
- The 10% of `capacity_usd_at_2c` cap keeps an order inside the depth Quotient saw within 2¢ of
  touch. Capacity is observed notional, not a fill guarantee; the Kalshi script uses an IOC
  limit at the ask so an order never walks the book past the quoted price.
- Contracts = `floor(size_usd / p)`. A size under one contract (or under $1 on Polymarket) is a skip.

## One lot, held to resolution

- **One lot per market, bought at once.** Splitting the entry into tranches lowered return in
  Quotient's study (`split_entry.py`): the first price was the best price.
- **Hold to resolution.** No take-profit, no stop. The signal's value is the gap closing at
  settlement.
- **Exit only on a flip.** When Q's forecast moves to the other side the signal retires with
  `retired_reason: "flipped"` (the publisher waits for two forecasts before it flips). Sell then.
  `fading_q` and `under_review` are also retirements; treat them as flips when the user wants
  the strict rule, or hold when they said hold to resolution.
- **Never hold both sides of one event.** The scripts skip a market the account already holds.

## The hold preset

Quotient's hold-to-resolution report on 103 lots: one lot per market, the two-forecast flip exit,
hold to resolution, **only signals with 15 points or more of edge and 60 days or less to
resolution**, returned +19.6% a lot. cassie ships it as the `signals-hold` preset. Pass
`--min-edge 15` to the scripts and prefer markets whose `resolves_at` is inside 60 days.

The same report warns that the result depends on the regime: a YES-heavy stretch in late summer
lost money. Size as if the next hundred signals will not all look like the last hundred.

## Games

- `pick.probability` is Q's live probability for the pick; `pick.entry_probability` was the
  publication value. A listing's `edge_pp` already uses the live one.
- Trade at most one listing per game. Prefer the venue the user named; otherwise the listing
  with the larger `edge_pp` that is `entry_eligible`.
- A game `in_play` is not an entry. The signal stays active for the record.
