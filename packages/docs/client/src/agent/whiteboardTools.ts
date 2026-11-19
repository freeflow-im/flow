// Whiteboard tools the agent calls (shared/whiteboard.ts): read_whiteboard and edit_whiteboard. In the browser they run
// against the open whiteboard's live editor (a DeckController over the board as a one-slide deck), so edits show, save
// and undo (one step per agent request) like the user's own; the MCP server runs the same code on a stored board through
// a headless controller (plugin/server/files.ts, editWhiteboard).
import type { ClientToolCall } from '../../../shared/agent/protocol.ts';
import { deckOutline, parseLinks, THEMES, toParagraphs, type Paragraph, type SlideElement, type TextElement, type TextRun } from '../../../shared/deck.ts';
import { boxFromEnds, lineEnds } from '../../../shared/lines.ts';
import { BOARD_H, BOARD_W, deckAsBoard, GRID, snap, validateWhiteboard } from '../../../shared/whiteboard.ts';
import type { DeckController } from '../deck/controller.ts';
import { applyElementSpec } from './deckTools.ts';
import { ToolError } from './toolError.ts';

export const WHITEBOARD_TOOLS: ReadonlySet<string> = new Set(['read_whiteboard', 'edit_whiteboard']);

/** The paper of a new sticky note. */
export const NOTE_FILL = '#fff59d';
const NOTE_SIZE = 200;
const TEXT_SIZE = 18;
/** The room left between items placed one after another. */
const GAP = 24;

export interface WhiteboardToolEnv {
  board: DeckController | null;
  group: string;
}

type Input = Record<string, unknown>;

function requireBoard(env: WhiteboardToolEnv): DeckController {
  if (!env.board) throw new ToolError('No whiteboard is open. Ask the user to open it, or pass board_id where the tool takes one.');
  return env.board;
}

// --- Text with bold and italic ------------------------------------------------------------------

const STYLED_RE = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g;

/** A line's runs: **bold**, *italic* and [label](url) links; undefined when it is plain. */
function styledRuns(line: string): TextRun[] | undefined {
  const runs: TextRun[] = [];
  let last = 0;
  const plain = (s: string) => {
    if (!s) return;
    runs.push(...(parseLinks(s) ?? [{ text: s }]));
  };
  for (const m of line.matchAll(STYLED_RE)) {
    plain(line.slice(last, m.index));
    const bold = m[0].startsWith('**');
    const inner = bold ? m[0].slice(2, -2) : m[0].slice(1, -1);
    for (const r of parseLinks(inner) ?? [{ text: inner }]) runs.push({ ...r, ...(bold ? { bold: true } : { italic: true }) });
    last = m.index + m[0].length;
  }
  plain(line.slice(last));
  return runs.some((r) => Object.keys(r).length > 1) ? runs : undefined;
}

/** Text as the tools take it: one paragraph per line, "- " bullets, **bold**, *italic*, [links](https://...). */
export function boardParagraphs(text: string): Paragraph[] {
  return toParagraphs(text.split('\n')).map((p) => {
    const runs = styledRuns(p.runs ? p.runs.map((r) => (r.link ? `[${r.text}](${r.link})` : r.text)).join('') : p.text);
    if (!runs) return p;
    const { runs: _old, ...rest } = p;
    return { ...rest, text: runs.map((r) => r.text).join(''), runs };
  });
}

/** Paragraphs written back as the tools take them (the inverse of boardParagraphs). */
export function boardText(ps: Paragraph[]): string {
  return ps
    .map((p) => {
      const body = p.runs?.length
        ? p.runs
            .map((r) => {
              let t = r.link ? `[${r.text}](${r.link})` : r.text;
              if (r.italic) t = `*${t}*`;
              if (r.bold) t = `**${t}**`;
              return t;
            })
            .join('')
        : p.text;
      return p.bullet ? `${'  '.repeat(p.level ?? 0)}- ${body}` : body;
    })
    .join('\n');
}

// --- Reading ------------------------------------------------------------------------------------

/** What kind of item an element is on a whiteboard. */
const itemType = (e: SlideElement): string => (e.type === 'text' ? (e.fill ? 'note' : 'text') : e.type);

