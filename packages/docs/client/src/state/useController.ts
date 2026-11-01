import { useSyncExternalStore } from 'react';
import type { SheetController } from './controller.ts';

/** Re-render whenever the controller (selection, edit state, or workbook) changes. */
export function useController(ctl: SheetController): number {
  return useSyncExternalStore(ctl.subscribe, ctl.getVersion);
}
