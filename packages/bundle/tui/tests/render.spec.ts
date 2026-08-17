/** Pure transcript folding: stream open/close, tool lines, and error lines. */

import { describe, expect, it } from 'vitest'
import { CallId, createToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionEventMap, SessionEventType } from '@deepseek-ai/dsh-session'
import { TranscriptRenderer, previewArguments } from '../src/render.ts'

function ev<K extends SessionEventType>(type: K, data: SessionEventMap[K]): SessionEvent<K> {
  return { type, seq: 1, time: 0, data } as SessionEvent<K>
}

function chunk(text: string): SessionEvent<'assistant/chunk'> {
  return ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } })
}

function toolCall(name: string, args: string): SessionEvent<'tool/call'> {
  return ev('tool/call', { turn: 1, step: 1, callId: CallId('c1'), name, arguments: args })
}

function toolResult(text: string, error?: { name: string; code: string }): SessionEvent<'tool/result'> {
  return ev('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: CallId('c1'),
      content: text === '' ? [] : [{ type: 'text', text }],
      isError: error !== undefined,
    }),
    ...error === undefined ? {} : { error },
  })
}

describe('previewArguments', () => {
  it('collapses whitespace to one line', () => {
    expect(previewArguments('{\n  "command": "ls -la"\n}')).toBe('{ "command": "ls -la" }')
  })

  it('truncates beyond the cap with an ellipsis', () => {
    const long = `{"command":"${'x'.repeat(100)}"}`
    const preview = previewArguments(long)
    expect(preview).toHaveLength(80)
    expect(preview.endsWith('…')).toBe(true)
  })
})

describe('TranscriptRenderer', () => {
  it('streams text deltas verbatim', () => {
    const renderer = new TranscriptRenderer()
    expect(renderer.render(chunk('Hello, '))).toBe('Hello, ')
    expect(renderer.render(chunk('world'))).toBe('world')
    expect(renderer.render(ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))).toBe('\n')
  })

  it('stays silent on non-text chunks', () => {
    const renderer = new TranscriptRenderer()
    expect(renderer.render(ev('assistant/chunk', {
      turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' },
    }))).toBe('')
    expect(renderer.render(ev('assistant/chunk', {
      turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'hmm' },
    }))).toBe('')
    // No stream was opened, so the boundary owes no newline.
    expect(renderer.render(ev('step/end', { turn: 1, step: 1 }))).toBe('')
  })

  it('opens a tool line on its own line after streamed text', () => {
    const renderer = new TranscriptRenderer()
    expect(renderer.render(chunk('checking'))).toBe('checking')
    expect(renderer.render(toolCall('bash', '{"command":"ls"}'))).toBe('\n● bash({"command":"ls"})\n')
    // The stream is closed: a following tool line gets no extra leading newline.
    expect(renderer.render(toolCall('bash', '{"command":"pwd"}'))).toBe('● bash({"command":"pwd"})\n')
  })

  it('prints only failing tool results', () => {
    const renderer = new TranscriptRenderer()
    expect(renderer.render(toolResult('ok'))).toBe('')
    expect(renderer.render(toolResult('permission denied', { name: 'ToolError', code: 'EACCES' })))
      .toBe('  ✗ ToolError: permission denied\n')
  })

  it('falls back to the error code when a failing result has no text', () => {
    const renderer = new TranscriptRenderer()
    expect(renderer.render(ev('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CallId('c1'),
        content: [{ type: 'reasoning', text: 'not visible text' }],
        isError: true,
      }),
      error: { name: 'ToolError', code: 'TIMEOUT' },
    }))).toBe('  ✗ ToolError: TIMEOUT\n')
  })

  it('closes an open stream at a step boundary', () => {
    const renderer = new TranscriptRenderer()
    expect(renderer.render(chunk('partial'))).toBe('partial')
    expect(renderer.render(ev('step/end', { turn: 1, step: 1 }))).toBe('\n')
    expect(renderer.render(ev('turn/end', { turn: 1, reason: { kind: 'completed' } }))).toBe('')
  })

  it('stays silent on events with no terminal rendering', () => {
    const renderer = new TranscriptRenderer()
    expect(renderer.render(ev('turn/start', { turn: 1 }))).toBe('')
    expect(renderer.render(ev('step/start', { turn: 1, step: 1 }))).toBe('')
    expect(renderer.render(ev('todo/write', { todos: [] }))).toBe('')
  })
})
