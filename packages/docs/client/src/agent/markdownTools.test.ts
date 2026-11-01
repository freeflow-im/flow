import { describe, expect, it } from 'vitest';
import { MarkdownController } from '../markdown/controller.ts';
import { confirmationFor, runClientTool, type ClientToolEnv } from './clientTools.ts';

function setup(text = '') {
  const markdown = new MarkdownController({ version: 1, text }, async () => {});
  const env: ClientToolEnv = {
    ctl: null,
    deck: null,
    doc: null,
    markdown,
    group: 'agent-1',
    openSheet: async () => Promise.reject(new Error('No sheet in this test.')),
    openDeck: async () => Promise.reject(new Error('No deck in this test.')),
    openDoc: async () => ({ kind: 'markdown', ctl: markdown }),
    requestAppChange: async () => ({ id: 'job-1' }),
    requestResearch: async () => ({ id: 'job-2', sheetIncluded: false }),
    uploadImage: async () => '/api/images/00000000-0000-0000-0000-000000000001',
    fetchConnectorData: async () => Promise.reject(new Error('x')),
  };
  const call = async (name: string, input: Record<string, unknown> = {}) => JSON.parse(await runClientTool({ id: 'x', name, input }, env));
  return { markdown, env, call };
}

const TEXT = '---\ntitle: Notes\n---\n\n# Notes\n\nFirst paragraph.\n\n- a\n- b\n';

describe('agent document tools on a Markdown document', () => {
  it('reads it as numbered blocks of Markdown source, with the cursor block', async () => {
    const { call, markdown } = setup(TEXT);
    markdown.cursor = TEXT.indexOf('First');
    const res = await call('read_doc');
    expect(res.format).toBe('markdown');
    expect(res.block_count).toBe(4);
    expect(res.cursor_block).toBe(3);
    expect(res.blocks.map((b: { type: string }) => b.type)).toEqual(['front_matter', 'heading1', 'paragraph', 'bullet_list']);
    expect(res.blocks[1].markdown).toBe('# Notes');
    const opened = await call('open_doc', { doc_id: 'any' });
    expect(opened.opened).toBe(true);
    expect(opened.block_count).toBe(4);
  });

  it('inserts, replaces and deletes blocks in the text, keeping the rest verbatim', async () => {
    const { call, markdown } = setup(TEXT);
    let res = await call('insert_content', { markdown: '## Tasks\n\n> todo', after: 3 });
    expect(res).toEqual({ inserted_blocks: [4, 5], block_count: 6 });
    expect(markdown.text).toBe('---\ntitle: Notes\n---\n\n# Notes\n\nFirst paragraph.\n\n## Tasks\n\n> todo\n\n- a\n- b\n');

    res = await call('replace_blocks', { from: 3, markdown: 'Rewritten **paragraph**.' });
    expect(res).toEqual({ replaced_blocks: [3], new_blocks: [3], block_count: 6 });
    expect(markdown.text).toContain('# Notes\n\nRewritten **paragraph**.\n\n## Tasks');

    res = await call('delete_blocks', { from: 4, to: 5 });
    expect(res).toEqual({ deleted_blocks: 2, block_count: 4 });
    expect(markdown.text).toBe('---\ntitle: Notes\n---\n\n# Notes\n\nRewritten **paragraph**.\n\n- a\n- b\n');

    res = await call('insert_content', { markdown: 'At the end' });
    expect(res.inserted_blocks).toEqual([5]);
    expect(markdown.text.endsWith('- b\n\nAt the end\n')).toBe(true);
    res = await call('insert_content', { markdown: 'Top', after: 0 });
    expect(res.inserted_blocks).toEqual([1]);
    expect(markdown.text.startsWith('Top\n\n---\n')).toBe(true);
    expect(markdown.cursor).toBe(5);
  });

  it('replaces text in place and reports the blocks touched', async () => {
    const { call, markdown } = setup('cat\n\ncat and cat\n');
    let res = await call('replace_text', { find: 'cat', replace: 'dog', block: 2 });
    expect(res).toEqual({ replaced: 2, blocks: [2], block_count: 2 });
    expect(markdown.text).toBe('cat\n\ndog and dog\n');
    res = await call('replace_text', { find: 'bird', replace: 'x' });
    expect(res.replaced).toBe(0);
  });

  it('refuses the formatting tools with a pointer to the content tools, and bad block numbers', async () => {
    const { call } = setup(TEXT);
    await expect(call('format_text', { find: 'Notes', bold: true })).rejects.toThrow(/Markdown document.*replace_text/);
    await expect(call('set_page_setup', { mode: 'pages' })).rejects.toThrow(/Markdown/);
    await expect(call('replace_blocks', { from: 9, markdown: 'x' })).rejects.toThrow(/no block 9/);
    await expect(call('insert_content', { markdown: '   ' })).rejects.toThrow(/empty/);
  });

  it('asks before deleting or replacing many blocks', () => {
    const { markdown } = setup(TEXT);
    expect(confirmationFor({ id: 'x', name: 'delete_blocks', input: { from: 2, to: 3 } }, null, null, null, markdown)).toBe('Delete blocks 2–3 of the document?');
    expect(confirmationFor({ id: 'x', name: 'replace_blocks', input: { from: 1, markdown: 'x' } }, null, null, null, markdown)).toBeNull();
  });
});
