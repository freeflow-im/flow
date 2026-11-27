// sites.js with an in-memory chrome.storage: node --test packages/browser-extension/sites.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

const area = () => {
  let data = {};
  return {
    get: async (key) => (key == null ? { ...data } : typeof key === 'string' ? (key in data ? { [key]: structuredClone(data[key]) } : {}) : {}),
    set: async (obj) => void (data = { ...data, ...structuredClone(obj) }),
    reset: () => void (data = {}),
  };
};
globalThis.chrome = { storage: { local: area(), session: area() } };
const { addSite, answerAsk, covers, isAllowed, listSites, normalizeSite, removeSite, siteOf, askLine } = await import('./sites.js');

test('a site is the host without www, for http(s) only', () => {
  assert.equal(siteOf('https://www.LinkedIn.com/messaging/'), 'linkedin.com');
  assert.equal(siteOf('http://127.0.0.1:8899/a.html'), '127.0.0.1');
  assert.equal(siteOf('chrome://version'), null);
  assert.equal(siteOf('not a url'), null);
});

test('what a person types becomes a site, or nothing', () => {
  assert.equal(normalizeSite(' https://www.example.com/path?q=1 '), 'example.com');
  assert.equal(normalizeSite('Docs.Google.com'), 'docs.google.com');
  assert.equal(normalizeSite('localhost'), 'localhost');
  assert.equal(normalizeSite('nodot'), null);
  assert.equal(normalizeSite('bad site.com'), null);
  assert.equal(normalizeSite(''), null);
});

test('a rule covers its site and subdomains, not look-alikes', () => {
  assert.ok(covers('linkedin.com', 'linkedin.com'));
  assert.ok(covers('linkedin.com', 'uk.linkedin.com'));
  assert.ok(!covers('linkedin.com', 'notlinkedin.com'));
  assert.ok(!covers('uk.linkedin.com', 'linkedin.com'));
});

test('always and session rules are listed, checked and removed', async () => {
  chrome.storage.local.reset();
  chrome.storage.session.reset();
  assert.equal(await isAllowed('example.com'), false);
  await addSite('example.com', 'always');
  await addSite('news.site.org', 'session');
  assert.deepEqual((await listSites()).map((r) => `${r.site}:${r.how}`), ['example.com:always', 'news.site.org:session']);
  assert.equal(await isAllowed('www2.example.com'), true);
  assert.equal(await isAllowed('site.org'), false);
  await removeSite('example.com');
  assert.equal(await isAllowed('example.com'), false);
  assert.equal((await listSites()).length, 1);
});

test('an answer allows the site as chosen, and a refusal allows nothing', async () => {
  chrome.storage.local.reset();
  chrome.storage.session.reset();
  await chrome.storage.session.set({ asks: [{ id: 'a1', site: 'linkedin.com', action: 'browser_open' }, { id: 'a2', site: 'evil.example', action: 'browser_click' }] });
  assert.equal(askLine({ site: 'linkedin.com', action: 'browser_open' }), 'Your FreeFlow assistant wants to open a page on linkedin.com.');
  await answerAsk('a1', 'session');
  await answerAsk('a2', 'deny');
  const { answers, asks } = await chrome.storage.session.get('answers').then(async (a) => ({ ...a, ...(await chrome.storage.session.get('asks')) }));
  assert.deepEqual(answers, { a1: 'session', a2: 'deny' });
  assert.deepEqual(asks, []);
  assert.equal(await isAllowed('linkedin.com'), true);
  assert.equal(await isAllowed('evil.example'), false);
  assert.equal((await chrome.storage.local.get('sites')).sites, undefined);
});
