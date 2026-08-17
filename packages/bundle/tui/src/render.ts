/**
 * Pure transcript rendering for the TUI: folds live session events into
 * printable chunks, tracking whether an assistant text stream is open so
 * tool lines and error lines start on their own line and every stream ends
 * with a newline. Kept free of io so the folding is unit-testable.
 * @module @deepseek-ai/dsh-tui/render
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * Collapse one raw tool-call `arguments` JSON string to a single-line
 * preview capped at `max` characters.
 * @param raw - the raw arguments string exactly as logged on `tool/call`.
 * @param max - preview length cap.
 * @returns the one-line preview, ellipsis-terminated when truncated.
 */
export function previewArguments(raw: string, max = 80): string {
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`
}

/** Join the text blocks inside a `tool/result` payload's single result block. */
function resultText(event: SessionEvent<'tool/result'>): string {
  let text = ''
  for (const inner of event.data.message.content[0].content) {
    if (inner.type === 'text') text += inner.text
  }
  return text
}

/**
 * Incremental session-event → terminal-text folder. One instance tracks one
 * session's open-stream state; create it when the agent is created.
 */
export class TranscriptRenderer {
  /** Whether an assistant text stream is open (a closing newline is owed). */
  private streaming = false

  /**
   * Fold one live session event into the text to print, or `''` when the
   * event carries nothing user-visible. The session event union is
   * merge-extensible, so unknown types fall through the default silently.
   * @param event - the durable event just appended to the session log.
   * @returns the printable chunk, possibly empty.
   */
  render(event: SessionEvent): string {
    switch (event.type) {
      case 'assistant/chunk': {
        const { chunk } = event.data
        if (chunk.type !== 'text-delta') return ''
        this.streaming = true
        return chunk.text
      }
      case 'tool/call': {
        return `${this.closeStream()}● ${event.data.name}(${previewArguments(event.data.arguments)})\n`
      }
      case 'tool/result': {
        if (event.data.error === undefined) return ''
        const text = resultText(event)
        return `${this.closeStream()}  ✗ ${event.data.error.name}: ${text !== '' ? text : event.data.error.code}\n`
      }
      case 'step/end':
      case 'turn/end': {
        return this.closeStream()
      }
      default:
        return ''
    }
  }

  /** Close an open assistant text stream with its owed newline, or print nothing. */
  private closeStream(): string {
    if (!this.streaming) return ''
    this.streaming = false
    return '\n'
  }
}
