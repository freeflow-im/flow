/** Icon for presentations (slide decks). */
export function DeckIcon({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill="#f4b400" />
      <path d="M7 9h18v12H7z" fill="none" stroke="#fff" strokeWidth="2" />
      <path d="M10 13h8M10 17h12" stroke="#fff" strokeWidth="2" />
      <path d="M16 21v4M12 25h8" stroke="#fff" strokeWidth="2" />
    </svg>
  );
}

/** Icon for text documents. */
export function DocIcon({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill="#4285f4" />
      <path d="M9 7h10l5 5v13H9z" fill="none" stroke="#fff" strokeWidth="2" strokeLinejoin="round" />
      <path d="M19 7v5h5M12 16h8M12 20h8" fill="none" stroke="#fff" strokeWidth="2" />
    </svg>
  );
}

/** Icon for Markdown documents: the "M↓" mark on slate. */
export function MarkdownIcon({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill="#455a64" />
      <path d="M6 22V10h3l3.5 4.5L16 10h3v12h-3v-7l-3.5 4.5L9 15v7z" fill="#fff" />
      <path d="M23.5 10v8m-3-3 3 3 3-3" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** The app's own mark (all document kinds), for the home page, file previews and sign-in pages. */
export function HomeIcon({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill="#3c4043" />
      <rect x="6" y="6" width="9" height="9" rx="2" fill="#0f9d58" />
      <rect x="17" y="6" width="9" height="9" rx="2" fill="#f4b400" />
      <rect x="6" y="17" width="9" height="9" rx="2" fill="#4285f4" />
      <rect x="17" y="17" width="9" height="9" rx="2" fill="#fff" fillOpacity="0.85" />
    </svg>
  );
}

/** Icon for spreadsheets. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill="#0f9d58" />
      <path d="M8 9h16v14H8z" fill="none" stroke="#fff" strokeWidth="2" />
      <path d="M8 14h16M8 18h16M14 9v14" stroke="#fff" strokeWidth="2" />
    </svg>
  );
}

/** What a stored file is, for its icon. */
export type StoredFileKind = 'pdf' | 'image' | 'video' | 'page' | 'other';

const FILE_ICON_COLORS: Record<StoredFileKind, string> = { pdf: '#d93025', image: '#00897b', video: '#7e57c2', page: '#f57c00', other: '#80868b' };

/**
 * Icon for a stored file (a PDF, picture, video, web page or anything else): the same square as the icons of
 * spreadsheets, presentations and documents, so every row of a list starts at one width.
 */
export function FileIcon({ kind, size = 28 }: { kind: StoredFileKind; size?: number }) {
  const line = { fill: 'none', stroke: '#fff', strokeWidth: 2, strokeLinejoin: 'round', strokeLinecap: 'round' } as const;
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill={FILE_ICON_COLORS[kind]} />
      {kind === 'image' && (
        <>
          <path d="M7 9h18v14H7z" {...line} />
          <path d="M8 21l5-5 4 4 3-3 4 4" {...line} />
          <circle cx="20.5" cy="13" r="1.6" fill="#fff" />
        </>
      )}
      {kind === 'video' && (
        <>
          <path d="M7 9h18v14H7z" {...line} />
          <path d="M14 13v6l5-3z" fill="#fff" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
        </>
      )}
      {kind === 'pdf' && (
        <>
          <path d="M9 7h10l5 5v13H9z" {...line} />
          <path d="M19 7v5h5" {...line} />
          <path d="M12 21v-5h1.6a1.5 1.5 0 0 1 0 3H12M18 16h3M18 16v5M18 18.5h2.4" {...line} strokeWidth={1.6} />
        </>
      )}
      {kind === 'page' && <path d="M13 11l-5 5 5 5M19 11l5 5-5 5" {...line} strokeWidth={2.4} />}
      {kind === 'other' && (
        <>
          <path d="M9 7h10l5 5v13H9z" {...line} />
          <path d="M19 7v5h5" {...line} />
        </>
      )}
    </svg>
  );
}

