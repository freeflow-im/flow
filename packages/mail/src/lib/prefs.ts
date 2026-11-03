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
