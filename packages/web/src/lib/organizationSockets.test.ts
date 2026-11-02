import { describe, expect, it, vi } from 'vitest';
import type { Event } from '@flow/shared';
import { OrganizationSockets } from './organizationSockets';
import type { SocketHandlers } from './ws';

function setup(ids: string[]) {
  const made = new Map<string, { handlers: SocketHandlers; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; sendTyping: ReturnType<typeof vi.fn> }>();
  const handlers = { onStatus: vi.fn(), onEvent: vi.fn() };
  const sockets = new OrganizationSockets(handlers as never, async () => ids, (id, h) => {
    const s = { handlers: h, start: vi.fn(), stop: vi.fn(), sendTyping: vi.fn() };
    made.set(id, s);
    return s as never;
  });
  return { sockets, made, handlers };
}
const flush = () => new Promise((r) => setTimeout(r));

describe('OrganizationSockets', () => {
  it('opens one socket per organization', async () => {
    const { sockets, made } = setup(['a', 'b']);
    sockets.start();
    await flush();
    expect([...made.keys()]).toEqual(['a', 'b']);
    expect(made.get('a')!.start).toHaveBeenCalled();
  });

  it('says connected once, when every organization is', async () => {
    const { sockets, made, handlers } = setup(['a', 'b']);
    sockets.start();
    await flush();
    made.get('a')!.handlers.onStatus('connected');
    made.get('b')!.handlers.onStatus('connecting');
    expect(handlers.onStatus).not.toHaveBeenCalledWith('connected');
    made.get('b')!.handlers.onStatus('connected');
    made.get('a')!.handlers.onStatus('connected');
    expect(handlers.onStatus.mock.calls.filter((c) => c[0] === 'connected')).toHaveLength(1);
  });

  it('passes every organization\'s events on, and sends typing to each', async () => {
    const { sockets, made, handlers } = setup(['a', 'b']);
    sockets.start();
    await flush();
    const event = { type: 'message.created' } as Event;
    made.get('b')!.handlers.onEvent(event);
    expect(handlers.onEvent).toHaveBeenCalledWith(event);
    sockets.sendTyping('c1');
    expect(made.get('a')!.sendTyping).toHaveBeenCalledWith('c1', undefined);
    expect(made.get('b')!.sendTyping).toHaveBeenCalledWith('c1', undefined);
  });

  it('stops them all', async () => {
    const { sockets, made } = setup(['a']);
    sockets.start();
    await flush();
    sockets.stop();
    expect(made.get('a')!.stop).toHaveBeenCalled();
  });

  it('follows a join to a new organization', async () => {
    const ids = ['a'];
    const { sockets, made } = setup(ids);
    sockets.start();
    await flush();
    ids.push('b');
    made.get('a')!.handlers.onEvent({ type: 'workspace.joined' } as Event);
    await flush();
    expect(made.has('b')).toBe(true);
  });
});
