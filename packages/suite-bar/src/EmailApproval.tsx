// An email an agent wrote and asked to send (decision_log 2026-11-17, "Email needs the person's click"): the card shows
// it as it will go out, and only Send message sends it (POST /api/agent/mail-approvals/:id/send, a session alone may).
// The same card is the send_email tool's row in the assistant panels, the panels' list of waiting emails, and the page
// the agent's note in Chat links to (Home, `?email-approval=`).
import { useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { MailApprovalDTO } from '@flow/shared';
import './email-approval.css';

const withOrg = (path: string, org: string | null) => (org ? `${path}${path.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(org)}` : path);

async function call(path: string, org: string | null, method = 'GET'): Promise<{ approval?: MailApprovalDTO; approvals?: MailApprovalDTO[]; error?: string }> {
  const res = await fetch(withOrg(path, org), { method, credentials: 'same-origin', headers: { accept: 'application/json' } });
  const body = (await res.json().catch(() => ({}))) as { approval?: MailApprovalDTO; approvals?: MailApprovalDTO[]; error?: string };
  if (!res.ok && !body.error) body.error = `Something went wrong (${res.status}).`;
  return body;
}

/** Told to every card and list on the page when the person sends or discards an email, so each copy shows its new state. */
const DECIDED = 'flow:mail-approval';

/** One email and the person's two choices, read from the server so every place shows its current state. */
export function useMailApproval(id: string, organizationId: string | null, initial?: MailApprovalDTO | null) {
  const [approval, setApproval] = useState<MailApprovalDTO | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void call(`/api/agent/mail-approvals/${encodeURIComponent(id)}`, organizationId).then((r) => {
      if (!live) return;
      if (r.approval) setApproval(r.approval);
      else if (r.error) setError(r.error);
    });
    const onDecided = (e: Event) => {
      const a = (e as CustomEvent<MailApprovalDTO>).detail;
      if (live && a?.id === id) setApproval(a);
    };
    window.addEventListener(DECIDED, onDecided);
    return () => { live = false; window.removeEventListener(DECIDED, onDecided); };
  }, [id, organizationId]);
  const act = useCallback(async (action: 'send' | 'discard') => {
    setBusy(true);
    setError(null);
    try {
      const r = await call(`/api/agent/mail-approvals/${encodeURIComponent(id)}/${action}`, organizationId, 'POST');
      if (r.approval) {
        setApproval(r.approval);
        window.dispatchEvent(new CustomEvent(DECIDED, { detail: r.approval }));
      }
      if (r.error) setError(r.error);
    } finally {
      setBusy(false);
    }
  }, [id, organizationId]);
  return { approval, error, busy, send: () => act('send'), discard: () => act('discard') };
}

/**
 * Whether a click on Send message or Discard came from the person: a script's click (an agent driving this browser
 * through the FreeFlow Browser extension, whose clicks are `element.click()`) is not trusted, so it decides nothing.
 * Tests replace it.
 */
export const clickPolicy = { trusted: (e: { nativeEvent: Event }) => e.nativeEvent.isTrusted };

const STATE_LINE: Record<Exclude<MailApprovalDTO['state'], 'waiting'>, string> = { sent: 'Sent', discarded: 'Discarded', failed: 'Not sent' };

