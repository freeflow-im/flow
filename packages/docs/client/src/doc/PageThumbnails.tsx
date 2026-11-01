// The page thumbnails on the left of a document: a small picture of every page (a scaled copy of the editor
// column, clipped per page, like the print layout), the current page highlighted, click to jump to a page.
import { useEffect, useRef, useState, type RefObject } from 'react';
import { pageMetrics } from '../../../shared/doc.ts';
import type { DocController } from './controller.ts';
import { PageChrome } from './DocEditor.tsx';

/** Room in a thumbnail row besides the picture: list padding and border, page number, gap, picture border. */
const THUMB_CHROME = 46;
/** Copies of the document are refreshed this long after the last change. */
const REFRESH_MS = 300;

export function PageThumbnails({ ctl, width, scrollRef }: { ctl: DocController; width: number; scrollRef: RefObject<HTMLDivElement | null> }) {
  const setup = ctl.pageSetup();
  const m = pageMetrics(setup);
  const { pageCount } = ctl.pagination();
  const paged = setup.mode === 'pages';
  const scale = Math.max(40, width - THUMB_CHROME) / m.pageW;
  const clips = useRef<(HTMLDivElement | null)[]>([]);
  const [current, setCurrent] = useState(0);

  // Refresh the page pictures a moment after the document (or its layout) changes.
  const version = ctl.version;
  useEffect(() => {
    if (!paged) return;
    const t = setTimeout(() => {
      const source = ctl.editorDom();
      if (!source) return;
      clips.current.forEach((clip, k) => {
        if (!clip || k >= pageCount) return;
        const column = document.createElement('div');
        column.className = 'doc-editor doc-editor-paged';
        column.style.padding = `${m.mt}px ${m.mr}px ${m.mb}px ${m.ml}px`;
        column.style.transform = `translateY(${-k * m.stride}px)`;
        const copy = source.cloneNode(true) as HTMLElement;
        copy.removeAttribute('contenteditable');
        copy.classList.remove('ProseMirror-focused');
        copy.querySelectorAll('.ProseMirror-selectednode').forEach((el) => el.classList.remove('ProseMirror-selectednode'));
        // A video playing in the page is its still here, not a second player.
        copy.querySelectorAll('.doc-video-player').forEach((el) => el.remove());
        column.append(copy);
        clip.replaceChildren(column);
      });
    }, REFRESH_MS);
    return () => clearTimeout(t);
  }, [ctl, version, pageCount, paged, m.mt, m.mr, m.mb, m.ml, m.stride]);

  // Which page is in view: the one under the top third of the scrolling area.
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || !paged) return;
    const update = () => {
      const pages = scroller.querySelector<HTMLElement>('.doc-pages');
      if (!pages) return;
      const r = pages.getBoundingClientRect();
      const viewScale = r.width / m.pageW || 1;
      const probe = scroller.getBoundingClientRect().top + scroller.clientHeight / 3;
      const y = (probe - r.top) / viewScale;
      setCurrent(Math.max(0, Math.min(pageCount - 1, Math.floor(y / m.stride))));
    };
    update();
    scroller.addEventListener('scroll', update, { passive: true });
    return () => scroller.removeEventListener('scroll', update);
  }, [scrollRef, paged, pageCount, m.pageW, m.stride, version]);

  const goTo = (k: number) => {
    const scroller = scrollRef.current;
    const pages = scroller?.querySelector<HTMLElement>('.doc-pages');
    if (!scroller || !pages) return;
    const r = pages.getBoundingClientRect();
    const viewScale = r.width / m.pageW || 1;
    const pageTop = r.top + k * m.stride * viewScale;
    // Instant rather than smooth: smooth scrolling is animation-driven and stalls in background tabs.
    scroller.scrollTop = scroller.scrollTop + pageTop - scroller.getBoundingClientRect().top - 12;
    setCurrent(k);
  };

  if (!paged) {
    return (
      <div className="doc-thumbs doc-thumbs-empty" style={{ width }}>
        <span className="muted">Page thumbnails appear in Pages view (View → Pages).</span>
      </div>
    );
  }
  return (
    <div className="doc-thumbs" role="listbox" aria-label="Pages" style={{ width }}>
      {Array.from({ length: pageCount }, (_, k) => (
        <div key={k} role="option" aria-selected={k === current} className={`doc-thumb${k === current ? ' current' : ''}`} title={`Page ${k + 1}`} onClick={() => goTo(k)}>
          <span className="doc-thumb-num">{k + 1}</span>
          <div className="doc-thumb-pic" style={{ width: Math.round(m.pageW * scale), height: Math.round(m.pageH * scale) }}>
            <div className="doc-thumb-page" style={{ width: m.pageW, height: m.pageH, transform: `scale(${scale})` }}>
              <div
                className="doc-thumb-clip"
                ref={(el) => {
                  clips.current[k] = el;
                }}
              />
              <PageChrome setup={setup} page={k + 1} pages={pageCount} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
