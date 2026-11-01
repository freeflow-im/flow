// The star in an editor's header, before the file's folders and name: whether the file is one of the user's
// Favorites (the home page's tab beside Recents), and a click to add it or take it off.
import { useEffect, useState } from 'react';
import { api, type RecentFile } from '../api.ts';

export function FavoriteStar({ kind, id, onError }: { kind: RecentFile['kind']; id: string; onError?(message: string): void }) {
  // Null until known: its place is kept (what follows it stays put), but no star is drawn rather than a wrong one.
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    let gone = false;
    setOn(null);
    api.isFavorite(kind, id).then(
      (r) => !gone && setOn(r.on),
      () => {},
    );
    return () => {
      gone = true;
    };
  }, [kind, id]);
  return (
    <StarButton
      on={on}
      onClick={() => {
        setOn(!on);
        api.setFavorite({ kind, id }, !on).catch((e: Error) => (setOn(on), onError?.(e.message)));
      }}
    />
  );
}

/** The star itself: filled when on; null keeps its place empty until it is known. */
export function StarButton({ on, onClick, what = 'Favorites' }: { on: boolean | null; onClick(): void; what?: string }) {
  if (on === null) return <span className="favorite-star" aria-hidden="true" />;
  const label = on ? `Remove from ${what}` : `Add to ${what}`;
  return (
    <button className={`favorite-star${on ? ' on' : ''}`} title={label} aria-label={label} aria-pressed={on} onClick={onClick}>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
        <path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.7l5.9-.9z" fill={on ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
    </button>
  );
}
