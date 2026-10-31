// Full-screen slideshow. Arrow keys, space and clicks move between slides; N shows the speaker notes
// (not on a public link, whose deck has none); Escape leaves.
import { useEffect, useRef, useState } from 'react';
import { SLIDE_H, SLIDE_W } from '../../../shared/deck.ts';
import type { DeckController } from './controller.ts';
import { SlideView } from './SlideView.tsx';

const NOTES_HEIGHT = 0.28; // share of the window given to the notes panel

export function PresentMode({ ctl, withNotes = true, onExit }: { ctl: Pick<DeckController, 'deck' | 'current' | 'goTo'>; withNotes?: boolean; onExit(): void }) {
  const [index, setIndex] = useState(ctl.current);
  const [notes, setNotes] = useState(false);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const n = ctl.deck.slides.length;
  // The page passes a new onExit each time it draws, and it draws again whenever the deck's state changes.
  // Full screen is entered once and left once, so the effects below must not run again for that.
  const exitRef = useRef(onExit);
  exitRef.current = onExit;
  const indexRef = useRef(index);
  indexRef.current = index;

  useEffect(() => {
    const el = document.querySelector('.present');
    if (el && !document.fullscreenElement) el.requestFullscreen?.().catch(() => {});
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    const onFs = () => {
      if (!document.fullscreenElement) exitRef.current();
    };
    window.addEventListener('resize', onResize);
    document.addEventListener('fullscreenchange', onFs);
    return () => {
      window.removeEventListener('resize', onResize);
      document.removeEventListener('fullscreenchange', onFs);
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') exitRef.current();
      else if (['ArrowRight', 'ArrowDown', ' ', 'PageDown', 'Enter'].includes(e.key)) setIndex((i) => Math.min(n - 1, i + 1));
      else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) setIndex((i) => Math.max(0, i - 1));
      else if (e.key === 'Home') setIndex(0);
      else if (e.key === 'End') setIndex(n - 1);
      else if (withNotes && e.key.toLowerCase() === 'n' && !e.metaKey && !e.ctrlKey) setNotes((v) => !v);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [n, withNotes]);

  // Leave the editor on the slide the show ended on (when the show ends, not at every slide).
  useEffect(() => () => ctl.goTo(indexRef.current), [ctl]);

  const slideArea = notes ? size.h * (1 - NOTES_HEIGHT) : size.h;
  const scale = Math.min(size.w / SLIDE_W, slideArea / SLIDE_H);
  const slide = ctl.deck.slides[Math.min(index, n - 1)];
  const next = ctl.deck.slides[index + 1];
  return (
    <div className={`present${notes ? ' with-notes' : ''}`} onClick={() => setIndex((i) => Math.min(n - 1, i + 1))} role="presentation">
      <div className="present-stage" style={{ height: slideArea }}>
        <SlideView slide={slide} theme={ctl.deck.theme} scale={scale} playVideo />
      </div>
      {notes && (
        <div className="present-notes" style={{ height: size.h - slideArea }} onClick={(e) => e.stopPropagation()}>
          <div className="present-notes-text">{slide.notes?.trim() ? slide.notes : <span className="present-notes-empty">No notes for this slide.</span>}</div>
          <div className="present-next">
            <div className="present-next-label">{next ? `Next: slide ${index + 2}` : 'Last slide'}</div>
            {next && <SlideView slide={next} theme={ctl.deck.theme} scale={Math.min(220 / SLIDE_W, ((size.h - slideArea) * 0.6) / SLIDE_H)} />}
          </div>
        </div>
      )}
      <div className="present-counter">
        {index + 1} / {n}
      </div>
      <div className="present-controls" onClick={(e) => e.stopPropagation()}>
        {withNotes && (
          <button className={`present-notes-btn${notes ? ' active' : ''}`} onClick={() => setNotes(!notes)} title="Speaker notes (N)" aria-pressed={notes}>
            Notes
          </button>
        )}
        <button className="present-exit" onClick={onExit} title="Exit (Esc)" aria-label="Exit presentation">
          ×
        </button>
      </div>
    </div>
  );
}
