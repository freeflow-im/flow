import { describe, expect, it } from 'vitest';
import type { ClientToolCall } from '../../../shared/agent/protocol.ts';
import type { FetchResult } from '../../../shared/connectors.ts';
import { newWorkbook, type Workbook } from '../../../shared/types.ts';
import { csvToWorkbook } from '../../../shared/csv.ts';
import { SheetController } from '../state/controller.ts';
import { csvGuard, lockedGuard, xlsxGuard } from '../state/store.ts';
import { confirmationFor, runClientTool, ToolError, type ClientToolEnv } from './clientTools.ts';
import type { AspEditorHandle } from '@ascentsparksoftware/react-image-editor';
import { setActiveImageEditor } from '../image/activeEditor.ts';
import { fakeEngine } from '../image/fakeEngine.ts';
import { toolLabel } from './describe.ts';

function setup(wb: Workbook = newWorkbook('t1')) {
  const ctl = new SheetController(wb, async () => {});
  const uploads: Blob[] = [];
  const env: ClientToolEnv = {
    ctl,
    deck: null,
    doc: null,
    group: 'agent-1',
    openSheet: async () => ctl,
    openDeck: async () => Promise.reject(new Error('No deck in this test.')),
    openDoc: async () => Promise.reject(new Error('No doc in this test.')),
    requestAppChange: async () => ({ id: 'job-1' }), requestResearch: async (_t, _task, includeSheet) => ({ id: 'job-2', sheetIncluded: includeSheet }),
    uploadImage: async (file) => {
      uploads.push(file);
      return `/api/images/00000000-0000-0000-0000-00000000000${uploads.length}`;
    },
    fetchConnectorData: async () => {
      throw new Error('No connector data in this test.');
    },
  };
  const call = async (name: string, input: Record<string, unknown> = {}) => JSON.parse(await runClientTool({ id: 'x', name, input }, env));
  return { ctl, env, call, uploads };
}

