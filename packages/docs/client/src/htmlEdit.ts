// Editing a stored web page in place (components/HtmlEditor.tsx). The page stays in its sandboxed frame, which the
// app cannot reach into, so the editing is done by a script put into the page: it selects the element the user
// clicks, edits its text, deletes it or recolors it, and posts the page's new HTML to the app, which saves it.
// While a page is being edited its own scripts are switched off (a Content-Security-Policy that only lets the
// editing script run), so what is on screen is the markup in the file and nothing a script generated gets saved
// into it. The same policy means nothing in the page can pose as the editing script.

/** What the frame posts to the app. */
export type FrameMessage =
  | {
      ff: 'select';
      /** A short name for the element, such as "h1#title" or "div.card". */
      label: string;
      /** The element's HTML. */
      html: string;
      /** Its text and background colors as #rrggbb. */
      color: string;
      background: string;
      /** False for the page body, which cannot be deleted. */
      deletable: boolean;
    }
  | { ff: 'deselect' }
  /** The page changed: its whole HTML, ready to store. */
  | { ff: 'change'; html: string };

/** What the app posts to the frame; each acts on the selected element. */
export type FrameCommand = { ff: 'cmd'; cmd: 'edit' | 'delete' | 'deselect' } | { ff: 'cmd'; cmd: 'color' | 'background'; value: string };

/** The longest element HTML the assistant is given as the selection. */
export const MAX_SELECTED_HTML = 2000;

export const shortenHtml = (html: string): string => (html.length > MAX_SELECTED_HTML ? `${html.slice(0, MAX_SELECTED_HTML)}…` : html);

/**
 * The script that runs inside the page. It is put into the page as text, so it must not use anything outside
 * its own body.
 */
