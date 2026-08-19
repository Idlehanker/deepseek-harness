# `@deepseek-ai/dsh-tui`

English | [中文](README.zh.md)

The dsh interactive terminal bundle. [`cordis.patch.yml`](cordis.patch.yml) rides directly over [`dsh-base`](../base/README.md): it supplies the coding persona and tool mode, disables HMR, mounts Code Mode's worker as a core execution capability, and inserts this package's `tui-runner` plugin. It mounts no Host, HTTP server, Web runtime, or browser plugin.

Boot it with `dsh --profile tui`. After the Loader settles, the runner reads the shared [`ctx.agentDefaultModel`](../../core/agent-default-model/README.md), creates one fresh persisted Agent through `ctx.agents`, prints a banner (model route and working directory), and loops on a readline prompt. Each entered line becomes one ordinary follow-up turn; while the turn runs, the runner folds live `session/event` records into the transcript — `assistant/chunk` text deltas stream verbatim, `tool/call` renders as a one-line `● name(args-preview)` indicator, and a failing `tool/result` prints a `✗` line. The pure folding lives in [`src/render.ts`](src/render.ts) (`TranscriptRenderer`), free of io. `approval/request` questions are answered inline on the terminal (`[y/N]`, anything but an explicit yes rejects, so the answerer fails closed), claimed only for the agent the runner created; other agents' questions delegate down the answerer chain. A terminal `turn/end` error reason writes its code and message to stderr.

`/help` prints the command list; `/exit`, `/quit`, Ctrl+D (EOF), or Ctrl+C ends the loop, flushes the Session, and requests exit through the launcher-provided `ctx.appExit` host hook ([`dsh-cmdline`](../../boot/cmdline/README.md)) with code 0. The process opens no listening port. The console is a narrow `TuiIo` seam (`write`/`error`/`prompt`/`close`) with a readline default over stdio; tests substitute a scripted console through `internals.createIo`.

## Model Experience

None, as the runner submits each entered line as an ordinary user message; prompts and tools belong to the composed base and tui bundles.

#### KV Cache effect

None; the runner adds nothing to the request prefix.

## Known Limitations and Deferred Work

- **No mid-turn input** — while a turn runs the prompt is not active; steering, interruption (cancel the active turn), and queued input are deferred. Ctrl+C relies on the launcher's shutdown path, not turn cancellation.
- **No `--resume`** — every boot starts a fresh session; resuming a persisted session is deferred.
- **No slash-command surface beyond `/help` and `/exit`** — base's `commands` capability is model-facing; the REPL does not dispatch user-typed slash commands to it yet.
- **No markup** — assistant text streams verbatim; markdown rendering, syntax highlighting, and diff cards are deferred.
- **`ctx.appExit` is launcher-owned** — booting the tui profile outside the `dsh` launcher fails loud at activation until the host provides the exit request.
