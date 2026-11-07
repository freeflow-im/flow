// What another page of the suite asks Chat for (platform phase 6.4): `?open=` and `?share=`, read and applied.
import { describe, expect, it } from 'vitest';
import type { ArtifactDTO, MessageDTO } from '@flow/shared';
import { createAddress, shareAddressOf } from '@flow/suite-bar';
import { applyChatIntent, readChatIntent, withoutChatIntent, type ChatIntentDeps } from './chatIntents';

const search = (url: string) => new URL(url, 'https://app.freeflow.im').search;

describe('readChatIntent', () => {
  it('reads the suite bars’ pages, an object’s address, the create and share intents', () => {
    expect(readChatIntent('?open=admin')).toEqual({ kind: 'page', page: 'admin' });
    expect(readChatIntent('?open=artifact%3Aa1')).toEqual({ kind: 'artifact', id: 'a1' });
    expect(readChatIntent('?open=message:m1')).toEqual({ kind: 'message', id: 'm1' });
    expect(readChatIntent(search(createAddress('chat-message', { channel: 'c1', text: 'Hello there' })))).toEqual({ kind: 'channel', id: 'c1', text: 'Hello there' });
    expect(readChatIntent(search(shareAddressOf({ organizationId: 'o', app: 'chat', kind: 'artifact', id: 'a1' })!))).toEqual({ kind: 'share', ref: { organizationId: 'o', app: 'chat', kind: 'artifact', id: 'a1' } });
    for (const junk of ['', '?open=', '?open=nonsense', '?open=folder:x', '?share=not-a-ref']) expect([junk, readChatIntent(junk)]).toEqual([junk, null]);
  });

  it('is taken off the address, leaving the rest', () => {
    expect(withoutChatIntent('?open=channel%3Ac1&text=hi')).toBe('');
    expect(withoutChatIntent('?share=o%2Fchat%2Fartifact%2Fa&x=1')).toBe('?x=1');
  });
});

describe('applyChatIntent', () => {
  function deps(answers: Record<string, unknown>, channels = ['c1']) {
    const did: string[] = [];
    const d: ChatIntentDeps = {
      api: async <T,>(_m: string, path: string) => { if (!(path in answers)) throw new Error('404'); return answers[path] as T; },
      channelIds: () => channels,
      openArtifactIn: (c, a) => did.push(`openArtifactIn ${c} ${a}`),
      selectArtifact: (a) => did.push(`selectArtifact ${a}`),
      selectChannel: (c) => did.push(`selectChannel ${c}`),
      jumpToMessage: (c, m, t) => did.push(`jumpToMessage ${c} ${m} ${t}`),
      setDraft: (c, t) => did.push(`setDraft ${c} ${t}`),
      shareArtifact: (a) => did.push(`shareArtifact ${a}`),
      notice: (t) => did.push(`notice ${t}`),
    };
    return { d, did };
  }
  const artifact = (id: string, channelId: string) => ({ id, channelId } as ArtifactDTO);

  it('?open=artifact:<id> opens the artifact panel on it: in its channel for a member, over this one for someone it was shared with', async () => {
    let t = deps({ '/v1/artifacts/a1': artifact('a1', 'c1') });
    await applyChatIntent({ kind: 'artifact', id: 'a1' }, t.d);
    expect(t.did).toEqual(['openArtifactIn c1 a1']);
    t = deps({ '/v1/artifacts/a2': artifact('a2', 'secret') });
    await applyChatIntent({ kind: 'artifact', id: 'a2' }, t.d);
    expect(t.did).toEqual(['selectArtifact a2']);
    t = deps({});
    await applyChatIntent({ kind: 'artifact', id: 'gone' }, t.d);
    expect(t.did).toEqual(['notice That artifact is not shared with you.']);
  });

  it('?open=message:<id> scrolls to it in its channel (its thread for a reply); ?open=channel:<id> fills the composer', async () => {
    let t = deps({ '/v1/messages/r1': { id: 'r1', channelId: 'c1', threadRootId: 'm0' } as MessageDTO });
    await applyChatIntent({ kind: 'message', id: 'r1' }, t.d);
    expect(t.did).toEqual(['jumpToMessage c1 r1 m0']);
    t = deps({});
    await applyChatIntent({ kind: 'channel', id: 'c1', text: 'Hi' }, t.d);
    expect(t.did).toEqual(['setDraft c1 Hi', 'selectChannel c1']);
    t = deps({});
    await applyChatIntent({ kind: 'channel', id: 'elsewhere' }, t.d);
    expect(t.did).toEqual(['notice That channel is not available to you.']);
  });

  it('?share=<ref> opens an artifact’s Share dialog; another app’s object is not Chat’s to share', async () => {
    let t = deps({});
    await applyChatIntent({ kind: 'share', ref: { organizationId: 'o', app: 'chat', kind: 'artifact', id: 'a1' } }, t.d);
    expect(t.did).toEqual(['shareArtifact a1']);
    t = deps({});
    await applyChatIntent({ kind: 'share', ref: { organizationId: 'o', app: 'docs', kind: 'sheet', id: 's' } }, t.d);
    expect(t.did).toEqual(['notice That cannot be shared from Chat.']);
  });
});
