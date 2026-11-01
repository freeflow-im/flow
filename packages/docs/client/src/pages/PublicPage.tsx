// What a public link shows (/p/<token>, server/publicLinks.ts): a video's player or a presentation to step through
// and present, read-only, for anyone, signed in or not.
import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { SLIDE_H, SLIDE_W, type Deck } from '../../../shared/deck.ts';
import { api, type PublicView } from '../api.ts';
import { HomeIcon } from '../components/Logo.tsx';
import { useDeckFonts } from '../deck/fonts.ts';
import { PresentMode } from '../deck/PresentMode.tsx';
import { SlideView } from '../deck/SlideView.tsx';
import { useFavicon } from '../favicon.ts';

// Room around the slide: the page's header and the bar under the slide, and the margins.
const CHROME_H = 136;
const MARGIN_W = 32;

function PublicDeck({ deck }: { deck: Deck }) {
  useDeckFonts(deck);
  const [index, setIndex] = useState(0);
  const [presenting, setPresenting] = useState(false);
  const [size, setSize] = useState({ w: window.innerWidth, h: window.innerHeight });
  const n = deck.slides.length;

  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    if (presenting) return;
    const onKey = (e: KeyboardEvent) => {
      if (['ArrowRight', 'ArrowDown', 'PageDown'].includes(e.key)) setIndex((i) => Math.min(n - 1, i + 1));
      else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) setIndex((i) => Math.max(0, i - 1));
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [n, presenting]);

  if (!n) return <div className="public-message">This presentation has no slides.</div>;
  const scale = Math.max(0.1, Math.min((size.w - MARGIN_W) / SLIDE_W, (size.h - CHROME_H) / SLIDE_H));
  return (
    <>
      <div className="public-stage">
        <SlideView key={index} slide={deck.slides[index]} theme={deck.theme} scale={scale} playVideo />
      </div>
      <div className="public-bar">
        <button className="btn" disabled={index === 0} onClick={() => setIndex(index - 1)} aria-label="Previous slide">
          ‹
        </button>
        <span className="public-counter">
          {index + 1} / {n}
        </span>
        <button className="btn" disabled={index === n - 1} onClick={() => setIndex(index + 1)} aria-label="Next slide">
          ›
        </button>
        <button className="btn primary" onClick={() => setPresenting(true)}>
          Present
        </button>
      </div>
      {presenting && <PresentMode ctl={{ deck, current: index, goTo: setIndex }} withNotes={false} onExit={() => setPresenting(false)} />}
    </>
  );
}

export function PublicPage() {
  const { token = '' } = useParams();
  useFavicon('home');
  const [view, setView] = useState<PublicView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    api.publicView(token).then(
      (v) => {
        if (!current) return;
        setView(v);
        document.title = v.title;
      },
      (e: Error) => current && setError(e.message),
    );
    return () => {
      current = false;
    };
  }, [token]);

  return (
    <div className="public-page">
      <header className="public-header">
        <a href="/" aria-label="Home">
          <HomeIcon size={24} />
        </a>
        <span className="public-title">{view?.title}</span>
        <span className="public-badge">View only</span>
      </header>
      <main className="public-body">
        {error ? (
          <div className="public-message">{error}</div>
        ) : !view ? (
          <div className="public-message">Loading…</div>
        ) : view.kind === 'deck' ? (
          <PublicDeck deck={view.deck} />
        ) : (
          <video className="public-video" src={view.url} controls playsInline />
        )}
      </main>
    </div>
  );
}
