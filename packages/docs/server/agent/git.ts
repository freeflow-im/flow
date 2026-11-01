// Git and GitHub for app-change jobs: turning the deployed source tree into a checkout, snapshotting the
// working tree before and after a job, and publishing a change as a pull request that is merged at once.
import { execFile } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface GitHubConfig {
  /** "owner/repo" */
  repo: string;
  token: string;
  /** Overrides for testing against a fake GitHub and a local bare repository. */
  apiUrl?: string;
  remoteUrl?: string;
}

/** Where to publish, from the environment: GITHUB_TOKEN plus GITHUB_REPO. */
export function githubConfig(env: NodeJS.ProcessEnv = process.env): GitHubConfig | null {
  const token = env.GITHUB_TOKEN;
  const repo = env.GITHUB_REPO;
  if (!token || !repo) return null;
  return { repo, token, ...(env.GITHUB_API_URL ? { apiUrl: env.GITHUB_API_URL } : {}), ...(env.GITHUB_REMOTE_URL ? { remoteUrl: env.GITHUB_REMOTE_URL } : {}) };
}

export class Git {
  readonly root: string;
  private env: NodeJS.ProcessEnv;

  constructor(root: string, env: NodeJS.ProcessEnv = process.env) {
    this.root = root;
    // Commit as the assistant. Nothing here reads the user's git identity.
    this.env = { ...env, GIT_AUTHOR_NAME: 'Sheets Assistant', GIT_AUTHOR_EMAIL: 'assistant@sheets.local', GIT_COMMITTER_NAME: 'Sheets Assistant', GIT_COMMITTER_EMAIL: 'assistant@sheets.local' };
  }

  async git(args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv } = {}): Promise<string> {
    const child = run('git', args, { cwd: this.root, env: { ...this.env, ...opts.env }, maxBuffer: 64 * 1024 * 1024 });
    if (opts.input !== undefined) {
      child.child.stdin!.end(opts.input);
    }
    const { stdout } = await child;
    return stdout;
  }

  hasRepo(): boolean {
    return existsSync(path.join(this.root, '.git'));
  }

  /**
   * Make the source tree a git checkout of the commit it was deployed from, without touching any file: the
   * production container has the files of one commit but no .git. Afterwards `git status` shows only what
   * changes from here on.
   */
  async ensureRepo(remoteUrl: string, sha: string | undefined): Promise<void> {
    if (this.hasRepo()) return;
    await this.git(['init', '-q', '-b', 'main']);
    await this.git(['remote', 'add', 'origin', remoteUrl]);
    await this.git(['fetch', '-q', '--depth', '1', 'origin', sha ?? 'main']);
    await this.git(['reset', '-q', '--mixed', 'FETCH_HEAD']);
  }

  async isClean(): Promise<boolean> {
    return (await this.git(['status', '--porcelain', '--untracked-files=all'])).trim() === '';
  }

  /** Bring main up to date with the remote when nothing is in progress locally, so a change is based on the latest code. */
  async syncMain(remote: { url: string; token?: string }): Promise<boolean> {
    if (!(await this.isClean())) return false;
    await this.fetch(remote, 'main');
    await this.git(['checkout', '-q', '-B', 'main', 'FETCH_HEAD']);
    return true;
  }

  /** A clone made by ensureRepo is shallow and stays so; a full clone (local development) keeps its history. */
  private fetch(remote: { url: string; token?: string }, ref: string): Promise<string> {
    const shallow = existsSync(path.join(this.root, '.git', 'shallow'));
    return this.withCredentials(remote.token, ['fetch', '-q', ...(shallow ? ['--depth', '1'] : []), remote.url, ref]);
  }

  /** A tree object of the whole working tree (tracked and untracked, not ignored), without touching the index. */
  async snapshotTree(): Promise<string> {
    const index = path.join(this.root, '.git', `agent-index-${process.pid}`);
    const env = { GIT_INDEX_FILE: index };
    await this.git(['read-tree', '--empty'], { env });
    await this.git(['add', '-A', '--', '.'], { env });
    const tree = (await this.git(['write-tree'], { env })).trim();
    await run('rm', ['-f', index]);
    return tree;
  }

  async changedFiles(fromTree: string, toTree: string): Promise<string[]> {
    const out = await this.git(['diff', '--name-only', fromTree, toTree]);
    return out.split('\n').filter(Boolean).sort();
  }

  async diff(fromTree: string, toTree: string): Promise<string> {
    return this.git(['diff', '--binary', fromTree, toTree]);
  }

  /**
   * Put the working tree back the way it was in a snapshot, for the files that differ from it now: a failed
   * job's edits are undone (files it created are deleted). The index is not touched.
   */
  async restoreTree(tree: string): Promise<string[]> {
    const files = await this.changedFiles(tree, await this.snapshotTree());
    if (!files.length) return [];
    const inTree = new Set((await this.git(['ls-tree', '-r', '--name-only', tree, '--', ...files])).split('\n').filter(Boolean));
    const existed = files.filter((f) => inTree.has(f));
    if (existed.length) await this.git(['restore', `--source=${tree}`, '--worktree', '--', ...existed]);
    for (const f of files) if (!inTree.has(f)) rmSync(path.join(this.root, f), { force: true });
    return files;
  }

  /** Apply a patch in reverse. Throws when it no longer applies cleanly. */
  async revertPatch(patch: string): Promise<void> {
    await this.git(['apply', '-R', '--whitespace=nowarn', '--recount', '-'], { input: patch });
  }

  /** Commit the given files on a new branch and push it; returns the commit sha. HEAD stays on the branch. */
  async commitOnBranch(branch: string, files: string[], message: string, remote: { url: string; token?: string }): Promise<string> {
    await this.git(['checkout', '-q', '-B', branch]);
    await this.git(['add', '-A', '--', ...files]);
    await this.git(['commit', '-q', '--allow-empty', '-F', '-'], { input: message });
    const sha = (await this.git(['rev-parse', 'HEAD'])).trim();
    await this.withCredentials(remote.token, ['push', '-q', '--force', remote.url, `HEAD:refs/heads/${branch}`]);
    return sha;
  }

  /** After a merge: point main at the remote's main (its tree matches the working tree) and drop the branch. */
  async finishBranch(branch: string, remote: { url: string; token?: string }): Promise<void> {
    await this.fetch(remote, 'main');
    await this.git(['checkout', '-q', '-B', 'main']);
    await this.git(['reset', '-q', '--mixed', 'FETCH_HEAD']);
    await this.git(['branch', '-q', '-D', branch]);
  }

  /**
   * Go back to main after a failed publish, keeping the job's changes in the working tree (they are live):
   * the branch is first moved onto main, so switching branches changes no file.
   */
  async abandonBranch(branch: string): Promise<void> {
    await this.git(['reset', '-q', '--mixed', 'main']);
    await this.git(['checkout', '-q', 'main']);
    await this.git(['branch', '-q', '-D', branch]);
  }

  /**
   * Run a git command that talks to the remote. The token reaches git through a credential helper that reads
   * it from the environment, so it never appears in a URL, the command line, an error message or git config.
   */
  private withCredentials(token: string | undefined, args: string[]): Promise<string> {
    if (!token) return this.git(args);
    return this.git(['-c', 'credential.helper=!f() { echo username=x-access-token; echo "password=$AGENT_GIT_TOKEN"; }; f', ...args], { env: { AGENT_GIT_TOKEN: token } });
  }
}

