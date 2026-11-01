// Find-and-replace edits to a text file, as the assistants' edit_file makes them: the in-app assistant
// (client/src/agent/clientTools.ts) and the MCP server (plugin/server/files.ts). All or nothing: when one
// edit does not match, nothing is changed.

/** An edit that cannot be made, with what to do instead; nothing was changed. */
export class TextEditError extends Error {}

export interface TextEdit {
  find: string;
  replace: string;
  /** Replace every occurrence instead of requiring exactly one. */
  all?: boolean;
}

/** The text with the edits made in order, and how many places changed. */
export function applyTextEdits(text: string, edits: TextEdit[]): { text: string; replacements: number } {
  let replacements = 0;
  edits.forEach((e, k) => {
    const count = text.split(e.find).length - 1;
    if (count === 0) throw new TextEditError(`Edit ${k + 1}: the text to find is not in the file. Nothing was changed. Read that part and copy it exactly.`);
    if (count > 1 && !e.all) throw new TextEditError(`Edit ${k + 1}: the text to find occurs ${count} times. Nothing was changed. Include more of the text around it, or set all to replace every one.`);
    text = text.split(e.find).join(e.replace);
    replacements += count;
  });
  return { text, replacements };
}
