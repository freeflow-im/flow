import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactDTO, ChannelDTO, WorkspaceMemberDTO } from '@flow/shared';
import {
  ActivityBell,
  ActivitySpinner,
  appEntries,
  channelLabel,
  DocsGroup,
  filterDocs,
  NavButton,
  nearestScrollDelta,
  nestChannels,
  sortChannelsByName,
  openChannelFromSidebar,
  readCollapsedDocs,
  splitAgentChannels,
  splitAgents,
  writeCollapsedDocs,
  WorkspaceTitle,
} from './Sidebar';
import { SelectionContext } from '../state';
import type { Selection } from '../state';

// Sub-channel display order (#118). The rule that matters is the fallback: a
// child whose parent isn't in the list must still be rendered, or you lose a
// channel you belong to.
const chan = (id: string, parentId: string | null = null): ChannelDTO => ({
  id,
  workspaceId: 'w1',
  name: id,
  kind: 'standard',
  topic: null,
  isPrivate: false,
  createdBy: 'u1',
  createdAt: '2026-07-29T00:00:00Z',
  archivedAt: null,
  isMember: true,
  lastReadMsgId: null,
  unreadCount: 0,
  unreadNotifications: 0,
  unreadThreadRootIds: [],
  notifyLevel: 1,
  parentId,
});

const shape = (list: ChannelDTO[]) => nestChannels(list).map((r) => `${r.nested ? '  ' : ''}${r.channel.id}`);

describe('sortChannelsByName', () => {
  it('sorts A to Z ignoring case, whatever order the backend sent', () => {
    const named = (id: string, name: string) => ({ ...chan(id), name });
    const list = [named('1', 'social'), named('2', 'all-biztrip'), named('3', 'Eng'), named('4', 'accounting')];
    expect(sortChannelsByName(list).map((c) => c.name)).toEqual(['accounting', 'all-biztrip', 'Eng', 'social']);
  });
});

describe('nestChannels', () => {
  it('leaves a flat list alone', () => {
    expect(shape([chan('alpha'), chan('beta')])).toEqual(['alpha', 'beta']);
  });

  it('puts a child directly under its parent, indented', () => {
    expect(shape([chan('alpha'), chan('zeta', 'alpha')])).toEqual(['alpha', '  zeta']);
  });

  it('pulls a child up to its parent regardless of input position', () => {
    // The server sorts by name, so a child usually arrives nowhere near its
    // parent — this is the ordinary case, not an edge case.
    expect(shape([chan('alpha'), chan('beta'), chan('gamma', 'alpha')])).toEqual(['alpha', '  gamma', 'beta']);
  });

  it('keeps several children under one parent, in input order', () => {
    expect(shape([chan('alpha'), chan('one', 'alpha'), chan('two', 'alpha')])).toEqual([
      'alpha',
      '  one',
      '  two',
    ]);
  });

  it('renders a child at top level when its parent is not in the list', () => {
    // You can be a member of a child without being in its parent, and the
    // parent may be archived. Either way the channel must not vanish.
    expect(shape([chan('orphan', 'not-here')])).toEqual(['orphan']);
  });

  it('never nests deeper than one level', () => {
    // The server rejects grandchildren. One arriving anyway falls back to top
    // level — the first version of this dropped it from the sidebar entirely.
    expect(shape([chan('alpha'), chan('kid', 'alpha'), chan('grandkid', 'kid')])).toEqual([
      'alpha',
      '  kid',
      'grandkid',
    ]);
  });

  it('returns every channel it was given', () => {
    const list = [chan('a'), chan('b', 'a'), chan('c', 'gone'), chan('d')];
    expect(nestChannels(list)).toHaveLength(list.length);
  });
});

