// Dragging messages from the list onto an inbox tab or a folder in the left panel, with HTML5 drag and drop. Only with a
// mouse or trackpad: on a touch screen the menus' "Move to tab" and "Move to" do it, as they do from the keyboard.
import { useState, useSyncExternalStore, type DragEvent } from 'react';
import type { Category } from '../api';

/** The drag's data type: only drags of messages from the list are dropped on the tabs and folders. */
export const DRAG_TYPE = 'application/x-freeflow-mail-messages';

/** The messages a drag carries: every checked row (in list order) when the dragged row is checked, else that row alone. */
export function dragUids(uid: number, checked: ReadonlySet<number>, order: readonly number[]): number[] {
  if (!checked.has(uid)) return [uid];
  const inList = order.filter((u) => checked.has(u));
  return inList.length ? inList : [uid];
}

/** What the chip under the pointer says. */
export function dragLabel(count: number): string {
  return count === 1 ? 'Move 1 message' : `Move ${count} messages`;
}

/** The tab a drop moves the messages to: none when it is the tab they are in (or no tab is open, as while searching). */
export function tabDropTarget(current: Category | null, target: Category): Category | null {
  return current && current !== target ? target : null;
}

/** The folder a drop moves the messages to: none when it is the folder they are in. */
export function folderDropTarget(current: string | null, target: string): string | null {
  return current && current !== target ? target : null;
}

/** The UIDs a drop carries, from the drag's data. */
export function droppedUids(data: string): number[] {
  try {
    const v = JSON.parse(data) as unknown;
    return Array.isArray(v) ? v.filter((u): u is number => Number.isInteger(u) && u > 0) : [];
  } catch {
    return [];
  }
}

/** Starts a drag of these messages: their UIDs as the data, and a small chip ("Move 3 messages") as the picture. */
export function startDrag(e: DragEvent, uids: number[]): void {
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(uids));
  const chip = document.createElement('div');
  chip.textContent = dragLabel(uids.length);
  chip.style.cssText =
    'position:fixed;top:-100px;left:-1000px;padding:6px 12px;border-radius:8px;background:#0b57d0;color:#fff;font:500 13px/18px system-ui,sans-serif;white-space:nowrap;box-shadow:0 1px 3px rgba(60,64,67,.3),0 4px 8px 3px rgba(60,64,67,.15)';
  document.body.appendChild(chip);
  e.dataTransfer.setDragImage(chip, -12, -8);
  setTimeout(() => chip.remove(), 0);
}

const fine = '(hover: hover) and (pointer: fine)';
function subscribe(l: () => void) {
  const mq = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(fine) : null;
  mq?.addEventListener('change', l);
  return () => mq?.removeEventListener('change', l);
}
/** Whether rows can be dragged: a mouse or trackpad, not a touch screen. */
export function useCanDrag(): boolean {
  return useSyncExternalStore(subscribe, () => typeof window !== 'undefined' && !!window.matchMedia?.(fine).matches, () => false);
}

/**
 * A drop target for dragged messages (a tab, a folder): `over` while a drag of messages is over it, and the handlers
 * that take the drop. Without `onDrop` it is not a target.
 */
export function useDropTarget(onDrop: ((uids: number[]) => void) | undefined) {
  const [over, setOver] = useState(false);
  const carries = (e: DragEvent) => !!onDrop && e.dataTransfer.types.includes(DRAG_TYPE);
  const props = {
    onDragEnter: (e: DragEvent) => {
      if (!carries(e)) return;
      e.preventDefault();
      setOver(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!carries(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!over) setOver(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setOver(false);
    },
    onDrop: (e: DragEvent) => {
      if (!carries(e)) return;
      e.preventDefault();
      setOver(false);
      const uids = droppedUids(e.dataTransfer.getData(DRAG_TYPE));
      if (uids.length) onDrop!(uids);
    },
  };
  return { over, props };
}
