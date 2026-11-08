// The suite's tool definitions, one list per app with tools, in the manifests' order (Chat's first: the bridge lists them
// first, as it always has). Each file is written by the Worker's registry test; adding an app adds its line here.
import type { ToolDefinition } from '../tools.js';
import { CALENDAR_TOOLS } from './calendar.js';
import { CHAT_TOOLS } from './chat.js';
import { CONTACTS_TOOLS } from './contacts.js';
import { DOCS_TOOLS } from './docs.js';
import { EVENTS_TOOLS } from './events.js';
import { MAIL_TOOLS } from './mail.js';

export { CALENDAR_TOOLS, CHAT_TOOLS, CONTACTS_TOOLS, DOCS_TOOLS, EVENTS_TOOLS, MAIL_TOOLS };

export const APP_TOOLS: readonly (readonly ToolDefinition[])[] = [CHAT_TOOLS, DOCS_TOOLS, MAIL_TOOLS, CALENDAR_TOOLS, EVENTS_TOOLS, CONTACTS_TOOLS];
