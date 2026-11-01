// A stored web page (an .html file, such as something ChatGPT generated) shown as a page. The file is someone
// else's code, so it never runs as part of the app: its text is fetched and handed to a frame that is sandboxed
// without "allow-same-origin", which gives it an origin of its own. Its scripts run, but they cannot read the
// app's cookies or storage, call its API as the user, or navigate the window around it.
import { useEffect, useState } from 'react';

/** Pages larger than this are not shown (they are still stored and can be downloaded). */
const MAX_HTML_CHARS = 10_000_000;

export function HtmlPreview({ url, title, credentials = 'same-origin' }: { url: string; title: string; credentials?: RequestCredentials }) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    setHtml(null);
    setError(null);
    fetch(url, { credentials })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Could not read the file (${res.status})`);
        const text = await res.text();
        if (text.length > MAX_HTML_CHARS) throw new Error('This page is too large to show here.');
        if (!stop) setHtml(text);
      })
      .catch((e: Error) => !stop && setError(e.message));
    return () => {
      stop = true;
    };
  }, [url, credentials]);

  if (error) return <div className="form-error">{error}</div>;
  if (html === null) return <div className="muted">Loading…</div>;
  return <iframe className="file-preview html-preview" title={title} sandbox="allow-scripts allow-popups allow-forms allow-modals" referrerPolicy="no-referrer" srcDoc={html} />;
}