/** The board's items as read_whiteboard gives them, with what the user sees and has selected when it is open. */
export function whiteboardOutline(ctl: DeckController, live: boolean) {
  const elements = ctl.deck.slides[0]?.elements ?? [];
  const byId = new Map(elements.map((e) => [e.id, e]));
  const items = deckOutline(ctl.deck).slides[0].elements.map((o) => {
    const e = byId.get(o.id)!;
    // A shape or line with no color of its own is drawn in the theme's accent: say so, as the user sees it.
    if (e.type === 'shape' && !e.fill) return { ...o, fill: THEMES.light.accent };
    if (e.type === 'line' && !e.strokeColor) return { ...o, stroke: THEMES.light.accent };
    if (e.type !== 'text') return o;
    const { role: _role, style, ...rest } = o as Record<string, unknown> & { style?: TextElement['style'] };
    const look = { ...(style?.size && style.size !== TEXT_SIZE ? { size: style.size } : {}), ...(style?.color ? { color: style.color } : {}), ...(style?.bold ? { bold: true } : {}), ...(style?.italic ? { italic: true } : {}), ...(style?.font ? { font: style.font } : {}) };
    return { ...rest, type: itemType(e), text: boardText(e.paragraphs), ...(e.fill ? { fill: e.fill } : {}), ...look };
  });
  const view = live ? ctl.viewCenter?.() : undefined;
  return {
    board: { width: BOARD_W, height: BOARD_H, grid: GRID },
    item_count: items.length,
    items,
    ...(view ? { view_center: view } : {}),
    ...(live && ctl.selection.length ? { selected_items: ctl.selection } : {}),
  };
}

// --- Editing ------------------------------------------------------------------------------------

/** Room for typed text, before the page measures it: about its widest line and its number of lines. */
function typedTextBox(ps: Paragraph[], size: number): { w: number; h: number } {
  const widest = Math.max(1, ...ps.map((p) => p.text.length + (p.bullet ? 2 : 0)));
  return { w: snap(Math.max(GRID * 3, widest * size * 0.55)), h: snap(Math.max(GRID * 6, ps.length * size * 1.25)) };
}

/** Where the next item without a place goes: from the middle of what the user sees, else below everything there is. */
function placer(ctl: DeckController, live: boolean) {
  const elements = ctl.deck.slides[0]?.elements ?? [];
  const view = live ? ctl.viewCenter?.() : undefined;
  const bottom = elements.reduce((m, e) => Math.max(m, e.y + e.h), 0);
  const start = view ? { x: Math.max(GRID * 10, view.x - 300), y: Math.max(GRID * 10, view.y - 150) } : { x: 80, y: elements.length ? bottom + GAP * 2 : 80 };
  let x = start.x;
  let y = start.y;
  let rowH = 0;
  return (w: number, h: number): { x: number; y: number } => {
    if (x > start.x && x + w > start.x + 1200) {
      x = start.x;
      y += rowH + GAP;
      rowH = 0;
    }
    const at = { x: snap(x), y: snap(y) };
    x += w + GAP;
    rowH = Math.max(rowH, h);
    return at;
  };
}

/** An item spec applied to what there is (or a new item): the slide editor's element spec, plus notes and typed text. */
function applyItemSpec(existing: SlideElement | undefined, s: Input, byId: Map<string, SlideElement>, place: (w: number, h: number) => { x: number; y: number }): SlideElement {
  const was = existing ? itemType(existing) : undefined;
  const type = (s.type as string | undefined) ?? was;
  if (!type) throw new ToolError('A new item needs a type: text, note, shape, line or image.');
  if (was && s.type && s.type !== was) throw new ToolError(`Item ${existing!.id} is a ${was}; its type cannot change. Remove it and add a new one.`);
  const positioned = typeof s.x === 'number' && typeof s.y === 'number';
  const isLine = type === 'line' || (type === 'shape' && s.shape === 'line');
  const spec: Input = { ...s, type: type === 'note' ? 'text' : type };
  delete spec.text;
  let el = applyElementSpec(existing, spec, byId);
  if (el.type === 'text') {
    const prev = existing?.type === 'text' ? existing : undefined;
    const paragraphs = typeof s.text === 'string' ? boardParagraphs(s.text) : (prev?.paragraphs ?? [{ text: '' }]);
    const style = { ...el.style };
    if (style.size === undefined) style.size = TEXT_SIZE;
    const { role: _role, ...rest } = el;
    if (type === 'note') {
      const fill = typeof s.fill === 'string' && s.fill && s.fill !== 'none' ? s.fill : (prev?.fill ?? NOTE_FILL);
      if (style.color === undefined) style.color = '#202124';
      el = { ...rest, paragraphs, style, fill, ...(existing ? {} : { w: typeof s.w === 'number' ? s.w : NOTE_SIZE, h: typeof s.h === 'number' ? s.h : NOTE_SIZE }) };
    } else {
      // Typed text: its box follows its text (the open page measures it as it is drawn).
      style.paraSpacing = 0;
      el = { ...rest, paragraphs, style, anchored: true, ...typedTextBox(paragraphs, style.size) };
    }
  } else if (el.type === 'image' && !existing && typeof s.w !== 'number') {
    el = { ...el, w: 320, h: typeof s.h === 'number' ? s.h : 200 };
  }
  // New items without a place go where the user is looking, one after another.
  if (!existing && !positioned && !isLine) el = { ...el, ...place(el.w, el.h) };
  if (el.type === 'line') {
    const { x1, y1, x2, y2 } = lineEnds(el);
    el = { ...el, ...boxFromEnds(snap(x1), snap(y1), snap(x2), snap(y2)) } as SlideElement;
  } else {
    const x = Math.max(0, Math.min(BOARD_W - el.w, snap(el.x)));
    const y = Math.max(0, Math.min(BOARD_H - el.h, snap(el.y)));
    el = { ...el, x, y, ...(el.type === 'text' && el.anchored ? {} : { w: Math.max(GRID, snap(el.w)), h: Math.max(GRID, snap(el.h)) }) };
  }
  return el;
}

