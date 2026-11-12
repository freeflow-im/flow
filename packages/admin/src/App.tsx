// FreeFlow Admin (docs/specs/workspace-admin.md): the suite bar, the section list on the left, the section's page on
// the right, for the organization the bar has active. Owners and admins see the sections; anyone else sees why not.
import { useEffect, useState } from 'react';
import { isInHome, useHomeMenu, type AdminSection, type SuiteMenuIcon } from '@flow/suite-bar';
import { AdminSuiteBar } from './components/AdminSuiteBar';
import { NoOrganization, NotAllowed } from './components/Empty';
import { useOrganizations } from './hooks/organization';
import { MEMBER_SECTIONS, SECTION_LABELS, SECTIONS, sectionOf, sectionPath } from './lib/route';
import { Domains } from './sections/Domains';
import { Agents } from './sections/Agents';
import { Assistant } from './sections/Assistant';
import { Connect } from './sections/Connect';
import { Automations } from './sections/Automations';
import { EventLog } from './sections/EventLog';
import { General } from './sections/General';
import { Members } from './sections/Members';

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
    if (s === section) return;
    window.history.pushState(null, '', sectionPath(s));
    setSection(s);
  };
  return [section, go];
}

const SECTION_ICONS: Record<AdminSection, SuiteMenuIcon> = { general: 'settings', members: 'people', domains: 'mail', agents: 'user', assistant: 'star', connect: 'share', automations: 'clock', events: 'draft' };

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
        <div className="flex min-h-0 flex-1 flex-col bg-panel sm:flex-row">
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
            <div className="mx-auto flex max-w-3xl flex-col gap-5">
              <header>
                <p className="text-xs font-semibold tracking-wide text-muted uppercase">{org.name}</p>
                <h1 className="text-xl font-semibold">{SECTION_LABELS[section]}</h1>
              </header>
              {section === 'general' && admin && <General org={org} />}
              {section === 'members' && admin && <Members org={org} />}
              {section === 'domains' && admin && <Domains org={org} />}
              {section === 'agents' && admin && <Agents org={org} />}
              {section === 'assistant' && <Assistant org={org} />}
              {section === 'connect' && <Connect />}
              {section === 'automations' && <Automations org={org} />}
              {section === 'events' && admin && <EventLog org={org} />}
            </div>
          </main>
        </div>
      )}
    </div>
  );
}