describe('agent sheet tools', () => {
  it('writes values and formulas, then reads computed values back', async () => {
    const { ctl, call } = setup();
    const res = await call('write_range', { start: 'A1', rows: [['Item', 'Cost'], ['Pens', 3], ['Paper', 4.5], ['Total', '=SUM(B2:B3)']] });
    expect(res).toMatchObject({ wrote: 'Sheet1!A1:B4', cells: 8 });
    expect(ctl.store.display(ctl.tab.id, 3, 1)).toBe('7.5');

    const read = await call('read_range', { range: 'A1:B4', include_formulas: true });
    expect(read.values).toEqual([['Item', 'Cost'], ['Pens', '3'], ['Paper', '4.5'], ['Total', '7.5']]);
    expect(read.formulas).toEqual({ B4: '=SUM(B2:B3)' });
  });

  it('reports formula errors in what it wrote', async () => {
    const { call } = setup();
    const res = await call('write_range', { start: 'A1', rows: [['=NOPE(1)']] });
    expect(res.cells_with_errors[0]).toMatchObject({ cell: 'A1' });
  });

  it('undoes all edits from one request as a single step', async () => {
    const { ctl, call } = setup();
    ctl.run((tx) => tx.setCell(ctl.tab.id, 'D1', { v: 'mine' }));
    await call('write_range', { start: 'A1', rows: [['a', 'b']] });
    await call('format_range', { range: 'A1:B1', bold: true, fill_color: '#ffff00' });
    await call('insert_rows', { at_row: 1, count: 1 });
    expect(ctl.store.cell(ctl.tab.id, 1, 0)).toEqual({ v: 'a', st: { b: true, bg: '#ffff00' } });

    ctl.undo();
    expect(ctl.store.cell(ctl.tab.id, 0, 0)).toBeUndefined();
    expect(ctl.store.cell(ctl.tab.id, 0, 3)).toEqual({ v: 'mine' });
  });

  it('turns word wrap on and off and reports it in read_range formats', async () => {
    const { ctl, call } = setup();
    await call('write_range', { start: 'A1', rows: [['a long description', 'x']] });
    await call('format_range', { range: 'A1:B1', wrap: true });
    expect(ctl.tab.cells.A1.st).toEqual({ wrap: true });
    const read = await call('read_range', { range: 'A1:B1', include_formats: true });
    expect(read.formats).toEqual({ A1: { wrap: true }, B1: { wrap: true } });

    await call('format_range', { range: 'B1', wrap: false });
    expect(ctl.tab.cells.B1.st).toBeUndefined();
    expect(ctl.tab.cells.A1.st).toEqual({ wrap: true });
  });

  it('grows the tab to fit what it writes', async () => {
    const { ctl, call } = setup();
    await call('write_range', { start: 'AB1001', rows: [['far']] });
    expect(ctl.tab.rows).toBe(1001);
    expect(ctl.tab.cols).toBe(28);
  });

  it('sorts by a column below a header row', async () => {
    const { ctl, call } = setup();
    await call('write_range', { start: 'A1', rows: [['Name', 'Score'], ['b', 2], ['a', 3], ['c', 1]] });
    await call('sort_range', { range: 'A:B', by_column: 'B', has_header: true, ascending: false });
    const read = await call('read_range', { range: 'A1:B4' });
    expect(read.values.map((r: string[]) => r[0])).toEqual(['Name', 'a', 'b', 'c']);
    expect(ctl.tab.cells.A1.v).toBe('Name');
  });

  it('moves columns with move_columns, updating formulas on other tabs, and undoes in one step', async () => {
    const { ctl, call } = setup();
    const header = ['id', 'name', 'status', 'primary', 'current_balance', 'available_balance', 'currency'];
    await call('write_range', { start: 'A1', rows: [header, [1, 'Ops', 'open', true, 100, 80, 'USD']] });
    await call('add_tab', { name: 'Summary' });
    await call('write_range', { tab: 'Summary', start: 'A1', rows: [['=Sheet1!F2', '=SUM(Sheet1!E2:F2)']] });
    const res = await call('move_columns', { tab: 'Sheet1', from_column: 'F', before_column: 'E' });
    expect(res).toMatchObject({ new_range: 'E:E', tab: 'Sheet1' });
    const read = await call('read_range', { tab: 'Sheet1', range: 'A1:G1' });
    expect(read.values[0]).toEqual(['id', 'name', 'status', 'primary', 'available_balance', 'current_balance', 'currency']);
    const summary = ctl.store.workbook.tabs[1];
    expect(summary.cells.A1.v).toBe('=Sheet1!E2');
    expect(summary.cells.B1.v).toBe('=SUM(Sheet1!E2:F2)');
    expect(ctl.store.display(summary.id, 0, 0)).toBe('80');

    await expect(call('move_columns', { tab: 'Sheet1', from_column: 'B', to_column: 'C', before_column: 'D' })).rejects.toThrow(ToolError);
    ctl.undo();
    expect(ctl.store.workbook.tabs.length).toBe(1);
    expect(ctl.store.workbook.tabs[0].cells.F1).toBeUndefined();
  });

  it('drags selected columns: selection follows the moved columns and undo restores in one step', async () => {
    const { ctl, call } = setup();
    await call('write_range', { start: 'A1', rows: [['a', 'b', 'c', 'd']] });
    ctl.selectCols(0, 1);
    expect(ctl.canDragCols(1)).toBe(true);
    expect(ctl.canDragCols(2)).toBe(false);
    ctl.moveCols(4); // A:B to just before E
    expect(['A1', 'B1', 'C1', 'D1'].map((k) => ctl.tab.cells[k].v)).toEqual(['c', 'd', 'a', 'b']);
    expect(ctl.primary).toMatchObject({ c1: 2, c2: 3, r1: 0, r2: ctl.tab.rows - 1 });
    ctl.undo();
    expect(['A1', 'B1', 'C1', 'D1'].map((k) => ctl.tab.cells[k].v)).toEqual(['a', 'b', 'c', 'd']);
    expect(ctl.primary).toMatchObject({ c1: 0, c2: 1 });
  });

  it('puts an image from a URL in a cell, reads it as [image], and undoes it', async () => {
    const { ctl, call } = setup();
    const url = 'https://example.com/logo.png';
    expect(await call('set_cell_image', { range: 'I9', url })).toEqual({ image_in: 'Sheet1!I9' });
    expect(ctl.tab.cells.I9).toEqual({ v: '', img: url });
    expect((await call('read_range', { range: 'I9' })).values).toEqual([['[image]']]);
    await expect(call('set_cell_image', { range: 'A1', url: 'javascript:alert(1)' })).rejects.toThrow(ToolError);
    await expect(call('set_cell_image', { range: 'A1:Z100', url })).rejects.toThrow(/at most 100/);
    ctl.undo();
    expect(ctl.tab.cells.I9).toBeUndefined();
  });

  it('makes cells links with set_cell_link and reports links in read_range', async () => {
    const { ctl, call } = setup();
    await call('write_range', { start: 'D2', rows: [['https://en.wikipedia.org/wiki/Eat_a_Peach'], ['n/a (original)']] });
    const res = await call('set_cell_link', { range: 'A1', url: 'https://example.com/?q="x"', label: 'Say "hi"' });
    expect(res).toEqual({ linked: 'Sheet1!A1', url: 'https://example.com/?q="x"', label: 'Say "hi"' });
    await call('set_cell_link', { range: 'B1:B2', url: 'mailto:me@example.com' });
    expect(ctl.store.display(ctl.tab.id, 1, 1)).toBe('mailto:me@example.com');
    const read = await call('read_range', { range: 'A1:D3' });
    expect(read.values[0][0]).toBe('Say "hi"');
    expect(read.links).toEqual({
      A1: 'https://example.com/?q="x"',
      B1: 'mailto:me@example.com',
      B2: 'mailto:me@example.com',
      D2: 'https://en.wikipedia.org/wiki/Eat_a_Peach',
    });
    await expect(call('set_cell_link', { range: 'A1', url: 'javascript:alert(1)' })).rejects.toThrow(ToolError);
    ctl.undo();
    expect(ctl.tab.cells.A1).toBeUndefined();
  });

  it('stores data: URL images on the server and puts the reference in the cell', async () => {
    const { ctl, call, uploads } = setup();
    await call('set_cell_image', { range: 'A15', url: 'data:image/png;base64,iVBORw0KGgo=' });
    expect(uploads).toHaveLength(1);
    expect(uploads[0].type).toBe('image/png');
    expect(uploads[0].size).toBe(8);
    expect(ctl.tab.cells.A15).toEqual({ v: '', img: '/api/images/00000000-0000-0000-0000-000000000001' });
  });

  it('sets filter criteria on filter columns, combined with AND', async () => {
    const { ctl, call } = setup();
    await expect(call('set_filter_criteria', { column: 'B', values: ['France'] })).rejects.toThrow(/set_filter/);
    await call('write_range', {
      start: 'A1',
      rows: [['Name', 'Country', 'Tier'], ['Alice', 'France', 'Gold'], ['Bob', 'Spain', 'Gold'], ['Chloé', 'france', 'Silver'], ['Dan', 'Italy', 'Silver']],
    });
    await call('set_filter', { range: 'A1:C5' });
    await expect(call('set_filter_criteria', { column: 'D', values: ['x'] })).rejects.toThrow(/not inside/);

    expect(await call('set_filter_criteria', { column: 'b', values: ['FRANCE'] })).toMatchObject({ column: 'B', visible_rows: 2 });
    expect([...ctl.hiddenRows()].sort()).toEqual([2, 4]);
    expect(await call('set_filter_criteria', { column: 'C', values: ['Gold'] })).toMatchObject({ visible_rows: 1 });
    expect(await call('set_filter_criteria', { column: 'B', clear: true })).toMatchObject({ visible_rows: 2 });
    expect(ctl.tab.filter!.cols[1]).toBeUndefined();
    expect([...ctl.hiddenRows()].sort()).toEqual([3, 4]);
  });

  it('sets row heights for a row or span, undoably', async () => {
    const { ctl, call } = setup();
    expect(await call('set_row_height', { rows: '1', height: 40 })).toEqual({ tab: 'Sheet1', rows: '1', height: 40 });
    expect(ctl.tab.rowHeights).toEqual({ 0: 40 });
    expect(await call('set_row_height', { rows: '5:3', height: 30 })).toMatchObject({ rows: '3:5', height: 30 });
    expect(ctl.tab.rowHeights).toEqual({ 0: 40, 2: 30, 3: 30, 4: 30 });
    await expect(call('set_row_height', { rows: 'A', height: 30 })).rejects.toThrow(ToolError);
    await expect(call('set_row_height', { rows: '0', height: 30 })).rejects.toThrow(/from 1/);
    ctl.undo();
    expect(ctl.tab.rowHeights).toEqual({});
  });

  it('works with tabs by name and switches to the tab it edits', async () => {
    const { ctl, call } = setup();
    await call('add_tab', { name: 'Summary' });
    expect(ctl.tab.name).toBe('Summary');
    ctl.switchTab(ctl.store.workbook.tabs[0].id);
    await call('write_range', { tab: 'Summary', start: 'A1', rows: [['=Sheet1!A1']] });
    expect(ctl.tab.name).toBe('Summary');
    await call('rename_tab', { tab: 'Sheet1', name: 'Data' });
    expect(ctl.store.workbook.tabs[1].cells.A1.v).toBe('=Data!A1');
    await expect(call('read_range', { range: 'Nope!A1' })).rejects.toThrow(ToolError);
  });

  it('describes the spreadsheet and the selection', async () => {
    const { ctl, call } = setup();
    await call('write_range', { start: 'A1', rows: [['h1', 'h2'], [1, 2]] });
    ctl.selectRange({ r1: 1, c1: 0, r2: 1, c2: 1 });
    const res = await call('get_sheet_overview');
    expect(res.tabs[0]).toMatchObject({ name: 'Sheet1', active: true, used_range: 'A1:B2', first_rows: [['h1', 'h2'], ['1', '2']] });
    expect(res.selection).toEqual(['A2:B2']);
  });

  it('fails clearly when no spreadsheet is open', async () => {
    const env: ClientToolEnv = { ctl: null, deck: null, doc: null, group: 'g', openSheet: async () => Promise.reject(new Error('x')), openDeck: async () => Promise.reject(new Error('x')), openDoc: async () => Promise.reject(new Error('x')), requestAppChange: async () => ({ id: 'job-1' }), requestResearch: async (_t, _task, includeSheet) => ({ id: 'job-2', sheetIncluded: includeSheet }), uploadImage: async () => '', fetchConnectorData: async () => Promise.reject(new Error('x')) };
    await expect(runClientTool({ id: 'x', name: 'read_range', input: { range: 'A1' } }, env)).rejects.toThrow(/No spreadsheet is open/);
  });

  it('asks before destructive actions', async () => {
    const { ctl, call } = setup();
    const c = (name: string, input: Record<string, unknown>): ClientToolCall => ({ id: 'x', name, input });
    expect(confirmationFor(c('delete_tab', { tab: 'Sheet1' }), ctl)).toMatch(/Delete the tab/);
    expect(confirmationFor(c('delete_rows', { from_row: 5, to_row: 2 }), ctl)).toBe('Delete rows 2–5 of “Sheet1”?');
    expect(confirmationFor(c('clear_range', { range: 'A1:A5' }), ctl)).toBeNull();
    await call('write_range', { start: 'A1', rows: Array.from({ length: 150 }, (_, i) => [i]) });
    expect(confirmationFor(c('clear_range', { range: 'A:A' }), ctl)).toMatch(/Clear 150 cells/);
    expect(confirmationFor(c('write_range', { start: 'A1', rows: [[1]] }), ctl)).toBeNull();
  });

  it('asks before changing the app, then queues the change', async () => {
    const { ctl, call } = setup();
    const input = { title: 'Add set_filter_values', spec: 'Let the assistant choose which values a filter shows.' };
    expect(confirmationFor({ id: 'x', name: 'request_app_change', input }, ctl)).toMatch(/Change the app: Add set_filter_values\?/);
    expect(confirmationFor({ id: 'x', name: 'request_app_change', input }, null)).toMatch(/Change the app/);
    // The user sees what the coding agent will be asked to do, not only the change's name.
    expect(confirmationFor({ id: 'x', name: 'request_app_change', input }, ctl)).toContain('Let the assistant choose which values a filter shows.');
    expect(await call('request_app_change', input)).toMatchObject({ job_id: 'job-1', status: 'queued' });
  });

  it('queues a research task, including the open spreadsheet by default', async () => {
    const { call } = setup();
    const input = { title: 'Find each company\u2019s revenue', task: 'For every company in column A, find its 2025 revenue and the source.' };
    expect(await call('request_research', input)).toMatchObject({ job_id: 'job-2', status: 'queued', sheet_included: true });
    expect(await call('request_research', { ...input, include_open_sheet: false })).toMatchObject({ sheet_included: false });
  });
});

