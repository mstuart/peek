# Contributing to peek

## Dev setup

```bash
git clone https://github.com/mstuart/peek.git
cd peek
npm ci
npm test
```

Useful scripts (see `package.json`):

- `npm run dev` — run the CLI from source via `tsx` (no build step)
- `npm test` / `npm run test:watch` — vitest
- `npm run lint` / `npm run lint:fix` — biome
- `npm run typecheck` — `tsc --noEmit`
- `npm run check` — lint + typecheck + test, same as CI
- `npm run build` — tsup, emits `dist/`

## Architecture / layering rules

```
adapters/{claude,codex,pi}/  → parse native logs → Unified Session Model
model/                       types + invariants (the moat)
engine/                      dedup → accounting → composition → compaction → attribution
commands/                    list | cost | compactions | context | diff | report | bench | --json
pricing/                     vendored LiteLLM snapshot + models.dev fallback + opt-in refresh
```

- **Adapters never throw** on malformed or unknown records — they warn (`ParseWarning`) and continue. Only an unreadable file rejects. This keeps one corrupt session from taking down a `list`/`cost` run across a whole directory.
- **Adapters produce the Unified Session Model** (`model/types.ts`); nothing downstream should special-case a harness. If a harness needs a new field, it goes into the USM first — see the "Do not add fields without updating this section first" note at the top of `model/types.ts`.
- **The engine consumes deduped sessions.** `engine/dedup.ts` runs before accounting, composition, compaction, or attribution — those stages assume a session has already been deduplicated and should not re-implement dedup logic themselves.
- **Commands are thin.** They call into `engine/` and `model/format.ts` for presentation; business logic (accounting, composition math, compaction detection) belongs in `engine/`, not in `commands/`.

## Honesty conventions

peek's core commitment is that every number is either **exact** (straight from a harness's own usage fields, never re-tokenized) or an **estimate**, and it's never ambiguous which:

- Exact figures are printed plain.
- Estimated figures are labeled `~` in every human-readable and JSON output — token/char estimates, discarded-content estimates, tool-schema sizing, etc.
- If something can't be measured at all (e.g. a residual a harness doesn't log), name what it is instead of hiding it or folding it into an adjacent category.

If you add a new computed field, decide up front whether it's exact or estimated, and thread that distinction through to output — don't leave it implicit.

## Tests

- Tests are fixture-backed. Real harness session shapes live under `test/fixtures/{claude-code,codex,pi}/<version>/...`; add a fixture rather than hand-rolling ad hoc JSON when a test needs realistic input.
- **Every bugfix lands with its reproducing fixture** — a fixture (or fixture excerpt) that fails on `main` and passes with the fix, not just an assertion.
- `test/local.integration.test.ts` runs against real local session logs on disk and is gated behind `PEEK_LOCAL=1`; it's skipped by default and excluded from CI. Only use it for local validation against your own machine's sessions — never commit real (non-fixture, non-redacted) session data.

## Pull requests

- `npm run check` (lint + typecheck + test) must be green.
- New behavior needs a test; bugfixes need a reproducing fixture (see above).
- Keep changes scoped — prefer a focused PR over bundling unrelated cleanup.
