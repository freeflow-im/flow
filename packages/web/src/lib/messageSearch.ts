// The text of the Chat search (the suite bar's search on Chat): kept here, outside the selection, so the Search view
// (components/SearchView.tsx, opened as the SEARCH_VIEW_ID selection) reads it and back and forward keep it.
import { useSyncExternalStore } from 'react';

let current = '';
const listeners = new Set<() => void>();

export function setMessageSearch(text: string): void {
  if (text === current) return;
  current = text;
  for (const l of listeners) l();
}

export function useMessageSearch(): string {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
