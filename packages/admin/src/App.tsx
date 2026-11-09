// FreeFlow Admin (docs/specs/workspace-admin.md): the suite bar, the section list on the left, the section's page on
// the right, for the organization the bar has active. Owners and admins see the sections; anyone else sees why not.
import { useEffect, useState } from 'react';
import type { AdminSection } from '@flow/suite-bar';
import { AdminSuiteBar } from './components/AdminSuiteBar';
import { NoOrganization, NotAllowed } from './components/Empty';
import { useOrganizations } from './hooks/organization';
import { SECTION_LABELS, SECTIONS, sectionOf, sectionPath } from './lib/route';
import { General } from './sections/General';

function useSection(): [AdminSection, (s: AdminSection) => void] {
  const [section, setSection] = useState<AdminSection>(() => sectionOf(window.location.pathname));
  useEffect(() => {
    const onPop = () => setSection(sectionOf(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const go = (s: AdminSection) => {
    if (s === section) return;
    window.history.pushState(null, '', sectionPath(s));
    setSection(s);
  };
  return [section, go];
}

export function App() {
  const organizations = useOrganizations();
  const org = organizations.active;
  const [section, go] = useSection();
  const allowed = org?.role === 'owner' || org?.role === 'admin';

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
          <nav className="flex shrink-0 gap-1 overflow-x-auto border-b border-hairline bg-white px-3 py-2 sm:w-56 sm:flex-col sm:border-r sm:border-b-0 sm:px-3 sm:py-4" aria-label="Sections">
            {SECTIONS.map((s) => (
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
              {section === 'general' && <General org={org} />}
            </div>
          </main>
        </div>
      )}
    </div>
  );
}
