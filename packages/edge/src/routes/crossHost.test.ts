import { describe, expect, it } from 'vitest';
import { handoffTarget, pluginHosts, secretMatches } from './crossHost';

describe('cross-host sign-in', () => {
  const hosts = pluginHosts({ PLUGIN_HOSTS: 'docs.freeflow.im, mcpdocs.freeflow.im' });

  it('sends the browser back only to a plugin host of ours, and only to one of its OAuth pages', () => {
    expect(handoffTarget('docs.freeflow.im', '/oauth/resume?p=abc', hosts)).toBe('https://docs.freeflow.im/oauth/handoff?next=%2Foauth%2Fresume%3Fp%3Dabc');
    expect(handoffTarget('MCPDocs.freeflow.im', '/oauth/resume?p=abc', hosts)).toBe('https://mcpdocs.freeflow.im/oauth/handoff?next=%2Foauth%2Fresume%3Fp%3Dabc');
    expect(handoffTarget('evil.example', '/oauth/resume?p=abc', hosts)).toBeNull();
    expect(handoffTarget('docs.freeflow.im', 'https://evil.example/', hosts)).toBeNull();
    expect(handoffTarget('docs.freeflow.im', '//evil.example/oauth/x', hosts)).toBeNull();
    expect(handoffTarget('docs.freeflow.im', '/docs', hosts)).toBeNull();
    expect(handoffTarget('docs.freeflow.im', '/oauth/resume?p=abc', [])).toBeNull();
    expect(handoffTarget(undefined, undefined, hosts)).toBeNull();
  });

  it('matches the edge secret exactly, and never an empty one', () => {
    expect(secretMatches('s3cret', 's3cret')).toBe(true);
    expect(secretMatches('s3cret', 's3creT')).toBe(false);
    expect(secretMatches('s3cre', 's3cret')).toBe(false);
    expect(secretMatches(undefined, 's3cret')).toBe(false);
    expect(secretMatches('', '')).toBe(false);
    expect(secretMatches('x', undefined)).toBe(false);
  });
});
