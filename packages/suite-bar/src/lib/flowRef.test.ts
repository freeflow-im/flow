import { afterEach, describe, expect, it } from 'vitest';
import { FLOW_REF_TYPE, hasFlowRef, noteRelayedDrag, readFlowRef, type DocsFileRef } from './flowRef';

const ref: DocsFileRef = { app: 'docs', kind: 'sheet', id: 's1', name: 'Budget', folder: '', shared: false };
/** A drop's DataTransfer with these types and data. */
const transfer = (data: Record<string, string>, files = false) =>
  ({ types: [...Object.keys(data), ...(files ? ['Files'] : [])], getData: (t: string) => data[t] ?? '' }) as unknown as DataTransfer;

afterEach(() => noteRelayedDrag(null));

describe('flowRef', () => {
  it('reads the reference a drag carries', () => {
    const dt = transfer({ [FLOW_REF_TYPE]: JSON.stringify(ref) });
    expect(hasFlowRef(dt)).toBe(true);
    expect(readFlowRef(dt)).toEqual(ref);
  });

  it('takes the one the panel relayed when the browser hides the drag\'s data, until the drag ends', () => {
    const hidden = transfer({ 'text/uri-list': 'https://x/docs/s/s1' });
    expect(hasFlowRef(hidden)).toBe(false);
    noteRelayedDrag(ref);
    expect(hasFlowRef(hidden)).toBe(true);
    expect(readFlowRef(hidden)).toEqual(ref);
    noteRelayedDrag(null);
    expect(readFlowRef(hidden)).toBeNull();
  });

  it('leaves files from the computer and anything else alone', () => {
    noteRelayedDrag(ref);
    expect(hasFlowRef(transfer({}, true))).toBe(false);
    expect(readFlowRef(transfer({}, true))).toBeNull();
    noteRelayedDrag({ app: 'other' });
    expect(readFlowRef(transfer({ [FLOW_REF_TYPE]: '{"app":"nope"}' }))).toBeNull();
  });
});
