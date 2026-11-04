// The compose body: TipTap's StarterKit (with its Link) and a small toolbar. @react-email/editor was tried first; it
// imports the `react-email` CLI package at run time (esbuild, socket.io, chokidar among its dependencies) and is built
// for designing email templates, so the plain TipTap it wraps fits a message box better.
import { useRef } from 'react';
import { EditorContent, Node, mergeAttributes, useEditor, useEditorState, type Editor as TiptapEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { Bold, Italic, Link2, List, ListOrdered, Quote, Strikethrough, Underline } from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * A picture in the message, in the line with the text: pasted in (a data: URL), quoted from the original or a draft (one of
 * this app's attachment URLs), or the original's remote one. Sent, each becomes an inline part shown by cid (lib/inlineImages.ts).
 */
export const Image = Node.create({
  name: 'image',
  inline: true,
  group: 'inline',
  draggable: true,
  atom: true,
  addAttributes() {
    return { src: { default: null }, alt: { default: null }, title: { default: null }, width: { default: null }, height: { default: null } };
  },
  parseHTML() {
    return [{ tag: 'img[src]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['img', mergeAttributes(HTMLAttributes, { style: 'max-width: 100%; height: auto;' })];
  },
});

/** Largest picture pasted in: the message's 20 MB holds a few of these. */
export const MAX_PASTED_IMAGE_BYTES = 10 * 1024 * 1024;

/** Reads pictures from files (the clipboard's) and puts them in the message at the caret, each as a data: URL. */
export async function insertImages(editor: TiptapEditor, files: readonly File[]): Promise<number> {
  const pictures = files.filter((f) => f.type.startsWith('image/') && f.size <= MAX_PASTED_IMAGE_BYTES);
  for (const file of pictures) {
    const src = await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
    if (editor.isDestroyed) break;
    editor.chain().focus().insertContent({ type: 'image', attrs: { src, alt: file.name || null } }).run();
  }
  return pictures.length;
}

export function useMailEditor(initialHtml: string) {
  const ref = useRef<TiptapEditor | null>(null);
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false, autolink: true, defaultProtocol: 'https' }, heading: { levels: [1, 2, 3] } }), Image, Placeholder.configure({ placeholder: 'Write your message…' })],
    content: initialHtml,
    autofocus: initialHtml ? 'start' : false,
    editorProps: {
      attributes: { class: 'px-1 py-2', 'aria-label': 'Message' },
      // A picture on the clipboard goes into the message where the caret is (a file dropped on the composer is attached).
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'));
        if (!files.length) return false;
        event.preventDefault();
        if (ref.current) void insertImages(ref.current, files);
        return true;
      },
    },
  });
  ref.current = editor;
  return editor;
}

function Tool({ label, active, onClick, children }: { label: string; active?: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn('flex size-8 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-ink', active && 'bg-row-selected text-ink')}
    >
      {children}
    </button>
  );
}

export function EditorToolbar({ editor }: { editor: TiptapEditor | null }) {
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e
        ? {
            bold: e.isActive('bold'),
            italic: e.isActive('italic'),
            underline: e.isActive('underline'),
            strike: e.isActive('strike'),
            bullet: e.isActive('bulletList'),
            ordered: e.isActive('orderedList'),
            quote: e.isActive('blockquote'),
            link: e.isActive('link'),
          }
        : null,
  });
  if (!editor || !s) return null;
  const c = () => editor.chain().focus();
  const link = () => {
    if (s.link) return c().unsetLink().run();
    const url = window.prompt('Link address');
    if (url) c().extendMarkRange('link').setLink({ href: /^[a-z]+:/i.test(url) ? url : `https://${url}` }).run();
  };
  return (
    <div className="flex flex-wrap items-center gap-0.5" role="toolbar" aria-label="Formatting">
      <Tool label="Bold" active={s.bold} onClick={() => c().toggleBold().run()}>
        <Bold className="size-4" />
      </Tool>
      <Tool label="Italic" active={s.italic} onClick={() => c().toggleItalic().run()}>
        <Italic className="size-4" />
      </Tool>
      <Tool label="Underline" active={s.underline} onClick={() => c().toggleUnderline().run()}>
        <Underline className="size-4" />
      </Tool>
      <Tool label="Strikethrough" active={s.strike} onClick={() => c().toggleStrike().run()}>
        <Strikethrough className="size-4" />
      </Tool>
      <Tool label="Link" active={s.link} onClick={link}>
        <Link2 className="size-4" />
      </Tool>
      <Tool label="Bulleted list" active={s.bullet} onClick={() => c().toggleBulletList().run()}>
        <List className="size-4" />
      </Tool>
      <Tool label="Numbered list" active={s.ordered} onClick={() => c().toggleOrderedList().run()}>
        <ListOrdered className="size-4" />
      </Tool>
      <Tool label="Quote" active={s.quote} onClick={() => c().toggleBlockquote().run()}>
        <Quote className="size-4" />
      </Tool>
    </div>
  );
}

export function EditorArea({ editor }: { editor: TiptapEditor | null }) {
  return <EditorContent editor={editor} className="mail-editor" />;
}
