// Small per-browser choices (localStorage), shared live between this browser's tabs: read with the hook, change with
// the setter. A value that is not one of `values` reads as the first, the default, which is never stored.
import { useSyncExternalStore } from 'react';

export function browserPref<T extends string>(key: string, values: readonly [T, ...T[]]) {
  const read = (): T => {
    try {
      const v = localStorage.getItem(key);
      return values.includes(v as T) ? (v as T) : values[0];
    } catch {
      return values[0];
    }
  };
  let current = read();
  const listeners = new Set<() => void>();
  const set = (v: T) => {
    try {
      if (v === values[0]) localStorage.removeItem(key);
      else localStorage.setItem(key, v);
    } catch {
      // Not remembered; this page still follows it until it reloads.
    }
    current = v;
    for (const l of listeners) l();
  };
  const subscribe = (l: () => void) => {
    listeners.add(l);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== key) return;
      current = read();
      l();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(l);
      window.removeEventListener('storage', onStorage);
    };
  };
  const use = (): T => useSyncExternalStore(subscribe, () => current, () => values[0]);
  return { use, set };
}

/** What this browser keeps for a calendar shared with the person (phase 4.4): whether it is ticked, and a colour of its
 * own. A shared calendar starts unticked; a share's link ticks it. Kept here rather than on the owner's calendar, which
 * the reader may not change. */
export interface SharedPref { shown?: boolean; color?: string }
const SHARED_KEY = 'flow.calendar.shared';

function sharedStore() {
  const read = (): Record<string, SharedPref> => {
    try {
      const v = JSON.parse(localStorage.getItem(SHARED_KEY) ?? '{}') as unknown;
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, SharedPref>) : {};
    } catch {
      return {};
    }
  };
  let current = read();
  const listeners = new Set<() => void>();
  const set = (id: string, patch: SharedPref) => {
    const next = { ...(current[id] ?? {}), ...patch };
    if (next.color === undefined) delete next.color;
    current = { ...current, [id]: next };
    try {
      localStorage.setItem(SHARED_KEY, JSON.stringify(current));
    } catch {
      // Not remembered; this page still follows it until it reloads.
    }
    for (const l of listeners) l();
  };
  const subscribe = (l: () => void) => {
    listeners.add(l);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== SHARED_KEY) return;
      current = read();
      l();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(l);
      window.removeEventListener('storage', onStorage);
    };
  };
  const use = (): Record<string, SharedPref> => useSyncExternalStore(subscribe, () => current, () => current);
  return { use, set, get: () => current };
}

export const sharedPrefs = sharedStore();
