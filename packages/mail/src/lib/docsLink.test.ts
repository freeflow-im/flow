import { describe, expect, it } from 'vitest';
import { docsFileUrl, linkByDefault, linksBlock, memberOf, type OrgMember } from './docsLink';

const members: OrgMember[] = [
  { userId: 'u1', accountId: 'a1', email: 'ann@gmail.com', address: 'ann@acme.freeflow.im' },
  { userId: 'u2', accountId: 'a2', email: 'bob@acme.freeflow.im' },
  { userId: 'u3', email: 'agent@agents.flow.local', address: 'ada@acme.freeflow.im', isAgent: true },
];

describe('a dropped Docs file: link or attachment (side-panel.md §7.1)', () => {
  it('is a link when every recipient is a member in the sender\'s domain', () => {
    expect(linkByDefault('me@acme.freeflow.im', ['ann@acme.freeflow.im', 'Bob@Acme.freeflow.im'], members)).toBe(true);
  });

  it('is an attachment with no recipient, one outside the domain, or one in the domain who is not a member', () => {
    expect(linkByDefault('me@acme.freeflow.im', [], members)).toBe(false);
    expect(linkByDefault('me@acme.freeflow.im', ['ann@acme.freeflow.im', 'joe@other.com'], members)).toBe(false);
    expect(linkByDefault('me@acme.freeflow.im', ['stranger@acme.freeflow.im'], members)).toBe(false);
  });

  it('never counts a free mail domain as colleagues, and never an agent as a member', () => {
    expect(linkByDefault('me@gmail.com', ['ann@gmail.com'], members)).toBe(false);
    expect(memberOf('ada@acme.freeflow.im', members)).toBeNull();
    expect(memberOf('ANN@gmail.com', members)?.accountId).toBe('a1');
  });

  it('links to the file\'s page in Docs, escaped, after what was written', () => {
    expect(docsFileUrl({ kind: 'sheet', id: 'x1' }, 'https://app.test')).toBe('https://app.test/docs/s/x1');
    expect(docsFileUrl({ kind: 'deck', id: 'x2' }, 'https://app.test')).toBe('https://app.test/docs/d/x2');
    const b = linksBlock([{ kind: 'doc', id: 'd1', name: 'Q&A <draft>' }], 'https://app.test');
    expect(b.html).toBe('<p><a href="https://app.test/docs/doc/d1">Q&amp;A &lt;draft&gt;</a></p>');
    expect(b.text).toBe('Q&A <draft>: https://app.test/docs/doc/d1');
    expect(linksBlock([])).toEqual({ html: '', text: '' });
  });
});
