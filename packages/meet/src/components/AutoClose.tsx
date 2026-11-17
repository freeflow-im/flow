// After leaving a meeting, the tab closes itself after a short countdown, so meeting tabs do not pile up. A browser only
// lets a page close a tab that a script opened (Meet's "Start a meeting now") or that has nothing else in its history (a
// link opened in a new tab); when it refuses, the tab goes to Meet's home instead, or for a guest, says it can be closed.
import { useEffect, useState } from 'react';

export const AUTO_CLOSE_SECONDS = 30;

/** Inside an app's own window (the desktop app's), closing would close the app: no countdown there. */
const inAppWindow = () => typeof window !== 'undefined' && 'flowDesktop' in window;

export function AutoClose(props: { fallbackUrl: string | null; seconds?: number }) {
  return inAppWindow() ? null : <Countdown {...props} />;
}

function Countdown({ fallbackUrl, seconds = AUTO_CLOSE_SECONDS }: { fallbackUrl: string | null; seconds?: number }) {
  const [left, setLeft] = useState(seconds);
  const [kept, setKept] = useState(false);
  const [closeFailed, setCloseFailed] = useState(false);

  useEffect(() => {
    if (kept || closeFailed) return;
    if (left <= 0) {
      window.close();
      // Still here a moment later: the browser would not close this tab.
      const t = window.setTimeout(() => {
        if (fallbackUrl) window.location.assign(fallbackUrl);
        else setCloseFailed(true);
      }, 300);
      return () => window.clearTimeout(t);
    }
    const t = window.setTimeout(() => setLeft((n) => n - 1), 1000);
    return () => window.clearTimeout(t);
  }, [left, kept, closeFailed, fallbackUrl]);

  if (closeFailed) return <p className="m-0 text-sm text-[#9aa0a6]">You can close this tab.</p>;
  if (kept) return null;
  return (
    <p className="m-0 text-sm text-[#9aa0a6]" aria-live="off">
      This tab closes in {left} s ·{' '}
      <button type="button" onClick={() => setKept(true)} className="cursor-pointer border-0 bg-transparent p-0 text-sm text-[#8ab4f8] hover:underline">
        Keep it open
      </button>
    </p>
  );
}
