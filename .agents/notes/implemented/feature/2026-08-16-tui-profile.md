# Agent Note: Interactive terminal (tui) profile

Status: implemented

[中文](2026-08-16-tui-profile.zh.md)

## Problem

The launcher help advertised `dsh --profile tui`, but no shipped template backed the name: `loadProfile` failed loud for it, and the only no-server surface was the one-shot `headless` runner. An interactive terminal chat — the Claude Code CLI shape — needed a bundle that drives one Agent in a readline loop without growing a Host, HTTP, or browser layer.

## Decision

**A new `tui` bundle package, `@deepseek-ai/dsh-tui` (`packages/bundle/tui`), follows the headless template.** Its `cordis.patch.yml` rides over `dsh-base` with the coding persona, HMR off, the Code Mode worker, and one inserted `tui-runner` row. `PROFILE_TEMPLATES` gains `tui: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-tui']`, so `dsh --profile tui` auto-initializes like `web` and `headless`; `apps/cli` depends on the bundle so the installation fallback resolves it.

**The runner drives a REPL over a narrow `TuiIo` seam.** After Loader settlement it creates one persisted Agent (same `installModelSelection` setup as headless), then loops: each line is one ordinary `followup` turn awaited through `whenIdle()`. `TuiIo` (`write`/`error`/`prompt`/`close`) has one readline default over stdio; `internals.createIo` lets tests substitute a scripted console, and the real readline wrapper is covered through `PassThrough` stdio.

**Rendering is a pure folder.** `TranscriptRenderer` (`src/render.ts`) folds live `session/event` records into printable chunks: `assistant/chunk` text deltas stream verbatim, `tool/call` prints a one-line `● name(args-preview)` indicator, failing `tool/result` prints a `✗` line, and stream open/close state supplies the newlines between them. Terminal `turn/end` error reasons go to stderr.

**Approval questions are answered inline and fail closed.** A root `approval/request` waterfall listener claims only the runner's own agent (other agents delegate via `next()`) and maps the typed answer to the outcome vocabulary: explicit `y`/`yes` grants `allowed-once`; everything else, including EOF, rejects.

**Exit is launcher-owned.** `/exit`, `/quit`, EOF, or Ctrl+C ends the loop, flushes the session, and requests `ctx.appExit(0)`; a missing `appExit` throws at activation, mirroring headless.

## Alternatives considered

**Reuse the headless runner with a loop flag.** Rejected: one-shot aggregation (fold after quiescence, map turn-end reason to process exit code) is a different contract than a live transcript; sharing the driver would entangle both.

**Drive the chat through the SDK JSON-RPC server.** Rejected: the TUI is same-process; the wire protocol would add a transport and a second runtime for no decoupling gain. The ACP/JSON-RPC demos remain the remote surfaces.

**A full-screen terminal UI library (ink, blessed).** Rejected for v1: a line-oriented readline loop covers the core loop with zero new dependencies; rich rendering (markdown, diffs, spinners) can layer on the same `TuiIo` seam later.

**Dispatch user-typed slash commands to the base `commands` capability.** Deferred: that surface is model-facing today; wiring REPL commands into it is a separate decision.

## Consequences

`dsh --profile tui` boots an interactive coding agent in any terminal with the full base tool stack, streamed replies, and inline approvals. Known gaps are recorded in the package README: no mid-turn steering or interrupt, no `--resume`, no user slash commands beyond `/help` and `/exit`, and verbatim (unrendered) text output. Unit coverage is 100% on all three source files; no keyless snapshot exists yet because the snapshot harness drives the assembled app transcript, which needs an interactive-stdin replay lane the current fixtures do not have.
