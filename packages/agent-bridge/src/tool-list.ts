// The `flow` MCP server's tool list from the suite's tool registry (platform.md §5.4): GET /v1/tools?door=bridge gives the
// definitions (name, description, input schema) at start, and each one is listed when this bridge implements it (its
// chat, calendar and mail tools, by name). A definition this bridge has no implementation for is skipped with a log line;
// a server too old to serve the registry, or one that cannot be reached, leaves the built-in list.
import type { FlowApi } from './api.js';

export interface McpToolEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** What GET /v1/tools returns for each tool (@flow/shared's ToolDefinition, the fields read here). */
export interface ToolDefinitionLike {
  name: string;
  description: string;
  input: Record<string, unknown>;
}

/** The tools to list: the definitions this bridge implements, in the server's order. */
export function toolListFrom(definitions: readonly ToolDefinitionLike[], builtIn: readonly McpToolEntry[], log: (line: string) => void): McpToolEntry[] {
  const known = new Set(builtIn.map((t) => t.name));
  const out: McpToolEntry[] = [];
  for (const d of definitions) {
    if (!d || typeof d.name !== 'string' || typeof d.description !== 'string' || !d.input || typeof d.input !== 'object') continue;
    if (!known.has(d.name)) {
      log(`flow mcp: the server defines ${d.name}, which this bridge does not implement; skipped`);
      continue;
    }
    out.push({ name: d.name, description: d.description, inputSchema: d.input });
  }
  return out;
}

/** The tool list from the server's registry, or the built-in one when the server does not serve it. */
export async function loadToolList(api: FlowApi, builtIn: readonly McpToolEntry[], log: (line: string) => void): Promise<McpToolEntry[]> {
  try {
    const r = await api.tools('bridge');
    const list = Array.isArray(r?.tools) ? toolListFrom(r.tools, builtIn, log) : [];
    if (list.length) return list;
    log('flow mcp: the server listed no tools; using the built-in list');
  } catch (err) {
    log(`flow mcp: no tool registry on the server (${(err as Error).message}); using the built-in list`);
  }
  return [...builtIn];
}
