// The desktop app's Recents (Spotlight, paths on disk) have no part in a hosted object.
import type { RecentFile, Recents } from '../../../recents.ts';
export const recentsAvailable = (): boolean => false;
export const recentFiles = async (..._a: unknown[]): Promise<Recents> => ({ files: [], blocked: [] });
export const openedFiles = async (..._a: unknown[]): Promise<RecentFile[]> => [];
export const whereOf = (_file: string, _home: string): string => '';
export const parseRecents = (_output: string): { path: string; lastUsed: string }[] => [];
export const listable = (..._a: unknown[]): boolean => false;
