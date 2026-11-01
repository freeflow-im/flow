import { describe, expect, it } from 'vitest';
import { newDeck } from '../../../shared/deck.ts';
import { DeckController } from './controller.ts';

describe('replacing a picture with its edited version', () => {
  it('puts the edited picture where the element is now, as one step that undo takes back', () => {
    const ctl = new DeckController(newDeck(), async () => {});
    const id = ctl.addImage('/api/images/old', { w: 800, h: 600 });
    const before = ctl.slide.elements.find((e) => e.id === id)!;
    // The user moves to another slide while the image editor is open: the element is still found.
    ctl.addSlide();
    expect(ctl.slide.elements.some((e) => e.id === id)).toBe(false);
    expect(ctl.replacePicture(id, '/api/images/new', { width: 800, height: 600 }, { width: 800, height: 300 })).toBe(true);
    const after = ctl.deck.slides.flatMap((s) => s.elements).find((e) => e.id === id)!;
    expect(after).toMatchObject({ type: 'image', src: '/api/images/new', w: before.w, h: Math.round(before.w / (800 / 300)) });
    ctl.undo();
    expect(ctl.deck.slides.flatMap((s) => s.elements).find((e) => e.id === id)).toEqual(before);
  });

  it('says so when the picture is no longer in the presentation', () => {
    const ctl = new DeckController(newDeck(), async () => {});
    const id = ctl.addImage('/api/images/old');
    ctl.select([id]);
    ctl.deleteSelected();
    expect(ctl.replacePicture(id, '/api/images/new', null, null)).toBe(false);
    // An element of another kind with that id is not a picture to replace.
    const title = ctl.slide.elements.find((e) => e.type === 'text');
    if (title) expect(ctl.replacePicture(title.id, '/api/images/new', null, null)).toBe(false);
  });
});

describe('cropping a picture on a slide', () => {
  it('crops as one step that undo takes back, and only pictures', () => {
    const ctl = new DeckController(newDeck(), async () => {});
    const id = ctl.addImage('/api/images/pic', { w: 800, h: 600 });
    const before = ctl.slide.elements.find((e) => e.id === id)!;
    if (before.type !== 'image') throw new Error('not a picture');
    ctl.startCropping(id);
    expect(ctl.cropping).toBe(id);
    expect(ctl.selection).toEqual([id]);
    const cropped = { ...before, w: before.w / 2, crop: { l: 0, t: 0, r: 0.5, b: 0 } };
    ctl.stopCropping(cropped);
    expect(ctl.cropping).toBeNull();
    expect(ctl.slide.elements.find((e) => e.id === id)).toEqual(cropped);
    ctl.undo();
    expect(ctl.slide.elements.find((e) => e.id === id)).toEqual(before);
    // Cancelled, or left as it was: nothing to undo is added.
    ctl.startCropping(id);
    ctl.stopCropping();
    ctl.startCropping(id);
    ctl.stopCropping(before);
    ctl.undo();
    expect(ctl.slide.elements.some((e) => e.id === id)).toBe(false);
    const title = ctl.slide.elements.find((e) => e.type === 'text');
    if (title) {
      ctl.startCropping(title.id);
      expect(ctl.cropping).toBeNull();
    }
  });

  it('puts the frame away when the picture is no longer what is being worked on', () => {
    const ctl = new DeckController(newDeck(), async () => {});
    const id = ctl.addImage('/api/images/pic');
    for (const leave of [() => ctl.select([]), () => ctl.goTo(0), () => ctl.setPresenting(true), () => ctl.addSlide(), () => ctl.undo()]) {
      if (!ctl.slide.elements.some((e) => e.id === id)) break;
      ctl.startCropping(id);
      expect(ctl.cropping).toBe(id);
      leave();
      expect(ctl.cropping).toBeNull();
      ctl.setPresenting(false);
      ctl.goTo(0);
    }
  });
});


describe('tables on a slide', () => {
  const table = (ctl: DeckController, id: string) => {
    const el = ctl.slide.elements.find((e) => e.id === id);
    if (el?.type !== 'table') throw new Error('not a table');
    return el;
  };

  it('edits cells, goes on with Tab (adding a row after the last cell), and undoes each change', () => {
    const ctl = new DeckController(newDeck(), async () => {});
    const id = ctl.addTable(2, 2);
    expect(table(ctl, id)).toMatchObject({ w: 320, h: 80, header: true });
    ctl.selectCell(id, 1, 1, true);
    expect(ctl.editing).toBe(id);
    ctl.setCellText(id, 1, 1, 'last');
    ctl.moveCell(1);
    expect(table(ctl, id).rows).toHaveLength(3);
    expect(table(ctl, id).h).toBe(120);
    expect(ctl.tableCell).toEqual({ id, r: 2, c: 0 });
    ctl.moveCell(-1);
    expect(ctl.tableCell).toEqual({ id, r: 1, c: 1 });
    ctl.undo();
    expect(table(ctl, id).rows).toHaveLength(2);
    ctl.undo();
    expect(table(ctl, id).rows[1][1].text).toBe('');
  });

  it('inserts and deletes rows and columns at the current cell, and styles it', () => {
    const ctl = new DeckController(newDeck(), async () => {});
    const id = ctl.addTable(2, 2);
    ctl.selectCell(id, 0, 1);
    ctl.setCellText(id, 0, 1, 'B');
    ctl.insertTableColumn('left');
    // The current cell moves with its column; the new column is empty and the widths stay shared evenly.
    expect(ctl.tableCell).toEqual({ id, r: 0, c: 2 });
    expect(table(ctl, id).rows[0].map((c) => c.text)).toEqual(['', '', 'B']);
    expect(table(ctl, id).cols).toBeUndefined();
    ctl.insertTableRow('below');
    expect(table(ctl, id).rows).toHaveLength(3);
    ctl.styleCells({ fill: '#ff0000', bold: false });
    expect(table(ctl, id).rows[0][2]).toEqual({ text: 'B', fill: '#ff0000', bold: false });
    ctl.deleteTableColumn();
    expect(table(ctl, id).rows[0].map((c) => c.text)).toEqual(['', '']);
    expect(ctl.tableCell).toEqual({ id, r: 0, c: 1 });
    ctl.setTableOptions({ header: false, banded: true, cols: [3, 1] });
    expect(table(ctl, id)).toMatchObject({ banded: true, cols: [0.75, 0.25] });
    expect(table(ctl, id).header).toBeUndefined();
    // Deleting its last row removes the table.
    ctl.deleteTableRow();
    ctl.deleteTableRow();
    ctl.deleteTableRow();
    expect(ctl.slide.elements.some((e) => e.id === id)).toBe(false);
    expect(ctl.tableCell).toBeNull();
  });
});
