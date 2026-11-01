// Turn a URL the user has just typed into a link when they follow it with a space (an input rule) or Enter (a
// command that runs before the usual Enter handling). Trailing punctuation stays outside the link, and text
// that is already linked, or inside a code block or inline code, is left alone.
import { InputRule } from 'prosemirror-inputrules';
import type { Command, EditorState, Transaction } from 'prosemirror-state';
import { docSchema } from '../../../shared/doc.ts';
import { safeLinkUrl } from '../../../shared/links.ts';

const URL_BEFORE_CURSOR = /(?:^|\s)(https?:\/\/\S+)$/i;
const TRAILING_PUNCTUATION = /[.,;:!?)\]'"]+$/;

/** The URL that ends right at the cursor, if it should become a link. */
export function urlBeforeCursor(state: EditorState): { from: number; to: number; href: string } | null {
  const { $from, empty } = state.selection;
  if (!empty || !$from.parent.isTextblock || $from.parent.type.spec.code) return null;
  const text = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
  const m = URL_BEFORE_CURSOR.exec(text);
  if (!m) return null;
  const href = m[1].replace(TRAILING_PUNCTUATION, '');
  if (!safeLinkUrl(href)) return null;
  const from = $from.pos - m[1].length;
  const to = from + href.length;
  const $start = state.doc.resolve(from);
  const marks = $start.nodeAfter?.marks ?? [];
  if (marks.some((mk) => mk.type === docSchema.marks.link || mk.type === docSchema.marks.code)) return null;
  return { from, to, href };
}

/** The input rule's handler: link the URL and still insert the space that was typed at `end`. */
export function autoLinkHandler(state: EditorState, _match: RegExpMatchArray, _start: number, end: number): Transaction | null {
  const url = urlBeforeCursor(state);
  if (!url) return null;
  const tr = state.tr.insertText(' ', end);
  tr.addMark(url.from, url.to, docSchema.marks.link.create({ href: url.href }));
  return tr;
}

/** Typing a space after a URL links it. */
export const autoLinkRule = new InputRule(/(?:^|\s)https?:\/\/\S+\s$/i, autoLinkHandler);

/** Enter after a URL links it, then lets the normal Enter handling split the block. */
export const autoLinkOnEnter: Command = (state, dispatch) => {
  const url = urlBeforeCursor(state);
  if (url && dispatch) dispatch(state.tr.addMark(url.from, url.to, docSchema.marks.link.create({ href: url.href })));
  return false;
};