// The "an agent is working here" spinner (#137).
describe('splitAgentChannels', () => {
  it('moves a channel an agent made, with its sub-channels, under that agent', () => {
    const made = (c: ChannelDTO, by: string) => ({ ...c, createdBy: by });
    const rows = nestChannels([
      made(chan('build'), 'agent1'),
      made(chan('build-sub', 'build'), 'u1'),
      chan('general'),
      made(chan('general-sub', 'general'), 'agent1'),
      made(chan('other'), 'agent2'),
    ]);
    const { byAgent, rest } = splitAgentChannels(rows, new Set(['agent1']));
    expect(byAgent.get('agent1')?.map((r) => `${r.nested ? '  ' : ''}${r.channel.id}`)).toEqual(['build', '  build-sub']);
    // A sub-channel an agent made in a person's channel stays with its parent; an agent not listed keeps its channels in Channels.
    expect(rest.map((r) => r.channel.id)).toEqual(['general', 'general-sub', 'other']);
  });
});

describe('ActivitySpinner', () => {
  it('spins, and holds still for anyone who asked for less motion', () => {
    const html = renderToStaticMarkup(<ActivitySpinner active={false} />);
    expect(html).toContain('animate-spin');
    expect(html).toContain('motion-reduce:animate-none');
  });

  it('is labelled, so it is not a mystery dot', () => {
    expect(renderToStaticMarkup(<ActivitySpinner active={false} />)).toContain('title="an agent is working');
  });

  it('does not shrink the channel name away', () => {
    // It sits after a truncating label — without shrink-0 the ring is what
    // collapses when a long channel name fills the row.
    expect(renderToStaticMarkup(<ActivitySpinner active />)).toContain('shrink-0');
  });
});

// Scrolling the active channel into view (#319). Coordinates are relative to
// the sidebar's scroll viewport; the result is a scrollTop delta.
describe('nearestScrollDelta', () => {
  const ROW = 30;
  const VIEW = 300;

  it('does not move a row that is already fully visible', () => {
    // The sidebar-click case: any scroll here would be a visible jump.
    expect(nearestScrollDelta(0, ROW, VIEW)).toBe(0);
    expect(nearestScrollDelta(120, ROW, VIEW)).toBe(0);
    expect(nearestScrollDelta(VIEW - ROW, ROW, VIEW)).toBe(0);
  });

  it('scrolls down by just enough for a row below the fold', () => {
    // The reported bug: click a notification for a channel low in the list.
    expect(nearestScrollDelta(400, ROW, VIEW)).toBe(130);
    expect(nearestScrollDelta(VIEW, ROW, VIEW)).toBe(ROW);
  });

  it('scrolls up by just enough for a row above the fold', () => {
    expect(nearestScrollDelta(-50, ROW, VIEW)).toBe(-50);
  });

  it('brings a partly-cut row the rest of the way in', () => {
    expect(nearestScrollDelta(VIEW - 10, ROW, VIEW)).toBe(20);
    expect(nearestScrollDelta(-1, ROW, VIEW)).toBe(-1);
  });

  it('aligns a row taller than the viewport to its top', () => {
    // Bottom-aligning it would push the start of the row off-screen.
    expect(nearestScrollDelta(40, 500, VIEW)).toBe(40);
  });
});


// The Agents section (#361): agents are pulled out of Direct messages into
// their own list, DM and all, so nobody is listed twice.
const ME = 'me';
const member = (userId: string, displayName: string, isAgent: boolean): WorkspaceMemberDTO => ({
  userId,
  displayName,
  email: `${userId}@example.com`,
  privacyMode: false,
  avatarUrl: null,
  statusEmoji: '',
  statusText: '',
  title: '',
  isAgent,
  isBot: false,
  sponsorId: null,
  role: 'member',
  joinedAt: '2026-08-25T00:00:00Z',
});
const dm = (id: string, memberIds: string[], kind: ChannelDTO['kind'] = 'dm'): ChannelDTO => ({
  ...chan(id),
  name: null,
  kind,
  memberIds,
});

