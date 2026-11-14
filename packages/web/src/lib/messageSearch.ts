// The Chat search (the suite bar's search on Chat): its text and its order, kept here, outside the selection, so the
// Search view (components/SearchView.tsx, opened as the SEARCH_VIEW_ID selection) reads them and coming back to it with
// Back, after opening a result, shows the same list in the same order.
import { useSyncExternalStore } from 'react';

export type SearchSort = 'relevance' | 'recent';

let current = '';
let order: SearchSort = 'relevance';
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

export function setMessageSearch(text: string): void {
  if (text === current) return;
  current = text;
  notify();
}

export function setMessageSearchSort(sort: SearchSort): void {
  if (sort === order) return;
  order = sort;
  notify();
}

export function useMessageSearch(): string {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

export function useMessageSearchSort(): SearchSort {
  return useSyncExternalStore(subscribe, () => order, () => order);
}
