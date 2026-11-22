// FreeFlow Admin (docs/specs/workspace-admin.md): the suite bar, the section list on the left, the section's page on
// the right, for the organization the bar has active. Owners and admins see the sections; anyone else sees why not.
import { lazy, Suspense, useEffect, useState } from 'react';
import { isInHome, useHomeMenu, type AdminSection, type SuiteMenuIcon } from '@flow/suite-bar';
import { AdminSuiteBar } from './components/AdminSuiteBar';
import { NoOrganization, NotAllowed } from './components/Empty';
import { useOrganizations } from './hooks/organization';
import { MEMBER_SECTIONS, SECTION_LABELS, SECTIONS, sectionOf, sectionPath } from './lib/route';
import { Domains } from './sections/Domains';
import { Agents } from './sections/Agents';
import { Apps } from './sections/Apps';
import { Prompts } from './sections/Prompts';
import { Assistant } from './sections/Assistant';
import { Connect } from './sections/Connect';
import { SuiteAssistant } from '@flow/suite-bar/assistant-chat';
import { Automations } from './sections/Automations';
import { EventLog } from './sections/EventLog';
import { General } from './sections/General';
import { Members } from './sections/Members';

/** Sections built around a wide table get more room; forms keep the narrow column. */
const WIDE_SECTIONS: ReadonlySet<string> = new Set(['members', 'events']);
// The changelog page and its Markdown are loaded only when it is opened.
const Changelog = lazy(() => import('./sections/Changelog').then((m) => ({ default: m.Changelog })));

function useSection(sections: readonly AdminSection[]): [AdminSection, (s: AdminSection) => void] {
  const [wanted, setWanted] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setWanted(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const section = sectionOf(wanted, sections);
  const setSection = (s: AdminSection) => setWanted(sectionPath(s));
  const go = (s: AdminSection) => {
    if (s === section) {
      // A page inside the section (Members › Usage) goes back to the section's own page, which listens for the change.
      if (window.location.pathname === sectionPath(s)) return;
      window.history.pushState(null, '', sectionPath(s));
      window.dispatchEvent(new PopStateEvent('popstate'));
      return;
    }
    window.history.pushState(null, '', sectionPath(s));
    setSection(s);
  };
  return [section, go];
}

const SECTION_ICONS: Record<AdminSection, SuiteMenuIcon> = { general: 'settings', members: 'people', domains: 'mail', agents: 'user', apps: 'folder', prompts: 'pen', assistant: 'star', connect: 'share', automations: 'clock', events: 'draft', changelog: 'today' };

export function App() {
  const organizations = useOrganizations();
  const org = organizations.active;
  const admin = org?.role === 'owner' || org?.role === 'admin';
  // An owner or admin has every section; a member has their assistant and Automations (§2); an agent or app nothing.
  const sections = admin ? SECTIONS : MEMBER_SECTIONS;
  const [section, go] = useSection(sections);
  const allowed = !!org && !!org.role;
  // Inside Home (docs/specs/home.md §2.1), Home's sidebar lists the sections in place of Admin's own list.
  const [inHome] = useState(isInHome);
  useHomeMenu('admin', inHome && allowed ? sections.map((s) => ({ id: s, label: SECTION_LABELS[s], icon: SECTION_ICONS[s], href: sectionPath(s) })) : null, section, (id) => {
    if ((sections as readonly string[]).includes(id)) go(id as AdminSection);
  }, sectionPath(section));

  return (
    <div className="flex h-full flex-col">
      <AdminSuiteBar />
      {!organizations.ready ? (
        <div className="flex flex-1 items-center justify-center text-sm text-muted">Loading…</div>
      ) : !org ? (
        <NoOrganization />
      ) : !allowed ? (
        <NotAllowed name={org.name} />
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col bg-panel sm:flex-row">
          <nav className={`${inHome ? 'hidden' : 'flex'} shrink-0 gap-1 overflow-x-auto border-b border-hairline bg-white px-3 py-2 sm:w-56 sm:flex-col sm:border-r sm:border-b-0 sm:px-3 sm:py-4`} aria-label="Sections">
            {sections.map((s) => (
              <a
                key={s}
                href={sectionPath(s)}
                aria-current={s === section ? 'page' : undefined}
                data-testid={`section-${s}`}
                className={`rounded-md px-3 py-1.5 text-sm whitespace-nowrap ${s === section ? 'bg-selected-blue font-semibold text-primary' : 'text-ink hover:bg-hover'}`}
                onClick={(e) => {
                  e.preventDefault();
                  go(s);
                }}
              >
                {SECTION_LABELS[s]}
              </a>
            ))}
          </nav>
          <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
            <div className={`mx-auto flex flex-col gap-5 ${WIDE_SECTIONS.has(section) ? 'max-w-6xl' : 'max-w-3xl'}`}>
              <header>
                <p className="text-xs font-semibold tracking-wide text-muted uppercase">{org.name}</p>
                <h1 className="text-xl font-semibold">{SECTION_LABELS[section]}</h1>
              </header>
              {section === 'general' && admin && <General org={org} />}
              {section === 'members' && admin && <Members org={org} />}
              {section === 'domains' && admin && <Domains org={org} />}
              {section === 'agents' && admin && <Agents org={org} />}
              {section === 'apps' && <Apps org={org} admin={admin} />}
              {section === 'prompts' && admin && <Prompts org={org} />}
              {section === 'assistant' && <Assistant org={org} />}
              {section === 'connect' && <Connect />}
              {section === 'automations' && <Automations org={org} />}
              {section === 'events' && admin && <EventLog org={org} />}
              {section === 'changelog' && admin && (
                <Suspense fallback={<p className="text-sm text-muted">Loading…</p>}>
                  <Changelog />
                </Suspense>
              )}
            </div>
          </main>
          {/* The panel, as in every app; here it starts with the admin agent for an owner or admin (agents.md §1.4). */}
          <SuiteAssistant organizationId={org.id} page="admin" prefer="admin" />
        </div>
      )}
    </div>
  );
}