describe('splitAgents', () => {
  const prism = member('a1', 'Prism', true);
  const builder = member('a2', 'builder', true);
  const scott = member('u1', 'Scott', false);

  it('lists an agent that has no DM yet', () => {
    const { agents, rest } = splitAgents([], [prism, scott], ME);
    expect(agents.map((a) => a.member.userId)).toEqual(['a1']);
    expect(agents[0]!.channel).toBeUndefined();
    expect(rest).toEqual([]);
  });

  it('moves an agent DM out of the DM list and onto the agent row', () => {
    const agentDm = dm('d1', [ME, 'a1']);
    const humanDm = dm('d2', [ME, 'u1']);
    const { agents, rest } = splitAgents([agentDm, humanDm], [prism, scott], ME);
    expect(agents[0]!.channel?.id).toBe('d1'); // unread badges ride along with it
    expect(rest.map((c) => c.id)).toEqual(['d2']);
  });

  it('sorts agents alphabetically, ignoring case', () => {
    const { agents } = splitAgents([], [prism, builder], ME);
    expect(agents.map((a) => a.member.displayName)).toEqual(['builder', 'Prism']);
  });

  it('leaves a group DM alone even when an agent is in it', () => {
    // Several people talking is a conversation, not a way to reach the agent.
    const group = dm('g1', [ME, 'a1', 'u1'], 'group_dm');
    const { agents, rest } = splitAgents([group], [prism, scott], ME);
    expect(rest.map((c) => c.id)).toEqual(['g1']);
    expect(agents[0]!.channel).toBeUndefined();
  });

  it('leaves the self-DM under Direct messages', () => {
    const self = dm('s1', [ME]);
    const { rest } = splitAgents([self], [member(ME, 'Me', true), prism], ME);
    expect(rest.map((c) => c.id)).toEqual(['s1']);
  });

  it('finds no agents in a workspace of humans — the section hides itself', () => {
    const { agents, rest } = splitAgents([dm('d2', [ME, 'u1'])], [scott], ME);
    expect(agents).toEqual([]);
    expect(rest).toHaveLength(1);
  });
});

// Activity moved from a channel-list row to a header bell (#385). What the
// tests pin is what the row used to carry: the unread badge and the selected
// state — the parts that would silently vanish in the move.
describe('ActivityBell', () => {
  it('is labelled "Activity", not a bare glyph', () => {
    const html = renderToStaticMarkup(<ActivityBell active={false} unread={0} onOpen={() => {}} />);
    expect(html).toContain('aria-label="Activity"');
    expect(html).toContain('title="Activity"');
  });

  it('badges the unread count, and caps it at 99', () => {
    expect(renderToStaticMarkup(<ActivityBell active={false} unread={3} onOpen={() => {}} />)).toContain('>3<');
    expect(renderToStaticMarkup(<ActivityBell active={false} unread={500} onOpen={() => {}} />)).toContain('>99<');
  });

  it('shows no badge when everything is read', () => {
    expect(renderToStaticMarkup(<ActivityBell active={false} unread={0} onOpen={() => {}} />)).not.toContain('bg-unread');
  });

  it('reads as current while the Activity feed is open', () => {
    const html = renderToStaticMarkup(<ActivityBell active unread={0} onOpen={() => {}} />);
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('bg-white');
  });
});

// A long workspace name used to shove the header controls off the sidebar edge
// (#456). The title is the element that yields: it shrinks and ellipsises, and
// the full name is still readable on hover.
describe('WorkspaceTitle', () => {
  it('can shrink below its text and ellipsises what is left', () => {
    const html = renderToStaticMarkup(<WorkspaceTitle name="Flow Home Team" onClick={() => {}} />);
    expect(html).toContain('min-w-0');
    expect(html).toContain('truncate');
  });

  it('keeps the full name reachable on hover', () => {
    const html = renderToStaticMarkup(<WorkspaceTitle name="Flow Home Team" onClick={() => {}} />);
    expect(html).toContain('title="Flow Home Team"');
  });

  it('never truncates the switcher chevron along with the name', () => {
    const html = renderToStaticMarkup(<WorkspaceTitle name="Flow Home Team" onClick={() => {}} />);
    expect(html).toContain('shrink-0');
    expect(html).toContain('▾');
  });

  it('falls back to "Workspace" before one is loaded', () => {
    const html = renderToStaticMarkup(<WorkspaceTitle onClick={() => {}} />);
    expect(html).toContain('Workspace');
    expect(html).toContain('title="Workspace"');
  });
});

