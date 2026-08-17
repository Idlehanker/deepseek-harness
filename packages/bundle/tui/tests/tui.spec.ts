/** Interactive REPL driving: prompts, streaming, approval answers, flush, and exit. */

import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { CallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import { apply, createTerminalIo, internals } from '../src/index.ts'
import type { TuiIo } from '../src/index.ts'

const originalInternals = { ...internals }
afterEach(() => { Object.assign(internals, originalInternals) })

/** A console whose prompt answers come from a fixed queue; exhaustion reads as EOF. */
function scriptedIo(answers: readonly string[]): TuiIo & { out: string; err: string; questions: string[]; closed: boolean } {
  const queue = [...answers]
  const io = {
    out: '',
    err: '',
    questions: [] as string[],
    closed: false,
    write(chunk: string) { io.out += chunk },
    error(chunk: string) { io.err += chunk },
    prompt(question: string) {
      io.questions.push(question)
      return Promise.resolve(queue.shift())
    },
    close() { io.closed = true },
  }
  return io
}

interface Script {
  before?(session: Session, agent: Agent): void
  afterPrompt?(session: Session, message: UserMessage, agent: Agent): Promise<void> | void
}

/** Mount the real registries around a scripted Agent factory and a scripted console. */
async function bench(script: Script, answers: readonly string[]): Promise<{
  ctx: Context
  run(): Promise<{ code: number; out: string; err: string; questions: string[]; closed: boolean; order: string[] }>
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentDefaultModelConfig, { provider: 'test-provider', model: 'test-model' })
  const io = scriptedIo(answers)
  internals.createIo = () => io
  ctx.agents.setFactory({
    async createAgent(ownerCtx: Context, options: CreateAgentOptions): Promise<AgentHandle> {
      const session = ctx.sessions.create(options.sessionId, {
        ...options.meta === undefined ? {} : { meta: options.meta },
      })
      let idle = Promise.resolve()
      const agent = {} as Agent
      const agentCtx = ownerCtx.extend({ agent })
      Object.assign(agent, {
        id: session.id,
        options: options.agentOptions ?? {},
        session,
        inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
        status: 'idle',
        ctx: agentCtx,
        cancel: () => {},
        runMaintenance: () => Promise.reject(new Error('not used')),
        send: () => {},
        followup: (message: UserMessage) => {
          agent.inbox.append('next-turn', message)
          idle = Promise.resolve().then(() => script.afterPrompt?.(session, message, agent))
        },
        steer: () => {},
        inject: () => {},
        whenIdle: () => idle,
      } satisfies Partial<Agent>)
      await options.setup?.(agentCtx)
      script.before?.(session, agent)
      ctx.agents.register(agent)
      return { agent, dispose: () => Promise.resolve() }
    },
    resume: () => Promise.reject(new Error('not used')),
  })
  return {
    ctx,
    run: async () => {
      const order: string[] = []
      ctx.on('session/flush', () => { order.push('flush') })
      const exited = new Promise<number>((resolve) => {
        ctx.provide('appExit', (code: number) => { order.push('exit'); resolve(code) })
      })
      apply(ctx)
      const code = await exited
      return { code, out: io.out, err: io.err, questions: io.questions, closed: io.closed, order }
    },
  }
}

