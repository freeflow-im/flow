// The headless browser PDFs are printed with, on Node: Playwright's Chromium (CHROMIUM_PATH, Playwright's own, or the
// machine's Chrome).
import type { Browser } from 'playwright-core';
export type { Browser, BrowserContext, Page } from 'playwright-core';

/** A browser, launched; `fail` makes the error to throw when none can be. */
export async function launchBrowser(fail: (message: string) => Error): Promise<Browser> {
  const { chromium } = await import('playwright-core');
  const path = process.env.CHROMIUM_PATH;
  if (path) return chromium.launch({ executablePath: path });
  try {
    return await chromium.launch();
  } catch {
    try {
      return await chromium.launch({ channel: 'chrome' });
    } catch {
      throw fail('PDFs cannot be made here: no Chromium or Chrome was found (set CHROMIUM_PATH).');
    }
  }
}