/** A question to ask before a destructive whiteboard call, or null. */
export function whiteboardConfirmationFor(call: ClientToolCall, board: DeckController | null): string | null {
  if (call.name !== 'edit_whiteboard' || !board) return null;
  const remove = (call.input.remove as string[] | undefined) ?? [];
  return remove.length > 10 ? `Remove ${remove.length} items from the whiteboard?` : null;
}

/** Run read_whiteboard or edit_whiteboard on the board `env.board` holds; `live` when it is the one the user sees. */
export function runWhiteboardTool(call: ClientToolCall, env: WhiteboardToolEnv, live = true): string {
  const ctl = requireBoard(env);
  const i = call.input;
  switch (call.name) {
    case 'read_whiteboard':
      return JSON.stringify(whiteboardOutline(ctl, live));

    case 'edit_whiteboard': {
      const sets = (i.set as Input[] | undefined) ?? [];
      const removes = new Set((i.remove as string[] | undefined) ?? []);
      if (!sets.length && !removes.size) throw new ToolError('Pass items to set and/or ids to remove.');
      const elements = ctl.deck.slides[0]?.elements ?? [];
      const byId = new Map(elements.map((e) => [e.id, e]));
      for (const id of removes) if (!byId.has(id)) throw new ToolError(`The whiteboard has no item "${id}". Use read_whiteboard for the ids.`);
      const place = placer(ctl, live);
      const changed: SlideElement[] = [];
      for (const s of sets) {
        const existing = typeof s.id === 'string' ? byId.get(s.id) : undefined;
        if (typeof s.id === 'string' && !existing) throw new ToolError(`The whiteboard has no item "${s.id}". Omit id to add a new item.`);
        const el = applyItemSpec(existing, s, byId, place);
        changed.push(el);
        byId.set(el.id, el); // a line may connect to an item added before it in the same call
      }
      let next = elements.filter((e) => !removes.has(e.id));
      for (const el of changed) next = next.some((e) => e.id === el.id) ? next.map((e) => (e.id === el.id ? el : e)) : [...next, el];
      const problem = validateWhiteboard(deckAsBoard({ ...ctl.deck, slides: [{ ...ctl.deck.slides[0], elements: next }] }));
      if (problem) throw new ToolError(problem);
      ctl.runAgent(env.group, (tx) => tx.updateSlide(0, (s) => ({ ...s, elements: next })));
      if (live) ctl.select(changed.map((e) => e.id));
      const stored = new Map((ctl.deck.slides[0]?.elements ?? []).map((e) => [e.id, e]));
      return JSON.stringify({
        set: changed.map((c) => {
          const e = stored.get(c.id) ?? c;
          return e.type === 'line' ? { id: e.id, type: 'line', ...lineEnds(e) } : { id: e.id, type: itemType(e), x: e.x, y: e.y, w: e.w, h: e.h };
        }),
        removed: [...removes],
        item_count: stored.size,
      });
    }

    default:
      throw new ToolError(`Unknown tool ${call.name}.`);
  }
}