describe('tui runner', () => {
  it('greets, runs one streamed turn, and flushes before exit on /exit', async () => {
    const test = await bench({
      afterPrompt(session, message) {
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Hello' } })
        session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: ', world' } })
        session.append('step/end', { turn: 1, step: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      },
    }, ['say hi', '/exit'])
    const result = await test.run()
    expect(result.code).toBe(0)
    expect(result.out).toContain('dsh tui — test-provider/test-model\n')
    expect(result.out).toContain('Hello, world\n')
    expect(result.questions).toEqual(['> ', '> '])
    expect(result.closed).toBe(true)
    expect(result.order).toEqual(['flush', 'exit'])
    await test.ctx.fiber.dispose()
  })

  it('renders tool calls and failing tool results between prompts', async () => {
    const test = await bench({
      afterPrompt(session, message) {
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'listing' } })
        session.append('tool/call', { turn: 1, step: 1, callId: CallId('c1'), name: 'bash', arguments: '{"command":"ls"}' })
        session.append('tool/result', {
          turn: 1,
          step: 1,
          message: createToolResultMessage({ callId: CallId('c1'), content: [{ type: 'text', text: 'denied' }], isError: true }),
          error: { name: 'ToolError', code: 'EACCES' },
        }, { surfaceOp: 'append' })
        session.append('step/end', { turn: 1, step: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      },
    }, ['ls please', '/quit'])
    const result = await test.run()
    expect(result.code).toBe(0)
    expect(result.out).toContain('listing\n● bash({"command":"ls"})\n  ✗ ToolError: denied\n')
    await test.ctx.fiber.dispose()
  })

  it('reports a terminal turn error on the diagnostic channel', async () => {
    const test = await bench({
      afterPrompt(session, message) {
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        session.append('step/end', { turn: 1, step: 1 })
        session.append('turn/end', {
          turn: 1,
          reason: { kind: 'error', error: { code: 'SERVER', message: 'provider unavailable' } },
        })
      },
    }, ['go', '/exit'])
    const result = await test.run()
    expect(result.code).toBe(0)
    expect(result.err).toBe('dsh: SERVER: provider unavailable\n')
    await test.ctx.fiber.dispose()
  })

  it('answers approval questions inline, y grants and anything else rejects', async () => {
    const ask = async (ctx: Context, agent: Agent): Promise<ApprovalOutcome> => {
      const req: ApprovalRequest = { agent, toolName: 'bash', reason: 'wants to write' }
      return ctx.waterfall('approval/request', req, () => Promise.resolve<ApprovalOutcome>('unavailable'))
    }
    const test = await bench({
      async afterPrompt(session, message, agent) {
        const granted = await ask(test.ctx, agent)
        const denied = await ask(test.ctx, agent)
        const delegated = await test.ctx.waterfall(
          'approval/request',
          { agent: {} as Agent, toolName: 'bash' } satisfies ApprovalRequest,
          () => Promise.resolve<ApprovalOutcome>('unavailable'),
        )
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        session.append('assistant/chunk', {
          turn: 1, step: 1,
          chunk: { type: 'text-delta', index: 0, text: `${granted}/${denied}/${delegated}` },
        })
        session.append('step/end', { turn: 1, step: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      },
    }, ['do it', 'y', 'n', '/exit'])
    const result = await test.run()
    expect(result.code).toBe(0)
    expect(result.out).toContain('allowed-once/rejected/unavailable\n')
    expect(result.questions).toEqual([
      '> ',
      'Allow bash — wants to write? [y/N] ',
      'Allow bash — wants to write? [y/N] ',
      '> ',
    ])
    await test.ctx.fiber.dispose()
  })

  it('treats an approval question without a reason as a bare tool question', async () => {
    const test = await bench({
      async afterPrompt(session, message, agent) {
        const outcome = await test.ctx.waterfall(
          'approval/request',
          { agent, toolName: 'bash' } satisfies ApprovalRequest,
          () => Promise.resolve<ApprovalOutcome>('unavailable'),
        )
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: outcome } })
        session.append('step/end', { turn: 1, step: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      },
    }, ['go', '', '/exit'])
    const result = await test.run()
    expect(result.out).toContain('rejected\n')
    expect(result.questions).toContain('Allow bash? [y/N] ')
    await test.ctx.fiber.dispose()
  })

  it('handles /help, unknown commands, and blank lines without touching the agent', async () => {
    const test = await bench({}, ['', '/help', '/bogus', '/exit'])
    const result = await test.run()
    expect(result.code).toBe(0)
    expect(result.out).toContain('/help   show this help')
    expect(result.out).toContain('dsh: unknown command /bogus — /help lists commands\n')
    expect(result.questions).toEqual(['> ', '> ', '> ', '> '])
    await test.ctx.fiber.dispose()
  })

  it('exits cleanly on immediate EOF', async () => {
    const test = await bench({}, [])
    const result = await test.run()
    expect(result.code).toBe(0)
    expect(result.closed).toBe(true)
    expect(result.order).toEqual(['flush', 'exit'])
    await test.ctx.fiber.dispose()
  })

  it('ignores events of sessions it does not own', async () => {
    const test = await bench({
      afterPrompt(session, message) {
        const other = test.ctx.sessions.create(SessionId('session-other'), {})
        other.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'noise' } })
        session.append('turn/start', { turn: 1 })
        session.append('step/start', { turn: 1, step: 1 })
        session.append('user/message', message, { surfaceOp: 'append' })
        session.append('step/end', { turn: 1, step: 1 })
        session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      },
    }, ['go', '/exit'])
    const result = await test.run()
    expect(result.out).not.toContain('noise')
    await test.ctx.fiber.dispose()
  })

  it('reports a direct Agent creation failure and exits 1', async () => {
    const ctx = new Context()
    let err = ''
    internals.errorOutput = { write: (chunk: string) => { err += chunk; return true } } as never
    const exited = new Promise<number>((resolve) => {
      ctx.provide('appExit', resolve)
    })
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) } as never)
    ctx.provide('sessions', {} as never)
    ctx.provide('agents', { create: () => Promise.reject(new Error('factory exploded')) } as never)
    apply(ctx)
    expect(await exited).toBe(1)
    expect(err).toBe('dsh: factory exploded\n')
    await ctx.fiber.dispose()
  })

  it('stringifies a non-Error Agent creation failure', async () => {
    const ctx = new Context()
    let err = ''
    internals.errorOutput = { write: (chunk: string) => { err += chunk; return true } } as never
    const exited = new Promise<number>((resolve) => {
      ctx.provide('appExit', resolve)
    })
    ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) } as never)
    ctx.provide('sessions', {} as never)
    const rejected = {
      then(_resolve: (value: never) => void, reject: (reason: unknown) => void): void {
        reject('factory exploded')
      },
    }
    ctx.provide('agents', { create: () => rejected } as never)
    apply(ctx)
    expect(await exited).toBe(1)
    expect(err).toBe('dsh: factory exploded\n')
    await ctx.fiber.dispose()
  })

  it('abandons the run when the tree is disposed during Loader settlement', async () => {
    const ctx = new Context()
    let exited = false
    internals.createIo = () => scriptedIo([])
    ctx.provide('appExit', () => { exited = true })
    const services = ctx.plugin((child: Context) => {
      child.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'p', model: 'm' }) } as never)
      child.provide('sessions', {} as never)
      child.provide('agents', {} as never)
    })
    await services
    let release: () => void
    const settlement = new Promise<void>((resolve) => { release = resolve })
    ctx.provide('loader', { await: () => settlement } as never)
    apply(ctx)
    await services.dispose()
    release!()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(exited).toBe(false)
    await ctx.fiber.dispose()
  })

  it('fails loud without the launcher-provided exit request', () => {
    const ctx = new Context()
    expect(() => { apply(ctx) }).toThrow('must provide ctx.appExit')
  })
})

