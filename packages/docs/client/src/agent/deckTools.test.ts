import { describe, expect, it } from 'vitest';
import type { ClientToolCall } from '../../../shared/agent/protocol.ts';
import { newDeck, slideContent, slideTitle, type TextElement } from '../../../shared/deck.ts';
import { DeckController } from '../deck/controller.ts';
import { confirmationFor, runClientTool, type ClientToolEnv } from './clientTools.ts';
import { keepDeckPictures, linkDeckTables } from './deckTools.ts';
import { pptxGuard } from '../deck/store.ts';
import { lockedGuard } from '../state/store.ts';

function setup() {
  const deck = new DeckController(newDeck(), async () => {});
  const env: ClientToolEnv = {
    ctl: null,
    deck,
    doc: null,
    group: 'agent-1',
    openSheet: async () => Promise.reject(new Error('No sheet in this test.')),
    openDeck: async () => deck,
    openDoc: async () => Promise.reject(new Error('No doc in this test.')),
    requestAppChange: async () => ({ id: 'job-1' }),
    requestResearch: async () => ({ id: 'job-2', sheetIncluded: false }),
    uploadImage: async () => '/api/images/00000000-0000-0000-0000-000000000001',
    fetchConnectorData: async () => Promise.reject(new Error('x')),
  };
  const call = async (name: string, input: Record<string, unknown> = {}) => JSON.parse(await runClientTool({ id: 'x', name, input }, env));
  return { deck, env, call };
}