describe('stored files', () => {
  it('lists files and opens one', async () => {
    const { env, call } = setup();
    const f = (id: string, filename: string) => ({ id, filename, type: 'application/pdf', size: 10, createdAt: '2026-01-01', url: `/api/files/${id}`, downloadUrl: `/api/files/${id}/download` });
    const opened: string[] = [];
    env.listFiles = async () => [f('a', 'Report.pdf'), f('b', 'Other.pdf')];
    env.openFile = async (id) => (opened.push(id), f(id, 'Report.pdf'));
    const listed = await call('list_files', { query: 'report' });
    expect(listed).toMatchObject({ total: 1, files: [{ id: 'a', filename: 'Report.pdf', download_url: '/api/files/a/download' }] });
    expect(await call('open_file', { file_id: 'a' })).toMatchObject({ opened: true, file_id: 'a', filename: 'Report.pdf' });
    expect(opened).toEqual(['a']);
  });

  it('reads a text file in parts and refuses files that are not text', async () => {
    const { env, call } = setup();
    const meta = (filename: string, type: string) => ({ id: 'h', filename, type, size: 10, createdAt: '2026-01-01', url: '/api/files/h', downloadUrl: '/api/files/h/download' });
    const page = '\uFEFF<h1>Sales</h1><p>Up 12%</p>';
    env.readFile = async () => ({ file: meta('index.html', 'text/html'), data: new TextEncoder().encode(page).buffer as ArrayBuffer });
    expect(await call('read_file', { file_id: 'h' })).toEqual({ file_id: 'h', filename: 'index.html', type: 'text/html', total_chars: 27, offset: 0, text: '<h1>Sales</h1><p>Up 12%</p>' });
    expect(await call('read_file', { file_id: 'h', max_chars: 14 })).toMatchObject({ text: '<h1>Sales</h1>', more: true, next_offset: 14 });
    expect(await call('read_file', { file_id: 'h', offset: 14 })).toMatchObject({ offset: 14, text: '<p>Up 12%</p>' });
    env.readFile = async () => ({ file: meta('Report.pdf', 'application/pdf'), data: new TextEncoder().encode('%PDF-1.7').buffer as ArrayBuffer });
    await expect(call('read_file', { file_id: 'h' })).rejects.toThrow(/not a text file/);
    env.readFile = async () => ({ file: meta('a.bin', 'application/octet-stream'), data: new Uint8Array([1, 0, 2]).buffer });
    await expect(call('read_file', { file_id: 'h' })).rejects.toThrow(/not a text file/);
  });

  it('shows Claude a stored picture, and makes an edited copy of one', async () => {
    const { env, call } = setup();
    const meta = (id: string, filename: string, type: string) => ({ id, filename, type, size: 10, createdAt: '2026-01-01', url: `/api/files/${id}`, downloadUrl: `/api/files/${id}/download` });
    const files = { p: meta('p', 'logo.jpg', 'image/jpeg'), e: meta('e', 'logo-edited.png', 'image/png'), d: meta('d', 'a.pdf', 'application/pdf') };
    const attached: string[] = [];
    const opened: string[] = [];
    env.readFile = async (id) => ({ file: files[id as keyof typeof files], data: new TextEncoder().encode(`bytes of ${id}`).buffer as ArrayBuffer });
    env.toAgentImage = async (file, data) => ({ mediaType: 'image/png', data: `${file.id}:${new TextDecoder().decode(data)}` });
    env.attachImage = (img) => attached.length < 2 && attached.push(img.data) > 0;
    env.openFile = async (id) => (opened.push(id), files[id as keyof typeof files]);
    env.editImage = async (id, prompt) => {
      if (id !== 'p') throw new ToolError('Only PNG, JPEG and WebP pictures can be edited.');
      expect(prompt).toBe('Make the background blue');
      return files.e;
    };

    expect(await call('view_image', { file_id: 'p' })).toMatchObject({ file_id: 'p', filename: 'logo.jpg', image: expect.stringContaining('Attached') });
    expect(attached).toEqual(['p:bytes of p']);
    await expect(call('view_image', { file_id: 'd' })).rejects.toThrow(/not a picture/);

    // The copy is opened for the user and attached for Claude.
    expect(await call('edit_image', { file_id: 'p', prompt: 'Make the background blue' })).toMatchObject({ edited: true, file_id: 'e', filename: 'logo-edited.png', source_file_id: 'p', note: 'A new file, open now; the original is unchanged.', image: expect.stringContaining('Attached') });
    expect(opened).toEqual(['e']);
    expect(attached).toEqual(['p:bytes of p', 'e:bytes of e']);
    await expect(call('edit_image', { file_id: 'd', prompt: 'x' })).rejects.toThrow(/Only PNG, JPEG and WebP/);
    // No room left in the message: the tool says so instead of failing.
    expect(await call('view_image', { file_id: 'p' })).toMatchObject({ image: expect.stringContaining('Not attached') });
  });

  it('edits a stored picture exactly: a copy by default, over the file when asked, in the open editor when there is one', async () => {
    const { env, call, uploads } = setup();
    const meta = (id: string, filename: string, type: string) => ({ id, filename, type, size: 10, createdAt: '2026-01-01', url: `/api/files/${id}`, downloadUrl: `/api/files/${id}/download` });
    const files: Record<string, ReturnType<typeof meta>> = { p: meta('p', 'photo.jpg', 'image/jpeg'), g: meta('g', 'anim.gif', 'image/gif') };
    const attached: string[] = [];
    const opened: string[] = [];
    const saved: string[] = [];
    let last = fakeEngine(1, 1);
    let closed = 0;
    env.readFile = async (id) => ({ file: files[id], data: new TextEncoder().encode(`bytes of ${id}`).buffer as ArrayBuffer });
    env.toAgentImage = async (file, data) => ({ mediaType: 'image/png', data: `${file.id}:${new TextDecoder().decode(data)}` });
    env.attachImage = (img) => attached.push(img.data) > 0;
    env.imageSize = async () => ({ width: 3000, height: 2000 });
    env.openFile = async (id) => (opened.push(id), files[id]);
    env.saveImage = async (id, image) => (saved.push(`over ${id}: ${await image.text()} (${image.type})`), files[id]);
    env.saveImageCopy = async (of, image) => {
      saved.push(`copy of ${of.id}: ${await image.text()} (${image.type})`);
      files.c = meta('c', 'photo-edited.jpg', 'image/jpeg');
      return files.c;
    };
    env.openImageEngine = async () => {
      last = fakeEngine(3000, 2000);
      const made = last;
      return { engine: made.engine, bake: made.bake, export: async (type) => new Blob([made.log.join('; ')], { type }), close: async () => void closed++ };
    };

    // view_image reports the size positions are given in.
    expect(await call('view_image', { file_id: 'p' })).toMatchObject({ width: 3000, height: 2000 });

    const ops = [{ op: 'crop', x: 0, y: 0, width: 1500, height: 1000 }, { op: 'text', text: 'Sale', x: 50, y: 50, size: 100 }];
    expect(await call('transform_image', { file_id: 'p', operations: ops })).toMatchObject({ edited: true, file_id: 'c', filename: 'photo-edited.jpg', source_file_id: 'p', applied: ['Cropped to 1500 × 1000', 'Added text “Sale”'], size: { width: 1500, height: 1000 }, saved: true, note: 'A new file, open now; the original is unchanged.' });
    expect(saved).toEqual(['copy of p: crop 0,0 1500x1000; text "Sale" at 50,50 size 100 #000000 (image/jpeg)']);
    expect(opened).toEqual(['c']);
    expect(attached.at(-1)).toBe('c:crop 0,0 1500x1000; text "Sale" at 50,50 size 100 #000000');
    expect(closed).toBe(1);

    // Saving over the file is asked about first, and done when asked for.
    const replace = { id: 't', name: 'transform_image', input: { file_id: 'p', operations: [{ op: 'rotate', degrees: 90 }], save: 'replace' } };
    expect(confirmationFor(replace, null)).toMatch(/over the original file/);
    expect(confirmationFor({ ...replace, input: { ...replace.input, save: 'copy' } }, null)).toBeNull();
    expect(await call('transform_image', replace.input)).toMatchObject({ file_id: 'p', saved: true, size: { width: 2000, height: 3000 }, note: expect.stringContaining('Saved over the file') });
    expect(saved.at(-1)).toBe('over p: rotate 90 (image/jpeg)');

    // Removing a JPEG's background makes the copy a PNG, which can be transparent.
    env.openImageEngine = async () => {
      last = fakeEngine(3000, 2000, { backgroundRemoval: true });
      const made = last;
      return { engine: made.engine, bake: made.bake, export: async (type) => new Blob([made.log.join('; ')], { type }), close: async () => void closed++ };
    };
    expect(await call('transform_image', { file_id: 'p', operations: [{ op: 'remove_background' }] })).toMatchObject({ saved: true, note: expect.stringContaining('It is a PNG, so the removed background is transparent.') });
    expect(saved.at(-1)).toBe('copy of p: remove background (image/png)');
    saved.pop();
    closed--;
    // A problem with an operation is one Claude can fix; nothing is saved, and the engine is let go.
    await expect(call('transform_image', { file_id: 'p', operations: [{ op: 'crop', x: 9000, y: 0, width: 10, height: 10 }] })).rejects.toThrow(/Operation 1 \(crop\): That rectangle is outside the picture/);
    await expect(call('transform_image', { file_id: 'p', operations: [{ op: 'crop', x: 9000, y: 0, width: 10, height: 10 }] })).rejects.toBeInstanceOf(ToolError);
    expect(saved).toHaveLength(2);
    expect(closed).toBe(4);
    await expect(call('transform_image', { file_id: 'g', operations: ops })).rejects.toThrow(/only PNG, JPEG and WebP/);
    await expect(call('transform_image', { file_id: 'p', operations: [] })).rejects.toThrow(/at least one operation/);

    // A picture inside a presentation, by its address: stored anew, and the new address comes back to be put in place.
    const stored = '/api/images/0f8fad5b-d9cb-469f-a165-70867728950e';
    const read: string[] = [];
    env.readImage = async (src) => (read.push(src), new Blob(['slide picture'], { type: 'image/jpeg' }));
    const uploadsBefore = saved.length;
    const embedded = await call('transform_image', { image: stored, operations: [{ op: 'crop', x: 0, y: 0, width: 1000, height: 1000 }] });
    expect(embedded).toMatchObject({ edited: true, image_address: '/api/images/00000000-0000-0000-0000-000000000001', source_image: stored, applied: ['Cropped to 1000 × 1000'], size: { width: 1000, height: 1000 }, saved: true, note: expect.stringContaining('edit_elements (src)') });
    expect(read).toEqual([stored]);
    expect(saved).toHaveLength(uploadsBefore);
    expect(attached.at(-1)).toBe(`/api/images/00000000-0000-0000-0000-000000000001:crop 0,0 1000x1000`);
    // With its background removed it is stored as a PNG, whatever it was.
    expect(await call('transform_image', { image: stored, operations: [{ op: 'remove_background' }] })).toMatchObject({ image_address: '/api/images/00000000-0000-0000-0000-000000000002' });
    expect(uploads.map((u) => u.type)).toEqual(['image/jpeg', 'image/png']);
    await expect(call('transform_image', { image: 'https://example.com/a.png', operations: ops })).rejects.toThrow(/stored picture’s address/);
    await expect(call('transform_image', { image: stored, file_id: 'p', operations: ops })).rejects.toThrow(/either file_id .* or image/);
    await expect(call('transform_image', { operations: ops })).rejects.toThrow(/either file_id .* or image/);
    expect(confirmationFor({ id: 't', name: 'transform_image', input: { image: stored, operations: ops, save: 'replace' } }, null)).toBeNull();
    closed -= 2;
    // Open in the image editor: the edits are made there as one step, shown, and not saved.
    const live = fakeEngine(3000, 2000);
    let refreshed = 0;
    const batches: string[] = [];
    const engine = Object.assign(live.engine, { batch: async <T,>(label: string, fn: () => T | Promise<T>) => (batches.push(label), fn()) });
    setActiveImageEditor({ fileId: 'p', handle: { engine, refresh: () => void refreshed++, exportBlob: async () => new Blob(['the editor’s picture'], { type: 'image/jpeg' }) } as unknown as AspEditorHandle });
    try {
      expect(confirmationFor(replace, null)).toBeNull();
      expect(await call('transform_image', { file_id: 'p', operations: ops, save: 'replace' })).toMatchObject({ file_id: 'p', saved: false, applied: ['Cropped to 1500 × 1000', 'Added text “Sale”'], note: expect.stringContaining('not saved until the user saves') });
      expect(live.log).toEqual(['crop 0,0 1500x1000', 'text "Sale" at 50,50 size 100 #000000']);
      expect(batches).toEqual(['Assistant edit']);
      expect(refreshed).toBe(1);
      expect(attached.at(-1)).toBe('p:the editor’s picture');
      expect(saved).toHaveLength(2);
      // The panels follow even when an operation fails part way.
      await expect(call('transform_image', { file_id: 'p', operations: [{ op: 'rotate', degrees: 90 }] })).rejects.toThrow(/cropped or has layers/);
      expect(refreshed).toBe(2);
    } finally {
      setActiveImageEditor(null);
    }
  });

  it('puts an attached picture on top of a stored one in the image editor, where it stays a layer', async () => {
    const { env, call } = setup();
    const photo = { id: 'p', filename: 'photo.png', type: 'image/png', size: 10, createdAt: '2026-01-01', url: '/api/files/p', downloadUrl: '/api/files/p/download' };
    const logo = '/api/images/0f8fad5b-d9cb-469f-a165-70867728950e';
    env.readFile = async (id) => {
      if (id !== 'p') throw new ToolError(`No file with id "${id}".`);
      return { file: photo, data: new ArrayBuffer(4) };
    };
    env.readImage = async () => new Blob(['logo'], { type: 'image/png' });
    env.imageSize = async () => ({ width: 400, height: 200 });
    env.toAgentImage = async () => ({ mediaType: 'image/png', data: 'shown' });
    env.attachImage = () => true;
    let hidden = 0;
    env.openImageEngine = async () => {
      hidden++;
      const made = fakeEngine(1000, 800);
      return { engine: made.engine, bake: made.bake, export: async (type) => new Blob([made.log.join('; ')], { type }), close: async () => {} };
    };
    env.saveImageCopy = async () => photo;
    env.saveImage = async () => photo;
    // The editor the picture is opened in.
    const live = fakeEngine(1000, 800);
    const engine = Object.assign(live.engine, { batch: async <T,>(_label: string, fn: () => T | Promise<T>) => fn() });
    const handle = { engine, refresh: () => {}, exportBlob: async () => new Blob(['edited'], { type: 'image/png' }) } as unknown as AspEditorHandle;
    const opening: string[] = [];
    env.openImageEditor = async (id) => (opening.push(id), handle);

    const result = await call('transform_image', { file_id: 'p', operations: [{ op: 'overlay', source: logo, x: 700, y: 650 }] });
    expect(opening).toEqual(['p']);
    expect(hidden).toBe(0);
    // With no size it keeps its own, made smaller to stay inside the picture: 300 wide, the room to the right edge.
    expect(live.log).toEqual(['image at 700,650 300x150']);
    expect(result).toMatchObject({ saved: false, applied: ['Put a picture on top at 700, 650, 300 × 150'], note: expect.stringContaining('can still move, resize or delete it') });
    expect(toolLabel('transform_image', { operations: [{ op: 'overlay' }] })).toBe('Put a picture on top of another');

    // A size and opacity as given; a stored picture file by its id works as a source too.
    await call('transform_image', { file_id: 'p', operations: [{ op: 'overlay', source: 'p', x: 0, y: 0, width: 100, opacity: 40 }] });
    expect(live.log.at(-1)).toBe('image at 0,0 100x50 opacity 0.4');
    // Asked for a finished file, it is made off screen and saved, as other edits are.
    await call('transform_image', { file_id: 'p', operations: [{ op: 'overlay', source: logo, x: 0, y: 0 }], save: 'copy' });
    expect(hidden).toBe(1);
    expect(opening).toHaveLength(2);

    await expect(call('transform_image', { file_id: 'p', operations: [{ op: 'overlay', x: 0, y: 0 }] })).rejects.toThrow(/"source" is missing/);
    await expect(call('transform_image', { file_id: 'p', operations: [{ op: 'overlay', source: 'https://example.com/a.png', x: 0, y: 0 }] })).rejects.toThrow(/import_file/);
    await expect(call('transform_image', { file_id: 'p', operations: [{ op: 'overlay', source: 'nope', x: 0, y: 0 }] })).rejects.toThrow(/No file with id "nope"/);
    await expect(call('transform_image', { file_id: 'p', operations: [{ op: 'overlay', source: logo, x: 2000, y: 0 }] })).rejects.toThrow(/outside the picture/);
  });

  it('edits a text file with exact replacements, saving nothing unless every one matches', async () => {
    const { env, call } = setup();
    const file = { id: 'h', filename: 'index.html', type: 'text/html', size: 10, createdAt: '2026-01-01', url: '/api/files/h', downloadUrl: '/api/files/h/download' };
    let text = '<style>:root{--bg:#000;--fg:#fff}</style><p class="a">Hi</p><p class="a">Bye</p>';
    const saves: string[] = [];
    let reverted = 0;
    env.readFile = async () => ({ file, data: new TextEncoder().encode(text).buffer as ArrayBuffer });
    env.writeFile = async (_id, next) => ((text = next), saves.push(next), file);
    env.revertFile = async () => (reverted++, file);
    expect(await call('edit_file', { file_id: 'h', edits: [{ find: '--bg:#000', replace: '--bg:#fff' }, { find: 'class="a"', replace: 'class="b"', all: true }] })).toMatchObject({ edited: true, replacements: 3 });
    expect(text).toBe('<style>:root{--bg:#fff;--fg:#fff}</style><p class="b">Hi</p><p class="b">Bye</p>');
    // An edit that matches nothing, or more than one place, changes nothing (the first edit of the call included).
    await expect(call('edit_file', { file_id: 'h', edits: [{ find: 'Hi', replace: 'Hello' }, { find: 'nope', replace: 'x' }] })).rejects.toThrow(/Edit 2: the text to find is not in the file/);
    await expect(call('edit_file', { file_id: 'h', edits: [{ find: 'class="b"', replace: 'x' }] })).rejects.toThrow(/occurs 2 times/);
    expect(saves).toHaveLength(1);
    expect(await call('edit_file', { file_id: 'h', content: '<p>New</p>' })).toMatchObject({ edited: true, total_chars: 10 });
    expect(text).toBe('<p>New</p>');
    expect(await call('edit_file', { file_id: 'h', undo: true })).toMatchObject({ undone: true });
    expect(reverted).toBe(1);
    await expect(call('edit_file', { file_id: 'h' })).rejects.toThrow(/exactly one of/);
    env.readFile = async () => ({ file: { ...file, filename: 'a.pdf', type: 'application/pdf' }, data: new TextEncoder().encode('%PDF').buffer as ArrayBuffer });
    await expect(call('edit_file', { file_id: 'h', content: 'x' })).rejects.toThrow(/cannot be edited/);
  });
});

