# Docs core: one engine under the hosted Docs app and the standalone MCP Docs

Status: design proposal · 2026-11-09. Ruling (Scott, 2026-11-09, `decision_log.md`): the standalone MCP Docs desktop
app stays a product; it and the suite's hosted Docs app stay in this one repository; what they share becomes an
explicit package. Nothing in the repository changes by this document.

Related: `docs/specs/freeflow-suite.md` (the merge of 2026-11-01; §7 is the desktop plan this replaces in part),
`docs/specs/cloudflare-spikes.md` (how the Docs code was first run on Workers), `packages/docs/CLAUDE.md` and
`packages/docs/docs/architecture.md` (how the Docs code works inside).

## 0. The problem in one paragraph

The Docs code is one package with two apps on it, but the sharing is implicit and in one place it is a copy. The
Worker's Docs object (`packages/edge/src/docs`) holds a hand-made copy of the Docs server and shared code: 103
files, 17,800 lines, 73 of them identical to the originals and 30 patched for Workers, marked `@ts-nocheck`,
with no script that refreshes them. Two patched copies already lag fixes made to their originals. The desktop app,
meanwhile, is released from the old `freeflow-im/mcp-docs` repository, which installed apps still check for
updates, so a desktop fix made here reaches nobody until the code is pushed there by hand. This document draws the
boundary between what is shared and what belongs to each app, names the packages, and sets the order of the work.

## 1. What exists today (measured 2026-11-09)

| Part of `packages/docs` | Lines | Who runs it |
| --- | --- | --- |
| `client/src`, the editors and the home page | 36,400 | both apps, one Vite build (`BASE_PATH` differs) |
| `server`, the Fastify routes, stores, imports, exports, the assistant | 27,250 | the desktop app as is; the Worker as a copy |
| `shared`, the document models, formats, formula engine | 10,970 | both, and the Worker as a copy (42 files, none patched) |
| `plugin`, MCP Docs' MCP server and the ChatGPT plugin's web view | 8,850 | the standalone's local MCP; the suite's `/mcp` door rides on a copy of it today; web view hosted only |
| `desktop`, the Electron shell | 2,200 | desktop only |
| `installer`, `npx @freeflow-im/mcp-docs` | 480 | desktop only |

