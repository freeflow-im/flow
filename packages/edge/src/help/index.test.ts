import { describe, expect, it } from 'vitest';
import { getPage, listTopics, parseFrontMatter } from './index';

const bundle = {
  files: {
    home: '---\ntitle: Getting started\norder: 1\n---\n\n# Hello\n',
    'no-title': '# Untitled\n',
    'whats-new': '---\ntitle: Shadow\n---\nnope\n',
    'Bad_Name': 'x',
    crlf: '---\r\ntitle: Windows\r\norder: 2\r\n---\r\nline one\r\nline two\r\n',
  },
  features: '# What\'s new in Flow\n\n- A thing\n\n',
};

describe('help', () => {
  it('lists topics in order, with What\'s New, never a shadowing or badly named file', () => {
    expect(listTopics(bundle)).toEqual([
      { slug: 'home', title: 'Getting started', order: 1 },
      { slug: 'crlf', title: 'Windows', order: 2 },
      { slug: 'whats-new', title: "What's New", order: 90 },
      { slug: 'no-title', title: 'no title', order: 100 },
    ]);
    expect(listTopics({ ...bundle, features: null }).map((t) => t.slug)).not.toContain('whats-new');
  });
  it('serves a page without its front-matter, and What\'s New from the changelog', () => {
    expect(getPage('home', bundle)).toEqual({ slug: 'home', title: 'Getting started', markdown: '# Hello\n' });
    expect(getPage('crlf', bundle).markdown).toBe('line one\nline two\n');
    expect(getPage('whats-new', bundle)).toEqual({ slug: 'whats-new', title: "What's New", markdown: "# What's new in Flow\n\n- A thing\n" });
  });
  it('404s an unknown or unsafe slug', () => {
    for (const slug of ['nope', '../home', 'Bad_Name', 'constructor', '__proto__']) expect(() => getPage(slug, bundle)).toThrow('no such help page');
    expect(() => getPage('whats-new', { ...bundle, features: null })).toThrow('no such help page');
  });
  it('reads front-matter keys in any case, quoted or not', () => {
    expect(parseFrontMatter('---\nTitle: "Quoted"\norder: 3\n---\nbody').meta).toEqual({ title: 'Quoted', order: '3' });
  });
  it('bundles the repository\'s help, with What\'s New', () => {
    const topics = listTopics();
    expect(topics.length).toBeGreaterThan(3);
    expect(topics.some((t) => t.slug === 'whats-new')).toBe(true);
    for (const t of topics) expect(getPage(t.slug).markdown.length).toBeGreaterThan(10);
  });
});
