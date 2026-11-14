// Dragging a thing from one app into another (docs/specs/side-panel.md §7): one drag type for every app, carrying a
// reference the drop target reads by its kind, not by the app it came from. The side panel's pages are frames of the
// same origin, so a browser's drag crosses from the panel into the host; a browser that keeps a frame's own drag types
// from another document still gets the reference, which the panel also sends the host by message when the drag starts
// (`flow:drag`, SidePanel.tsx notes it here) and clears when it ends.

/** The drag type: its data is the reference as JSON. */
export const FLOW_REF_TYPE = 'application/x-flow-ref+json';

/** A Docs file: a document, presentation, spreadsheet or stored file, as Mail's attach-from-Docs names one. */
export interface DocsFileRef {
  app: 'docs';
  kind: 'doc' | 'sheet' | 'deck' | 'markdown' | 'file';
  id: string;
  name: string;
  /** The folder it is in ('' at the top). */
  folder: string;
  /** One of the organization's shared files (Organization files) rather than one of the person's own. */
  shared: boolean;
  /** A spreadsheet kept as a CSV file. */
  format?: string;
  /** A stored file's type and size. */
  type?: string;
  size?: number;
}

export type FlowRef = DocsFileRef;

const isRef = (v: unknown): v is FlowRef => {
  const r = v as Partial<DocsFileRef> | null;
  return !!r && r.app === 'docs' && typeof r.id === 'string' && typeof r.name === 'string' && typeof r.kind === 'string';
};

/** A drag a panel said it started (its `flow:drag` message), until it ends. */
let relayed: FlowRef | null = null;

/** The host: a panel's drag started (its reference) or ended (null). */
export function noteRelayedDrag(ref: unknown): void {
  relayed = isRef(ref) ? ref : null;
}

/** Starts a drag of a reference: its data, the address as a link for anything else it is dropped on, and the host told. */
export function startFlowRefDrag(e: { dataTransfer: DataTransfer | null }, ref: FlowRef, url?: string): void {
  const dt = e.dataTransfer;
  if (!dt) return;
  dt.setData(FLOW_REF_TYPE, JSON.stringify(ref));
  if (url) {
    dt.setData('text/uri-list', url);
    dt.setData('text/plain', url);
  }
  dt.effectAllowed = 'copy';
  if (window.parent !== window) window.parent.postMessage({ type: 'flow:drag', ref }, window.location.origin);
}

/** Ends it (the source's dragend): the host forgets it. */
export function endFlowRefDrag(): void {
  if (window.parent !== window) window.parent.postMessage({ type: 'flow:dragend' }, window.location.origin);
}

/** Whether a drag over a target carries a reference (its data can only be read on the drop). */
export function hasFlowRef(dt: DataTransfer | null): boolean {
  return !!dt && (dt.types.includes(FLOW_REF_TYPE) || (!!relayed && !dt.types.includes('Files')));
}

/** The reference a drop carries, or null. */
export function readFlowRef(dt: DataTransfer | null): FlowRef | null {
  if (!dt) return null;
  try {
    const raw = dt.getData(FLOW_REF_TYPE);
    if (raw) {
      const v = JSON.parse(raw) as unknown;
      if (isRef(v)) return v;
    }
  } catch {
    // Not ours.
  }
  return dt.types.includes('Files') ? null : relayed;
}
