# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities via GitHub's private ["Report a vulnerability"](https://github.com/mstuart/peek/security/advisories/new) advisory flow, or open a regular issue for anything non-sensitive. Expect an initial response within a few days.

## Supported versions

peek is pre-1.0. Security fixes land on the latest `main` / latest published version only.

## Threat model and local-only guarantees

peek is a local-first CLI that reads coding-agent session logs already on your disk. Its design intent is that your session data never leaves your machine.

- **No telemetry, no analytics.** peek makes exactly one network request, and only when you explicitly run `peek pricing refresh`: an unauthenticated `GET https://models.dev/api.json` that sends no request body and no session data. Nothing else in the tool touches the network. (Historical note: an early privacy audit predates the `peek pricing refresh` command — see the dated addendum in `docs/PRIVACY-AUDIT.md`.)
- **Local file writes.** peek writes a totals cache and an optional pricing-snapshot cache under `${XDG_CACHE_HOME:-~/.cache}/peek/`, created with `0700` dir / `0600` file permissions so other local accounts can't read them. The cache rows contain session file paths, cwd, model ids, and token/cost totals — never message content.
- **Report/dashboard artifacts are shareable-by-design but not content-free.** `peek report`, `peek report --all`, and `peek report --diff` produce self-contained HTML that includes model ids, tool/MCP-server names, token/cost numbers, and a shortened working-directory path — never message text, prompts, or tool output. `--json-embed` inlines the full computed report structure (still no message content); its serialization escapes `</script>` to prevent markup breakout from crafted session fields. Review a report before sharing it outside your org if project directory names are sensitive.

## `peek bench` trust boundary

`peek bench` is the one command that executes code. It runs real coding agents (`claude`/`codex`) with file-write permission, plus your task suite's `setup`/`verify` strings through `/bin/sh`, inside an isolated `git worktree`. Two things to understand:

- **A worktree is a filesystem convention, not a sandbox.** Trial commands run with your OS user's full permissions and inherit your environment (including `$HOME` and any credentials in it). Only run task suites you trust — the same trust you'd extend to a `Makefile` or `npm` script from that source.
- **Suite trust is enforced, not just documented.** The first time you run a given suite — and any time its task files or config overlays change — peek prints every `setup`/`verify` command it will execute and requires explicit approval. `--yes` skips the cost-estimate confirmation but **never** the suite-trust prompt; a changed suite always re-prompts.

## Dependencies

Runtime dependencies are limited to `commander` and `picocolors`. `npm audit` is expected to report zero vulnerabilities; CI would surface a regression.
