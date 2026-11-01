// Types of updater.js (plain JavaScript, as main.js is, which imports it).
import type { App, Dialog, Shell } from 'electron';

export interface Release {
  version: string;
  url: string;
  name: string;
  size: number;
  page: string;
}

export function assetPattern(platform: string): RegExp;
export function isNewer(a: string, b: string): boolean;
export function latestFor(releases: unknown[], platform: string): Release | null;
export function createUpdater(electron: { app: App; dialog: Dialog; shell: Shell; onProgress: (fraction: number | null) => void }): {
  check(): Promise<void>;
};
