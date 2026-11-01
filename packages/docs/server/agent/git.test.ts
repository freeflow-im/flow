import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Git, GitHub, githubConfig } from './git.ts';

// A bare "GitHub" repository on disk, a checkout to seed it from, and a bare directory of files that stands in
// for the production container (the deployed files, no .git).
let root: string;
let origin: string;
let deployed: string;
let sha: string;

const sh = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }).trim();

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'sheetsweb-git-test-'));
  origin = path.join(root, 'origin.git');
  sh(root, ['init', '-q', '--bare', origin]);
  const seed = path.join(root, 'seed');
  mkdirSync(seed);
  sh(seed, ['init', '-q', '-b', 'main']);
  writeFileSync(path.join(seed, 'a.txt'), 'one\n');
  writeFileSync(path.join(seed, '.gitignore'), 'build/\n');
  sh(seed, ['add', '-A']);
  sh(seed, ['commit', '-q', '-m', 'initial']);
  sha = sh(seed, ['rev-parse', 'HEAD']);
  sh(seed, ['push', '-q', origin, 'main']);
  // "Deploy": copy the files without .git, plus a build artifact.
  deployed = path.join(root, 'deployed');
  mkdirSync(path.join(deployed, 'build'), { recursive: true });
  writeFileSync(path.join(deployed, 'a.txt'), 'one\n');
  writeFileSync(path.join(deployed, '.gitignore'), 'build/\n');
  writeFileSync(path.join(deployed, 'build', 'out.js'), '//');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('git for app-change jobs', () => {
  it('turns deployed files into a clean checkout of the deployed commit', async () => {
    const git = new Git(deployed);
    expect(git.hasRepo()).toBe(false);
    await git.ensureRepo(origin, sha);
    expect(git.hasRepo()).toBe(true);
    expect(await git.isClean()).toBe(true);
    expect((await git.git(['rev-parse', 'HEAD'])).trim()).toBe(sha);
    expect(readFileSync(path.join(deployed, 'build', 'out.js'), 'utf8')).toBe('//'); // untouched
    await git.ensureRepo(origin, sha); // idempotent
  });

  it('records what a job changed and can apply it in reverse', async () => {
    const git = new Git(deployed);
    const before = await git.snapshotTree();
    writeFileSync(path.join(deployed, 'a.txt'), 'one\ntwo\n');
    writeFileSync(path.join(deployed, 'new.txt'), 'hello\n');
    writeFileSync(path.join(deployed, 'build', 'out.js'), '// rebuilt'); // ignored: not a change
    const after = await git.snapshotTree();
    expect(await git.changedFiles(before, after)).toEqual(['a.txt', 'new.txt']);
    const patch = await git.diff(before, after);
    expect(patch).toContain('+two');
    expect(patch).toContain('new.txt');
    expect(await git.isClean()).toBe(false); // the snapshot leaves the real index alone

    await git.revertPatch(patch);
    expect(readFileSync(path.join(deployed, 'a.txt'), 'utf8')).toBe('one\n');
    expect(await git.isClean()).toBe(true);
    // Re-apply for the publishing test below.
    await git.git(['apply', '--whitespace=nowarn', '-'], { input: patch });
    expect(await git.isClean()).toBe(false);
  });

  it('commits the job files on a branch, pushes, and returns to main after a merge', async () => {
    const git = new Git(deployed);
    // A token is passed (through the credential helper) even though a file remote never asks for it.
    const commit = await git.commitOnBranch('assistant/test', ['a.txt', 'new.txt'], 'Add two\n\nRecord.\n', { url: origin, token: 'secret' });
    expect(sh(root, ['-C', origin, 'rev-parse', 'refs/heads/assistant/test'])).toBe(commit);
    expect(sh(root, ['-C', origin, 'log', '-1', '--format=%an %s', 'assistant/test'])).toBe('Sheets Assistant Add two');

    // Simulate GitHub squash-merging into main.
    const merger = path.join(root, 'merger');
    sh(root, ['clone', '-q', origin, merger]);
    sh(merger, ['merge', '-q', '--squash', 'origin/assistant/test']);
    sh(merger, ['commit', '-q', '-m', 'Add two (#1)']);
    sh(merger, ['push', '-q', 'origin', 'main']);
    const merged = sh(merger, ['rev-parse', 'HEAD']);

    await git.finishBranch('assistant/test', { url: origin, token: 'secret' });
    expect((await git.git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('main');
    expect((await git.git(['rev-parse', 'HEAD'])).trim()).toBe(merged);
    expect(await git.isClean()).toBe(true);
    expect(readFileSync(path.join(deployed, 'new.txt'), 'utf8')).toBe('hello\n');
  });

  it('syncs main from the remote only when nothing is in progress', async () => {
    const git = new Git(deployed);
    writeFileSync(path.join(deployed, 'wip.txt'), 'x');
    expect(await git.syncMain({ url: origin })).toBe(false);
    rmSync(path.join(deployed, 'wip.txt'));
    expect(await git.syncMain({ url: origin })).toBe(true);
  });

  it('keeps the working tree when a publish is abandoned, and keeps a full clone full', async () => {
    const full = path.join(root, 'full');
    sh(root, ['clone', '-q', origin, full]);
    const git = new Git(full);
    writeFileSync(path.join(full, 'a.txt'), 'changed by a job\n');
    await git.commitOnBranch('assistant/fail', ['a.txt'], 'msg', { url: path.join(root, 'missing.git') }).catch(() => {});
    await git.abandonBranch('assistant/fail');
    expect((await git.git(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()).toBe('main');
    expect((await git.git(['branch', '--list', 'assistant/fail'])).trim()).toBe('');
    expect(readFileSync(path.join(full, 'a.txt'), 'utf8')).toBe('changed by a job\n'); // still live on disk
    expect(await git.isClean()).toBe(false);
    // Syncing a full clone does not make it shallow.
    await git.git(['checkout', '-q', 'HEAD', '--', 'a.txt']);
    expect(await git.syncMain({ url: origin })).toBe(true);
    expect(existsSync(path.join(full, '.git', 'shallow'))).toBe(false);
    expect((await git.git(['rev-list', '--count', 'HEAD'])).trim()).not.toBe('1');
  });

  it('puts back the files a failed job changed, and only those', async () => {
    const dir = path.join(root, 'restore');
    sh(root, ['clone', '-q', origin, dir]);
    const git = new Git(dir);
    writeFileSync(path.join(dir, 'mine.txt'), 'the user was working on this\n');
    sh(dir, ['add', 'mine.txt']);
    const original = readFileSync(path.join(dir, 'a.txt'), 'utf8');
    const before = await git.snapshotTree();
    writeFileSync(path.join(dir, 'a.txt'), 'broken\n');
    writeFileSync(path.join(dir, 'made-by-job.txt'), 'x');
    expect(await git.restoreTree(before)).toEqual(['a.txt', 'made-by-job.txt']);
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe(original);
    expect(existsSync(path.join(dir, 'made-by-job.txt'))).toBe(false);
    expect(readFileSync(path.join(dir, 'mine.txt'), 'utf8')).toBe('the user was working on this\n');
    expect(sh(dir, ['diff', '--cached', '--name-only'])).toBe('mine.txt'); // the index is left as it was
    expect(await git.restoreTree(before)).toEqual([]);
  });

  it('reads the GitHub configuration from the environment', () => {
    expect(githubConfig({})).toBeNull();
    expect(githubConfig({ GITHUB_TOKEN: 't' })).toBeNull();
    expect(githubConfig({ GITHUB_TOKEN: 't', GITHUB_REPO: 'a/b' })).toEqual({ token: 't', repo: 'a/b' });
  });

  it('opens and merges pull requests through the GitHub API', async () => {
    const calls: { method: string; url: string; body: unknown }[] = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ method: init?.method ?? 'GET', url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (String(url).endsWith('/pulls')) return new Response(JSON.stringify({ number: 7, html_url: 'https://github.com/a/b/pull/7' }), { status: 201 });
      if (String(url).endsWith('/merge')) return new Response(JSON.stringify({ merged: true, sha: 'abc123' }), { status: 200 });
      if (init?.method === 'DELETE') return new Response('', { status: 204 });
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    }) as typeof fetch;
    const hub = new GitHub({ repo: 'a/b', token: 'tok' }, fakeFetch);
    expect(hub.remoteUrl).toBe('https://github.com/a/b.git');
    expect(await hub.createPullRequest({ branch: 'assistant/x', title: 'T', body: 'B' })).toEqual({ number: 7, url: 'https://github.com/a/b/pull/7' });
    expect(await hub.mergePullRequest(7, 'T (#7)')).toBe('abc123');
    await hub.deleteBranch('assistant/x');
    expect(calls.map((c) => `${c.method} ${c.url.replace('https://api.github.com', '')}`)).toEqual([
      'POST /repos/a/b/pulls',
      'PUT /repos/a/b/pulls/7/merge',
      'DELETE /repos/a/b/git/refs/heads/assistant/x',
    ]);
    expect(calls[0].body).toMatchObject({ head: 'assistant/x', base: 'main', title: 'T' });
    expect(calls[1].body).toMatchObject({ merge_method: 'squash' });
    const failing = new GitHub({ repo: 'a/b', token: 'tok' }, (async () => new Response(JSON.stringify({ message: 'Bad' }), { status: 422 })) as typeof fetch);
    await expect(failing.createPullRequest({ branch: 'b', title: 't', body: '' })).rejects.toThrow(/422.*Bad/);
  });
});
