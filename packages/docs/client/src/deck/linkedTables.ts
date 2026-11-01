// Keeps the linked tables and charts of an open presentation (TableElement.source, ChartElement.source) showing
// their spreadsheet ranges and charts. It
// follows the revision feed (/api/revisions/:id, server/revisionFeed.ts) of every spreadsheet a table is linked
// to: the feed says the current revision on connecting and each new one after, and a table read from another
// revision is read again (GET /api/sheets/:id/table) and refreshed as an undo step of its own.
import { useEffect, useState } from 'react';
import type { ChartElement, TableElement } from '../../../shared/deck.ts';
import type { LinkedChart } from '../../../shared/chart.ts';
import { refOf, type LinkedTable, type SheetTableRef } from '../../../shared/sheetTable.ts';
import { api } from '../api.ts';
import type { DeckController } from './controller.ts';

export interface LinkedTableIo {
  fetch(sheetId: string, ref: SheetTableRef): Promise<LinkedTable>;
  fetchChart(sheetId: string, chartId: string): Promise<LinkedChart>;
  /** Hear each revision of a spreadsheet; returns the function that stops. */
  follow(sheetId: string, onRev: (rev: string) => void): () => void;
}

const browserIo: LinkedTableIo = {
  fetch: (id, ref) => api.sheetTable(id, ref),
  fetchChart: (id, chartId) => api.sheetChart(id, chartId),
  follow: (id, onRev) => {
    if (typeof EventSource === 'undefined') return () => {};
    const events = new EventSource(`/api/revisions/${encodeURIComponent(id)}`);
    events.onmessage = (e: MessageEvent<string>) => {
      try {
        const rev = (JSON.parse(e.data) as { rev?: unknown }).rev;
        if (typeof rev === 'string') onRev(rev);
      } catch {
        // not an announcement
      }
    };
    return () => events.close();
  },
};

export class LinkedTableSync {
  /** Why a table could not be refreshed (its spreadsheet or range is gone), by element id. */
  readonly problems = new Map<string, string>();
  private feeds = new Map<string, () => void>();
  private latest = new Map<string, string>();
  private busy = new Set<string>();
  /** The revision each table was last read for, so one that could not be refreshed is not read again for it. */
  private tried = new Map<string, string>();
  private listeners = new Set<() => void>();
  private stop: () => void;
  private ctl: DeckController;
  private io: LinkedTableIo;

  constructor(ctl: DeckController, io: LinkedTableIo = browserIo) {
    this.ctl = ctl;
    this.io = io;
    this.stop = ctl.subscribe(() => this.follow());
    this.follow();
  }

  dispose(): void {
    this.stop();
    for (const close of this.feeds.values()) close();
    this.feeds.clear();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  /** Every linked table and chart in the presentation. */
  private tables(): (TableElement | ChartElement)[] {
    return this.ctl.deck.slides.flatMap((s) => s.elements.filter((e): e is TableElement | ChartElement => (e.type === 'table' || e.type === 'chart') && !!e.source));
  }

  /** Follow the spreadsheets the tables are linked to now, and stop following the others. */
  private follow(): void {
    const sheets = new Set(this.tables().map((t) => t.source!.sheet));
    for (const [id, close] of this.feeds) {
      if (sheets.has(id)) continue;
      close();
      this.feeds.delete(id);
      this.latest.delete(id);
    }
    for (const id of sheets) {
      if (this.feeds.has(id)) {
        // A table linked (or undone) since the last announcement may be behind it.
        const rev = this.latest.get(id);
        if (rev) void this.catchUp(id, rev);
        continue;
      }
      this.feeds.set(
        id,
        this.io.follow(id, (rev) => {
          this.latest.set(id, rev);
          void this.catchUp(id, rev);
        }),
      );
    }
  }

  /** Refresh the tables linked to a spreadsheet that were read from another revision than `rev`. */
  private async catchUp(sheetId: string, rev: string): Promise<void> {
    for (const t of this.tables()) {
      if (t.source!.sheet !== sheetId || t.source!.rev === rev || this.problems.has(t.id) || this.tried.get(t.id) === rev) continue;
      this.tried.set(t.id, rev);
      await this.refresh(t.id);
    }
  }

  /** Read a linked table's range again and put it in the table. */
  async refresh(id: string): Promise<void> {
    if (this.busy.has(id)) return;
    const el = this.tables().find((t) => t.id === id);
    if (!el?.source) return;
    this.busy.add(id);
    try {
      if (el.type === 'chart') {
        const c = await this.io.fetchChart(el.source.sheet, el.source.chart);
        this.problems.delete(id);
        this.ctl.refreshLinkedChart(id, c);
      } else {
        const data = await this.io.fetch(el.source.sheet, refOf(el.source));
        this.problems.delete(id);
        this.ctl.refreshLinkedTable(id, data);
      }
    } catch (e) {
      this.problems.set(id, e instanceof Error ? e.message : String(e));
    } finally {
      this.busy.delete(id);
      this.emit();
    }
  }

  /** Try again: forget a table's problem and read it. */
  retry(id: string): Promise<void> {
    this.problems.delete(id);
    return this.refresh(id);
  }
}

/** Keep the open presentation's linked tables current while the page shows it. */
export function useLinkedTables(ctl: DeckController | null): LinkedTableSync | null {
  const [sync, setSync] = useState<LinkedTableSync | null>(null);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!ctl) return;
    const s = new LinkedTableSync(ctl);
    const off = s.subscribe(() => setTick((t) => t + 1));
    setSync(s);
    return () => {
      off();
      s.dispose();
      setSync(null);
    };
  }, [ctl]);
  return sync;
}