describe('createTerminalIo', () => {
  function fakeStdio(): { input: PassThrough; output: PassThrough; errorOutput: PassThrough } {
    const input = new PassThrough()
    const output = new PassThrough()
    const errorOutput = new PassThrough()
    internals.input = input
    internals.output = output
    internals.errorOutput = errorOutput
    return { input, output, errorOutput }
  }

  it('asks questions, writes both channels, and short-circuits after close', async () => {
    const { input, output, errorOutput } = fakeStdio()
    // Exercise the default internals.createIo factory, not the bare constructor.
    const io = internals.createIo()
    const asked = io.prompt('q? ')
    input.write('answer\n')
    await expect(asked).resolves.toBe('answer')
    io.write('x')
    io.error('y')
    const transcript = (output.read() as Buffer | null)?.toString() ?? ''
    expect(transcript).toContain('q? ')
    expect(transcript).toContain('x')
    expect((errorOutput.read() as Buffer | null)?.toString()).toContain('y')
    io.close()
    await expect(io.prompt('again')).resolves.toBeUndefined()
  })

  it('settles a pending question with undefined on EOF', async () => {
    const { input } = fakeStdio()
    const io = createTerminalIo()
    const asked = io.prompt('q? ')
    input.push(null)
    await expect(asked).resolves.toBeUndefined()
  })
})