// ---------------------------------------------------------------------------
// GitHub API

export class GitHub {
  private cfg: GitHubConfig;
  private fetchFn: typeof fetch;

  constructor(cfg: GitHubConfig, fetchFn: typeof fetch = fetch) {
    this.cfg = cfg;
    this.fetchFn = fetchFn;
  }

  get remoteUrl(): string {
    return this.cfg.remoteUrl ?? `https://github.com/${this.cfg.repo}.git`;
  }

  async createPullRequest(args: { branch: string; title: string; body: string; base?: string }): Promise<{ number: number; url: string }> {
    const pr = (await this.api('POST', `/repos/${this.cfg.repo}/pulls`, { title: args.title, body: args.body, head: args.branch, base: args.base ?? 'main' })) as {
      number: number;
      html_url: string;
    };
    return { number: pr.number, url: pr.html_url };
  }

  async mergePullRequest(number: number, title: string): Promise<string> {
    const res = (await this.api('PUT', `/repos/${this.cfg.repo}/pulls/${number}/merge`, { merge_method: 'squash', commit_title: title })) as { sha: string; merged: boolean };
    if (!res.merged) throw new Error('GitHub did not merge the pull request.');
    return res.sha;
  }

  async deleteBranch(branch: string): Promise<void> {
    await this.api('DELETE', `/repos/${this.cfg.repo}/git/refs/heads/${branch}`).catch(() => {});
  }

  private async api(method: string, pathname: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchFn(`${this.cfg.apiUrl ?? 'https://api.github.com'}${pathname}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.cfg.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        const j = JSON.parse(text) as { message?: string; errors?: { message?: string }[] };
        message = [j.message, ...(j.errors ?? []).map((e) => e.message)].filter(Boolean).join(': ');
      } catch {
        // keep raw text
      }
      throw new Error(`GitHub ${method} ${pathname} failed (${res.status}): ${message}`);
    }
    return text ? JSON.parse(text) : null;
  }
}
