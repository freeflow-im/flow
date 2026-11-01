// The front page drawn when the app is built (scripts/prerender-landing.ts), so that a visitor, and a crawler or agent
// that does not run scripts, gets its text in the HTML; the app then draws it again over the same markup (main.tsx).
// It is wrapped as AppShell wraps it, so the styles apply as they do in the app.
import { renderToString } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { ORIGIN_MARK } from '../../shared/brand.ts';
import { LandingPage } from './pages/LandingPage.tsx';

export { ORIGIN_MARK };

export function renderLanding(): string {
  return renderToString(
    <div className="app-shell">
      <div className="app-main">
        <StaticRouter location="/">
          <LandingPage origin={ORIGIN_MARK} />
        </StaticRouter>
      </div>
    </div>,
  );
}
