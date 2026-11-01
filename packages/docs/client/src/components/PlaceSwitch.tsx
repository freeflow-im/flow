// Local | Web, beside the logo in the desktop app (MCP Docs; docs/web-and-pdf.md): which kind of tab this is (a
// folder on this computer, or the person's files on the web) and a switch to the other. The other side is an
// mcpdocs:// link, which desktop/main.js catches before it loads: the hosted page gets nothing of the app's to
// call. Shown only in the app, which marks its pages' user agent.
import { useAuth } from '../auth.tsx';

/** This page is in the desktop app, in a Local or a Web tab. */
export const inDesktopApp = (): boolean => typeof navigator !== 'undefined' && navigator.userAgent.includes('MCPDocs/');

export function PlaceSwitch() {
  const { loading, local } = useAuth();
  if (!inDesktopApp() || loading) return null;
  const web = !local;
  return (
    <span className="place-switch" role="group" aria-label="Local or web files">
      {web ? (
        <a href="mcpdocs://switch?to=local" title="Go to the folders on this computer">
          Local
        </a>
      ) : (
        <span className="active" aria-current="page">
          Local
        </span>
      )}
      {web ? (
        <span className="active" aria-current="page">
          Web
        </span>
      ) : (
        <a href="mcpdocs://switch?to=web" title="Go to your files on the web">
          Web
        </a>
      )}
    </span>
  );
}
