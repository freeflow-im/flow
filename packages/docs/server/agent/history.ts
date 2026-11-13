// The stored chat, as each provider can take it. The history stays in Claude's format whichever provider answered, and a
// chat can move between providers (the user changes their key in Settings). Each refuses some of the others' blocks:
// Anthropic wants `srvtoolu_` ids on search calls (OpenAI's and OpenRouter's have none; openai.ts stores OpenAI's search as
// Claude's blocks) and refuses thinking it did not sign; OpenRouter refuses Claude's search result block. OpenAI takes
// any of them (openai.ts drops thinking and what it does not know).
import type Anthropic from '@anthropic-ai/sdk';

type MessageParam = Anthropic.Beta.BetaMessageParam;
type Block = { type: string; id?: string; name?: string; tool_use_id?: string; signature?: string; data?: string };

/** Where a request goes: Anthropic's API, or OpenRouter's Anthropic Messages API (openrouter.ts). */
export type HistoryTarget = 'anthropic' | 'openrouter';

/** OpenRouter's tool search, as the tool and the name on its calls. */
export const OPENROUTER_SEARCH = 'openrouter:tool_search';

/**
 * The mark on OpenRouter's thinking, which looks like Claude's but is not signed by Anthropic: openrouter.ts puts it on
 * each signature (thinking) and data (redacted_thinking) it receives and takes it off what it sends.
 */
const MARK = 'openrouter:';

/** OpenRouter's reply content with its thinking marked as OpenRouter's. */
export function markOpenRouterThinking<T>(content: T[]): T[] {
  return content.map((b) => {
    const block = b as Block;
    if (block.type === 'thinking' && typeof block.signature === 'string') return { ...block, signature: MARK + block.signature } as T;
    if (block.type === 'redacted_thinking' && typeof block.data === 'string') return { ...block, data: MARK + block.data } as T;
    return b;
  });
}

const isThinking = (b: Block) => b.type === 'thinking' || b.type === 'redacted_thinking';
const marked = (b: Block) => (b.type === 'thinking' ? b.signature : b.data)?.startsWith(MARK) ?? false;
const unmarked = (b: Block): Block => (b.type === 'thinking' ? { ...b, signature: b.signature!.slice(MARK.length) } : { ...b, data: b.data!.slice(MARK.length) });

/**
 * The history as `target` takes it: the search steps and thinking another provider wrote taken out (the calls and results
 * stay; only how the tools were found, and reasoning only its writer can read, go), OpenRouter's thinking unmarked for
 * OpenRouter, and assistant messages left empty dropped. A history the target wrote itself comes back as it is.
 */
export function portableHistory(messages: MessageParam[], target: HistoryTarget): MessageParam[] {
  const foreign = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    for (const b of m.content as Block[]) {
      if (b.type !== 'server_tool_use') continue;
      const own = target === 'anthropic' ? b.id!.startsWith('srvtoolu_') && b.name !== OPENROUTER_SEARCH : b.name === OPENROUTER_SEARCH;
      if (!own) foreign.add(b.id!);
    }
  }
  const keep = (b: Block): boolean => {
    if (b.type === 'server_tool_use') return !foreign.has(b.id!);
    if (b.type === 'tool_search_tool_result') return target === 'anthropic' && !foreign.has(b.tool_use_id!);
    if (b.type === 'openrouter_tool_search_result') return target === 'openrouter';
    if (isThinking(b)) return target === 'openrouter' ? marked(b) : !marked(b);
    return true;
  };
  let changed = false;
  const out: MessageParam[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') {
      out.push(m);
      continue;
    }
    const blocks = m.content as Block[];
    const kept = blocks.filter(keep).map((b) => (target === 'openrouter' && isThinking(b) ? unmarked(b) : b));
    if (kept.length === blocks.length && kept.every((b, i) => b === blocks[i])) out.push(m);
    else {
      changed = true;
      if (kept.length) out.push({ ...m, content: kept as MessageParam['content'] });
    }
  }
  return changed ? out : messages;
}

/** What an unanswered tool call is answered with: its turn stopped (a restart or a deploy) before its result was saved. */
export const INTERRUPTED_RESULT = 'This tool call was interrupted before it finished (the turn stopped), so it has no result. Run it again if it is still needed.';

/**
 * The history with every tool call answered. A turn cut off between a tool call and its saved result (the Worker restarted
 * mid-turn) leaves a `tool_use` with no `tool_result`, and every provider then refuses the whole conversation ("No tool
 * output found for function call"), so the chat could never be used again. Each such call gets an error result, at the
 * start of the next user message (or a new one at the end). A history with nothing open comes back as it is.
 */
export function answerOpenCalls(messages: MessageParam[]): MessageParam[] {
  let changed = false;
  const out: MessageParam[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    out.push(m);
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    const calls = (m.content as Block[]).filter((b) => b.type === 'tool_use').map((b) => b.id!);
    if (!calls.length) continue;
    const next = messages[i + 1];
    const answered = new Set(next && next.role === 'user' && typeof next.content !== 'string' ? (next.content as Block[]).filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id!) : []);
    const open = calls.filter((id) => !answered.has(id));
    if (!open.length) continue;
    changed = true;
    const results = open.map((id) => ({ type: 'tool_result', tool_use_id: id, content: INTERRUPTED_RESULT, is_error: true }));
    if (next && next.role === 'user') {
      const rest = typeof next.content === 'string' ? [{ type: 'text', text: next.content }] : next.content;
      out.push({ ...next, content: [...results, ...rest] as MessageParam['content'] });
      i++;
    } else {
      out.push({ role: 'user', content: results as MessageParam['content'] });
    }
  }
  return changed ? out : messages;
}
