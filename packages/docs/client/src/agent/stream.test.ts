import { describe, expect, it } from 'vitest';
import { parseAgentEvents, readAgentEvents } from './stream.ts';
import type { AgentEvent } from '../../../shared/agent/protocol.ts';

const body = (...chunks: string[]) =>
  new ReadableStream<BufferSource>({
    start(c) {
      for (const s of chunks) c.enqueue(new TextEncoder().encode(s));
      c.close();
    },
  });

describe('the assistant’s turn stream', () => {
  it('parses whole events and keeps a partial one for the next chunk', () => {
    expect(parseAgentEvents('data: {"type":"text","text":"a"}\n\ndata: {"type":"do')).toEqual({ events: [{ type: 'text', text: 'a' }], rest: 'data: {"type":"do' });
  });

  it('reads events split across chunks, and knows a turn that ended from one cut off', async () => {
    const seen: AgentEvent[] = [];
    expect(await readAgentEvents(body('data: {"type":"tool_end","id":"1","ok":true,"res', 'ult":"{}"}\n\ndata: {"type":"done"}\n\n'), (e) => seen.push(e))).toBe(true);
    expect(seen).toEqual([{ type: 'tool_end', id: '1', ok: true, result: '{}' }, { type: 'done' }]);
    expect(await readAgentEvents(body('data: {"type":"text","text":"Hal"}\n\n'), () => {})).toBe(false);
  });
});