describe('NavButton', () => {
  it('is labelled Back / Forward rather than a bare chevron', () => {
    const back = renderToStaticMarkup(<NavButton dir="back" enabled onClick={() => {}} />);
    expect(back).toContain('aria-label="Back"');
    expect(back).toContain('title="Back"');
    const fwd = renderToStaticMarkup(<NavButton dir="forward" enabled onClick={() => {}} />);
    expect(fwd).toContain('aria-label="Forward"');
    expect(fwd).toContain('title="Forward"');
  });

  it('points the chevron the way it navigates', () => {
    expect(renderToStaticMarkup(<NavButton dir="back" enabled onClick={() => {}} />)).toContain('15 18 9 12 15 6');
    expect(renderToStaticMarkup(<NavButton dir="forward" enabled onClick={() => {}} />)).toContain('9 18 15 12 9 6');
  });

  it('is dimmed and non-interactive at the end of the history', () => {
    const html = renderToStaticMarkup(<NavButton dir="back" enabled={false} onClick={() => {}} />);
    expect(html).toContain('disabled');
    expect(html).toContain('text-white/25');
  });

  it('is live and hoverable when there is somewhere to go', () => {
    const html = renderToStaticMarkup(<NavButton dir="forward" enabled onClick={() => {}} />);
    expect(html).not.toContain('disabled');
    expect(html).toContain('hover:bg-white/10');
  });
});

// Apps section (#394): the sidebar attaches each app the server returned to its
// host channel, which is where the row's muted secondary label comes from.
const app = (id: string, name: string, channelId: string): ArtifactDTO => ({
  id,
  workspaceId: 'w1',
  channelId,
  kind: 'link',
  fileId: null,
  url: 'https://app.example.com/',
  name,
  ownsFile: false,
  isApp: true,
  createdAt: '2026-08-27T00:00:00Z',
  updatedAt: '2026-08-27T00:00:00Z',
  file: null,
});

describe('appEntries', () => {
  it('pairs each app with its host channel, keeping the server order', () => {
    const channels = [chan('factory'), chan('general')];
    const entries = appEntries([app('a1', 'Task Board', 'factory'), app('a2', 'Zoo', 'general')], channels);
    expect(entries.map((e) => [e.artifact.name, e.channel.id])).toEqual([
      ['Task Board', 'factory'],
      ['Zoo', 'general'],
    ]);
  });

  it('lists an app from a public channel this user has not joined', () => {
    // The whole point of the section: #factory is public and unjoined, and its
    // Task Board still shows up (clicking it joins).
    const unjoined = { ...chan('factory'), isMember: false };
    const entries = appEntries([app('a1', 'Task Board', 'factory')], [unjoined]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.channel.isMember).toBe(false);
  });

  it('drops an app whose channel is not in the local list', () => {
    // No channel means nothing to join and nowhere to open — a channel-less row
    // would be a dead end, so it is left out rather than rendered.
    expect(appEntries([app('a1', 'Ghost', 'gone')], [chan('general')])).toEqual([]);
  });
});

describe('channelLabel', () => {
  it('names a channel with a hash and a DM by its members', () => {
    expect(channelLabel(chan('factory'), {}, 'me')).toBe('#factory');
    const dm: ChannelDTO = { ...chan('d1'), kind: 'dm', name: null, memberIds: ['me', 'u2'] };
    expect(channelLabel(dm, { u2: 'Prism' }, 'me')).toBe('Prism');
  });
});