describe('agent deck tools', () => {
  it('adds slides from layouts, reads the outline and undoes one request as a single step', async () => {
    const { deck, call } = setup();
    const res = await call('add_slides', {
      slides: [
        { title: 'Agenda', body: ['Intro', 'Numbers', '  Details'] },
        { layout: 'section', title: 'Part one' },
        { layout: 'two-column', title: 'Compare', body: ['a'], body2: ['b'] },
      ],
    });
    expect(res).toEqual({ added_slides: [2, 3, 4], slide_count: 4 });
    expect(deck.current).toBe(3);

    await call('set_deck_theme', { theme: 'ocean' });
    const outline = await call('read_deck');
    expect(outline.theme).toBe('ocean');
    expect(outline.slide_count).toBe(4);
    expect(outline.slides[1].layout).toBe('title-body');
    const body = outline.slides[1].elements.find((e: { role?: string }) => e.role === 'body');
    expect(body.text).toBe('- Intro\n- Numbers\n  - Details');

    deck.undo();
    expect(deck.deck.slides).toHaveLength(1);
    expect(deck.deck.theme).toBe('light');
  });

  it('updates a slide by role and rearranges with a layout', async () => {
    const { deck, call } = setup();
    await call('add_slides', { slides: [{ title: 'Old title', body: ['x'] }] });
    const title = deck.deck.slides[1].elements.find((e) => e.type === 'text' && e.role === 'title')!;

    let res = await call('update_slide', { slide: 2, title: 'New title', notes: 'Remember to smile', background: '#123456' });
    expect(res).toMatchObject({ updated_slide: 2 });
    const s = deck.deck.slides[1];
    expect(slideTitle(s)).toBe('New title');
    expect(s.notes).toBe('Remember to smile');
    expect(s.bg).toBe('#123456');
    expect(s.elements.find((e) => e.id === title.id)).toBeTruthy(); // same element, text replaced

    res = await call('update_slide', { slide: 2, layout: 'two-column', body2: ['right side'] });
    expect(deck.deck.slides[1].layout).toBe('two-column');
    expect(slideContent(deck.deck.slides[1])).toMatchObject({ title: 'New title', body: ['- x'], body2: ['- right side'] });

    await expect(call('update_slide', { slide: 9, title: 'x' })).rejects.toThrow(/no slide 9/);
    await expect(call('update_slide', { slide: 2 })).rejects.toThrow(/at least one property/);
  });

  it('edits individual elements: add, move, restyle and remove', async () => {
    const { deck, call } = setup();
    const before = deck.deck.slides[0].elements.map((e) => e.id);
    const res = await call('edit_elements', {
      slide: 1,
      set: [
        { id: before[0], x: 10, y: 20, bold: false, color: '#ff0000' },
        { type: 'shape', shape: 'ellipse', x: 700, y: 400, w: 100, h: 100, fill: '#00ff00', text: 'Go' },
        { type: 'image', src: 'https://example.com/pic.png', x: 0, y: 0, w: 200, h: 100 },
      ],
      remove: [before[1]],
    });
    expect(res.removed).toEqual([before[1]]);
    expect(res.set).toHaveLength(3);
    const slide = deck.deck.slides[0];
    expect(slide.elements).toHaveLength(3);
    const moved = slide.elements.find((e) => e.id === before[0]) as TextElement;
    expect(moved).toMatchObject({ x: 10, y: 20, style: { align: 'center', valign: 'bottom', color: '#ff0000' } });
    expect(moved.style?.bold).toBeUndefined();
    expect(slide.elements[1]).toMatchObject({ type: 'shape', shape: 'ellipse', fill: '#00ff00', text: 'Go' });
    expect(slide.elements[2]).toMatchObject({ type: 'image', src: 'https://example.com/pic.png' });
    expect(deck.selection).toEqual(res.set.map((e: { id: string }) => e.id));

    // A video is kept by its address (a YouTube link in any form becomes its watch address) and stays a video when moved.
    const added = await call('edit_elements', { slide: 1, set: [{ type: 'video', src: 'https://youtu.be/dQw4w9WgXcQ?t=4', x: 100, y: 100, w: 320, h: 180 }] });
    const videoId = added.set[0].id as string;
    expect(slide.elements).toHaveLength(3); // the slide read before the edit is not changed
    await call('edit_elements', { slide: 1, set: [{ id: videoId, x: 40 }] });
    expect(deck.deck.slides[0].elements.find((e) => e.id === videoId)).toMatchObject({ type: 'video', src: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', x: 40, y: 100, w: 320, h: 180 });
    await expect(call('edit_elements', { slide: 1, set: [{ type: 'video', src: 'https://vimeo.com/1' }] })).rejects.toThrow(/video element needs src/);
    await call('edit_elements', { slide: 1, remove: [videoId] });

    await expect(call('edit_elements', { slide: 1, set: [{ id: 'nope', x: 1 }] })).rejects.toThrow(/no element "nope"/);
    await expect(call('edit_elements', { slide: 1, set: [{ type: 'image', src: 'ftp://x/y.png' }] })).rejects.toThrow(/Image must be/);
    await expect(call('edit_elements', { slide: 1, set: [{ type: 'text', text: 'hi', x: Number.NaN }] })).rejects.toThrow(/invalid x/);
  });

  it('adds a table, changes single cells and rows, and reports it in read_deck', async () => {
    const { deck, call } = setup();
    const res = await call('edit_elements', { slide: 1, set: [{ type: 'table', rows: [['Region', 'Q1'], ['North', '10'], ['South']], x: 100, y: 120, banded: true }] });
    const id = res.set[0].id as string;
    // Rows are padded to the widest; the box is sized to the rows; a header row by default.
    expect(res.set[0]).toMatchObject({ type: 'table', x: 100, y: 120, w: 320, h: 120 });
    const table = () => deck.deck.slides[0].elements.find((e) => e.id === id)!;
    expect(table()).toMatchObject({ header: true, banded: true, rows: [[{ text: 'Region' }, { text: 'Q1' }], [{ text: 'North' }, { text: '10' }], [{ text: 'South' }, { text: '' }]] });

    await call('edit_elements', { slide: 1, set: [{ id, cells: [{ row: 3, col: 2, text: '7', align: 'right', bold: true }], col_widths: [240, 80], size: 20, stroke: 'none' }] });
    expect(table()).toMatchObject({ cols: [0.75, 0.25], style: { size: 20, border: 'none' } });
    if (table().type !== 'table') throw new Error('not a table');
    // New rows keep the look of the cells they land on, and the table keeps its rows' height.
    await call('edit_elements', { slide: 1, set: [{ id, rows: [['Region', 'Q1'], ['North', '10'], ['South', '7'], ['West', '3']], header: false }] });
    const t = table();
    if (t.type !== 'table') throw new Error('not a table');
    expect(t.h).toBe(160);
    expect(t.header).toBeUndefined();
    expect(t.rows[2][1]).toEqual({ text: '7', align: 'right', bold: true });
    expect(t.rows[3][1]).toEqual({ text: '3' });

    const outline = (await call('read_deck')).slides[0].elements.find((e: { id: string }) => e.id === id);
    expect(outline).toMatchObject({ type: 'table', rows: [['Region', 'Q1'], ['North', '10'], ['South', '7'], ['West', '3']], header: false, banded: true, col_widths: [240, 80], cell_styles: [{ row: 3, col: 2, align: 'right', bold: true }] });

    await expect(call('edit_elements', { slide: 1, set: [{ type: 'table' }] })).rejects.toThrow(/needs rows/);
    await expect(call('edit_elements', { slide: 1, set: [{ id, cells: [{ row: 9, col: 1, text: 'x' }] }] })).rejects.toThrow(/no cell at row 9/);
    await expect(call('edit_elements', { slide: 1, set: [{ id, col_widths: [1, 2, 3] }] })).rejects.toThrow(/needs 2 widths/);
    await expect(call('edit_elements', { slide: 1, set: [{ id, type: 'text' }] })).rejects.toThrow(/type cannot change/);
  });

  it('links a table to a spreadsheet range, refuses to edit its cells, and unlinks it', async () => {
    const { deck, env } = setup();
    const asked: unknown[] = [];
    const read = async (sheetId: string, ref: { range?: string }) => {
      asked.push(ref);
      if (sheetId !== 'sheet-1') throw new Error('There is no spreadsheet nope.');
      return { title: 'Figures', rev: 'r1', tabId: 't1', tab: 'Data', range: 'A1:B2', tabs: ['Data'], rows: [[{ text: 'Item', bold: true }, { text: 'Cost' }], [{ text: 'Pens' }, { text: '5', align: 'right' as const }]] };
    };
    const run = async (input: Record<string, unknown>) => JSON.parse(await runClientTool(await linkDeckTables({ id: 'x', name: 'edit_elements', input }, read), env));
    const res = await run({ slide: 1, set: [{ type: 'table', link: { sheet_id: 'sheet-1', range: 'Data!A1:B2' }, banded: true }] });
    const id = res.set[0].id as string;
    const table = () => deck.deck.slides[0].elements.find((e) => e.id === id)!;
    expect(table()).toMatchObject({ h: 80, banded: true, header: true, source: { sheet: 'sheet-1', tab: 'Data', range: 'A1:B2', rev: 'r1' }, rows: [[{ text: 'Item', bold: true }, { text: 'Cost' }], [{ text: 'Pens' }, { text: '5', align: 'right' }]] });
    expect(asked).toEqual([{ range: 'Data!A1:B2' }]);
    expect(table()).not.toMatchObject({ source: { used: true } });
    // Without a range (or with only the tab) the table follows the tab's used part.
    const whole = await run({ slide: 1, set: [{ type: 'table', link: { sheet_id: 'sheet-1', range: 'Data!' } }] });
    expect(deck.deck.slides[0].elements.find((e) => e.id === whole.set[0].id)).toMatchObject({ source: { used: true } });
    await run({ slide: 1, remove: [whole.set[0].id] });
    const outline = JSON.parse(await runClientTool({ id: 'r', name: 'read_deck', input: {} }, env)).slides[0].elements.find((e: { id: string }) => e.id === id);
    expect(outline.linked).toMatchObject({ sheet_id: 'sheet-1', title: 'Figures', range: 'Data!A1:B2' });

    await expect(run({ slide: 1, set: [{ id, cells: [{ row: 1, col: 1, text: 'x' }] }] })).rejects.toThrow(/cannot be changed here/);
    await expect(run({ slide: 1, set: [{ type: 'table', link: { sheet_id: 'nope' } }] })).rejects.toThrow(/Could not read the range to link: There is no spreadsheet nope/);
    // Its own look still changes; null unlinks and keeps the values, which can then be edited.
    await run({ slide: 1, set: [{ id, size: 20 }] });
    expect(table()).toMatchObject({ style: { size: 20 }, source: { sheet: 'sheet-1' } });
    await run({ slide: 1, set: [{ id, link: null, cells: [{ row: 2, col: 2, text: '6' }] }] });
    expect(table()).not.toHaveProperty('source');
    expect(table()).toMatchObject({ rows: [[{ text: 'Item' }, { text: 'Cost' }], [{ text: 'Pens' }, { text: '6', align: 'right' }]] });
  });

  it('puts a spreadsheet chart on a slide, moves it and unlinks it, and refuses a chart with nothing to show', async () => {
    const { deck, env } = setup();
    const chart = { title: 'Figures', rev: 'r1', tabId: 't1', tab: 'Data', w: 1200, h: 600, chart: { id: 'c9', type: 'column' as const, title: 'Costs', series: [{ values: 'B2:B3' }] }, data: { categories: ['a', 'b'], series: [{ name: 'Cost', color: '#4285f4', points: [{ y: 1 }, { y: 2 }] }] } };
    const run = async (input: Record<string, unknown>) =>
      JSON.parse(await runClientTool(await linkDeckTables({ id: 'x', name: 'edit_elements', input }, async () => Promise.reject(new Error('no tables')), async (sheet, id) => (sheet === 's1' && id === 'c9' ? chart : Promise.reject(new Error('There is no such chart.')))), env));
    const res = await run({ slide: 1, set: [{ type: 'chart', link: { sheet_id: 's1', chart_id: 'c9' } }] });
    const id = res.set[0].id as string;
    const el = () => deck.deck.slides[0].elements.find((e) => e.id === id)!;
    // Scaled to fit the slide, in the middle.
    expect(el()).toMatchObject({ type: 'chart', x: 80, y: 70, w: 800, h: 400, chart: { title: 'Costs' }, source: { sheet: 's1', chart: 'c9', tab: 'Data', rev: 'r1' } });
    const outline = JSON.parse(await runClientTool({ id: 'r', name: 'read_deck', input: {} }, env)).slides[0].elements.find((e: { id: string }) => e.id === id);
    expect(outline).toMatchObject({ type: 'chart', chart_type: 'column', labels: ['a', 'b'], series: [{ name: 'Cost', values: [1, 2] }], linked: { sheet_id: 's1', chart_id: 'c9' } });
    await run({ slide: 1, set: [{ id, x: 10, w: 400, link: null }] });
    expect(el()).toMatchObject({ x: 10, w: 400, h: 400 });
    expect(el()).not.toHaveProperty('source');
    await expect(run({ slide: 1, set: [{ type: 'chart' }] })).rejects.toThrow(/needs link/);
    await expect(run({ slide: 1, set: [{ type: 'chart', link: { sheet_id: 's1', chart_id: 'zz' } }] })).rejects.toThrow(/Could not read the chart to link: There is no such chart/);
  });

  it('draws an elbow connector between two boxes that follows them, and reports it in read_deck', async () => {
    const { deck, call } = setup();
    await call('update_slide', { slide: 1, layout: 'blank' });
    const made = await call('edit_elements', {
      slide: 1,
      set: [
        { type: 'shape', shape: 'rect', x: 100, y: 50, w: 200, h: 60, fill: '#eeeeee', text: 'Fetch' },
        { type: 'shape', shape: 'rect', x: 400, y: 250, w: 200, h: 60, fill: '#eeeeee', text: 'Cache' },
      ],
    });
    const [a, b] = made.set.map((e: { id: string }) => e.id);
    const res = await call('edit_elements', {
      slide: 1,
      set: [{ type: 'line', kind: 'elbow', end_arrow: 'triangle', dash: 'dash', stroke: '#ff0000', stroke_width: 2, connect_start: { element_id: a, site: 'bottom' }, connect_end: { element_id: b, site: 'top' } }],
    });
    // The ends sit on the middles of the sides.
    expect(res.set[0]).toMatchObject({ type: 'line', x1: 200, y1: 110, x2: 500, y2: 250 });
    const id = res.set[0].id;
    expect(deck.deck.slides[0].elements.find((e) => e.id === id)).toMatchObject({ kind: 'elbow', endArrow: 'triangle', dash: 'dash', strokeColor: '#ff0000', strokeWidth: 2 });

    // Moving a box moves the end of the line with it.
    await call('edit_elements', { slide: 1, set: [{ id: b, x: 600, y: 300 }] });
    const outline = await call('read_deck');
    const line = outline.slides[0].elements.find((e: { id: string }) => e.id === id);
    expect(line).toMatchObject({ kind: 'elbow', x1: 200, y1: 110, x2: 700, y2: 300, end_arrow: 'triangle', start_arrow: 'none', connect_start: { element_id: a, site: 'bottom' }, connect_end: { element_id: b, site: 'top' } });

    // Removing a box detaches the line; the old `arrow` input still works; a connection needs a real element.
    await call('edit_elements', { slide: 1, remove: [b] });
    expect(deck.deck.slides[0].elements.find((e) => e.id === id)).not.toHaveProperty('endConnection');
    await call('edit_elements', { slide: 1, set: [{ id, arrow: 'both' }] });
    expect(deck.deck.slides[0].elements.find((e) => e.id === id)).toMatchObject({ startArrow: 'arrow', endArrow: 'arrow' });
    await expect(call('edit_elements', { slide: 1, set: [{ id, connect_end: { element_id: 'nope', site: 'left' } }] })).rejects.toThrow(/Cannot connect/);

    // Lines point any direction, and the legacy "shape: line" becomes a line element.
    const back = await call('edit_elements', { slide: 1, set: [{ type: 'line', x1: 300, y1: 400, x2: 100, y2: 350 }, { type: 'shape', shape: 'line', x: 10, y: 20, w: 0, h: 80, arrow: 'end' }] });
    expect(back.set[0]).toMatchObject({ x1: 300, y1: 400, x2: 100, y2: 350 });
    expect(deck.deck.slides[0].elements.find((e) => e.id === back.set[0].id)).toMatchObject({ x: 100, y: 350, w: 200, h: 50, flipH: true, flipV: true });
    expect(deck.deck.slides[0].elements.find((e) => e.id === back.set[1].id)).toMatchObject({ type: 'line', w: 0, h: 80, endArrow: 'arrow' });
  });

  it('keeps a drawn connector attached when a box is dragged or resized, and detaches it when only the line moves', () => {
    const { deck } = setup();
    const a = deck.addElement({ type: 'shape', shape: 'rect', x: 100, y: 100, w: 100, h: 50 });
    const b = deck.addElement({ type: 'shape', shape: 'rect', x: 400, y: 300, w: 100, h: 50 });
    const l = deck.addLine('elbow', true, { x1: 150, y1: 150, x2: 450, y2: 300, startConnection: { elementId: a, site: 'bottom' }, endConnection: { elementId: b, site: 'top' } });
    const line = () => deck.slide.elements.find((e) => e.id === l) as import('../../../shared/deck.ts').LineElement;
    expect(line()).toMatchObject({ kind: 'elbow', endArrow: 'arrow', x: 150, y: 150, w: 300, h: 150 });

    deck.moveElements({ [b]: { x: 600, y: 320 } });
    expect(line()).toMatchObject({ x: 150, y: 150, w: 500, h: 170 });
    deck.updateElements([a], (e) => ({ ...e, x: 0, w: 300 })); // resized: the bottom middle is now x = 150 still, wider box
    expect(line().startConnection).toBeDefined();

    deck.moveElements({ [l]: { x: 10, y: 10 } });
    expect(line().startConnection).toBeUndefined();
    expect(line().endConnection).toBeUndefined();
    deck.undo();
    expect(line().endConnection).toMatchObject({ elementId: b });
  });

  it('adds arcs with start and end angles and reports them', async () => {
    const { deck, call } = setup();
    const res = await call('edit_elements', { slide: 1, set: [{ type: 'shape', shape: 'arc', x: 10, y: 10, w: 100, h: 100, stroke: '#f00', stroke_width: 4, start_angle: 90, end_angle: 200 }] });
    const id = res.set[0].id;
    expect(deck.deck.slides[0].elements.find((e) => e.id === id)).toMatchObject({ shape: 'arc', stroke: '#f00', strokeWidth: 4, startAngle: 90, endAngle: 200 });
    const outline = await call('read_deck');
    expect(outline.slides[0].elements.find((e: { id: string }) => e.id === id)).toMatchObject({ shape: 'arc', start_angle: 90, end_angle: 200 });
  });

  it('creates an arc from center and radius with a tight box, and keeps the ellipse when angles change', async () => {
    const { deck, call } = setup();
    const res = await call('edit_elements', { slide: 1, set: [{ type: 'shape', shape: 'arc', cx: 300, cy: 300, radius: 100, stroke_width: 2, start_angle: 0, end_angle: 90 }] });
    const id = res.set[0].id;
    const find = () => deck.deck.slides[0].elements.find((e) => e.id === id)!;
    // Quarter circle to the bottom right: box spans center..center+radius, plus the stroke.
    const near = (b: { x: number; y: number; w: number; h: number }, x: number, y: number, w: number, h: number) => {
      for (const [k, v] of Object.entries({ x, y, w, h })) expect(b[k as 'x']).toBeCloseTo(v, 6);
    };
    expect(find()).toMatchObject({ tight: true });
    near(find(), 299, 299, 102, 102);
    await call('edit_elements', { slide: 1, set: [{ id, end_angle: 180 }] });
    near(find(), 199, 299, 202, 102);
  });

  it('styles shape labels with size, font, bold and color', async () => {
    const { deck, call } = setup();
    const res = await call('edit_elements', { slide: 1, set: [{ type: 'shape', text: 'Q1', size: 9, font: 'Poppins', bold: true, color: '#333' }] });
    const id = res.set[0].id;
    expect(deck.deck.slides[0].elements.find((e) => e.id === id)).toMatchObject({ text: 'Q1', textSize: 9, textFont: 'Poppins', textBold: true, textColor: '#333' });
    await call('edit_elements', { slide: 1, set: [{ id, bold: false, font: '' }] });
    const el = deck.deck.slides[0].elements.find((e) => e.id === id)!;
    expect(el).toMatchObject({ textSize: 9 });
    expect(el).not.toHaveProperty('textBold');
    expect(el).not.toHaveProperty('textFont');
    const outline = await call('read_deck');
    expect(outline.slides[0].elements.find((e: { id: string }) => e.id === id)).toMatchObject({ text: 'Q1', size: 9, color: '#333' });
    await expect(call('edit_elements', { slide: 1, set: [{ id, size: 2 }] })).rejects.toThrow(/label font size/);
  });

  it('renders a slide, attaches the picture and reports overflowing text', async () => {
    const { deck, env, call } = setup();
    await call('add_slides', { slides: [{ title: 'Roadmap' }] });
    const attached: unknown[] = [];
    const renders: { title: string; theme: string; scale: number }[] = [];
    env.attachImage = (img) => attached.push(img) <= 1;
    env.renderSlide = async (slide, theme, scale) => {
      renders.push({ title: slideTitle(slide), theme, scale });
      return {
        blob: new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }),
        width: 960 * scale,
        height: 540 * scale,
        overflow: [{ id: 'e1', type: 'shape', box_w: 80, box_h: 20, text_w: 80, text_h: 44 }],
        missingImages: [],
      };
    };
    const res = await call('render_slide', { slide: 2 });
    expect(renders).toEqual([{ title: 'Roadmap', theme: 'light', scale: 1 }]);
    expect(res).toMatchObject({ slide: 2, width: 960, height: 540, image_url: '/api/images/00000000-0000-0000-0000-000000000001', overflow: [{ id: 'e1', text_h: 44 }] });
    expect(res.image).toMatch(/Attached/);
    expect(attached).toEqual([{ mediaType: 'image/png', data: 'iVBORw==', url: '/api/images/00000000-0000-0000-0000-000000000001' }]);

    // No room left for another picture in this message.
    expect((await call('render_slide', { slide: 1, scale: 0.5 })).image).toMatch(/Not attached/);

    await expect(call('render_slide', { slide: 3 })).rejects.toThrow(/no slide 3. The presentation has 2 slides/);
    await expect(runClientTool({ id: 'x', name: 'render_slide', input: { slide: 1 } }, { ...env, deck: null })).rejects.toThrow(/No presentation is open/);

    // Another saved presentation by id.
    env.deckId = 'open-one';
    env.loadDeck = async (id) => {
      if (id !== 'other') throw new Error('404');
      return { ...newDeck(), theme: 'ocean' };
    };
    await call('render_slide', { slide: 1, deck_id: 'other' });
    expect(renders.at(-1)).toMatchObject({ title: 'Presentation title', theme: 'ocean' });
    await expect(call('render_slide', { slide: 1, deck_id: 'missing' })).rejects.toThrow(/No presentation with id "missing"/);
    expect(deck.deck.slides).toHaveLength(2);
  });

  it('exports the deck as a PDF download named after its title', async () => {
    const { env, call } = setup();
    await call('add_slides', { slides: [{ title: 'Two' }] });
    const saved: { name: string; size: number }[] = [];
    env.deckTitle = 'BizTrip: Business Risk Review';
    env.makePdf = async (d) => new Blob([`pages:${d.slides.length}`]);
    env.uploadFile = async (name, file) => {
      saved.push({ name, size: file.size });
      return { id: 'f1', filename: name, type: file.type, size: file.size, createdAt: '', url: '/api/files/f1', downloadUrl: '/api/files/f1/download' };
    };
    expect(await call('export_deck', {})).toMatchObject({ file_id: 'f1', filename: 'BizTrip_Business_Risk_Review.pdf', pages: 2, url: '/api/files/f1', download_url: '/api/files/f1/download' });
    expect(saved).toEqual([{ name: 'BizTrip_Business_Risk_Review.pdf', size: 7 }]);

    env.loadDeck = async (id) => {
      if (id !== 'other') throw new Error('404');
      return newDeck();
    };
    env.loadDeckTitle = async () => 'Other deck';
    expect(await call('export_deck', { deck_id: 'other', format: 'pdf' })).toMatchObject({ filename: 'Other_deck.pdf', pages: 1 });
    await expect(call('export_deck', { deck_id: 'missing' })).rejects.toThrow(/No presentation with id "missing"/);
  });

  it('builds a PDF with one page per slide', async () => {
    const { buildPdf } = await import('../deck/pdf.ts');
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const text = await buildPdf([1, 2, 3].map(() => ({ jpeg, width: 1920, height: 1080 }))).text();
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('/Count 3');
    expect(text.match(/\/Type \/Page /g)).toHaveLength(3);
    expect(text).toContain('/MediaBox [0 0 960 540]');
  });

  it('deletes and moves slides, asking first and keeping one slide', async () => {
    const { deck, call } = setup();
    await call('add_slides', { slides: [{ title: 'Two' }, { title: 'Three' }] });
    const c = (name: string, input: Record<string, unknown>): ClientToolCall => ({ id: 'x', name, input });
    expect(confirmationFor(c('delete_slides', { slides: [2] }), null, deck)).toBe('Delete slide 2?');
    expect(confirmationFor(c('delete_slides', { slides: [2, 3] }), null, deck)).toBe('Delete 2 slides (2, 3)?');
    expect(confirmationFor(c('add_slides', { slides: [] }), null, deck)).toBeNull();

    await call('move_slide', { slide: 3, to: 1 });
    expect(deck.deck.slides.map(slideTitle)).toEqual(['Three', 'Presentation title', 'Two']);

    const res = await call('delete_slides', { slides: [1, 3] });
    expect(res).toEqual({ deleted: 2, slide_count: 1 });
    expect(slideTitle(deck.deck.slides[0])).toBe('Presentation title');
    await expect(call('delete_slides', { slides: [1] })).rejects.toThrow(/every slide/);
  });

  it('fails clearly when no presentation is open, and opens one', async () => {
    const { env, deck } = setup();
    const noDeck = { ...env, deck: null };
    await expect(runClientTool({ id: 'x', name: 'read_deck', input: {} }, noDeck)).rejects.toThrow(/No presentation is open/);
    await expect(runClientTool({ id: 'x', name: 'read_range', input: { range: 'A1' } }, env)).rejects.toThrow(/A presentation is open, not a spreadsheet/);
    const opened = JSON.parse(await runClientTool({ id: 'x', name: 'open_deck', input: { deck_id: 'd1' } }, noDeck));
    expect(opened).toMatchObject({ opened: true, slide_count: deck.deck.slides.length });
  });
});

