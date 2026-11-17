// An email an agent wrote waits for the person's click (EmailApproval.tsx): the card shows it as it will go out, Send
// message sends it once, Discard drops it, and the send_email tool's result is what turns a chat row into the card.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MailApprovalDTO } from '@flow/shared';
import { EmailApprovalCard, clickPolicy, emailApprovalOf } from './EmailApproval';

const WAITING: MailApprovalDTO = {
  id: 'ap-1', state: 'waiting', agentName: 'Ada', from: 'ann@gmail.test', fromAgent: false, to: ['Zoe <zoe@outside.example>'], cc: [], bcc: [],
  subject: 'Lunch', body: 'Shall we meet **Friday**?', quotes: null, createdAt: '2026-11-17T10:00:00Z', decidedAt: null, error: null,
};
let calls: string[];
const realPolicy = clickPolicy.trusted;
beforeEach(() => {
  calls = [];
  // fireEvent's clicks are a script's (isTrusted false), as an agent's would be: the tests stand in for a person's.
  clickPolicy.trusted = () => true;
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path.includes('/send')) return json({ approval: { ...WAITING, state: 'sent', decidedAt: '2026-11-17T10:01:00Z' } });
    if (path.includes('/discard')) return json({ approval: { ...WAITING, state: 'discarded', decidedAt: '2026-11-17T10:01:00Z' } });
    return json({ approval: WAITING });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); clickPolicy.trusted = realPolicy; });

describe('the email approval card', () => {
  it('shows the email as it will go out and sends it on Send message, in the organization given', async () => {
    render(<EmailApprovalCard id="ap-1" organizationId="org-1" />);
    await screen.findByText('Ada wants to send this email');
    expect(screen.getByText('Zoe <zoe@outside.example>')).toBeTruthy();
    expect(screen.getByText('Friday').tagName).toBe('STRONG');
    fireEvent.click(screen.getByTestId('email-approval-send'));
    await waitFor(() => expect(screen.getByTestId('email-approval-state').textContent).toMatch(/^Sent/));
    expect(calls).toContain('POST /api/agent/mail-approvals/ap-1/send?workspace=org-1');
    expect(screen.queryByTestId('email-approval-send')).toBeNull();
  });

  it('discards it without sending', async () => {
    render(<EmailApprovalCard id="ap-1" organizationId="org-1" />);
    fireEvent.click(await screen.findByTestId('email-approval-discard'));
    await waitFor(() => expect(screen.getByTestId('email-approval-state').textContent).toMatch(/^Discarded/));
    expect(calls.some((c) => c.includes('/send'))).toBe(false);
  });

  it('ignores a script’s click, as an agent driving the browser would make', async () => {
    clickPolicy.trusted = realPolicy;
    render(<EmailApprovalCard id="ap-1" organizationId="org-1" />);
    fireEvent.click(await screen.findByTestId('email-approval-send'));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(calls.some((c) => c.includes('/send'))).toBe(false);
  });

  it('is the send_email row once the tool answered that the email waits', () => {
    expect(emailApprovalOf('send_email', JSON.stringify({ waiting_for_approval: true, id: 'ap-1' }))).toBe('ap-1');
    expect(emailApprovalOf('send_email', 'Sending email is not available here.')).toBeNull();
    expect(emailApprovalOf('create_mail_draft', JSON.stringify({ waiting_for_approval: true, id: 'ap-1' }))).toBeNull();
  });
});
