// The building tools (docs/specs/user-apps.md §9.6): what the assistant and other agents use to build a hosted app in the
// suite, as their caller (a person's own agent builds the person's drafts; a shared agent its own, and those whose authors
// picked it in the Build page's panel). They are offered as the
// reserved app `apps` (`apps__create_draft`, …), so every door's routing of app tools reaches them unchanged: the Org
// object answers them itself (Org.callUserAppTool).
import type { UserAppTool } from '@flow/shared';
import { FREEFLOW_MANIFEST_DOC, FREEFLOW_SDK_DOC } from './sdk';

/** The reserved app name the building tools are offered under. */
export const BUILDING_APP = 'apps';
export const BUILDING_LABEL = 'FreeFlow Apps';

const app = { type: 'string', description: "The app's name (its draft's)." };
const owner = { type: 'string', description: "The draft's author (`author` in list_drafts), when you may edit several drafts of this app. Usually left out." };

export const BUILDING_TOOLS: UserAppTool[] = [
  {
    name: 'guide',
    description: 'How to build a FreeFlow hosted app: the manifest, server.js with the built-in SDK, migrations and the screen. Read it before writing an app.',
    input: { type: 'object', properties: {} },
    scopes: [],
  },
  {
    name: 'list_drafts',
    description: "The app drafts the caller may edit: its own and those whose authors let it edit them. Each has its name, label, author, files and the problems that stand between it and a version.",
    input: { type: 'object', properties: {} },
    scopes: [],
  },
  {
    name: 'create_draft',
    description: 'Starts a draft of an app: a working starter project (one table, two tools, a screen), or with from_installed the installed app of that name, to change it. A draft runs nothing until it is tried or published.',
    input: { type: 'object', properties: { name: { type: 'string', description: '2-20 lowercase letters and digits.' }, label: { type: 'string', description: 'The name people see.' }, from_installed: { type: 'boolean' } }, required: ['name'] },
    scopes: [],
  },
  {
    name: 'read_file',
    description: "One file of a draft: freeflow-app.json, server.js, migrations/NNNN_name.sql or ui/<path>.",
    input: { type: 'object', properties: { app, owner, path: { type: 'string' } }, required: ['app', 'path'] },
    scopes: [],
  },
  {
    name: 'write_file',
    description: "Writes one file of a draft, whole (made or replaced). Back come the draft's files and its problems now.",
    input: { type: 'object', properties: { app, owner, path: { type: 'string' }, text: { type: 'string', description: "The file's whole text." } }, required: ['app', 'path', 'text'] },
    scopes: [],
    destructive: true,
  },
  {
    name: 'delete_file',
    description: 'Deletes one file of a draft.',
    input: { type: 'object', properties: { app, owner, path: { type: 'string' } }, required: ['app', 'path'] },
    scopes: [],
    destructive: true,
  },
  {
    name: 'check_draft',
    description: "A draft's files and its problems (the manifest's and the files'): empty problems means it can be tried and published.",
    input: { type: 'object', properties: { app, owner }, required: ['app'] },
    scopes: [],
  },
  {
    name: 'try_tool',
    description: "Runs one of a draft's tools in its dev install, as the caller: its own data apart from any installed app's, no internet. Use it to test a change.",
    input: { type: 'object', properties: { app, owner, tool: { type: 'string' }, input: { type: 'object', description: "The tool's input." } }, required: ['app', 'tool'] },
    scopes: [],
  },
  {
    name: 'publish_draft',
    description: 'Publishes a draft as a version of the app. It runs nowhere until an owner or admin installs it in Organization settings → Apps; tell the person so.',
    input: { type: 'object', properties: { app, owner }, required: ['app'] },
    scopes: [],
  },
];

/** What the guide tool answers. */
export const BUILDING_GUIDE = `${FREEFLOW_MANIFEST_DOC}\n\n${FREEFLOW_SDK_DOC}\n\nTo build: create_draft, read the starter files, write_file the changes, check_draft, try_tool, then publish_draft. The person may watch the app's screen in the Build app page (/apps/) as you work.`;
