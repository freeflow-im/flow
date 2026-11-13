import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { coreTools, deferTools, keepReferencedTools, openSearches, referencedTools, TOOL_SEARCH } from './toolSearch.ts';

type Tool = Anthropic.Beta.BetaToolUnion;
const tool = (name: string): Tool => ({ name, description: name, input_schema: { type: 'object', properties: {} } });
const names = ['list_files', 'open_file', 'find_files', 'read_range', 'write_range', 'get_sheet_overview', 'format_range', 'add_chart', 'read_doc', 'search_mail', 'create_event'];
const loaded = (tools: Tool[]) => tools.filter((t) => !('defer_loading' in t && t.defer_loading)).map((t) => ('name' in t ? t.name : ''));

describe('tool search', () => {
  it('loads the page core and defers the rest, with the search first', () => {
    const tools = deferTools(names.map(tool), { page: 'sheet', sheetId: 's1' } as never);
    expect(tools[0]).toBe(TOOL_SEARCH);
    expect(loaded(tools).sort()).toEqual(['tool_search_tool_bm25', 'list_files', 'open_file', 'find_files', 'read_range', 'write_range', 'get_sheet_overview', 'format_range'].sort());
    expect(tools).toHaveLength(names.length + 1);
  });

  it('loads only the shared core on a page it has no list for', () => {
    expect([...coreTools({ page: 'home' })].sort()).toEqual(['find_files', 'list_files', 'memory', 'open_file']);
    expect([...coreTools(undefined)].sort()).toEqual(['find_files', 'list_files', 'memory', 'open_file']);
  });

  it('leaves a short list alone', () => {
    const few = names.slice(0, 5).map(tool);
    expect(deferTools(few, { page: 'home' })).toBe(few);
  });


  it('adds a deferred stand-in for each tool a past search loaded that is not offered now', () => {
    const history = [
      { role: 'user' as const, content: 'hi' },
      {
        role: 'assistant' as const,
        content: [
          { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_bm25', input: { query: 'x' } },
          { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'tool_search_tool_search_result', tool_references: [{ type: 'tool_reference', tool_name: 'add_chart' }, { type: 'tool_reference', tool_name: 'gone' }] } },
        ],
      },
    ] as Anthropic.Beta.BetaMessageParam[];
    expect([...referencedTools(history)]).toEqual(['add_chart', 'gone']);
    const tools = names.map(tool);
    const kept = keepReferencedTools(tools, history);
    expect(kept.slice(0, tools.length)).toEqual(tools);
    expect(kept.slice(tools.length)).toEqual([{ name: 'gone', description: 'Not available here.', input_schema: { type: 'object', properties: {} }, defer_loading: true }]);
    expect(keepReferencedTools(tools, history.slice(0, 1))).toBe(tools);
  });
});

describe('open searches', () => {
  it('finds a search the last reply left without its result', () => {
    const reply = (content: unknown[]) => [{ role: 'user' as const, content: 'hi' }, { role: 'assistant' as const, content }] as Anthropic.Beta.BetaMessageParam[];
    const search = { type: 'server_tool_use', id: 'srvtoolu_1', name: 'tool_search_tool_bm25', input: { query: 'x' } };
    expect(openSearches(reply([search, { type: 'tool_use', id: 't1', name: 'read_range', input: {} }]))).toEqual(['srvtoolu_1']);
    expect(openSearches(reply([search, { type: 'tool_search_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'tool_search_tool_search_result', tool_references: [] } }]))).toEqual([]);
    expect(openSearches([{ role: 'user', content: 'hi' }])).toEqual([]);
  });
});