// #327: a channel whose unreads are all inside a thread looks unchanged when
// you click it, so clicking opens the thread too.
describe('openChannelFromSidebar', () => {
  const selection = (channelId: string | null) => {
    const calls: string[] = [];
    const sel = {
      channelId,
      selectChannel: (id: string | null) => calls.push(`select:${id}`),
      jumpToMessage: (c: string, m: string, root?: string | null) => calls.push(`jump:${c}:${m}:${root}`),
    } as unknown as Selection;
    const revisit = (c: ChannelDTO) => calls.push(`revisit:${c.id}`);
    return { sel, calls, revisit };
  };
  const withUnreadThread = (id: string): ChannelDTO => ({
    ...chan(id),
    unreadNotifications: 2,
    unreadThreadRootIds: ['root1'],
    oldestUnreadThreadReply: { rootId: 'root1', replyId: 'reply1' },
  });

  it('opens the thread holding the oldest unread reply', () => {
    const { sel, calls } = selection('other');
    openChannelFromSidebar(sel, withUnreadThread('alpha'));
    expect(calls).toEqual(['jump:alpha:reply1:root1']);
  });

  it('is a plain channel switch when the oldest unread is top-level', () => {
    const { sel, calls } = selection('other');
    openChannelFromSidebar(sel, { ...chan('alpha'), unreadCount: 3 });
    expect(calls).toEqual(['select:alpha']);
  });

  it('is a plain channel switch with no unreads at all', () => {
    const { sel, calls } = selection('other');
    openChannelFromSidebar(sel, chan('alpha'));
    expect(calls).toEqual(['select:alpha']);
  });

  // #533: clicking the row of the channel you are already in used to do
  // nothing, which is exactly the gesture someone makes when a badge won't go
  // away. It re-runs the read pass now — and follows the auto-open target,
  // since a badge you just clicked should take you to what it counts.
  it('re-runs the read pass when you click the channel you are already in', () => {
    const { sel, calls, revisit } = selection('alpha');
    openChannelFromSidebar(sel, chan('alpha'), revisit);
    expect(calls).toEqual(['revisit:alpha', 'select:alpha']);
  });

  it('re-reads and opens the waiting thread on a re-click', () => {
    const { sel, calls, revisit } = selection('alpha');
    openChannelFromSidebar(sel, withUnreadThread('alpha'), revisit);
    expect(calls).toEqual(['revisit:alpha', 'jump:alpha:reply1:root1']);
  });

  it('does not re-read a channel you are switching into', () => {
    const { sel, calls, revisit } = selection('other');
    openChannelFromSidebar(sel, chan('alpha'), revisit);
    expect(calls).toEqual(['select:alpha']); // entering it marks it read already
  });
});

// Channel Docs list (#574): a channel with dozens of artifacts pushed every
// other channel off the sidebar. The group folds, and the filter finds one by
// name without scrolling.
const doc = (id: string, name: string, channelId = 'factory'): ArtifactDTO => ({
  ...app(id, name, channelId),
  kind: 'file',
  isApp: false,
  url: null,
});

describe('filterDocs', () => {
  const docs = [doc('d1', 'Q3 roadmap'), doc('d2', 'roadmap-archive'), doc('d3', 'Onboarding')];

  it('returns everything for an empty query, so clearing the box restores the list', () => {
    expect(filterDocs(docs, '')).toEqual(docs);
    expect(filterDocs(docs, '   ')).toEqual(docs);
  });

  it('matches a substring anywhere in the name, ignoring case', () => {
    expect(filterDocs(docs, 'ROADMAP').map((d) => d.id)).toEqual(['d1', 'd2']);
    expect(filterDocs(docs, 'board').map((d) => d.id)).toEqual(['d3']);
  });

  it('ignores padding a person types around the query', () => {
    expect(filterDocs(docs, '  onboarding ').map((d) => d.id)).toEqual(['d3']);
  });

  it('returns nothing when nothing matches, rather than falling back to all', () => {
    expect(filterDocs(docs, 'zzz')).toEqual([]);
  });

  it('keeps the incoming (newest-first) order', () => {
    expect(filterDocs([docs[1]!, docs[0]!], 'roadmap').map((d) => d.id)).toEqual(['d2', 'd1']);
  });
});

