// A JSON file shown as a tree: every object and array open at first (a very large file only its top levels), each
// one closed and opened again with its triangle, and Collapse all / Expand all for the whole file. A file that is not
// valid JSON says what is wrong, and offers the text editor. FilePage shows it for a .json file; Edit there is the text editor.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FindBox, FindToggle } from '../find/FindBox.tsx';
import { findAll, stepIndex, useFind } from '../find/find.ts';
import { clearMatches, paintMatches, rangesIn, scrollToRange } from '../find/highlights.ts';
import type { StoredFile } from '../../../shared/types.ts';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** More values than this and only the top levels start open: drawing every row of a huge file takes too long. */
export const OPEN_ALL_LIMIT = 50_000;
/** How deep a large file starts open. */
const LARGE_OPEN_DEPTH = 2;

const isContainer = (v: Json): v is Json[] | { [key: string]: Json } => typeof v === 'object' && v !== null;

/** A container's path: its keys and indexes from the top, as a JSON Pointer ("" is the whole file). */
const childPath = (path: string, key: string | number) => `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

/** The paths of the objects and arrays in a value deeper than `depth` levels (0: all of them but the top), and how many values it holds. */
export function containers(value: Json, depth = 0): { paths: string[]; count: number } {
  const paths: string[] = [];
  let count = 0;
  const walk = (v: Json, path: string, level: number) => {
    count++;
    if (!isContainer(v)) return;
    if (level > depth) paths.push(path);
    for (const [k, child] of Array.isArray(v) ? v.map((c, i) => [i, c] as const) : Object.entries(v)) walk(child, childPath(path, k), level + 1);
  };
  walk(value, '', 0);
  return { paths, count };
}

/** The objects and arrays (by path) holding a key or value whose text, as the tree shows it, has the query in it. */
export function containersWith(value: Json, query: string, matchCase: boolean): Set<string> {
  const out = new Set<string>();
  const has = (text: string) => findAll(text, query, matchCase).length > 0;
  const walk = (v: Json, path: string): boolean => {
    if (!isContainer(v)) return has(v === null ? 'null' : typeof v === 'string' ? JSON.stringify(v) : String(v));
    let found = false;
    for (const [k, child] of Array.isArray(v) ? v.map((c, i) => [i, c] as const) : Object.entries(v)) {
      if (walk(child, childPath(path, k)) || (!Array.isArray(v) && has(JSON.stringify(k)))) found = true;
    }
    if (found) out.add(path);
    return found;
  };
  if (query) walk(value, '');
  return out;
}

function Scalar({ value }: { value: Json }) {
  if (value === null) return <span className="json-null">null</span>;
  if (typeof value === 'string') return <span className="json-string">{JSON.stringify(value)}</span>;
  if (typeof value === 'number') return <span className="json-number">{String(value)}</span>;
  return <span className="json-bool">{String(value)}</span>;
}

function Node({ name, value, path, last, closed, toggle }: { name?: ReactNode; value: Json; path: string; last: boolean; closed: Set<string>; toggle(path: string): void }) {
  const comma = last ? '' : ',';
  const label = name !== undefined && <>{name}: </>;
  if (!isContainer(value)) {
    return (
      <div className="json-row">
        <span className="json-toggle" />
        {label}
        <Scalar value={value} />
        {comma}
      </div>
    );
  }
  const array = Array.isArray(value);
  const entries = array ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
  const [open, close] = array ? ['[', ']'] : ['{', '}'];
  if (!entries.length) {
    return (
      <div className="json-row">
        <span className="json-toggle" />
        {label}
        {open}
        {close}
        {comma}
      </div>
    );
  }
  const isClosed = closed.has(path);
  const size = `${entries.length} ${array ? (entries.length === 1 ? 'item' : 'items') : entries.length === 1 ? 'key' : 'keys'}`;
  return (
    <div className="json-node">
      <div className="json-row">
        <button className="json-toggle" onClick={() => toggle(path)} aria-expanded={!isClosed} title={isClosed ? 'Expand' : 'Collapse'}>
          {isClosed ? '▸' : '▾'}
        </button>
        {label}
        {open}
        {isClosed && (
          <>
            <button className="json-more" onClick={() => toggle(path)}>
              …
            </button>
            {close}
            {comma}
            <span className="json-size">{size}</span>
          </>
        )}
      </div>
      {!isClosed && (
        <>
          <div className="json-children">
            {entries.map(([k, v], i) => (
              <Node key={k} name={array ? undefined : <span className="json-key">{JSON.stringify(k)}</span>} value={v} path={childPath(path, k)} last={i === entries.length - 1} closed={closed} toggle={toggle} />
            ))}
          </div>
          <div className="json-row">
            <span className="json-toggle" />
            {close}
            {comma}
          </div>
        </>
      )}
    </div>
  );
}

export function JsonViewer({ file, onEdit }: { file: StoredFile; /** Edit the file as text (shown when it is not valid JSON). */ onEdit(): void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    // Not from the cache: the file may have just been saved from the text editor.
    fetch(file.url, { credentials: 'same-origin', cache: 'no-cache' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Could not read the file (${res.status})`);
        const body = await res.text();
        if (!gone) setText(body.replace(/^﻿/, ''));
      })
      .catch((e: unknown) => !gone && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      gone = true;
    };
  }, [file.url]);

  const parsed = useMemo((): { value: Json; all: string[]; large: boolean } | { problem: string } | null => {
    if (text === null) return null;
    try {
      const value = JSON.parse(text) as Json;
      const { paths: all, count } = containers(value);
      return { value, all, large: count > OPEN_ALL_LIMIT };
    } catch (e) {
      // The engine's message says where, when it can (line and column).
      return { problem: `This is not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
    }
  }, [text]);

  // The objects and arrays that are closed. A large file starts with only its top levels open.
  const [closed, setClosed] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (parsed && 'value' in parsed) setClosed(new Set(parsed.large ? containers(parsed.value, LARGE_OPEN_DEPTH).paths : []));
  }, [parsed]);
  const toggle = (path: string) =>
    setClosed((cur) => {
      const next = new Set(cur);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  // Find (⌘F): searching opens the objects and arrays with matches in them, and the matches are found in the tree
  // as drawn (the sizes of closed ones left out).
  const finder = useFind(!!parsed && 'value' in parsed);
  const find = finder.find;
  useEffect(() => {
    if (!find?.query || !parsed || !('value' in parsed)) return;
    const holding = containersWith(parsed.value, find.query, find.matchCase);
    setClosed((cur) => (cur.size && [...holding].some((p) => cur.has(p)) ? new Set([...cur].filter((p) => !holding.has(p))) : cur));
  }, [find?.query, find?.matchCase, parsed]);
  const treeRef = useRef<HTMLDivElement>(null);
  const [ranges, setRanges] = useState<Range[]>([]);
  useLayoutEffect(() => {
    const root = treeRef.current;
    setRanges(find?.query && root ? rangesIn(root, find.query, find.matchCase, '.json-size, .json-more, .json-bar') : []);
  }, [find?.query, find?.matchCase, closed, parsed]);
  const current = find && find.current < ranges.length ? find.current : -1;
  useEffect(() => {
    if (!ranges.length) return clearMatches();
    paintMatches(ranges, current >= 0 ? ranges[current] : null);
    return clearMatches;
  }, [ranges, current]);
  useEffect(() => {
    if (current >= 0 && ranges[current]) scrollToRange(ranges[current]);
  }, [current, ranges]);

  if (error) return <div className="form-error">{error}</div>;
  if (!parsed) return <div className="muted text-file-wait">Loading…</div>;
  if ('problem' in parsed)
    return (
      <div className="json-view">
        <div className="form-error">{parsed.problem}</div>
        <div>
          <button className="btn" onClick={onEdit}>
            Edit as text
          </button>
        </div>
      </div>
    );
  const anyClosed = closed.size > 0;
  return (
    <div className="json-view">
      <div className="json-bar">
        {parsed.large && <span className="muted">A large file: only its top levels are open.</span>}
        {parsed.all.length > 0 && (
          // Collapsing all keeps the top open, so its keys still show.
          <button className="btn" onClick={() => setClosed(anyClosed ? new Set() : new Set(parsed.all))}>
            {anyClosed ? 'Expand all' : 'Collapse all'}
          </button>
        )}
      </div>
      {find && (
        <FindBox
          query={find.query}
          onQuery={(query) => finder.set({ query, current: 0 })}
          count={ranges.length}
          current={current}
          onStep={(dir) => finder.set({ current: stepIndex(current, ranges.length, dir) })}
          onClose={finder.close}
          focusSeq={find.focusSeq}
          placeholder="Find in JSON"
          label="Find in JSON"
        >
          <FindToggle on={find.matchCase} title="Match case" onClick={() => finder.set({ matchCase: !find.matchCase, current: 0 })}>
            Aa
          </FindToggle>
        </FindBox>
      )}
      <div className="json-tree" aria-label={file.filename} ref={treeRef}>
        <Node value={parsed.value} path="" last closed={closed} toggle={toggle} />
      </div>
    </div>
  );
}
