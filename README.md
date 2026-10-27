# quotient-signals

[![skills.sh](https://skills.sh/b/division-sign-labs/quotient-signals)](https://skills.sh/division-sign-labs/quotient-signals)

An agent skill for Quotient's published prediction-market signals: read them through the Pro
endpoint, understand a signal's side, edge and conviction, and trade on one on Kalshi or on
Polymarket through Bankr. Dry run by default.

```bash
npx skills add division-sign-labs/quotient-signals
export QUOTIENT_PRO_KEY=qp_…     # from https://app.quotient.social/agents (Pro)
```

Then ask your agent: "Show today's signals." · "Anything new for me?" · "Buy every football signal on Kalshi, dry run."

- [SKILL.md](SKILL.md): the endpoint, how to read a signal, the rules, the scripts
- [references/fields.md](references/fields.md): every field the scripts read
- [references/strategy.md](references/strategy.md): side, edge, ¼ Kelly, one lot, hold to resolution
- [references/kalshi.md](references/kalshi.md) · [references/bankr.md](references/bankr.md): venue setup

The feeds are `GET https://app.quotient.social/api/v2/pro/signals` and
`GET https://app.quotient.social/api/v2/pro/notifications`, with
`Authorization: Bearer $QUOTIENT_PRO_KEY`, 50 requests a day per key across both. OpenAPI:
https://app.quotient.social/api/v2/pro/openapi.json.

Source of truth: `skills/quotient-signals` in the Quotient app repository; this repository is
its published copy.
