// What the Assistant object (object.ts) needs from the Docs agent, the model SDKs and the suite's Docs tools, in one module
// it loads when an object is made instead of when the Worker starts: imported at the top they ran on every start of the
// Worker, whose startup CPU Cloudflare caps at 1 s (2026-11-18: about a quarter of what was left after PR #875).
export { default as Anthropic } from '@anthropic-ai/sdk';
export { AgentError, AgentService } from '@flow/docs/server/agent/agent.ts';
export { openaiErrorMessage } from '@flow/docs/server/agent/openai.ts';
export { OpenRouterError } from '@flow/docs/server/agent/openrouter.ts';
export { checkAssistantKey, OwnKeyError } from '@flow/docs/server/agent/providers.ts';
export { AgentStore } from '@flow/docs/server/agent/store.ts';
export { checkBraveKey } from '@flow/docs/server/agent/tools.ts';
export { ASSISTANT_PAGES, HEADLESS_DOCS_TOOLS, headlessRefusal, SUITE_GUIDANCE } from '../docs/assistantTools.ts';
export { docsPageUrl, docsToolContext, importToDocs } from './docsTools.ts';
