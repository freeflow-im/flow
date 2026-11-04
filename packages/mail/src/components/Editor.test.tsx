// The message body's pictures: an <img> survives the editor, and a picture file goes in at the caret as a data: URL.
import { describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Image, insertImages } from './Editor';

const PNG = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));

describe('the message body', () => {
  it('keeps a picture in the text, and puts a pasted picture file in at the caret', async () => {
    const editor = new Editor({ extensions: [StarterKit, Image], content: '<p>Before <img src="https://x.test/a.png" alt="a"> after</p>' });
    expect(editor.getHTML()).toContain('<img src="https://x.test/a.png" alt="a"');
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    const n = await insertImages(editor, [new File([PNG], 'dot.png', { type: 'image/png' }), new File(['x'], 'notes.txt', { type: 'text/plain' })]);
    expect(n).toBe(1);
    expect(editor.getHTML()).toMatch(/after<img src="data:image\/png;base64,iVBOR[^"]+" alt="dot.png"/);
    expect(editor.getText()).toBe('Before  after');
    editor.destroy();
  });
});