**The Worker's copy.** `packages/edge/src/docs/{server,shared,plugin}` plus 690 lines of runtime stand-ins in
`packages/edge/src/docs/runtime`: `fs` and `fsp` (files are R2 objects), `sqlite` (the object's own database),
`fastify` (the part of Fastify the routes use), `context` (which organization's object handles this request),
`pdfText` and `pdfOcr`, and `inert` (desktop features answer with nothing). The 30 patched server files swap
`node:fs`, `node:sqlite`, `node:fs/promises` and Fastify for those stand-ins, replace the S3 backup client with
`Inert`, and add the suite's own pieces to the assistant's tools (Mail, Calendar, the tool registry). The copies are
refreshed by hand when someone remembers: `server/pdfMarkdown.ts` changed on 2026-11-08 and `server/localStore.ts`
on 2026-11-06, their copies last on 2026-11-02.

**The desktop shell** (`desktop/main.js`, `desktop/server.ts`) imports `server/app.ts`, `server/localStore.ts`,
`server/sheets.ts`, `server/pdf.ts`, `server/webCopy.ts` and `shared/types.ts`, and serves `dist/client`.

**The client** is nearly runtime-neutral: five files import `desktopBridge.ts` (the desktop's window, file-at-path
and "show in Finder"), two import `@flow/suite-bar`, and 34 of its 161 source files mention organizations, sign-in
or the suite in some way.

**Releases.** `docs-desktop-release.yml` in this repository builds `desktop-v*` tags and would create a GitHub
release here, where no installed app looks; it has never produced one. The three desktop releases since the merge
(0.2.36 to 0.2.38) were made from the old repository. `desktop/updater.js` has `REPO = 'freeflow-im/mcp-docs'`,
the installer's package metadata and the Claude Code plugin's marketplace point there too. Versions have already
parted: `packages/docs` says 0.2.37, the old repository 0.2.38.

## 2. The boundary, file by file

Four groups. A file's group is decided by one question: does it need to know where it runs?

### 2.1 Core, pure (shared by both apps, no runtime in it)

- All of `shared/` (42 files): the sheet, deck and document models, `docMarkdown`, `diff`, `formula/`, the Office
  formats (`xlsxFormat`, `docxFormat`, `pptxFormat`, `pptxExport`), `csv`, `zip`, `preview`, `video`, `pdfSign`,
  `agent/` (the assistant's protocol and readers), `brand.ts`.
- The server files the Worker copies unchanged (31 files, 6,600 lines): the imports and exports (`pptxImport`,
  `docxImport`, `docxExport`, `xlsxImport`, `xlsxCharts`, `importFile`, `imageSize`, `imageEdit`), the assistant's
  model clients and settings (`agent/openai`, `agent/openrouter`, `agent/llmSearch`, `agent/providers`,
  `agent/settings`, `agent/store`), `access`, `scope`, `auth`, `folders`, `favorites`, `storedText`, `signatures`,
  `publicLinks`, `revisionFeed`, `linkedTable`, `webFetch`, `googleAuth`, `mail`, `legal`, `llms`, `ids`, `env`.
- The client's editors: `client/src` except the files in §2.4.

### 2.2 Core, behind a runtime seam (shared, but patched today)

The 30 patched server files, 11,200 lines: `app.ts` (the routes), `agent/tools.ts`, `agent/agent.ts`,
`agent/prompt.ts`, `agent/jobs.ts`, `agent/claudeAgent.ts`, `sheets.ts`, `export.ts`, `previews.ts`, `pdf.ts`,
`pdfMarkdown.ts`, `webCopy.ts`, `db.ts`, `files.ts`, `recents.ts`, `images.ts`, `zipView.ts`, `blob.ts`,
`connectors/*`, `gettingStarted.ts`, `windowTools.ts`, `marketing.ts`, and the five in §2.3 that the Worker
copies only to make them inert.

These stay shared. What changes is how they reach the machine: through one `runtime` module (§3) instead of
`node:fs`, `node:sqlite`, `node:fs/promises` and Fastify directly. The Worker's stand-ins already define that module;
the Node app's version is a pass-through to Node. The suite-only additions to the assistant's tools (Mail,
Calendar, the registry) leave `agent/tools.ts` and become a registration the hosted app makes (§4.2).

### 2.3 The standalone app only

`server/localStore.ts` (the folder of real files), `server/backup.ts` and `server/blob.ts`'s S3 client (the
off-box copy), `server/folderWatch.ts`, `server/localMcp.ts`, `server/supervise.ts`, `server/agent/worker.ts` and
`server/agent/git.ts` (the local coding agent), `server/index.ts`, `server/testing.ts`, `server/scripts/r2.ts`;
`plugin/server` (MCP Docs' own MCP server, the one agents on the machine connect to; ruling 5); all of `desktop/`;
`installer/`; `claude-plugin/`; `client/src/desktopBridge.ts` and the Local tab's pieces (`LocalFolderMenu`,
`OpenInTab`'s file-at-path, the recent-opens hooks in `main.tsx`).

### 2.4 The hosted app only

`packages/edge/src/docs/object.ts`, `move.ts`, `runtime/*` (the Worker's runtime for the seam), `plugin/web/*` (the
ChatGPT plugin's view), the suite's tool registrations (Mail, Calendar, the registry), **Flow's own MCP door**
(`packages/edge/src/routes/mcp.ts`, today `docs/plugin/server/worker.ts` in the copy: it reads the tool registry,
`platform.md` §5.4, and is not MCP Docs' MCP server; ruling 5), the
`/workspace` client entry with `@flow/suite-bar` and the organization switcher, the sign-in and session pieces the
suite's Directory provides. The 34 client files that mention organizations or sign-in are reviewed in phase 2; the
expectation is that most are the home page and file library reading a `host` (§3.2), not hosted-only code.

## 3. The seams

### 3.1 The server runtime

One module the core imports as `runtime`, with two implementations: `runtime/node` (the standalone app) and the
Worker's `packages/edge/src/docs/runtime`. Its surface is what the Worker's stand-ins already provide, named:

| Part | What the core asks | Node | Worker |
| --- | --- | --- | --- |
| `files` | read, write, list, remove, stream a stored file by key | `node:fs`, `node:fs/promises` under the data folder | R2 under the organization's prefix |
| `db` | open a SQLite database by name, synchronous statements | `node:sqlite` | the object's SQLite (one database, disjoint tables) |
| `http` | register routes, hooks, parsers, cookies, hijack a reply for a stream | Fastify | `DocsApp` (the Worker's small router) |
| `context` | who is asking, for which organization | one process, one folder | `AsyncLocalStorage` per request |
| `pdf` | text of a PDF, OCR of a page, render a page | pdfjs and Chromium on the box | Browser Rendering and the OCR object |
| `features` | has local files, has a browser, has a shell | yes, yes, yes | no, rendering only, no |

A core file that needs something not on this table is either in the wrong group or the table grows. The table is
the whole list of what the core knows about the machine.

### 3.2 The client host

The editors take a `host` from the app that mounts them: sign-in state and who the user is, the list of places to
save to (organizations, or the local folder), the suite bar or none, and the desktop bridge or none. Today those
are read from modules and globals in five places; they become one object given at mount.

## 4. The packages after

```
packages/docs-core/        @flow/docs-core   shared/, server/ (core + seamed), client/src (editors)
packages/docs/             @flow/docs        the hosted Docs app: the /workspace client entry; manifest; nothing else
packages/edge/src/docs/    the Worker's Docs object and its runtime, importing @flow/docs-core; the copies deleted
packages/edge/src/routes/mcp.ts   Flow's MCP door, over the tool registry; Docs' tools run through runners from the core
apps/mcp-docs/             @freeflow-im/mcp-docs-app   the standalone app: Electron shell, Node runtime, local store,
                           backup, folder watch, MCP Docs' MCP server (plugin/server, localMcp), the coding agent,
                           installer/, claude-plugin/
```

- `@flow/docs-core` is a workspace package, never published: both apps build from the same commit. It is typechecked
  once, under its own settings, and the `@ts-nocheck` headers go with the copies.
- Its `exports` map names the doors: `./shared/*`, `./server/*`, `./client`, `./plugin/server`, `./runtime` (the
  interface). The Worker imports by name; the relative paths into a copy go.
- `@flow/docs` keeps the name the manifests and deploys know (`client.dist: packages/docs/dist`), so the suite's
  assembler and deploys do not change.
- The standalone app has its own `version`, its own changelog (`packages/docs/CHANGELOG.md` moves with it) and its
  own release workflow. It knows nothing of organizations or the suite's Directory. Its Web tab keeps opening
  `app.freeflow.im/workspace` as today.

### 4.1 Releases of the standalone app

- `docs-desktop-release.yml` publishes to this repository's GitHub releases (both repositories are public, so the
  updater needs no token). `desktop/updater.js`'s `REPO` becomes `freeflow-im/flow`, with the tag prefix it already
  filters on. The installer's and the plugin's repository fields follow.
- The first release made from here ships the updater change, so installed apps on 0.2.38 take one more update from
  the old repository and then look here. The old repository gets that last release, a README pointing here, and is
  made read-only.
- `BUILD.md` gets the recipe: bump the standalone's version in its PR, tag `desktop-v<version>` on `main`, the
  workflow does the rest. No subtree push, ever again.

### 4.2 The hosted app's additions

The suite adds tools to the assistant (Mail, Calendar, the registry) and pages the standalone does not have. Those
become registrations the hosted app makes against the core (`registerTools`, `registerRoutes`) at the object's
start, so `agent/tools.ts` and `app.ts` carry no `// Edge only` blocks.

**Flow's MCP door is Flow's.** Today `/mcp` on the Worker is a copy of MCP Docs' `plugin/server/worker.ts`, and Docs'
tools on it are run by the plugin's own MCP server (`mcp.ts`), which the registry only filters. After: the door
lives in `packages/edge` (`routes/mcp.ts`), Docs' tools are registered with runners from the core exactly as Mail's
and Calendar's are, and the door runs them from the registry. MCP Docs' MCP server is then the standalone app's
alone, for agents on the same machine.

## 5. Phases

Each phase is one branch and one PR against `main`, phases as commits inside it (CLAUDE.md). Phase 1 lands alone
because it deletes 17,800 lines and the Worker's deploy must be verified before anything moves.

1. **The runtime seam, and the copies deleted.** In `packages/docs/server`, the 30 patched files import `runtime`
   instead of Node and Fastify; `runtime/node` is the pass-through; the Worker's runtime is moved into shape and the
   Worker imports `packages/docs` directly. The suite's additions to the tools become registrations (§4.2).
   Flow's `/mcp` door moves to `packages/edge/src/routes/mcp.ts` and runs Docs' tools from the registry (§4.2), so
   the copy of `plugin/server` goes too. `packages/edge/src/docs/{server,shared,plugin}` are deleted. Done when: the
   Docs tests, the Worker's tests, `test/e2e-docs.mjs` and the MCP e2e pass, and the hosted Docs is verified live.
   Also carries the two lagging fixes.
2. **The client host.** `desktopBridge` and the suite's pieces behind one `host`; two entries, `/workspace` and the
   desktop's, from one build; the 34 files reviewed. Done when both apps run from the same `dist`.
3. **The package split.** `packages/docs-core`, `packages/docs` as the thin hosted entry, `apps/mcp-docs`; exports
   map; tsconfigs; CI runs the core's tests once; `scripts/clients.mjs` and the manifests still find `packages/docs/dist`.
4. **Releases from here.** §4.1. Done when an installed 0.2.38 updates to a release published from this repository.

Phases 1 and 4 are the ones that remove risk; 2 and 3 are the ones that make the boundary hold. If time is short,
1 then 4.

## 6. Proposed rulings

1. **The standalone app keeps the name MCP Docs** and its `mcpdocs://` scheme; the suite's own desktop app
   (`apps/desktop`, Electron, Chat and the rest) stays separate. `freeflow-suite.md` §7's "one Electron app" is
   withdrawn for the standalone: it is a product of its own, not a shell for the suite.
2. **Releases of the standalone app come from this repository**, by tag, with the updater reading this
   repository's releases; the old repository becomes read-only after the hand-over release.
3. **The core is a workspace package, not a published one.** A published core would be the version drift we have
   now with an extra step.
4. **The runtime table in §3.1 is the whole contract.** A core file that needs more goes to its app, or the table
   grows in the same PR, with both implementations.
5. **Ruled (Scott, 2026-11-09): MCP Docs' MCP server and Flow's MCP are separate things.** The local server in
   `plugin/server` and `localMcp.ts` belongs to the standalone app, for agents on the same machine. The suite's `/mcp`
   is Flow's door over the tool registry; Docs' tools reach it as runners, like every other app's.

## 7. Open questions

- Whether the ChatGPT plugin (`plugin/web`) is still wanted; it is hosted-only and 8,850 lines. Not decided here.
