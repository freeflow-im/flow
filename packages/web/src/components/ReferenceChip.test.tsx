// Chips for FreeFlow addresses in messages (platform phase 6.4): resolved for the reader by the list, the reference's
// icon, title and kind with Open; a denied one says only its kind; an unresolved one stays the link. A share notice's
// address becomes the chip.
vi.mock('../lib/useBoundApi', () => ({ useBoundApi: () => ({ api: async () => ({}), serverOrigin: 'https://app.freeflow.im' }) }));
vi.mock('../state', () => ({ useSelection: () => ({ workspaceId: 'w1', openArtifactIn() {}, selectArtifact() {}, selectChannel() {}, jumpToMessage() {} }) }));
vi.mock('../hooks', () => ({ useChannels: () => ({ data: [] }) }));
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { MessageDTO, ResolvedReference } from '@flow/shared';
import { ReferencesContext, referencesIn, referencesOfMessages, type ReferenceLookup } from '../lib/references';
import { ReferenceChip } from './ReferenceChip';
import { SystemLine } from './SystemLine';

const ORIGIN = 'https://app.freeflow.im';
const lookup = (answers: ResolvedReference[]): ReferenceLookup => ({ origin: ORIGIN, organizationId: 'w1', get: (ref) => answers.find((a) => a.ref === ref) });

describe('references in a message', () => {
  it('finds the FreeFlow addresses on this server, each once, and nothing else', () => {
    const body = `plan: ${ORIGIN}/docs/d/D1. again ${ORIGIN}/docs/d/D1 and https://example.com/docs/s/x and ${ORIGIN}/?open=artifact%3AA1`;
    expect(referencesIn(body, ORIGIN, 'w1').map((f) => f.ref)).toEqual(['w1/docs/sheet/D1', 'w1/chat/artifact/A1']);
    expect(referencesOfMessages([{ body, deletedAt: null }, { body: `${ORIGIN}/calendar/?event=e1`, deletedAt: null }, { body, deletedAt: 'x' }], ORIGIN, 'w1'))
      .toEqual(['w1/calendar/event/e1', 'w1/chat/artifact/A1', 'w1/docs/sheet/D1']);
    expect(referencesOfMessages([{ body, deletedAt: null }], ORIGIN, null)).toEqual([]);
  });

  it('draws a resolved chip with its icon, title, kind and Open; Share for someone who may share it', () => {
    const [found] = referencesIn(`${ORIGIN}/docs/d/D1`, ORIGIN, 'w1');
    const html = renderToStaticMarkup(<ReferenceChip found={found!} resolved={{ ref: 'w1/docs/sheet/D1', app: 'docs', kind: 'sheet', fileKind: 'deck', title: 'Q4 plan', url: '/docs/d/D1', icon: '📽️', role: 'manager' }} />);
    expect(html).toContain('data-state="resolved"');
    expect(html).toContain('📽️');
    expect(html).toContain('Q4 plan');
    expect(html).toContain('Presentation');
    expect(html).toContain('data-testid="reference-open"');
    expect(html).toContain('data-testid="reference-share"');
    const viewer = renderToStaticMarkup(<ReferenceChip found={found!} resolved={{ ref: 'w1/docs/sheet/D1', app: 'docs', kind: 'sheet', title: 'Q4 plan', url: '/docs/d/D1', icon: '📽️', role: 'viewer' }} />);
    expect(viewer).not.toContain('reference-share');
  });

  it('says only the kind of what the reader may not see, and stays the link until it is resolved', () => {
    const [found] = referencesIn(`${ORIGIN}/docs/s/S9`, ORIGIN, 'w1');
    const denied = renderToStaticMarkup(<ReferenceChip found={found!} resolved={{ ref: 'w1/docs/sheet/S9', denied: true }} />);
    expect(denied).toContain('data-state="denied"');
    expect(denied).toContain('a spreadsheet you cannot see');
    expect(denied).not.toContain('reference-open');
    const pending = renderToStaticMarkup(<ReferenceChip found={found!} resolved={undefined} />);
    expect(pending).toContain(`href="${ORIGIN}/docs/s/S9"`);
  });

  it('turns a share notice’s address into the chip, inside a message list', () => {
    const message = { id: 'm1', systemKind: 'file_shared', body: `Ann shared Q4 plan with you\n${ORIGIN}/docs/d/D1` } as MessageDTO;
    const html = renderToStaticMarkup(
      <ReferencesContext.Provider value={lookup([{ ref: 'w1/docs/sheet/D1', app: 'docs', kind: 'sheet', fileKind: 'deck', title: 'Q4 plan', url: '/docs/d/D1', icon: '📽️', role: 'viewer' }])}>
        <SystemLine message={message} />
      </ReferencesContext.Provider>,
    );
    expect(html).toContain('Ann shared Q4 plan with you');
    expect(html).toContain('data-state="resolved"');
    expect(html).not.toContain(`>${ORIGIN}/docs/d/D1<`);
  });
});
