# Privacy / leak audit

Scope: everything that would ship if the current working tree were committed
(`git ls-files -o --exclude-standard`, 130 files — this repo has no commits
yet, so `git ls-files` alone returns nothing; the untracked-but-not-ignored
list is the accurate "what would ship" set). Verifies docs/DESIGN.md's Deferred / limitations ledger item 6: real
logs never leave the machine; the repo ships synthetic fixtures plus two
redacted real captures only.

Audited against the live working tree as of 2026-08-08 16:42 local. Note:
`scripts/redact.ts` was actively being patched by another agent during this
audit (grew from 397 to 466 lines mid-sweep, fixing mid-string structural-tag
scrambling and adding context-aware `name`/`toolName` handling). Findings
below reflect the file's state at the end of the audit; two gaps documented
in `test/fixtures/codex/README.md` ("Known redaction gap" note on
`real-capture-tools-redacted.jsonl`) were fixed during the audit and that
README note is now stale/inaccurate — a doc-drift item, not a leak.

## 1. Repo-wide leak sweep — result: 0 leaks

Grepped all 130 candidate-shipped files for: personal identifiers
(`mark`/`stuart`/`mstuart`, case-insensitive), `/Users/` paths, email
addresses, and API-key shapes (`sk-`, `ghp_`, `xox[baprs]-`, `AKIA`, `Bearer
`). Cross-referenced every hit against the full `~/git` directory-name list
(none of those project names appear anywhere in the tree).

**Legitimate hits (not leaks):**
- `LICENSE:3` — `Copyright (c) 2026 Mark Stuart`. Expected for an OSS license file.
- `package.json:29` — `git+https://github.com/mstuart/peek.git`. Standard `repository` field.
- `test/unit/redact.test.ts` — multiple `/Users/mark/git/peek` occurrences. These are **test *inputs*** feeding the redactor under test; every assertion in that file checks the string does *not* survive redaction (`.not.toBe(...)`, `.not.toContain(...)`). This is the test proving the leak-prevention works, not a leak itself.
- `docs/CLEANROOM.md:12` — "Working copy: rsync of `/Users/mark/git/peek` → scratchpad...". Deliberate packaging-validation documentation describing the audit environment, not session content. Low-severity judgment call: it does put the real macOS username in a doc that will ship publicly. Not a session-content leak, but flagging since it's avoidable (could say "the repo root" instead of the absolute path) if the user wants zero personal-path mentions anywhere in the shipped tree.

**No hits at all:** email addresses, API-key-shaped strings. (One grep match on the `Bearer` pattern in `src/adapters/claude/spans.ts:22` was a false positive — the line only contains the literal strings `"<teammate-message"` / `"<task-notification"`, no bearer token.)

All `docs/examples/*`, `test/fixtures/claude-code/*`, and `test/fixtures/pi/*` content uses placeholder paths (`/Users/fixture/project`, `/Users/fake/project`, `/Users/dev/projects/*`) confirmed fabricated by their respective `README.md` files.

## 2. Real-capture fixtures — manual inspection — result: 0 leaks found

`test/fixtures/codex/v0.134/real-capture-redacted.jsonl` (11 lines, 52KB) and
`real-capture-tools-redacted.jsonl` (16 lines, 55KB) are genuine `codex exec`
session captures from this machine, run through `scripts/redact.ts`.

