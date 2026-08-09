# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-08-09

Initial release.

- Three harness adapters — Claude Code, Codex, and pi — parsing native session logs into a Unified Session Model.
- Eight commands: `list`, `cost`, `compactions`, `context`, `diff`, `report`, `bench`, `pricing`.
- `peek diff` for turn-by-turn session comparison, including a zero-argument `--last 2` mode.
- `peek cost` with per-tool, per-MCP-server, and per-subagent attribution depth.
- `peek compactions` and `peek context` for compaction timelines and historical context composition, with exact totals and estimated (`~`) categories clearly labeled.
- `peek report` for a shareable HTML artifact, including a `--all` cross-session dashboard.
- `peek bench` config A/B runner: re-runs a task suite under two config variants (`current` vs. an overlay) in isolated git worktrees, diffing success rate, tokens, cost, and compaction counts from each trial's own session log.
- `peek pricing` with a vendored LiteLLM pricing snapshot, models.dev fallback, and an opt-in network refresh command.
- A `list` totals cache to avoid re-parsing unchanged sessions on repeat runs.
- `--json` output on all read commands for scripting.
