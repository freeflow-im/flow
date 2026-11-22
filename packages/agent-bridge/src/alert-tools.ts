// show_alert on the `flow` MCP server (shared/alerts.ts): an alert card at the top of the FreeFlow suite, sent through
// POST /v1/alerts as the agent's account in the organization the bridge serves (`?workspace=`). It names no one: the
// server sends it to the person whose request started this turn (the bridge's `x-flow-invoked-by`), else the agent's
// owner. Kept apart from mcp-server.ts so the suite runs it against a fake server.
import type { FlowApi } from './api.js';
import { FlowApiError } from './api.js';

export const ALERT_TOOLS = [
  {
    name: 'show_alert',
    description:
      'Shows an alert card at the top of the FreeFlow suite, on every page the person has open (and as a desktop notification where they turned those on), like a meeting alert. It goes only to the person you are working for (the person who asked, or your owner); you cannot choose someone else. To tell other people, post in a Chat channel instead. Use it for something that needs their attention soon: a reminder you were asked for, a long task finished, a decision you need. The card shows until they close it or minutes pass (default 30, up to 1440).',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The alert in a few words: "Report ready", "Call Dana back".' },
        lines: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'Up to 4 short lines under the title.' },
        kind: { type: 'string', description: 'A short word above the title, such as Reminder or Done. Defaults to Alert.' },
        links: {
          type: 'array',
          maxItems: 3,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: 'The button text: "Open report".' },
              url: { type: 'string', description: 'A web address (https://…) or a path in the suite (/docs/…, /calendar/…).' },
            },
            required: ['label', 'url'],
          },
          description: 'Up to 3 links; the first is the main button.',
        },
        minutes: { type: 'integer', minimum: 1, maximum: 1440, description: 'How long it shows if not closed. Defaults to 30.' },
      },
      required: ['title'],
    },
  },
];

export const ALERT_TOOL_NAMES: ReadonlySet<string> = new Set(ALERT_TOOLS.map((t) => t.name));

export type AlertApi = Pick<FlowApi, 'alerts'>;

/** show_alert's call: its answer as text, and whether it is an error the agent should read. */
export async function alertTool(api: AlertApi, workspaceId: string, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  if (name !== 'show_alert') return { text: `unknown tool ${name}`, isError: true };
  if (!workspaceId) return { text: 'show_alert needs a workspace (FLOW_WORKSPACE_ID is not set)', isError: true };
  const title = typeof args.title === 'string' ? args.title.trim() : '';
  if (!title) return { text: 'show_alert needs a title', isError: true };
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);
  const links = Array.isArray(args.links)
    ? (args.links as Record<string, unknown>[]).map((l) => ({ label: String(l?.label ?? ''), url: String(l?.url ?? '') }))
    : undefined;
  const body = {
    title,
    ...(strings(args.lines) ? { lines: strings(args.lines) } : {}),
    ...(typeof args.kind === 'string' && args.kind.trim() ? { kind: args.kind.trim() } : {}),
    ...(links ? { links } : {}),
    ...(args.minutes !== undefined ? { minutes: Number(args.minutes) } : {}),
  };
  try {
    const { alert } = await api.alerts<{ alert: { alertId: string; to: string; endsAt: string } }>(workspaceId, body);
    return { text: `alert shown to ${alert.to} until ${alert.endsAt} (id ${alert.alertId})`, isError: false };
  } catch (err) {
    if (err instanceof FlowApiError) return { text: err.message, isError: true };
    throw err;
  }
}
