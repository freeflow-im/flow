// Step 1, the workspace (docs/specs/onboarding.md §1): its name and its address. The free address is
// `<slug>.freeflow.im`; a domain of one's own is recorded now and set up in Admin › Domains when setup ends. As the
// 2026-11-15 ruling has it, agents get mailboxes at the workspace's address; a person links their own mail, or gets an
// address once an own domain has mail.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PLATFORM_DOMAIN, SLUG_RE } from '@flow/shared';
import { suite } from '../suite';
import { setupApi } from './api';
import { cleanDomain, slugify } from './lib';
import { ErrorText, input, lead, Mark, PrimaryButton, SideCard, StepHeading } from './ui';

export function WorkspaceStep({ stepOf, onCreated }: { stepOf: string; onCreated: (organizationId: string, ownDomain: string | null) => void }) {
  const me = useQuery({ queryKey: ['suite', 'me'], queryFn: suite.me });
  const [name, setName] = useState('');
  const [slugTyped, setSlugTyped] = useState<string | null>(null);
  const [own, setOwn] = useState(false);
  const [domainText, setDomainText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const slug = slugTyped ?? slugify(name);
  const domain = own ? cleanDomain(domainText) : null;
  const platform = `${slug || 'your-team'}.${PLATFORM_DOMAIN}`;
  const ready = name.trim().length > 0 && SLUG_RE.test(slug) && (!own || !!domain);
  const firstName = (me.data?.displayName ?? '').split(' ')[0] || 'You';

  const create = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const ws = await setupApi.createWorkspace(name.trim(), slug);
      // The domain is only added here; its records and mail are set up in Admin › Domains after setup.
      if (domain) await setupApi.addDomain(ws.id, domain).catch(() => undefined);
      onCreated(ws.id, domain);
    } catch (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <>
      <form
        className="flex min-w-0 flex-[999_1_520px] flex-col gap-7"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <StepHeading stepOf={stepOf} title="Set up your workspace">
          <p className={lead}>A workspace is where your team works: people and AI agents together. Every agent in it gets its own email address and calendar.</p>
        </StepHeading>

        <div className="flex max-w-[560px] flex-col gap-2">
          <label htmlFor="ws-name" className="text-sm font-semibold">Workspace name</label>
          <input id="ws-name" className={input} value={name} autoFocus maxLength={80} placeholder="Your team or company" onChange={(e) => setName(e.target.value)} data-testid="setup-workspace-name" />
        </div>

        <fieldset className="m-0 flex max-w-[560px] flex-col gap-2.5 border-0 p-0">
          <legend className="mb-2.5 p-0 text-sm font-semibold">Workspace address</legend>
          <Choice checked={!own} onChange={() => setOwn(false)} title="Use a free FreeFlow address" testid="setup-address-free">
            <span className="break-all">{platform}</span> — ready right away
          </Choice>
          {!own && (
            <div className="flex flex-col gap-1.5 pl-1">
              <label htmlFor="ws-slug" className="text-xs text-muted">Address name (it cannot change later)</label>
              <input id="ws-slug" className={`${input} h-10 max-w-[320px] text-sm`} value={slug} maxLength={40} onChange={(e) => setSlugTyped(e.target.value.toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40))} data-testid="setup-workspace-slug" />
            </div>
          )}
          <Choice checked={own} onChange={() => setOwn(true)} title="Use a domain you own" testid="setup-address-own">
            Like yourcompany.com. You add its DNS records after setup.
          </Choice>
          {own && (
            <div className="flex flex-col gap-1.5 pl-1">
              <label htmlFor="ws-domain" className="text-xs text-muted">Your domain</label>
              <input id="ws-domain" className={`${input} h-10 max-w-[320px] text-sm`} value={domainText} placeholder="yourcompany.com" onChange={(e) => setDomainText(e.target.value)} data-testid="setup-workspace-domain" />
            </div>
          )}
        </fieldset>

        <div className="flex max-w-[560px] items-start gap-3.5 rounded-xl bg-selected-blue p-4">
          <svg aria-hidden="true" className="mt-0.5 flex-none" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#1558b0" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>
          <p className="m-0 text-sm leading-relaxed text-ink-soft">
            {own && domain ? (
              <>Agents get addresses at <b>{domain}</b> once its mail is on, and so do people. Until then agents use <b>{platform}</b>.</>
            ) : (
              <>Your agents get addresses here, like <b>ada@{platform}</b>, each with a mailbox and calendar. You keep your own email: link Gmail or iCloud in Mail, or add a domain you own to get an address on it.</>
            )}
          </p>
        </div>

        <ErrorText error={error} />
        <div className="flex flex-wrap items-center gap-5">
          <PrimaryButton type="submit" disabled={!ready || busy} testid="setup-workspace-continue">{busy ? 'Creating…' : 'Continue'}</PrimaryButton>
        </div>
      </form>

      <SideCard label="Your team so far">
        <div className="flex items-baseline justify-between">
          <h2 className="m-0 text-lg font-semibold">{name.trim() || 'Your workspace'}</h2>
          <span className="text-xs text-muted">1 member</span>
        </div>
        <div className="flex items-center gap-3 rounded-xl bg-panel p-3">
          <Mark name={me.data?.displayName ?? 'You'} src={me.data?.avatarUrl ?? null} />
          <div className="flex min-w-0 flex-col">
            <span className="font-semibold">{firstName} <span className="font-normal text-muted">(you)</span></span>
            <span className="truncate text-xs text-muted">{me.data?.email}</span>
          </div>
          <span className="ml-auto rounded-md bg-track px-2 py-1 text-xs font-semibold text-ink-soft">Person</span>
        </div>
        <Placeholder agent tone="#a78bfa">Your Chief of Staff — next step</Placeholder>
        <Placeholder agent tone="#f59e0b">Omni, the team’s shared agent — step 3</Placeholder>
        <Placeholder tone="#9aa0a6">Teammates and agents — step 4</Placeholder>
        <p className="m-0 text-xs leading-relaxed text-muted">People and agents are listed together. Round pictures are people; rounded squares are agents.</p>
      </SideCard>
    </>
  );
}

function Choice({ checked, onChange, title, children, testid }: { checked: boolean; onChange: () => void; title: string; children: React.ReactNode; testid: string }) {
  return (
    <label className={`flex cursor-pointer items-start gap-3.5 rounded-xl bg-white p-4 ${checked ? 'border-2 border-primary' : 'border border-border'}`}>
      <input type="radio" name="address" checked={checked} onChange={onChange} className="mt-1 h-[18px] w-[18px] accent-[#1a73e8]" data-testid={testid} />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="font-semibold">{title}</span>
        <span className="text-sm text-muted">{children}</span>
      </span>
    </label>
  );
}

function Placeholder({ agent, tone, children }: { agent?: boolean; tone: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border-[1.5px] border-dashed border-border p-3">
      <span aria-hidden="true" className="h-10 w-10 flex-none border-[1.5px] border-dashed" style={{ borderColor: tone, borderRadius: agent ? 11 : 999 }} />
      <span className="text-sm text-muted">{children}</span>
    </div>
  );
}