describe('ingest_connector_data', () => {
  const result = (rows: FetchResult['rows'], truncated = false): FetchResult => ({
    handle: 'h1',
    columns: [
      { name: 'id', type: 'string' },
      { name: 'posted_at', type: 'date' },
      { name: 'amount', type: 'number' },
      { name: 'merchant', type: 'string' },
    ],
    rows,
    truncated,
    totalRows: rows.length,
  });

  function withData(data: FetchResult) {
    const s = setup();
    const requests: unknown[] = [];
    s.env.fetchConnectorData = async (id, body) => {
      requests.push({ id, ...body });
      return data;
    };
    return { ...s, requests };
  }

  it('creates the tab and writes a header and rows as real numbers, dates and text', async () => {
    const { ctl, call, requests } = withData(result([['0012', '2025-01-03', 12.5, 'TRUE Coffee'], ['tx2', '2025-01-04', -3, '=evil()']]));
    const res = await call('ingest_connector_data', { connection_id: 'c1', dataset: 'card_transactions', params: { posted_at_start: '2025-01-01' }, tab: 'Brex Transactions' });
    expect(requests).toEqual([{ id: 'c1', dataset: 'card_transactions', params: { posted_at_start: '2025-01-01' }, handle: undefined }]);
    expect(res).toMatchObject({ tab: 'Brex Transactions', created_tab: true, range_written: 'Brex Transactions!A1:D3', rows_written: 2, truncated: false });
    const tab = ctl.store.workbook.tabs.find((t) => t.name === 'Brex Transactions')!;
    expect(ctl.tab.id).toBe(tab.id);
    expect(ctl.store.value(tab.id, 1, 2)).toBe(12.5);
    expect(typeof ctl.store.value(tab.id, 1, 1)).toBe('number'); // a date serial
    expect(ctl.store.display(tab.id, 1, 1)).toBe('1/3/2025');
    expect(ctl.store.value(tab.id, 1, 0)).toBe('0012');
    expect(ctl.store.value(tab.id, 2, 3)).toBe('=evil()');
    expect(ctl.store.display(tab.id, 0, 3)).toBe('merchant');
  });

  it('replaces earlier data but keeps formatting, and appends below existing rows', async () => {
    const { ctl, call, env } = withData(result([['a', '2025-01-01', 1, 'x'], ['b', '2025-01-02', 2, 'y'], ['c', '2025-01-03', 3, 'z']]));
    await call('ingest_connector_data', { connection_id: 'c1', dataset: 'd' });
    await call('format_range', { range: 'C:C', number_format: 'currency' });
    env.fetchConnectorData = async () => result([['n', '2025-02-01', 9, 'w']]);
    const res = await call('ingest_connector_data', { connection_id: 'c1', dataset: 'd' });
    expect(res.range_written).toBe('Sheet1!A1:D2');
    expect(ctl.store.cell(ctl.tab.id, 2, 0)).toBeUndefined();
    expect(ctl.store.display(ctl.tab.id, 1, 2)).toBe('$9.00');

    const app = await call('ingest_connector_data', { connection_id: 'c1', dataset: 'd', mode: 'append' });
    expect(app).toMatchObject({ range_written: 'Sheet1!A3:D3', header_written: false, rows_written: 1 });
  });

  it('writes thousands of rows in one undoable step and reports truncation', async () => {
    const rows = Array.from({ length: 5000 }, (_, k) => [`t${k}`, '2025-01-01', k / 100, 'm']);
    const { ctl, call } = withData(result(rows, true));
    const res = await call('ingest_connector_data', { connection_id: 'c1', dataset: 'd', start_cell: 'B2' });
    expect(res).toMatchObject({ range_written: 'Sheet1!B2:E5002', rows_written: 5000, truncated: true });
    ctl.undo();
    expect(Object.keys(ctl.tab.cells)).toHaveLength(0);
  });

  it('sets frozen rows and columns from the grid separators and undoes them', () => {
    const { ctl } = setup();
    ctl.setFrozen(5, undefined);
    ctl.setFrozen(undefined, 1);
    expect(ctl.tab.frozenRows).toBe(5);
    expect(ctl.tab.frozenCols).toBe(1);
    ctl.setFrozen(0, undefined);
    expect(ctl.tab.frozenRows).toBeUndefined();
    expect(ctl.tab.frozenCols).toBe(1);
    ctl.undo();
    expect(ctl.tab.frozenRows).toBe(5);
  });

  it('passes connector errors to Claude', async () => {
    const { call, env } = setup();
    env.fetchConnectorData = async () => {
      throw new Error('Brex rejected the user token (401).');
    };
    await expect(call('ingest_connector_data', { connection_id: 'c1', dataset: 'd' })).rejects.toThrow(/401/);
  });
});