describe('pictures from the web on a slide', () => {
  const call = (name: string, input: Record<string, unknown>): ClientToolCall => ({ id: 'c1', name, input });
  const web = 'https://logos.example/openai.png';

  it('are stored with the presentation before the tool runs, once each', async () => {
    const fetched: string[] = [];
    const keep = async (url: string) => {
      fetched.push(url);
      return `/api/images/00000000-0000-4000-8000-00000000000${fetched.length}`;
    };
    const stored = '/api/images/00000000-0000-4000-8000-000000000001';
    const edited = await keepDeckPictures(call('edit_elements', { slide: 1, set: [{ type: 'image', src: web, x: 10 }, { id: 'a', src: web }, { id: 'b', x: 5 }, { id: 'c', src: '/api/images/11111111-1111-4111-8111-111111111111' }] }), keep);
    expect(edited.input.set).toEqual([{ type: 'image', src: stored, x: 10 }, { id: 'a', src: stored }, { id: 'b', x: 5 }, { id: 'c', src: '/api/images/11111111-1111-4111-8111-111111111111' }]);
    expect(fetched).toEqual([web]);
    expect((await keepDeckPictures(call('update_slide', { slide: 2, image: web }), keep)).input).toEqual({ slide: 2, image: '/api/images/00000000-0000-4000-8000-000000000002' });
    expect((await keepDeckPictures(call('add_slides', { slides: [{ title: 'A' }, { layout: 'image', image: web }] }), keep)).input.slides).toEqual([{ title: 'A' }, { layout: 'image', image: '/api/images/00000000-0000-4000-8000-000000000003' }]);
    // Nothing to keep: the call is passed on as it is, and other tools are never touched.
    const plain = call('update_slide', { slide: 1, title: 'Hi' });
    expect(await keepDeckPictures(plain, keep)).toBe(plain);
    const other = call('insert_image', { src: web });
    expect(await keepDeckPictures(other, keep)).toBe(other);
    expect(fetched).toHaveLength(3);
  });

  it('tell the assistant to pick another picture when one cannot be fetched', async () => {
    const failing = keepDeckPictures(call('edit_elements', { slide: 1, set: [{ type: 'image', src: web }] }), async () => {
      throw new Error('The server answered 403.');
    });
    await expect(failing).rejects.toThrow('The picture at https://logos.example/openai.png could not be fetched (The server answered 403.) Use another picture');
  });
});