/** The email as it will go out, with Send message and Discard while it waits. */
export function EmailApprovalCard({ id, organizationId, initial, onDecided }: { id: string; organizationId: string | null; initial?: MailApprovalDTO | null; onDecided?: (a: MailApprovalDTO) => void }) {
  const { approval: a, error: failed, busy, send, discard } = useMailApproval(id, organizationId, initial);
  const [refused, setRefused] = useState<string | null>(null);
  const error = refused ?? failed;
  const byPerson = (e: { nativeEvent: Event }, act: () => Promise<void>) => {
    if (!clickPolicy.trusted(e)) return setRefused('Only a click of your own sends or discards this email.');
    setRefused(null);
    void act();
  };
  useEffect(() => {
    if (a && a.state !== 'waiting') onDecided?.(a);
  }, [a, onDecided]);
  if (!a) return <div className="email-approval" data-testid="email-approval">{error ?? 'Loading the email…'}</div>;
  const row = (label: string, list: string[]) => (list.length ? <div className="email-approval-row"><span>{label}</span>{list.join(', ')}</div> : null);
  return (
    <div className={`email-approval ${a.state}`} data-testid="email-approval">
      <div className="email-approval-head">
        <span aria-hidden="true">✉️</span>
        {a.state === 'waiting' ? `${a.agentName} wants to send this email` : `${STATE_LINE[a.state]}: email from ${a.agentName}`}
      </div>
      <div className="email-approval-row"><span>From</span>{a.from}{a.fromAgent ? ` (${a.agentName}’s own address)` : ''}</div>
      {row('To', a.to)}
      {row('Cc', a.cc)}
      {row('Bcc', a.bcc)}
      <div className="email-approval-row"><span>Subject</span>{a.subject || '(no subject)'}</div>
      <div className="email-approval-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{a.body}</ReactMarkdown></div>
      {a.quotes && <div className="email-approval-note">The {a.quotes === 'reply' ? 'message it answers' : 'forwarded message'} is quoted below it.</div>}
      {(error || a.error) && <div className="email-approval-error" role="alert">{error ?? a.error}</div>}
      {a.state === 'waiting' ? (
        <div className="email-approval-actions">
          <button type="button" className="email-approval-discard" disabled={busy} onClick={(e) => byPerson(e, discard)} data-testid="email-approval-discard">Discard</button>
          <button type="button" className="email-approval-send" disabled={busy} onClick={(e) => byPerson(e, send)} data-testid="email-approval-send">{busy ? 'Sending…' : 'Send message'}</button>
        </div>
      ) : (
        <div className="email-approval-done" data-testid="email-approval-state">{STATE_LINE[a.state]}{a.decidedAt ? ` · ${new Date(a.decidedAt).toLocaleString()}` : ''}</div>
      )}
    </div>
  );
}

/** The send_email tool's row in a chat: the card of the email its result names, once the tool has answered. */
export function emailApprovalOf(name: string, result: unknown): string | null {
  if (name !== 'send_email' || result == null) return null;
  try {
    const r = (typeof result === 'string' ? JSON.parse(result) : result) as { waiting_for_approval?: unknown; id?: unknown };
    return r.waiting_for_approval === true && typeof r.id === 'string' ? r.id : null;
  } catch {
    return null;
  }
}

/** The emails waiting for the person, at the top of a panel; read again when the window comes back into view. */
export function WaitingEmails({ organizationId, refreshKey, hide = [] }: { organizationId: string | null; refreshKey?: unknown; /** Emails the chat below already shows. */ hide?: string[] }) {
  const [list, setList] = useState<MailApprovalDTO[]>([]);
  const load = useCallback(() => {
    void call('/api/agent/mail-approvals', organizationId).then((r) => setList(r.approvals ?? []));
  }, [organizationId]);
  useEffect(() => {
    load();
    window.addEventListener('focus', load);
    window.addEventListener(DECIDED, load);
    return () => { window.removeEventListener('focus', load); window.removeEventListener(DECIDED, load); };
  }, [load, refreshKey]);
  const shown = list.filter((a) => !hide.includes(a.id));
  if (!shown.length) return null;
  return (
    <div className="email-approval-waiting" data-testid="email-approval-waiting">
      <div className="email-approval-waiting-title">Waiting for your approval ({shown.length})</div>
      {shown.map((a) => <EmailApprovalCard key={a.id} id={a.id} organizationId={organizationId} initial={a} />)}
    </div>
  );
}

/** Home's page for the link in the agent's note (`?email-approval=<id>&workspace=<org>`): the card over the page. */
export function EmailApprovalOverlay() {
  const params = new URLSearchParams(window.location.search);
  const [id, setId] = useState(params.get('email-approval'));
  const org = params.get('workspace');
  if (!id) return null;
  const close = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('email-approval');
    window.history.replaceState(null, '', url.toString());
    setId(null);
  };
  return (
    <div className="email-approval-overlay" role="dialog" aria-label="Email waiting for your approval" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div className="email-approval-sheet">
        <EmailApprovalCard id={id} organizationId={org} />
        <button type="button" className="email-approval-close" onClick={close}>Close</button>
      </div>
    </div>
  );
}
