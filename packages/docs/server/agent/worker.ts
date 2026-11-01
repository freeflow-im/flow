// Worker process for one app-change job: `node server/agent/worker.ts <jobId>`.
//
// Steps: make sure the source tree is a git checkout (production has no .git) → snapshot the tree → run
// Claude Code with the job's spec (or apply the original change's patch in reverse for a revert) → verify
// with typecheck and tests → in production rebuild the client and ask the server to restart → publish the
// change to GitHub as a pull request that is merged at once → record the change. Progress goes to the
// agent_jobs table. Launched detached by JobRunner so it survives the server restarting.
// A job that fails puts the files it changed back the way they were.
import '../env.ts';
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { displayValue } from '../../shared/agent/sheetRead.ts';
import { Engine } from '../../shared/formula/engine.ts';
import { openDb } from '../db.ts';
import { SheetStore } from '../sheets.ts';
import { Git, GitHub, githubConfig } from './git.ts';
import { JobStore, REPO_ROOT, type JobRecord } from './jobs.ts';

const run = promisify(execFile);

const TIMEOUT_MS = 25 * 60 * 1000;
/** How many times the coding agent is sent back to fix failing checks. */
const MAX_FIX_ROUNDS = 2;
const MAX_CODING_TURNS = 150;
const MAX_RESEARCH_TURNS = 80;
const MAX_RESEARCH_USD = 5;
const CHANGELOG = 'CHANGELOG.md';

const jobId = process.argv[2];
if (!jobId) {
  console.error('usage: worker.ts <jobId>');
  process.exit(2);
}

const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(REPO_ROOT, 'data'));
const db = openDb(path.join(dataDir, 'app.db'));
const store = new JobStore(db);
const job = store.get(jobId);
if (!job) {
  console.error(`no job ${jobId}`);
  process.exit(2);
}

const production = process.env.NODE_ENV === 'production';
/** The server runs under server/supervise.ts and can be asked to restart. */
const supervised = process.env.SUPERVISED === '1' && !!process.env.AGENT_SERVER_PID;
const github = githubConfig();
const git = new Git(REPO_ROOT);

const log = (line: string) => {
  console.log(`[${new Date().toISOString()}] ${line}`);
  store.appendLog(jobId, line);
};

const RULES = `## Requirements

- Make the smallest change that fully implements the request, following the patterns in CLAUDE.md and the existing code.
- Add or update tests for what you change.
- Run \`npm run typecheck\` and \`npm test\`, and fix any failures before you finish.
- Do not commit. Leave the changes in the working tree.
- Do not modify ${CHANGELOG}, files under data/, any .env file, server/auth.ts, or anything under server/agent/ other than tools.ts and prompt.ts.
- When you are done, reply with only a short summary (two to four sentences) of what you changed. Name any new assistant tool and say what it does and what its inputs are. This summary is shown to the user and given to the assistant so it can use the new capability.`;

const abort = new AbortController();
const timer = setTimeout(() => abort.abort(), TIMEOUT_MS);
/** The working tree before the job touched it, so a failure can put it back. */
let before: string | null = null;
/** Whether dist/client was rebuilt from the job's files (it is not in git, so a rollback rebuilds it). */
let built = false;

