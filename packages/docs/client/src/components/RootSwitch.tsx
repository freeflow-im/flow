// The FreeFlow suite's two roots of the selected organization over the home page's list (docs/specs/freeflow-suite.md
// §2.4): the organization's shared files first, then the user's own files in it. Which is shown is in the address.

/** The address parameter of Organization files (`?org=<id>`); without it the home page lists My files. */
export const ORG_PARAM = 'org';

export function RootSwitch(props: { organization: string; shared: boolean; onSelect(shared: boolean): void }) {
  return (
    <div className="root-switch" role="tablist" aria-label="Files">
      <button role="tab" aria-selected={props.shared} className={props.shared ? 'active' : undefined} onClick={() => props.onSelect(true)} title={`Files shared with everyone in ${props.organization}`}>
        <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M22 19v-1a4 4 0 0 0-3-3.9M16 3.1a3.5 3.5 0 0 1 0 6.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Organization files
      </button>
      <button role="tab" aria-selected={!props.shared} className={!props.shared ? 'active' : undefined} onClick={() => props.onSelect(false)} title={`Your own files in ${props.organization}, private to you`}>
        <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 11V8a6 6 0 0 1 12 0v3M5 11h14v10H5z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        My files
      </button>
    </div>
  );
}
