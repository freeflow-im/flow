// The compose body: TipTap's StarterKit (with its Link) and a small toolbar. @react-email/editor was tried first; it
// imports the `react-email` CLI package at run time (esbuild, socket.io, chokidar among its dependencies) and is built
// for designing email templates, so the plain TipTap it wraps fits a message box better.
import { EditorContent, useEditor, useEditorState, type Editor as TiptapEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import { Bold, Italic, Link2, List, ListOrdered, Quote, Strikethrough, Underline } from 'lucide-react';
import { cn } from '../lib/utils';

export function useMailEditor(initialHtml: string) {
  return useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false, autolink: true, defaultProtocol: 'https' }, heading: { levels: [1, 2, 3] } }), Placeholder.configure({ placeholder: 'Write your message…' })],
    content: initialHtml,
    autofocus: initialHtml ? 'start' : false,
    editorProps: { attributes: { class: 'px-1 py-2', 'aria-label': 'Message' } },
  });
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
