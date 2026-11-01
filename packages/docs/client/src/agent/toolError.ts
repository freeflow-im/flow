import { EDIT_NOT_ALLOWED } from '../state/store.ts';

/** An error the agent should see and can act on (bad input, missing tab, ...). */
export class ToolError extends Error {}

/**
 * What the agent is told when an Office file (desktop app) refused its change: `reason` is the guard's answer,
 * EDIT_NOT_ALLOWED while the user has not allowed editing the file yet, or what
 * the file cannot hold. `app` names the file's program (PowerPoint), `own` the app's own kind of file.
 */
export function refusedChange(reason: string, app: string, own: string): ToolError {
  if (reason === EDIT_NOT_ALLOWED) {
    return new ToolError(
      `Nothing was changed: this ${app} file holds things the app cannot keep, so it is read-only until the user allows editing it, which removes those from the file. Tell the user, and that they allow it with the "Read-only" button next to its name; continue only after they have.`,
    );
  }
  return new ToolError(
    `Nothing was changed: this is a ${app} file, which cannot hold ${reason.toLowerCase()}. Tell the user that this needs the file kept as a ${own} instead of a ${app} file (they are offered that when they make such a change themselves), and continue only after they have.`,
  );
}
