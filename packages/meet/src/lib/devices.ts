// Camera, microphone and speaker choice (task #48): on the check screen and in the room. The choice is remembered in
// this browser, the lists follow devices being plugged in and out (`devicechange`), and a browser that cannot send
// sound to a chosen speaker (no `setSinkId`, e.g. Firefox before 116 and Safari) shows no Speaker picker at all.
import { useEffect, useState } from 'react';

export type DeviceKind = 'videoinput' | 'audioinput' | 'audiooutput';

export interface DeviceOption {
  id: string;
  label: string;
}

export type DeviceChoice = Partial<Record<DeviceKind, string>>;

export type DeviceLists = Record<DeviceKind, DeviceOption[]>;

const PREFS_KEY = 'flow.meet.devices';

export function rememberedDevices(): DeviceChoice {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object') return {};
    const out: DeviceChoice = {};
    for (const kind of ['videoinput', 'audioinput', 'audiooutput'] as const) {
      const v = (raw as Record<string, unknown>)[kind];
      if (typeof v === 'string' && v) out[kind] = v;
    }
    return out;
  } catch {
    return {};
  }
}

export function rememberDevice(kind: DeviceKind, id: string): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...rememberedDevices(), [kind]: id }));
  } catch {
    // Not kept: the default device is used next time.
  }
}

const FALLBACK_NAME: Record<DeviceKind, string> = {
  videoinput: 'Camera',
  audioinput: 'Microphone',
  audiooutput: 'Speaker',
};

/**
 * The browser's devices by kind. Before the site has camera or microphone permission the browser hides names (and may
 * list one blank entry), so those get "Camera 1", "Microphone 1"…; blank ids (nothing usable) are dropped.
 */
export function groupDevices(devices: readonly Pick<MediaDeviceInfo, 'kind' | 'deviceId' | 'label'>[]): DeviceLists {
  const lists: DeviceLists = {
    videoinput: [],
    audioinput: [],
    audiooutput: [],
  };
  for (const d of devices) {
    if (!(d.kind in lists) || !d.deviceId) continue;
    const list = lists[d.kind as DeviceKind];
    if (list.some((o) => o.id === d.deviceId)) continue;
    list.push({
      id: d.deviceId,
      label: d.label || `${FALLBACK_NAME[d.kind as DeviceKind]} ${list.length + 1}`,
    });
  }
  return lists;
}

/**
 * Which device is in use: the chosen one while it is plugged in; otherwise the system default, else the first.
 * So unplugging the chosen headset falls back without forgetting it, and plugging it back picks it again.
 */
export function pickDevice(list: readonly DeviceOption[], chosen: string | undefined): string | undefined {
  if (chosen && list.some((d) => d.id === chosen)) return chosen;
  return list.find((d) => d.id === 'default')?.id ?? list[0]?.id;
}

/** True when this browser can send a media element's sound to a chosen output device. */
export function canPickSpeaker(): boolean {
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
}

type SinkElement = HTMLMediaElement & {
  setSinkId?: (id: string) => Promise<void>;
};

/** Sends an element's sound to `id` where the browser allows it; elsewhere (or on failure) it plays on the default. */
export function routeToSpeaker(el: HTMLMediaElement, id: string | undefined): void {
  const sink = el as SinkElement;
  if (!id || typeof sink.setSinkId !== 'function' || (el as { sinkId?: string }).sinkId === id) return;
  sink.setSinkId(id).catch(() => {});
}

/** The device lists, refreshed when a device is plugged in or out and when `refresh` changes (e.g. after permission). */
export function useDeviceLists(refresh: unknown = null): DeviceLists {
  const [lists, setLists] = useState<DeviceLists>({
    videoinput: [],
    audioinput: [],
    audiooutput: [],
  });
  useEffect(() => {
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (!md?.enumerateDevices) return;
    let cancelled = false;
    const load = () =>
      void md
        .enumerateDevices()
        .then((all) => !cancelled && setLists(groupDevices(all)))
        .catch(() => {});
    load();
    md.addEventListener?.('devicechange', load);
    return () => {
      cancelled = true;
      md.removeEventListener?.('devicechange', load);
    };
  }, [refresh]);
  return lists;
}

/** A short two-note tone on the chosen speaker, so a person can hear which one it is. Never throws. */
export async function playTestSound(speaker: string | undefined): Promise<void> {
  let ctx: AudioContext;
  try {
    ctx = new AudioContext();
  } catch {
    return;
  }
  try {
    await ctx.resume();
    const out = ctx.createMediaStreamDestination();
    const el = new Audio();
    el.srcObject = out.stream;
    routeToSpeaker(el, speaker);
    const start = ctx.currentTime + 0.05;
    [523.25, 783.99].forEach((freq, i) => {
      const at = start + i * 0.35;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.setValueAtTime(freq, at);
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.15, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.5);
      osc.connect(gain).connect(out);
      osc.start(at);
      osc.stop(at + 0.55);
    });
    await el.play();
    setTimeout(() => {
      el.srcObject = null;
      void ctx.close().catch(() => {});
    }, 1200);
  } catch {
    void ctx.close().catch(() => {});
  }
}