describe('collapsed-docs preference', () => {
  let store: Record<string, string>;
  beforeEach(() => {
    store = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('remembers a collapsed channel and forgets it again', () => {
    writeCollapsedDocs('factory', true);
    expect([...readCollapsedDocs()]).toEqual(['factory']);
    writeCollapsedDocs('general', true);
    expect(readCollapsedDocs().has('factory')).toBe(true);
    writeCollapsedDocs('factory', false);
    expect([...readCollapsedDocs()]).toEqual(['general']);
  });

  it('treats an unreadable preference as "nothing collapsed" instead of throwing', () => {
    // A sidebar that won't render because one localStorage key is junk is a
    // far worse outcome than a section that reopens.
    store['flow.sidebarDocsCollapsed'] = 'not json';
    expect([...readCollapsedDocs()]).toEqual([]);
    store['flow.sidebarDocsCollapsed'] = '{"factory":true}';
    expect([...readCollapsedDocs()]).toEqual([]);
  });
});

describe('DocsGroup', () => {
  let store: Record<string, string>;
  beforeEach(() => {
    store = {};
    const storage = {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    };
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('sessionStorage', storage);
    // An expanded group renders real ArtifactRows, which reach the connection
    // runtime — it wants an origin to key its registry by.
    vi.stubGlobal('location', { origin: 'https://flow.test' });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('renders nothing at all for a channel with no docs', () => {
    // The common case: every channel row must look exactly as it did before.
    expect(renderToStaticMarkup(<DocsGroup channelId="factory" docs={[]} />)).toBe('');
  });

  const many = [doc('d1', 'Q3 roadmap'), doc('d2', 'Onboarding'), doc('d3', 'Runbook'), doc('d4', 'Budget')];

  it('folds the rows away but keeps the count visible when collapsed', () => {
    store['flow.sidebarDocsCollapsed'] = JSON.stringify(['factory']);
    const html = renderToStaticMarkup(<DocsGroup channelId="factory" docs={many} />);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('4'); // the count is what says there is something hidden
    expect(html).not.toContain('Q3 roadmap');
  });

  // Expanded, the rows are real ArtifactRows, so they need the contexts the
  // sidebar normally supplies.
  const renderExpanded = (channelId: string, docs: ArtifactDTO[]) =>
    renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <SelectionContext.Provider value={{ artifactId: null } as unknown as Selection}>
          <DocsGroup channelId={channelId} docs={docs} />
        </SelectionContext.Provider>
      </QueryClientProvider>,
    );

  it('lists every doc when the channel is not collapsed', () => {
    store['flow.sidebarDocsCollapsed'] = JSON.stringify(['general']); // a different channel
    const html = renderExpanded('factory', many);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('Q3 roadmap');
    expect(html).toContain('Budget');
  });

  it('shows a short list as plain rows with no header, even if the channel was folded before', () => {
    // One to three docs: the rows alone, nested under the channel, as the
    // macOS client draws them. The header's chrome is for a list long enough
    // to need folding or filtering.
    store['flow.sidebarDocsCollapsed'] = JSON.stringify(['factory']);
    const html = renderExpanded('factory', [doc('d1', 'Task Board'), doc('d2', 'Onboarding'), doc('d3', 'Runbook')]);
    expect(html).toContain('sidebar-docs-plain-factory');
    expect(html).not.toContain('aria-expanded');
    expect(html).not.toContain('Docs');
    expect(html).not.toContain('sidebar-docs-search-factory');
    expect(html).toContain('Task Board');
    expect(html).toContain('Runbook');
  });

  it('keeps the artifact row test ids, so opening a doc is unchanged', () => {
    const html = renderExpanded('factory', [doc('d1', 'Q3 roadmap')]);
    expect(html).toContain('sidebar-artifact-Q3 roadmap');
  });
});
