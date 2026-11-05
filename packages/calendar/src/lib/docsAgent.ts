// What Calendar's assistant panel shares with Docs' (packages/docs/client/src/agent), as Mail's does: the protocol of the
// assistant's API, the stream reader, the one-line labels of tool calls and the Markdown of replies, imported from Docs'
// sources so the panels cannot drift apart; Vite bundles them (one React: vite.config.ts dedupes it).
export { CALENDAR_CHAT, CLIENT_TOOLS, MAX_CALENDARS_SHOWN, type AgentEvent, type AgentTurnRequest, type CalendarContext, type ChatItem, type ClientToolCall, type ClientToolResult } from '../../../docs/shared/agent/protocol';
export { readAgentEvents } from '../../../docs/client/src/agent/stream';
export { toolLabel } from '../../../docs/client/src/agent/describe';
export { ChatMarkdown } from '../../../docs/client/src/agent/ChatMarkdown';