describe('CSV files', () => {
  function csvSetup() {
    const s = setup(csvToWorkbook('Name,Qty\nPens,3\nPaper,1\n'));
    s.ctl.store.guard = csvGuard;
    return s;
  }

  it('takes values, formulas, sorting and row changes from the assistant', async () => {
    const { ctl, call } = csvSetup();
    await call('write_range', { start: 'A4', rows: [['Total', '=SUM(B2:B3)']] });
    expect(ctl.store.display(ctl.tab.id, 3, 1)).toBe('4');
    await call('sort_range', { range: 'A2:B3', by_column: 'B' });
    expect(ctl.tab.cells.A2).toEqual({ v: 'Paper' });
    expect(csvGuard([])).toBeNull();
  });

  it('refuses what CSV cannot store, changes nothing and says to convert', async () => {
    const { ctl, call } = csvSetup();
    const before = JSON.stringify(ctl.store.workbook);
    await expect(call('format_range', { range: 'A1:B1', bold: true })).rejects.toThrow(/CSV file.*cell formatting.*Convert to spreadsheet/s);
    await expect(call('freeze', { rows: 1 })).rejects.toThrow(ToolError);
    await expect(call('add_tab', { name: 'More' })).rejects.toThrow(/more than one sheet/);
    expect(JSON.stringify(ctl.store.workbook)).toBe(before);
    expect(ctl.store.canUndo()).toBe(false);
  });

  it('offers the user a retry, which goes through once the file is converted', () => {
    const { ctl } = csvSetup();
    let asked: { reason: string; retry: () => void } | null = null;
    ctl.onRefused = (reason, retry) => (asked = { reason, retry });
    ctl.setStyle({ b: true });
    expect(asked!.reason).toBe('Cell formatting');
    expect(ctl.tab.cells.A1).toEqual({ v: 'Name' });
    ctl.store.guard = null;
    asked!.retry();
    expect(ctl.tab.cells.A1).toEqual({ v: 'Name', st: { b: true } });
    ctl.undo();
    expect(ctl.tab.cells.A1).toEqual({ v: 'Name' });
  });
});

