// The headless browser PDFs are printed with, on Workers: Cloudflare's Browser Rendering, driven by its build of
// Playwright, which the Docs object gives this module at start (it holds the binding and the dependency).
export type Browser = any;
export type BrowserContext = any;
export type Page = any;

let launcher: (() => Promise<Browser>) | null = null;
/** Set by the Docs object from its environment: how to launch the browser, or null where there is no binding. */
export const setBrowserLauncher = (launch: (() => Promise<Browser>) | null): void => { launcher = launch; };

export async function launchBrowser(fail: (message: string) => Error): Promise<Browser> {
  if (!launcher) throw fail('PDFs cannot be made here: there is no browser binding.');
  return launcher();
}