try {
  store.setStatus(jobId, 'coding', { pid: process.pid });

  // Research tasks never touch the app: run them in a scratch folder and record the report.
  if (job.kind === 'research') {
    const { report, cost } = await research(job);
    store.setStatus(jobId, 'done', { summary: report, costUsd: cost });
    log('Done.');
    process.exit();
  }

  const original = job.kind === 'revert' && job.revertsJobId ? store.get(job.revertsJobId) : null;
  if (job.kind === 'revert' && !original) throw new Error('The change to revert no longer exists.');

  // 1. A git checkout to work in. In production the container has the deployed files but no .git.
  if (github) {
    const hub = new GitHub(github);
    await git.ensureRepo(hub.remoteUrl, process.env.GIT_COMMIT_SHA);
    if (await git.syncMain({ url: hub.remoteUrl, token: github.token })) log('Source tree matches the latest main.');
  } else if (!git.hasRepo()) {
    throw new Error('The source tree is not a git repository and GITHUB_TOKEN is not set, so changes could not be recorded.');
  }
  before = await git.snapshotTree();

  // 2. Make the change.
  let summary = '';
  let cost = 0;
  let sessionId: string | undefined;
  if (job.kind === 'revert') {
    summary = await revert(original!);
  } else {
    const outcome = await code(changePrompt(job));
    if (outcome.aborted) throw new Error('The job took too long and was stopped.');
    ({ summary, cost, sessionId } = outcome);
  }

  // 3. Verify, sending the coding agent back to fix failures.
  for (let round = 0; ; round++) {
    store.setStatus(jobId, 'verifying');
    const problem = await verify();
    if (!problem) break;
    if (round >= MAX_FIX_ROUNDS) throw new Error(`The checks failed after the change:\n${problem}`);
    log('Checks failed; asking the coding agent to fix them…');
    store.setStatus(jobId, 'coding');
    const fix = await code(fixPrompt(problem), sessionId);
    if (fix.aborted) throw new Error('The job took too long and was stopped.');
    summary = fix.summary || summary;
    sessionId = fix.sessionId ?? sessionId;
    cost += fix.cost;
  }

  // 4. What changed, as the record for the Changes page and for a later revert.
  const after = await git.snapshotTree();
  const files = await git.changedFiles(before, after);
  const patch = files.length ? await git.diff(before, after) : '';
  log(files.length ? `Changed ${files.length} file${files.length === 1 ? '' : 's'}.` : 'No files were changed.');
  summary = summary || (job.kind === 'revert' ? `Reverted "${original!.title}".` : 'The change was made.');
  store.setStatus(jobId, 'verifying', { summary, files, patch, costUsd: cost });

  // 5. Production: rebuild the client and restart the server so the change is live right away.
  if (production) {
    store.setStatus(jobId, 'building');
    log('Building the client…');
    built = true;
    await run('npm', ['run', 'build'], { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024, signal: abort.signal });
    log('Build finished.');
  }
  if (supervised) {
    store.setStatus(jobId, 'restarting');
    if (!(await restartServer())) throw new Error('The app did not start again with the change.');
  }

  // 6. Publish: commit on a branch, push, open a pull request and merge it. The change is already live, so a
  // failure here is recorded on the job rather than failing it.
  if (github) {
    store.setStatus(jobId, 'publishing');
    try {
      await publish(job, original, summary, files);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(`Publishing failed: ${message}`);
      store.setStatus(jobId, 'done', { error: `The change is live but could not be published to GitHub: ${message}` });
      if (original) store.markReverted(original.id, jobId);
      process.exit();
    }
  } else {
    log('GITHUB_TOKEN is not set; leaving the change uncommitted in the working tree.');
  }

  if (original) store.markReverted(original.id, jobId);
  store.setStatus(jobId, 'done');
  log('Done.');
} catch (e) {
  const message = e instanceof Error ? e.message : String(e);
  log(`Failed: ${message}`);
  // Leave nothing half-done on disk: the server loads its code from these files the next time it starts.
  if (before) {
    try {
      const restored = await git.restoreTree(before);
      if (restored.length) log(`Put back ${restored.length} file${restored.length === 1 ? '' : 's'} the job changed.`);
      if (built) {
        log('Building the client again without the change…');
        await run('npm', ['run', 'build'], { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 });
      }
    } catch (err) {
      log(`Could not put back the files the job changed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
    }
  }
  store.setStatus(jobId, 'failed', { error: message });
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  // The SDK's CLI subprocess can keep the event loop alive; the job is recorded, so leave explicitly.
  process.exit();
}

// ---------------------------------------------------------------------------
// Coding

/**
 * Environment for Claude Code (the coding and research jobs). It never gets the GitHub token, and it uses
 * CODING_API_KEY as its credential when set, so the jobs can be billed apart from the live assistant.
 * CODING_API_KEY may be an API key (sk-ant-api...) or a Claude Code OAuth token from `claude setup-token`
 * (sk-ant-oat...); the latter goes in CLAUDE_CODE_OAUTH_TOKEN, and the live assistant's API key is removed
 * so it cannot shadow the token.
 */
function claudeCodeEnv(): Record<string, string> {
  const { GITHUB_TOKEN: _token, CODING_API_KEY: codingKey, ...env } = process.env;
  const key = codingKey?.trim();
  if (key?.startsWith('sk-ant-oat')) {
    delete env.ANTHROPIC_API_KEY;
    env.CLAUDE_CODE_OAUTH_TOKEN = key;
  } else if (key) {
    env.ANTHROPIC_API_KEY = key;
  }
  return env as Record<string, string>;
}

/** CODING_MODEL pins the model Claude Code runs on; unset, Claude Code uses its own default. */
function codingModel(): Pick<Options, 'model'> {
  const model = process.env.CODING_MODEL?.trim();
  return model ? { model } : {};
}

/** One Claude Code session (or a resumed one) over the repository. */
async function code(prompt: string, resume?: string): Promise<{ summary: string; sessionId?: string; cost: number; aborted: boolean }> {
  const options: Options = {
    cwd: REPO_ROOT,
    abortController: abort,
    env: claudeCodeEnv(),
    ...codingModel(),
    // Loads CLAUDE.md, which explains the codebase and how to add an assistant tool.
    settingSources: ['project'],
    permissionMode: 'acceptEdits',
    allowedTools: [
      'Read',
      'Edit',
      'Write',
      'MultiEdit',
      'Glob',
      'Grep',
      'Bash(npm run typecheck)',
      'Bash(npm run typecheck:*)',
      'Bash(npm test)',
      'Bash(npm test:*)',
      'Bash(npx vitest:*)',
      'Bash(npx tsc:*)',
      'Bash(git status:*)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
      'Bash(ls:*)',
      'Bash(cat:*)',
    ],
    maxTurns: MAX_CODING_TURNS,
    ...(resume ? { resume } : {}),
  };

  let summary = '';
  let sessionId: string | undefined;
  let cost = 0;
  let failure: string | null = null;
  try {
    for await (const m of query({ prompt, options })) {
      const line = describe(m);
      if (line) log(line);
      if (m.type === 'system' && m.subtype === 'init') sessionId = m.session_id;
      if (m.type === 'result') {
        cost = m.total_cost_usd;
        if (m.subtype === 'success') summary = m.result.trim();
        else failure = m.errors.join('\n') || `The coding agent stopped (${m.subtype.replace(/_/g, ' ')}).`;
      }
    }
  } catch (e) {
    if (abort.signal.aborted) return { summary, sessionId, cost, aborted: true };
    throw e;
  }
  if (abort.signal.aborted) return { summary, sessionId, cost, aborted: true };
  if (failure) throw new Error(failure);
  return { summary, sessionId, cost, aborted: false };
}

function changePrompt(job: JobRecord): string {
  return `You are making a change to this app that its built-in assistant requested on behalf of a user. Read CLAUDE.md first: it explains the codebase and exactly how to add an assistant tool.

## Change requested: ${job.title}

${job.spec}

${RULES}`;
}

function fixPrompt(problem: string): string {
  return `After your change, the project checks fail. Fix the problems, run \`npm run typecheck\` and \`npm test\` again until both pass, then reply with the same kind of short summary as before.

\`\`\`
${problem.slice(0, 12_000)}
\`\`\``;
}

function revertPrompt(original: JobRecord): string {
  return `Undo an earlier change to this app. The change is described below, with the exact patch it made. Reverse it completely: remove what it added (tools, schemas, labels, tests, UI) and restore what it altered, while keeping anything added since then working. Read CLAUDE.md first for the codebase layout.

## Change to undo: ${original.title}

${original.summary ?? ''}

Files it changed: ${(original.files ?? []).join(', ') || 'unknown'}

## The original patch

\`\`\`diff
${(original.patch ?? '').slice(0, 60_000)}
\`\`\`

${RULES.replace('Name any new assistant tool and say what it does and what its inputs are. ', '')}`;
}

/** Undo an earlier change: apply its patch in reverse, or have the coding agent do it when the code has moved on. */
async function revert(original: JobRecord): Promise<string> {
  if (!original.patch) throw new Error('No patch was recorded for that change, so it cannot be reverted automatically.');
  log(`Reverting "${original.title}"…`);
  try {
    await git.revertPatch(original.patch);
    log('The original patch applied in reverse.');
    return `Reverted "${original.title}" by applying its patch in reverse.`;
  } catch (e) {
    log(`The patch no longer applies cleanly (${e instanceof Error ? e.message.split('\n')[0] : String(e)}); asking the coding agent to undo it.`);
  }
  const outcome = await code(revertPrompt(original));
  if (outcome.aborted) throw new Error('The job took too long and was stopped.');
  store.setStatus(jobId, 'coding', { costUsd: outcome.cost });
  return outcome.summary || `Reverted "${original.title}".`;
}

/** A one-line progress description of a Claude Code message, or null for messages not worth showing. */
function describe(m: SDKMessage): string | null {
  if (m.type === 'system' && m.subtype === 'init') return `Claude Code ${m.claude_code_version} started.`;
  if (m.type !== 'assistant') return null;
  const lines: string[] = [];
  for (const block of m.message.content) {
    if (block.type === 'text') {
      const t = block.text.trim().replace(/\s+/g, ' ');
      if (t) lines.push(t.length > 160 ? `${t.slice(0, 157)}…` : t);
    } else if (block.type === 'tool_use') {
      lines.push(describeTool(block.name, block.input as Record<string, unknown>));
    }
  }
  return lines.length ? lines.join(' ') : null;
}

function describeTool(name: string, input: Record<string, unknown>): string {
  const file = typeof input.file_path === 'string' ? path.relative(REPO_ROOT, input.file_path) : '';
  switch (name) {
    case 'Read':
      return `Read ${file}`;
    case 'Edit':
    case 'MultiEdit':
      return `Edited ${file}`;
    case 'Write':
      return `Wrote ${file}`;
    case 'Glob':
    case 'Grep':
      return `Searched for ${String(input.pattern ?? '')}`;
    case 'WebSearch':
      return `Searched the web for ${String(input.query ?? '')}`;
    case 'WebFetch':
      return `Read ${String(input.url ?? '')}`;
    case 'Bash': {
      const cmd = String(input.command ?? '').replace(/\s+/g, ' ');
      return `Ran ${cmd.length > 80 ? `${cmd.slice(0, 77)}…` : cmd}`;
    }
    default:
      return name;
  }
}

// ---------------------------------------------------------------------------
// Research

/** Run Claude Code as a researcher: web search and read-only tools, in a scratch folder with the exported sheet. */
async function research(job: JobRecord): Promise<{ report: string; cost: number }> {
  const dir = path.join(dataDir, 'jobs', job.id);
  mkdirSync(dir, { recursive: true });
  let sheetNote = '';
  if (job.sheetId) {
    const exported = await exportSheet(job.userId, job.sheetId, path.join(dir, 'sheet'));
    if (exported) {
      log(`Exported "${exported.title}" (${exported.tabs} tab${exported.tabs === 1 ? '' : 's'}) for the researcher.`);
      sheetNote = `\n\n## The user's spreadsheet: "${exported.title}"\n\nIt is exported in the folder \`sheet/\`: \`sheet/overview.json\` lists the tabs with their sizes and header rows, and \`sheet/<tab>.csv\` has every value of a tab as the user sees it. Read what the task needs.`;
    } else {
      log('The spreadsheet could not be exported; researching without it.');
    }
  }

  const prompt = `You are the research agent of a spreadsheet app. The app's chat assistant handed you a task that needs more time or web access than a chat reply allows. Do the research and write the report; the assistant will act on it (often by writing the results into the spreadsheet).

## Task: ${job.title}

${job.spec}${sheetNote}

## How to answer

- Use web search and fetch pages when the task needs facts from the web. Next to each fact taken from the web, give the source URL.
- Do not invent facts. When something cannot be found, say so for that item.
- Reply with the report only, in plain text or simple markdown: the answer first, then the details. When the result is one line per item, include it as a markdown table or a CSV block so the assistant can write it into the spreadsheet.
- Keep the report under about 3000 words.`;

  const options: Options = {
    cwd: dir,
    abortController: abort,
    env: claudeCodeEnv(),
    ...codingModel(),
    settingSources: [],
    tools: ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep'],
    allowedTools: ['WebSearch', 'WebFetch', 'Read', 'Glob', 'Grep'],
    permissionMode: 'default',
    maxTurns: MAX_RESEARCH_TURNS,
    maxBudgetUsd: MAX_RESEARCH_USD,
  };

  let report = '';
  let cost = 0;
  let failure: string | null = null;
  for await (const m of query({ prompt, options })) {
    const line = describe(m);
    if (line) log(line);
    if (m.type === 'result') {
      cost = m.total_cost_usd;
      if (m.subtype === 'success') report = m.result.trim();
      else failure = m.errors.join('\n') || `The research agent stopped (${m.subtype.replace(/_/g, ' ')}).`;
    }
  }
  if (abort.signal.aborted) throw new Error('The research took too long and was stopped.');
  if (failure) throw new Error(failure);
  if (!report) throw new Error('The research agent produced no report.');
  return { report, cost };
}

/** Write a spreadsheet as CSV files (displayed values) plus an overview, for the researcher to read. */
async function exportSheet(userId: string, sheetId: string, dir: string): Promise<{ title: string; tabs: number } | null> {
  const sheets = new SheetStore(db, path.join(dataDir, 'sheets'));
  const res = await sheets.load(userId, sheetId);
  if (!res) return null;
  mkdirSync(dir, { recursive: true });
  const src = { workbook: res.workbook, engine: new Engine(res.workbook) };
  const overview: { name: string; file: string; rows: number; columns: number; header: string[] }[] = [];
  for (const tab of res.workbook.tabs) {
    const ext = src.engine.extent(tab.id);
    const lines: string[] = [];
    for (let r = 0; r < ext.rows; r++) {
      const cells: string[] = [];
      for (let c = 0; c < ext.cols; c++) cells.push(csvCell(displayValue(src, tab, r, c)));
      lines.push(cells.join(','));
    }
    const file = `${tab.name.replace(/[^A-Za-z0-9 _.-]+/g, '_')}.csv`;
    writeFileSync(path.join(dir, file), `${lines.join('\n')}\n`);
    const header: string[] = [];
    for (let c = 0; c < ext.cols; c++) header.push(ext.rows ? displayValue(src, tab, 0, c) : '');
    overview.push({ name: tab.name, file: `sheet/${file}`, rows: ext.rows, columns: ext.cols, header });
  }
  writeFileSync(path.join(dir, 'overview.json'), JSON.stringify({ title: res.meta.title, tabs: overview }, null, 2));
  return { title: res.meta.title, tabs: res.workbook.tabs.length };
}

function csvCell(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

// ---------------------------------------------------------------------------
// Verify, restart, publish

/** Run the project checks; returns the failure output, or null when everything passes. */
async function verify(): Promise<string | null> {
  for (const [label, args] of [
    ['Typecheck', ['run', 'typecheck']],
    ['Tests', ['test']],
  ] as const) {
    log(`${label}: running…`);
    try {
      await run('npm', [...args], { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024, signal: abort.signal, env: { ...process.env, CI: '1' } });
      log(`${label}: passed.`);
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; message?: string };
      const out = `${err.stdout ?? ''}\n${err.stderr ?? ''}`.trim() || err.message || 'unknown error';
      log(`${label}: failed.`);
      return `${label} failed:\n${tail(out, 6000)}`;
    }
  }
  return null;
}

/** Ask the supervised server to restart, then wait until it answers again on its port; false when it did not come back. */
async function restartServer(): Promise<boolean> {
  const pid = Number(process.env.AGENT_SERVER_PID);
  const port = process.env.PORT ?? '3001';
  log('Restarting the server…');
  try {
    process.kill(pid, 'SIGUSR2');
  } catch {
    log('The server process was not found; it may already have restarted.');
    return true;
  }
  // Wait for it to go away and come back.
  const deadline = Date.now() + 90_000;
  let wentDown = false;
  while (Date.now() < deadline) {
    await sleep(500);
    const up = await healthy(port);
    if (!up) wentDown = true;
    else if (wentDown) {
      log('The server is back with the new code.');
      return true;
    }
  }
  log(wentDown ? 'The server did not come back in time.' : 'The server never went down; continuing anyway.');
  return !wentDown;
}

async function healthy(port: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function publish(job: JobRecord, original: JobRecord | null, summary: string, files: string[]): Promise<void> {
  const hub = new GitHub(github!);
  const branch = `assistant/${job.createdAt.slice(0, 10)}-${slug(job.title)}-${job.id.slice(0, 8)}`;
  const title = job.kind === 'revert' ? `Revert: ${original!.title}` : job.title;
  const record = changeRecord(job, original, summary, files);
  prependChangelog(record);

  log(`Committing on ${branch}…`);
  const commitSha = await git.commitOnBranch(branch, [...files, CHANGELOG], `${title}\n\n${record}\n`, { url: hub.remoteUrl, token: github!.token });
  store.setStatus(jobId, 'publishing', { branch, commitSha });
  try {
    log('Opening a pull request…');
    const pr = await hub.createPullRequest({ branch, title, body: record });
    store.setStatus(jobId, 'publishing', { prNumber: pr.number, prUrl: pr.url });
    log(`Merging pull request #${pr.number}…`);
    const mergedSha = await hub.mergePullRequest(pr.number, `${title} (#${pr.number})`);
    store.setStatus(jobId, 'publishing', { mergedSha });
    await hub.deleteBranch(branch);
    await git.finishBranch(branch, { url: hub.remoteUrl, token: github!.token });
    log(`Merged as ${mergedSha.slice(0, 7)}.`);
  } catch (e) {
    await git.abandonBranch(branch).catch((err) => log(`Could not clean up the branch: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`));
    throw e;
  }
}

/** The assistant's own record of the change: goes into the pull request, the commit and CHANGELOG.md. */
function changeRecord(job: JobRecord, original: JobRecord | null, summary: string, files: string[]): string {
  const lines = [
    job.kind === 'revert' ? `Reverts the change "${original!.title}"${original!.prUrl ? ` (${original!.prUrl})` : ''}.` : summary,
    '',
    `Requested by ${job.requestedBy ?? 'a user'} through the in-app assistant on ${job.createdAt.slice(0, 10)}.`,
  ];
  if (job.kind === 'revert' && summary) lines.splice(1, 0, '', summary);
  else if (job.kind === 'change') lines.push('', '### Request', '', job.spec.trim());
  lines.push('', `Files: ${files.join(', ') || 'none'}`, '', `Job: ${job.id}`);
  return lines.join('\n');
}

function prependChangelog(record: string): void {
  const file = path.join(REPO_ROOT, CHANGELOG);
  const title = job!.kind === 'revert' ? `Revert: ${job!.title}` : job!.title;
  const entry = `## ${job!.createdAt.slice(0, 10)} — ${title}\n\n${record}\n\n`;
  let existing = '';
  try {
    existing = readFileSync(file, 'utf8');
  } catch {
    existing = '# Changes made by the assistant\n\nEach entry is written by the app itself when a change requested through the assistant goes live.\n\n';
  }
  const headerEnd = existing.indexOf('\n## ');
  const next = headerEnd >= 0 ? `${existing.slice(0, headerEnd + 1)}${entry}${existing.slice(headerEnd + 1)}` : `${existing.trimEnd()}\n\n${entry}`;
  writeFileSync(file, next);
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

function tail(s: string, n: number): string {
  return s.length > n ? `…${s.slice(-n)}` : s;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
