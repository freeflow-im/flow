// The server's alerts in the suite bar (shared/alerts.ts): read when the page loads, pushed over the alerts-only socket
// as they happen, closed on the server (so every tab closes them), and gone on their own once they end.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlertDTO } from '@flow/shared';
import { SuiteBar } from './SuiteBar';
import { applyAlertFrame, toSuiteAlert } from './serverAlerts';

const T0 = Date.parse('2026-11-22T18:00:00Z');
const min = 60_000;
const alert = (over: Partial<AlertDTO> = {}): AlertDTO => ({
  alertId: 'a1', kind: 'Reminder', title: 'Call Dana back', lines: ['She asked about the contract'], actions: [{ label: 'Open', href: '/docs/x', primary: true }],
  endsAt: new Date(T0 + 30 * min).toISOString(), from: 'Helper', ...over,
});

/** A WebSocket the test drives: it records what the page sends, and the test plays the server. */
class FakeSocket {
  static all: FakeSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((m: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(public url: string) { FakeSocket.all.push(this); }
  send(text: string) { this.sent.push(text); }
  close() { this.readyState = 3; }
  open() { this.readyState = 1; this.onopen?.(); }
  serve(frame: unknown) { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

const account = { name: 'Cal', email: 'cal@x.test', onProfile() {}, onSettings() {}, onLogout() {} };
const organization = { name: 'Acme', entries: [{ id: 'org1', name: 'Acme', unread: 0, active: true }], onSelect() {}, onAdd() {} };

let asked: { url: string; method: string }[];
let served: AlertDTO[];

beforeEach(() => {
  localStorage.clear();
  FakeSocket.all = [];
  asked = [];
  served = [];
  vi.useFakeTimers({ now: T0, toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    asked.push({ url, method: init?.method ?? 'GET' });
    return new Response(JSON.stringify(url.startsWith('/v1/alerts?') ? { alerts: served } : {}), { status: 200 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(10); });

describe('the server’s alerts', () => {
  it('are read when the page loads, from the organization the bar shows', async () => {
    served = [alert()];
    render(<SuiteBar tabs={[]} organization={organization} account={account} meetingAlerts={false} />);
    await settle();
    expect(asked.some((a) => a.url === '/v1/alerts?workspace=org1')).toBe(true);
    const card = screen.getByTestId('suite-alert');
    expect(card.textContent).toContain('Call Dana back');
    expect(card.textContent).toContain('From Helper');
    expect(screen.getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/docs/x');
  });

  it('arrive over the socket as they happen, and leave when closed elsewhere', async () => {
    render(<SuiteBar tabs={[]} organization={organization} account={account} meetingAlerts={false} />);
    await settle();
    const ws = FakeSocket.all[0]!;
    expect(ws.url).toBe('ws://localhost:3000/v1/ws?workspace=org1');
    act(() => ws.open());
    expect(JSON.parse(ws.sent[0]!)).toEqual({ op: 'auth', alerts: true });
    act(() => ws.serve({ op: 'hello', sessionId: 's1', heartbeat: 'client' }));
    act(() => ws.serve({ op: 'alert', type: 'alert.created', seq: 9, data: alert({ alertId: 'a2', title: 'Report ready' }) }));
    expect(screen.getByTestId('suite-alert').textContent).toContain('Report ready');
    act(() => ws.serve({ op: 'alert', type: 'alert.closed', seq: 10, data: { alertId: 'a2' } }));
    expect(screen.queryByTestId('suite-alert')).toBeNull();
    // It pings, as the server asks.
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(ws.sent).toContain('{"op":"ping"}');
  });

  it('close on the server when the person closes one', async () => {
    served = [alert()];
    render(<SuiteBar tabs={[]} organization={organization} account={account} meetingAlerts={false} />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Close alert' }));
    expect(screen.queryByTestId('suite-alert')).toBeNull();
    expect(asked).toContainEqual({ url: '/v1/alerts/a1/close?workspace=org1', method: 'POST' });
  });

  it('end on their own, and the socket comes back after a drop but not after a refusal', async () => {
    served = [alert({ endsAt: new Date(T0 + 1 * min).toISOString() })];
    render(<SuiteBar tabs={[]} organization={organization} account={account} meetingAlerts={false} />);
    await settle();
    expect(screen.getByTestId('suite-alert')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(min + 15_000); });
    expect(screen.queryByTestId('suite-alert')).toBeNull();

    act(() => FakeSocket.all[0]!.onclose?.({ code: 1006 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(FakeSocket.all).toHaveLength(2);
    act(() => FakeSocket.all[1]!.onclose?.({ code: 4003 }));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(FakeSocket.all).toHaveLength(2);
  });
});

describe('a pushed frame', () => {
  it('adds, replaces and removes by id', () => {
    const one = alert();
    expect(applyAlertFrame([], { type: 'alert.created', data: one })).toEqual([one]);
    const again = alert({ title: 'Changed' });
    expect(applyAlertFrame([one], { type: 'alert.created', data: again })).toEqual([again]);
    expect(applyAlertFrame([one], { type: 'alert.closed', data: { alertId: 'a1' } })).toEqual([]);
    expect(toSuiteAlert(alert({ from: undefined })).lines).toEqual(['She asked about the contract']);
  });
});
