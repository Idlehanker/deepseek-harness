/**
 * @deepseek-ai/dsh-tui — interactive terminal chat driver. The bundle patch
 * rides over dsh-base without Host, HTTP, or browser plugins; this runner
 * creates one Agent through the core registry and drives a readline REPL:
 * each entered line becomes one ordinary follow-up turn, assistant text
 * streams live from `assistant/chunk` events, tool calls render as one-line
 * indicators, and `approval/request` questions are answered inline on the
 * terminal. `/exit`, `/quit`, or EOF flushes the Session and exits.
 *
 * @module @deepseek-ai/dsh-tui
 */

import { randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline/promises'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
// Empty type imports carry the loader Context merge for the settlement await
// and the cmdline Context merge for the appExit host value.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import { TranscriptRenderer } from './render.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-runner'

/** Core services required before the REPL can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/**
 * The console surface the REPL drives. Kept narrow so tests substitute a
 * scripted console while the process default is readline over stdio.
 */
export interface TuiIo {
  /** Append transcript output. */
  write(chunk: string): void
  /** Append a diagnostic line. */
  error(chunk: string): void
  /**
   * Ask one question and resolve the entered line. Resolves `undefined` once
   * input closes (EOF), so every loop terminates on end-of-stream.
   * @param question - the prompt text written before reading.
   * @returns the entered line, or `undefined` after input closed.
   */
  prompt(question: string): Promise<string | undefined>
  /** Release the input surface; the REPL is done asking. */
  close(): void
}

/** The process streams and the io factory the REPL uses; tests substitute both. */
export const internals: {
  input: NodeJS.ReadableStream
  output: NodeJS.WritableStream
  errorOutput: NodeJS.WritableStream
  createIo: () => TuiIo
} = {
  input: process.stdin,
  output: process.stdout,
  errorOutput: process.stderr,
  createIo: () => createTerminalIo(),
}

/**
 * Create the readline-backed console over {@link internals}. `close` from any
 * source — EOF, `rl.close()`, or Ctrl+C with no SIGINT listener — settles a
 * pending question with `undefined` and short-circuits later ones.
 * @returns the terminal console.
 */
export function createTerminalIo(): TuiIo {
  const rl = createInterface({ input: internals.input, output: internals.output })
  let closed = false
  rl.on('close', () => { closed = true })
  return {
    write: (chunk) => { internals.output.write(chunk) },
    error: (chunk) => { internals.errorOutput.write(chunk) },
    prompt: (question) => {
      if (closed) return Promise.resolve(undefined)
      return Promise.race([
        rl.question(question),
        new Promise<undefined>((resolve) => { rl.once('close', () => { resolve(undefined) }) }),
      ])
    },
    close: () => { rl.close() },
  }
}

/** The `/help` transcript block. */
export const HELP_TEXT = `Commands:
  /help   show this help
  /exit   flush the session and quit (also: /quit, Ctrl+D)
`

/** The greeting block: model route, workspace, and the one-line usage hint. */
function banner(provider: string, model: string): string {
  return `dsh tui — ${provider}/${model}\nWorking directory: ${process.cwd()}\nType a message and press Enter; /help lists commands.\n\n`
}

/**
 * Answer one approval question inline; anything but an explicit y/yes
 * rejects, including EOF, keeping the terminal answerer fail-closed.
 * @param io - the console the question is asked on.
 * @param req - the pending decision (tool identity and the asker's reason).
 * @returns the one-shot outcome.
 */
async function answerApproval(io: TuiIo, req: ApprovalRequest): Promise<ApprovalOutcome> {
  const reason = req.reason === undefined ? '' : ` — ${req.reason}`
  const answer = await io.prompt(`Allow ${req.toolName}${reason}? [y/N] `)
  return answer !== undefined && /^(y|yes)$/i.test(answer.trim()) ? 'allowed-once' : 'rejected'
}

/**
 * Run the REPL until exit, then flush and request process exit.
 * @param ctx - plugin context carrying core services and launcher hooks.
 * @param exit - the launcher's bounded exit request.
 */
async function run(ctx: Context, exit: (code: number) => void): Promise<void> {
  // Loader siblings mount concurrently. Await the complete application before
  // creating an Agent so its scoped tools and adapters are not half-composed.
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  // Early process shutdown can dispose the tree while settlement is pending.
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  const selection = defaultModel.currentSelection()
  // This bundle composes no preset roster, so the model-facing rows sit in the
  // host plane and the agent reads them from the global layer (same stance as
  // the headless runner).
  const { agent } = await agents.create({
    sessionId: SessionId(`session-${randomUUID()}`),
    meta: { cwd: process.cwd() },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: (agentCtx) => {
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, selected)
    },
  })
  await agent.whenIdle()

  const io = internals.createIo()
  const renderer = new TranscriptRenderer()
  ctx.on('session/event', (session, event) => {
    if (session !== agent.session) return
    if (event.type === 'turn/end' && event.data.reason.kind === 'error') {
      io.error(`dsh: ${event.data.reason.error.code}: ${event.data.reason.error.message}\n`)
    }
    const chunk = renderer.render(event)
    if (chunk !== '') io.write(chunk)
  })
  ctx.on('approval/request', (req, next) => {
    if (req.agent !== agent) return next()
    return answerApproval(io, req)
  })

  io.write(banner(selection.provider, selection.model))
  for (;;) {
    const line = await io.prompt('> ')
    if (line === undefined) break
    const text = line.trim()
    if (text === '') continue
    if (text === '/exit' || text === '/quit') break
    if (text === '/help') {
      io.write(HELP_TEXT)
      continue
    }
    if (text.startsWith('/')) {
      io.write(`dsh: unknown command ${text} — /help lists commands\n`)
      continue
    }
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
  }
  await sessions.flush(agent.session)
  io.close()
  exit(0)
}

/**
 * Mount the interactive terminal driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 */
export function apply(ctx: Context): void {
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('tui-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  void run(ctx, exit).catch((error: unknown) => {
    internals.errorOutput.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
    exit(1)
  })
}