describe('Excel files (desktop app)', () => {
  it('take formatting, but refuse a picture in a cell and say to keep the file as an MCP Docs spreadsheet', async () => {
    const { ctl, call } = setup();
    ctl.store.guard = xlsxGuard;
    await call('format_range', { range: 'A1:B1', bold: true });
    expect(ctl.tab.cells.A1?.st).toEqual({ b: true });
    await expect(call('set_cell_image', { range: 'C3', url: 'https://example.com/logo.png' })).rejects.toThrow(/Excel file.*pictures in cells.*MCP Docs spreadsheet/s);
    expect(ctl.tab.cells.C3).toBeUndefined();
  });

  it('refuse every change until the user allows editing one that holds things the app cannot keep', async () => {
    const { ctl, call } = setup();
    ctl.store.guard = lockedGuard;
    await expect(call('write_range', { start: 'A1', rows: [['x']] })).rejects.toThrow(/read-only until the user allows editing.*"Read-only" button/s);
    expect(ctl.tab.cells.A1).toBeUndefined();
    let retry: (() => void) | null = null;
    ctl.onRefused = (_reason, r) => (retry = r);
    ctl.setStyle({ b: true });
    expect(ctl.tab.cells.A1).toBeUndefined();
    ctl.store.guard = xlsxGuard;
    retry!();
    expect(ctl.tab.cells.A1).toEqual({ v: '', st: { b: true } });
  });
});