function frameScript(): void {
  const MARK = 'data-ff-edit';
  const post = (msg: unknown) => window.parent.postMessage(msg, '*');
  let selected: HTMLElement | null = null;
  let editing: HTMLElement | null = null;
  let before = '';
  let hovered: HTMLElement | null = null;
  const boxes: Record<string, HTMLElement> = {};

  // Outlines are drawn as boxes over the page rather than as styles on its elements, so they never get saved.
  const outline = (name: 'hover' | 'select', el: HTMLElement | null) => {
    let box = boxes[name];
    if (!box) {
      box = document.createElement('div');
      box.setAttribute(MARK, '');
      box.style.cssText = `position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;border:${name === 'select' ? '2px solid #1a73e8' : '1px dashed #1a73e8'}`;
      boxes[name] = box;
    }
    if (!el || !el.isConnected) {
      box.remove();
      return;
    }
    if (!box.isConnected) document.documentElement.appendChild(box);
    const r = el.getBoundingClientRect();
    box.style.left = `${r.left}px`;
    box.style.top = `${r.top}px`;
    box.style.width = `${r.width}px`;
    box.style.height = `${r.height}px`;
  };
  const redraw = () => {
    outline('select', selected);
    outline('hover', hovered && hovered !== selected && !editing ? hovered : null);
  };

  const hex = (css: string, fallback: string) => {
    const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?/.exec(css);
    if (!m || m[4] === '0') return fallback;
    return `#${[m[1], m[2], m[3]].map((n) => Math.round(Number(n)).toString(16).padStart(2, '0')).join('')}`;
  };

  const serialize = () => {
    const root = document.documentElement.cloneNode(true) as HTMLElement;
    root.querySelectorAll(`[${MARK}]`).forEach((n) => n.remove());
    root.querySelectorAll('[contenteditable][data-ff-editing]').forEach((n) => {
      n.removeAttribute('contenteditable');
      n.removeAttribute('data-ff-editing');
    });
    const dt = document.doctype;
    const ids = dt ? (dt.publicId ? ` PUBLIC "${dt.publicId}"` : dt.systemId ? ' SYSTEM' : '') + (dt.systemId ? ` "${dt.systemId}"` : '') : '';
    return `${dt ? `<!DOCTYPE ${dt.name}${ids}>\n` : ''}${root.outerHTML}\n`;
  };

  const report = () => {
    if (!selected) return post({ ff: 'deselect' });
    const cls = selected.classList[0];
    const style = getComputedStyle(selected);
    post({
      ff: 'select',
      label: selected.tagName.toLowerCase() + (selected.id ? `#${selected.id}` : cls ? `.${cls}` : ''),
      html: selected.outerHTML,
      color: hex(style.color, '#000000'),
      background: hex(style.backgroundColor, '#ffffff'),
      deletable: selected !== document.body,
    });
  };
  const changed = () => {
    post({ ff: 'change', html: serialize() });
    report();
    redraw();
  };

  const finishEditing = () => {
    const el = editing;
    if (!el) return;
    editing = null;
    el.removeAttribute('contenteditable');
    el.removeAttribute('data-ff-editing');
    if (el.innerHTML !== before) changed();
    redraw();
  };
  const startEditing = () => {
    if (!selected || editing) return;
    editing = selected;
    before = editing.innerHTML;
    editing.setAttribute('contenteditable', 'true');
    editing.setAttribute('data-ff-editing', '');
    editing.focus();
    editing.addEventListener('blur', finishEditing, { once: true });
    redraw();
  };
  const select = (el: HTMLElement | null) => {
    finishEditing();
    selected = el === document.documentElement ? document.body : el;
    report();
    redraw();
  };
  const remove = () => {
    if (!selected || selected === document.body) return;
    const el = selected;
    selected = null;
    el.remove();
    changed();
  };

  const target = (e: Event) => (e.target instanceof HTMLElement ? e.target : e.target instanceof Element ? e.target.closest<HTMLElement>('*:not(svg *)') : null);
  const inEdit = (e: Event) => !!editing && e.target instanceof Node && editing.contains(e.target);

  document.addEventListener(
    'mousemove',
    (e) => {
      hovered = target(e);
      redraw();
    },
    true,
  );
  document.addEventListener('mouseleave', () => {
    hovered = null;
    redraw();
  });
  // A click selects instead of following a link or pressing a button.
  document.addEventListener(
    'click',
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!inEdit(e)) select(target(e));
    },
    true,
  );
  document.addEventListener(
    'dblclick',
    (e) => {
      e.preventDefault();
      if (!inEdit(e)) startEditing();
    },
    true,
  );
  document.addEventListener('submit', (e) => e.preventDefault(), true);
  document.addEventListener(
    'keydown',
    (e) => {
      if (editing) {
        if (e.key === 'Escape') editing.blur();
        return;
      }
      if (!selected) return;
      if (e.key === 'Delete' || e.key === 'Backspace') remove();
      else if (e.key === 'Enter') startEditing();
      else if (e.key === 'Escape') select(null);
      else return;
      e.preventDefault();
    },
    true,
  );
  document.addEventListener('input', redraw, true);
  window.addEventListener('scroll', redraw, true);
  window.addEventListener('resize', redraw);

  window.addEventListener('message', (e) => {
    const m = e.data as { ff?: string; cmd?: string; value?: string } | null;
    if (e.source !== window.parent || !m || m.ff !== 'cmd') return;
    if (m.cmd === 'deselect') return select(null);
    if (!selected) return;
    if (m.cmd === 'edit') startEditing();
    else if (m.cmd === 'delete') remove();
    else if (m.cmd === 'color' || m.cmd === 'background') {
      finishEditing();
      selected.style[m.cmd === 'color' ? 'color' : 'backgroundColor'] = String(m.value);
      changed();
    }
  });
}

/**
 * A page's HTML made editable: the editing script, and the policy that stops the page's own scripts, go in
 * right after the doctype (before it they would put the page in quirks mode). `nonce` must be unguessable.
 */
export function editableHtml(html: string, nonce: string): string {
  const head =
    `<meta data-ff-edit http-equiv="Content-Security-Policy" content="script-src 'nonce-${nonce}'">` +
    `<style data-ff-edit>*{cursor:default!important}[data-ff-editing]{cursor:text!important;outline:none!important}</style>` +
    `<script data-ff-edit nonce="${nonce}">(${frameScript.toString()})()</script>`;
  const at = /^(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i.exec(html)?.[0].length ?? 0;
  return html.slice(0, at) + head + html.slice(at);
}