describe('PowerPoint files (desktop app)', () => {
  it('take plain changes, but refuse what a PowerPoint file only approximates and say to keep it as a presentation of the app', async () => {
    const { deck, call } = setup();
    deck.store.guard = pptxGuard;
    await call('update_slide', { slide: 1, background: '#123456' });
    expect(deck.deck.slides[0].bg).toBe('#123456');
    await expect(call('update_slide', { slide: 1, background: 'linear-gradient(90deg, #ff0000, #0000ff)' })).rejects.toThrow(/PowerPoint file.*gradient fills.*MCP Docs presentation/s);
    expect(deck.deck.slides[0].bg).toBe('#123456');
  });

  it('refuse every change until the user allows editing, and the user is asked with a retry', async () => {
    const { deck, call } = setup();
    deck.store.guard = lockedGuard;
    await expect(call('update_slide', { slide: 1, notes: 'x' })).rejects.toThrow(/read-only until the user allows editing/);
    let retry: (() => void) | null = null;
    deck.onRefused = (_reason, r) => (retry = r);
    deck.run((tx) => tx.updateSlide(0, (sl) => ({ ...sl, notes: 'mine' })));
    expect(deck.deck.slides[0].notes).toBeUndefined();
    deck.store.guard = pptxGuard;
    retry!();
    expect(deck.deck.slides[0].notes).toBe('mine');
  });
});
