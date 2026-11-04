// The assistant's turn as the server streams it (POST /api/agent/turn): server-sent events, one AgentEvent per `data:`
// line. Shared with FreeFlow Mail's assistant panel (packages/mail), which talks to the same API.
import type { AgentEvent } from '../../../shared/agent/protocol.ts';

/** Whether an event ends the turn's stream: the server always sends one of these last. */
export const endsTurn = (e: AgentEvent) => e.type === 'done' || e.type === 'client_tools' || e.type === 'error';

/** The events in a chunk of the stream, and what is left over (an event not complete yet). */
export function parseAgentEvents(buf: string): { events: AgentEvent[]; rest: string } {
  const events: AgentEvent[] = [];
  let end;
  while ((end = buf.indexOf('\n\n')) >= 0) {
    const chunk = buf.slice(0, end);
    buf = buf.slice(end + 2);
    for (const line of chunk.split('\n')) if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)) as AgentEvent);
  }
  return { events, rest: buf };
}

/**
 * Reads a turn's stream to its end, handing each event to `onEvent`. False when it stopped without a last event: it was
 * cut off (for example by the server restarting).
 */
export async function readAgentEvents(body: ReadableStream<BufferSource>, onEvent: (e: AgentEvent) => void): Promise<boolean> {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = '';
  let ended = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const { events, rest } = parseAgentEvents(buf + value);
    buf = rest;
    for (const event of events) {
      if (endsTurn(event)) ended = true;
      onEvent(event);
    }
  }
  return ended;
}
