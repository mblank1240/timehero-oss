# Contributing

Thanks for helping. TimeHero handles people's pay and leave, so correctness
matters more than speed.

## Before you start

Read `CLAUDE.md`: the stack, the layout, and the rules that must not be
broken. The short version:

1. Policy is data, never code — no organization's figures as literals.
2. Balances are never stored; they are the sum of an append-only ledger.
3. Scheduled jobs are idempotent, enforced by the database.
4. Comp time is for exempt staff only (FLSA).
5. Every duration is an integer count of minutes.

`docs/DECISIONS.md` explains why things are the way they are. If a change
needs a new judgement call, add an entry there.

## Development

Set up as in the README's **Try it locally**, then:

```bash
npm run check              # typecheck and lint
npm test                   # unit tests, no database
npm run test:integration   # against a migrated, seeded Postgres
npm run test:e2e           # Playwright; starts its own server on port 3100
```

CI runs all of them, plus a production build and a Docker build. New
behaviour comes with tests: pure logic in `lib/accrual/` and friends gets unit
tests against figures you can check by hand; anything touching the ledger
gets an integration test.

Schema changes are Prisma migrations (`npm run db:migrate`). Never edit one
that has been merged.

## Pull requests

Keep them focused, describe what changed and why, and say how you tested it.
Update the docs a change makes stale.