describe('charts', () => {
  const table = [
    ['Date', 'Model', 'Input', 'Output'],
    ['2023-03', 'gpt-4', 30, 60],
    ['2024-05', 'gpt-4o', 5, 15],
    ['2025-04', 'o3', 2, 8],
  ];

  it('adds a chart of a table, lists it in the overview, changes it and deletes it, each in the request’s undo step', async () => {
    const { ctl, call, env } = setup();
    await call('write_range', { start: 'A1', rows: table });
    const added = await call('add_chart', { data_range: 'A1:D4', title: 'Prices', log_scale: true });
    expect(added.added).toMatchObject({ type: 'line', at: 'E1', title: 'Prices', labels: 'A2:A4', log_scale: true, series: [{ values: 'C2:C4', name_cell: 'C1' }, { values: 'D2:D4', name_cell: 'D1' }] });
    const id = added.added.id as string;
    expect(ctl.selectedChart).toBe(id);
    const overview = await call('get_sheet_overview');
    expect(overview.tabs[0].charts).toEqual([added.added]);

    await call('edit_chart', { chart_id: id, type: 'bar', series: [{ values: 'Sheet1!D2:D4', name: 'D1' }, { values: 'C2:C4', name: 'Input price', color: '#FF0000' }], at: 'B8', width: 400, log_scale: false, title: '' });
    const chart = ctl.tab.charts![0];
    expect(chart).toMatchObject({ type: 'bar', anchor: { r: 7, c: 1, dx: 0, dy: 0 }, w: 400, series: [{ values: 'D2:D4', nameRef: 'D1' }, { values: 'C2:C4', name: 'Input price', color: '#ff0000' }] });
    expect(chart).not.toHaveProperty('title');
    expect(chart).not.toHaveProperty('logScale');

    await expect(call('edit_chart', { chart_id: 'nope', type: 'pie' })).rejects.toThrow(/no chart "nope"/);
    await expect(call('edit_chart', { chart_id: id, series: [{ values: 'Nowhere!A1:A3' }] })).rejects.toThrow(/series 1: There is no tab named "Nowhere"/);
    await expect(call('add_chart', { data_range: 'B1:B4' })).rejects.toThrow(/no numbers to chart/);
    await expect(call('add_chart', { labels: 'A2:A4' })).rejects.toThrow(/Give data_range, or series/);

    await call('delete_chart', { chart_id: id });
    expect(ctl.tab.charts).toBeUndefined();
    // The whole request is one step.
    ctl.undo();
    expect(ctl.tab.charts).toBeUndefined();
    expect(ctl.store.display(ctl.tab.id, 0, 0)).toBe('');
    void env;
  });

  it('keeps charts on their data when rows are inserted, tabs renamed and duplicated, and refuses them in a CSV file', async () => {
    const { ctl, call } = setup();
    await call('write_range', { start: 'A1', rows: table });
    const { added } = await call('add_chart', { labels: 'A2:A4', series: [{ values: 'C2:C4' }] });
    expect(added.at).toBe('D2');
    ctl.selectCell({ r: 0, c: 0 });
    ctl.insertRows('above');
    expect(ctl.tab.charts![0]).toMatchObject({ anchor: { r: 2, c: 3 }, categories: 'A3:A5', series: [{ values: 'C3:C5' }] });
    ctl.undo();
    expect(ctl.tab.charts![0].categories).toBe('A2:A4');

    // A chart on another tab follows a rename of the tab it reads.
    ctl.addTab();
    const second = ctl.tab;
    await call('add_chart', { tab: second.name, labels: 'Sheet1!A2:A4', series: [{ values: 'Sheet1!C2:C4' }], at: 'A1' });
    const first = ctl.store.workbook.tabs[0];
    ctl.renameTab(first.id, 'Prices 2025');
    expect(ctl.store.getTab(second.id)!.charts![0]).toMatchObject({ categories: "'Prices 2025'!A2:A4", series: [{ values: "'Prices 2025'!C2:C4" }] });

    // A copy of a tab has its own charts, reading its own cells.
    ctl.duplicateTab(first.id);
    const copy = ctl.store.workbook.tabs.find((t) => t.name.startsWith('Copy of'))!;
    expect(copy.charts![0].categories).toBe('A2:A4');
    expect(copy.charts![0].id).not.toBe(ctl.store.getTab(first.id)!.charts![0].id);

    const csv = setup(csvToWorkbook('a,b\n1,2\n3,4\n'));
    csv.ctl.store.guard = csvGuard;
    await expect(csv.call('add_chart', { data_range: 'A1:B3' })).rejects.toThrow(/this needs charts/);
  });

  it('charts the selection, or the data around one cell, from Insert › Chart', async () => {
    const { ctl, call } = setup();
    await call('write_range', { start: 'B2', rows: table });
    ctl.selectCell({ r: 3, c: 2 });
    expect(ctl.insertChart()).toBeNull();
    expect(ctl.tab.charts![0]).toMatchObject({ categories: 'B3:B5', series: [{ values: 'D3:D5' }, { values: 'E3:E5' }], anchor: { r: 1, c: 5 } });
    expect(ctl.chartEditor).toBe(ctl.tab.charts![0].id);
    ctl.selectCell({ r: 20, c: 20 });
    expect(ctl.insertChart()).toMatch(/Select the cells with the numbers/);
  });
});