Method: extracted every quoted string ≥20 chars and grepped for
space-delimited English stopwords (scrambled output uses an alphanumeric-only
charset with **no spaces**, so any surviving natural-language phrase would be
trivially visible this way) — zero hits in both files. Separately enumerated
every string value ≤8 chars (the passthrough threshold) across both files and
manually reviewed all 89: every one is a legitimate schema/enum value
(`"gpt-5.5"`, `"openai"`, `"managed"`, `"root"`, model/role/type/mode
dispatch values, etc.) or trivial assistant reply text (two single-word
final-turn messages, both wholly generic affirmatives with no informational
content). Confirmed real `cwd`, `timezone`, `current_date`, `workdir`, and
shell `cmd` values are all consistently scrambled to fixed-length gibberish;
`repository_url`/`branch`/`commit_hash` fields are absent from both captures
(session wasn't in a git repo). Rate-limit/billing telemetry
(`rate_limits`, `credits`, `plan_type`) is present and **numeric/boolean
values are not redacted at all** — see Gap 4 below; content here is
inconsequential (usage percentages, a null balance, `plan_type: "free"`) but
is real data from the machine.

`docs/examples/context-codex-real.{txt,json}` (the rendered CLI output built
from these fixtures) was also checked directly — only redacted path segments
and token counts appear, nothing else.

## 3. `scripts/redact.ts` — adversarial review — 4 gaps found

All four confirmed by direct execution against the live `redactRecord()`
function (synthetic probe input, not real captured content — safe to quote
in full below).

**Gap 1 — [High] Key-name allowlist is depth-unaware.** `ALLOWLIST_KEYS`
(`type`, `role`, `status`, `source`, `mode`, `kind`, `namespace`, `model`,
`version`, `effort`, etc.) matches by bare key name at **any nesting depth**,
not just the known top-level record shape. Any object anywhere in the tree —
including inside arbitrary MCP tool arguments/results — with a key that
happens to collide with one of these ~20 common English words bypasses
redaction entirely, verbatim, regardless of length or content. Probe:

```
input:  { tool_result: { status: "Blocked pending review from mark@company.com re: acquisition" } }
output: { tool_result: { status: "Blocked pending review from mark@company.com re: acquisition" } }  // unchanged
```

A real MCP tool with a `status`, `source`, `mode`, `kind`, or `namespace`
field carrying free-text content (ticket descriptions, commit messages,
error strings, anything) will ship completely unredacted on a future capture.

**Gap 2 — [High] Short-string (≤8 char) passthrough.** `classify()` scrambles
free text only when `value.length > 8`; anything shorter and otherwise
unclassified passes through **verbatim**. Probe:

```
input:  { author: "mstuart", env_user: "mark" }
output: { author: "mstuart", env_user: "mark" }  // unchanged
```

Real-world hits this threshold would let through: short usernames, git
author initials, a `USER`/`LOGNAME`-style env var value, short branch
names, short commit-message fragments, single-word replies. Confirmed the
mechanism is live on real data: two single-word assistant messages in the
real-capture fixtures survived via this exact path (harmless content in
those instances — see §2 — but the same code path would carry a name or
short phrase unredacted on a different real capture).

**Gap 3 — [High] `PATH_KEYS` misses Codex's actual (flattened) branch field
name.** `PATH_KEYS` matches `cwd`, `gitBranch`, `repository_url` by exact
normalized key name. Codex's real wire shape — per
`test/fixtures/codex/README.md`'s own documented ambiguity resolution — puts
git fields flat on `payload` as `commit_hash`, `branch`, `repository_url`
(no `gitBranch`, no nested `git` object with that name). `branch` is not in
`PATH_KEYS`, doesn't start with `/Users/`, isn't UUID/`toolu_`/`msg_`-shaped,
and isn't in `ID_KEY_NAMES` — so it falls through to Gap 2's threshold.
Probe:

```
input:  { payload: { git: { commit_hash: "abc1234", branch: "mstuart", repository_url: "https://github.com/example/x.git" } } }
output: { payload: { git: { commit_hash: "abc1234", branch: "mstuart", repository_url: "<redacted-fake-url>" } } }
```

`repository_url` gets correctly redacted (key-name match); `branch` and the
short `commit_hash` do not. A real capture with git metadata and a short or
personally-identifying branch name (a very plausible real-world case —
branch-per-developer naming conventions) will leak that branch name
verbatim.

**Gap 4 — [Informational] Numbers and booleans are never redacted.** Only
`typeof value === "string"` goes through classification; every numeric/
boolean field ships as-is. Currently low-sensitivity in practice (token
counts, `used_percent`, `window_minutes`, `resets_at` epoch timestamps,
`has_credits`/`unlimited` booleans — confirmed present verbatim in
`real-capture-redacted.jsonl`'s `rate_limits`/`credits` block, per §2) but
worth a conscious call given docs/DESIGN.md's Deferred / limitations ledger item 6's "real logs never leave the
machine" framing — these numbers are real telemetry from the actual account/
session, not scrambled or fabricated.

**Reviewed and found already fixed** (no action needed): the codex fixture
README's documented gap about `<INSTRUCTIONS>`/`<environment_context>` tags
only being preserved as a *leading* prefix (losing mid-string tags to
scrambling) — `scripts/redact.ts` now has `STRUCTURAL_TAGS` +
`scrambleWithTags()` handling tags anywhere in the string, confirmed by the
passing `test/unit/redact.test.ts` suite (14/14 pass). Also reviewed and
found correctly scoped: the new context-aware `name`/`toolName` allowlist
(only fires when a sibling `call_id`/`arguments`/`input_schema`/
`tool_use_id` key is present on the same object) — one second-order,
lower-confidence risk noted: a non-tool-call object that coincidentally uses
one of those exact sibling key names alongside a free-text `name` field
would also get the pass-through, but no such shape was found in any fixture
or the recon docs.

## 4. Runtime telemetry — 0 findings, confirmed clean

`grep -rE 'fetch\(|require\((http|https|net|dns)|from "(node:)?(http|https|net|dns)"|XMLHttpRequest|WebSocket'` across `src/` returns nothing. The only two files that mention `fetch` at all —
`src/pricing/refresh.ts` and `src/pricing/modelsDev.ts` — are both
unimplemented stubs that `throw new Error("...not implemented...")`; neither
makes a network call. `package.json` dependencies are `commander` and
`picocolors` only — no HTTP client library is even installed. Filesystem
writes: `scripts/redact.ts` (writes only to its own CLI-supplied output arg)
and `src/commands/report.ts:251` (writes only to a user-supplied
`--output` path or a sensible default in the CWD) — no writes outside
repo/user-specified paths.

## 5. `docs/examples/` regeneration safety — confirmed safe

`docs/examples/README.md` states explicitly (lines 3–4): "Real command
output, captured against fixture/synthetic sessions only — never against
`~/.claude` or `~/.codex`." Every repro command in the file's table targets a
path under `test/fixtures/`; none reference a real log directory.

## Summary

**0 leaks found, 4 redactor gaps, 0 telemetry findings.**

(Gap counting note: 3 gaps rated High — key-allowlist depth-unawareness,
short-string passthrough, and the `branch`-key path-detection miss — plus 1
Informational gap on numeric/boolean fields never being touched. All three
High gaps are latent: nothing currently shipped in the repo is affected, but
each is a concrete, demonstrated path by which a *future* real capture run
through `scripts/redact.ts` could leak content.)
