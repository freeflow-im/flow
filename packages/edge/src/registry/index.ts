// The tool registry on the Worker (docs/specs/platform.md §5.4). The definitions are @flow/shared's TOOL_DEFINITIONS; each
// app's module registers how its server tools run when it is imported (Mail's mailTools.ts, Calendar's calendarTools.ts,
// Events' eventTools.ts, the assistant's own in docs/server/agent/tools.ts; an app added by manifest, its object module,
// src/<app>/object.ts, with `ctx.apps[<app>]`: apps.ts), and each door asks `toolsFor` what it may use:
//
//   - /mcp (docs/plugin/server/worker.ts): the server tools whose scopes the token has all been granted, of the apps the
//     Worker can reach for this caller. Docs' are served by the plugin's MCP server (mcp.ts), which registers and runs
//     them itself: they come without a runner, and the door keeps only the ones listed.
//   - the assistant (docs/server/agent/tools.ts): every server tool, and the browser tools of the open app.
//   - the bridge: definitions only, over GET /v1/tools?door=bridge (routes.ts); the bridge has its own implementations.
import { allowedBy, grantedScopes, runsInApp, toolsAtDoor, type ToolDefinition, type ToolDoor } from '@flow/shared/tools';

/** How a server tool runs at a door. `C` is the door's context: the caller's objects, by app (`mail`, `calendar`, `events`). */
export interface ToolRunner<C = never> {
  run(ctx: C, input: Record<string, unknown>): Promise<unknown>;
  /** The Zod shape its input is checked against, where the door validates with it (/mcp's SDK). */
  shape?: Record<string, unknown>;
  title?: string;
  annotations?: Record<string, unknown>;
  /** An error whose message the caller should see as it is (a wrong id, a calendar it cannot change). */
  refusal?: (e: unknown) => boolean;
  /** What the caller is told of any other error. */
  failure?: (e: unknown) => string;
  /** The key of the door's context this tool needs: where the Worker cannot reach that app for the caller, /mcp leaves it out. */
  needs?: string;
  /**
   * An app added by manifest says what its tool is told and the scopes it needs here, beside how it runs: the registry's
   * test writes its definitions (@flow/shared's toolDefinitions/<app>.ts) from these.
   */
  description?: string;
  scopes?: string[];
}

/** A definition and, for a server tool that runs in the Worker, how. */
export interface DoorTool {
  definition: ToolDefinition;
  runner?: ToolRunner<never>;
}

export interface DoorContext {
  /** The token's scopes (/mcp). */
  scopes?: readonly string[];
  /** The open app (the assistant): its browser tools are offered. */
  app?: string;
  /** What the Worker can reach for this caller (/mcp): a tool whose runner `needs` a key not here is left out. */
  reach?: Record<string, unknown>;
}

const runners = new Map<string, ToolRunner<never>>();
const key = (door: ToolDoor, app: string, name: string) => `${door}:${app}:${name}`;

/**
 * An app's server tool: how it runs at /mcp and in the assistant (or the doors named), where the definitions offer it.
 * Called by the app's module when it is imported. The registry's test checks that each one matches a definition.
 */
export function register<C>(app: string, name: string, runner: ToolRunner<C>, doors: ToolDoor[] = ['mcp', 'assistant']): void {
  for (const door of doors) runners.set(key(door, app, name), runner as ToolRunner<never>);
}

/** Every registration, for the registry's test. */
export const registrations = (): { door: ToolDoor; app: string; name: string }[] =>
  [...runners.keys()].map((k) => {
    const [door, app, name] = k.split(':') as [ToolDoor, string, string];
    return { door, app, name };
  });

/** A registration as it was made, whether or not a definition offers it yet (the registry's test). */
export const registered = (door: ToolDoor, app: string, name: string): ToolRunner<never> | undefined => runners.get(key(door, app, name));

/** How a door's tool runs, when it is a server tool that runs in the Worker. */
export function runnerOf(door: ToolDoor, name: string): ToolRunner<never> | undefined {
  const def = toolsAtDoor(door).find((t) => t.name === name);
  return def?.kind === 'server' ? runners.get(key(door, def.app, name)) : undefined;
}

/** What a door may use, in the definitions' order. */
export function toolsFor(door: ToolDoor, ctx: DoorContext = {}): DoorTool[] {
  const all = toolsAtDoor(door).map((definition) => ({ definition, runner: definition.kind === 'server' ? runners.get(key(door, definition.app, definition.name)) : undefined }));
  if (door === 'mcp') {
    const granted = grantedScopes(ctx.scopes ?? []);
    return all.filter((t) => t.definition.kind === 'server' && allowedBy(t.definition, granted) && (!t.runner?.needs || ctx.reach?.[t.runner.needs] !== undefined));
  }
  if (door === 'assistant') return all.filter((t) => t.definition.kind === 'server' || (!!ctx.app && runsInApp(t.definition, ctx.app)));
  return all;
}
