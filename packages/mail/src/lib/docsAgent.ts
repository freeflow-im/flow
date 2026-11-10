// What Mail's assistant panel shares with Docs' (packages/docs/client/src/agent): the protocol of the assistant's API, the
// stream reader, the one-line labels of tool calls and the Markdown of replies. Imported from Docs' sources, so the two
// panels cannot drift apart; Vite bundles them (one React: vite.config.ts dedupes it).
export { CLIENT_TOOLS, MAIL_CHAT, MAX_IMAGES_PER_MESSAGE, MAX_MAIL_SELECTED, type AgentEvent, type AgentImage, type AgentTurnRequest, type ChatItem, type ClientToolCall, type ClientToolResult, type MailContext } from '../../../docs/shared/agent/protocol';
export { readAgentEvents } from '../../../docs/client/src/agent/stream';
export { toolLabel } from '../../../docs/client/src/agent/describe';
export { ChatMarkdown, picturesOf } from '../../../docs/client/src/agent/ChatMarkdown';
// The web tools (prototype): the FreeFlow browser extension in this browser runs them.
export { browserExtensionPresent, checkBrowserExtension, isWebTool, runWebTool, webPicturesNote } from '../../../docs/client/src/agent/browserBridge';
