// Whether messages load their images from the web. Until the user chooses, they are hidden and the message says so;
// "Show images" there is the choice, made once for every message after it. Account settings can turn it off again.
// Kept in this browser (localStorage), and shared live between its tabs.
import { useSyncExternalStore } from 'react';

const KEY = 'mail.remoteImages';
export type ImagePref = 'ask' | 'always';

function read(): ImagePref {
  try {
    return localStorage.getItem(KEY) === 'always' ? 'always' : 'ask';
  } catch {
    return 'ask';
  }
}

const listeners = new Set<() => void>();
export function setImagePref(pref: ImagePref): void {
  try {
    if (pref === 'always') localStorage.setItem(KEY, 'always');
    else localStorage.removeItem(KEY);
  } catch {
    // Not remembered; this page still follows it until it reloads.
  }
  current = pref;
  for (const l of listeners) l();
}

let current: ImagePref = read();
function subscribe(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    current = read();
    l();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener('storage', onStorage);
  };
}

export function useImagePref(): ImagePref {
  return useSyncExternalStore(subscribe, () => current, () => 'ask');
}
