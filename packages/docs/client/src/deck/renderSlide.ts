// Takes a picture of a slide for the assistant's render_slide tool. The slide is drawn by the same SlideView the
// editor and present mode use, offscreen in this page (so the deck's web fonts and the app's CSS apply), then
// rasterized through an SVG <foreignObject> with the CSS, fonts and images inlined. The text layout is measured in
// the live DOM to report text that overflows its box.
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { SLIDE_H, SLIDE_W, type Slide, type ThemeId } from '../../../shared/deck.ts';
import { ensureFonts } from './fonts.ts';
import { SlideView } from './SlideView.tsx';

export interface OverflowItem {
  id: string;
  type: 'text' | 'shape' | 'table';
  /** The element's box and the size of its rendered text, in slide points. */
  box_w: number;
  box_h: number;
  text_w: number;
  text_h: number;
}

export interface SlideRender {
  blob: Blob;
  width: number;
  height: number;
  overflow: OverflowItem[];
  /** Image elements whose picture could not be loaded into the render (e.g. hosts that block other sites). */
  missingImages: string[];
}

/** Padding around a shape label (styles.css, .sl-shape > span). */
const LABEL_PAD = 8;

export async function renderSlideImage(slide: Slide, theme: ThemeId, scale: number): Promise<SlideRender> {
  const fonts = new Set<string>();
  for (const e of slide.elements) {
    if (e.type === 'text') {
      if (e.style?.font) fonts.add(e.style.font);
      for (const p of e.paragraphs) if (p.font) fonts.add(p.font);
    } else if (e.type === 'shape' && e.textFont) fonts.add(e.textFont);
  }
  ensureFonts([...fonts]);
  await stylesheetsLoaded();

  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:fixed;left:-100000px;top:0;pointer-events:none;';
  document.body.appendChild(host);
  const root = createRoot(host);
  try {
    flushSync(() => root.render(createElement(SlideView, { slide, theme, scale })));
    void host.offsetHeight; // lay out, so the fonts the slide uses start loading
    await document.fonts.ready;
    const overflow = measureOverflow(host, slide);
    const width = Math.round(SLIDE_W * scale);
    const height = Math.round(SLIDE_H * scale);
    const clone = host.firstElementChild!.cloneNode(true) as HTMLElement;
    const missingImages = await inlineImages(clone, slide);
    const wrap = document.createElement('div');
    const style = document.createElement('style');
    style.textContent = `${pageCss()}\n${await fontFaceCss(usedFamilies(host), host.textContent ?? '')}`;
    wrap.append(style, clone);
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<foreignObject x="0" y="0" width="${width}" height="${height}">${new XMLSerializer().serializeToString(wrap)}</foreignObject></svg>`;
    const blob = await rasterize(svg, width, height);
    return { blob, width, height, overflow, missingImages };
  } finally {
    root.unmount();
    host.remove();
  }
}

/** Text boxes, shape labels and tables whose rendered text is larger than their box (1 point of tolerance). */
export function measureOverflow(host: HTMLElement, slide: Slide): OverflowItem[] {
  const out: OverflowItem[] = [];
  for (const node of Array.from(host.querySelectorAll<HTMLElement>('[data-el]'))) {
    const el = slide.elements.find((e) => e.id === node.dataset.el);
    if (!el || el.type === 'image' || el.type === 'video' || el.type === 'line' || el.type === 'chart') continue;
    let textW = 0;
    let textH = 0;
    if (el.type === 'text') {
      const ps = Array.from(node.children) as HTMLElement[];
      if (!ps.length) continue;
      const first = ps[0];
      const last = ps[ps.length - 1];
      textH = last.offsetTop + last.offsetHeight - first.offsetTop;
      textW = Math.max(...ps.map((p) => p.scrollWidth));
    } else if (el.type === 'table') {
      // A table grows taller than its box when a row has more text than its share of the height.
      const grid = node.querySelector<HTMLElement>('table');
      if (!grid) continue;
      textW = grid.offsetWidth;
      textH = grid.offsetHeight;
    } else {
      const label = node.querySelector<HTMLElement>(':scope > span');
      if (!label || !el.text) continue;
      textW = label.offsetWidth - 2 * LABEL_PAD;
      textH = label.offsetHeight - 2 * LABEL_PAD;
    }
    if (textH > el.h + 1 || textW > el.w + 1) {
      out.push({ id: el.id, type: el.type, box_w: el.w, box_h: el.h, text_w: Math.round(textW), text_h: Math.round(textH) });
    }
  }
  return out;
}

/** Wait (briefly) for stylesheets still loading, such as a Google Fonts link ensureFonts just added. */
async function stylesheetsLoaded(): Promise<void> {
  const pending = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')).filter((l) => !l.sheet);
  if (!pending.length) return;
  const loaded = Promise.all(pending.map((l) => new Promise<void>((resolve) => ['load', 'error'].forEach((ev) => l.addEventListener(ev, () => resolve(), { once: true })))));
  await Promise.race([loaded, new Promise((r) => setTimeout(r, 5000))]);
}

/** The app's own CSS (same-origin stylesheets), so the slide classes style the copy like the original. */
function pageCss(): string {
  const parts: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) if (!(rule instanceof CSSFontFaceRule)) parts.push(rule.cssText);
    } catch {
      // Cross-origin (Google Fonts): its @font-face rules are fetched by fontFaceCss.
    }
  }
  return parts.join('\n');
}

/** Font families the rendered slide uses, lowercased and unquoted. */
function usedFamilies(host: HTMLElement): Set<string> {
  const out = new Set<string>();
  for (const node of [host, ...Array.from(host.querySelectorAll('*'))]) {
    for (const f of getComputedStyle(node).fontFamily.split(',')) out.add(f.trim().replace(/^["']|["']$/g, '').toLowerCase());
  }
  return out;
}

const dataUrls = new Map<string, Promise<string | null>>();

/** A resource as a data: URL (cached), or null if it can't be fetched from this page. */
function toDataUrl(url: string): Promise<string | null> {
  if (url.startsWith('data:')) return Promise.resolve(url);
  let p = dataUrls.get(url);
  if (!p) {
    p = (async () => {
      try {
        const res = await fetch(url, { credentials: new URL(url, location.href).origin === location.origin ? 'same-origin' : 'omit' });
        if (!res.ok) return null;
        const blob = await res.blob();
        return await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = () => reject(r.error);
          r.readAsDataURL(blob);
        });
      } catch {
        return null;
      }
    })();
    dataUrls.set(url, p);
    void p.then((v) => v === null && dataUrls.delete(url));
  }
  return p;
}

const LATIN = /U\+0+-0*FF\b/i;

/**
 * @font-face rules for the families the slide uses, with their font files inlined (an SVG image can't load
 * anything itself). Google Fonts splits a family into unicode ranges; only the Latin ones are kept unless the
 * slide has other characters.
 */
async function fontFaceCss(families: Set<string>, text: string): Promise<string> {
  const rules: { css: string; base: string }[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    const base = sheet.href ?? location.href;
    try {
      for (const rule of Array.from(sheet.cssRules)) if (rule instanceof CSSFontFaceRule) rules.push({ css: rule.cssText, base });
    } catch {
      if (!sheet.href) continue;
      try {
        const res = await fetch(sheet.href);
        const css = res.ok ? await res.text() : '';
        for (const m of css.match(/@font-face\s*{[^}]*}/g) ?? []) rules.push({ css: m, base });
      } catch {
        // Unreachable font host: the render falls back like the page would.
      }
    }
  }
  const allRanges = /[^\u0000-ÿ]/.test(text);
  const out = await Promise.all(
    rules.map(async ({ css, base }) => {
      const family = /font-family:\s*([^;]+);/i.exec(css)?.[1].trim().replace(/^["']|["']$/g, '').toLowerCase();
      if (!family || !families.has(family)) return '';
      const range = /unicode-range:\s*([^;]+);/i.exec(css)?.[1];
      if (range && !allRanges && !LATIN.test(range)) return '';
      let result = css;
      for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
        const data = await toDataUrl(new URL(m[1], base).href);
        if (!data) return '';
        result = result.replace(m[0], `url("${data}")`);
      }
      return result;
    }),
  );
  return out.filter(Boolean).join('\n');
}

/** Point the copy's images at data: URLs; returns the ids of image elements that could not be loaded. */
async function inlineImages(clone: HTMLElement, slide: Slide): Promise<string[]> {
  const missing: string[] = [];
  await Promise.all(
    Array.from(clone.querySelectorAll<HTMLImageElement>('[data-el] img')).map(async (img) => {
      const id = img.closest<HTMLElement>('[data-el]')?.dataset.el ?? '';
      const el = slide.elements.find((e) => e.id === id);
      // A video's still is YouTube's: drawn when it can be fetched, and not a missing picture when it cannot.
      const data = el?.type === 'image' ? await toDataUrl(new URL(el.src, location.href).href) : el?.type === 'video' ? await toDataUrl(img.src).catch(() => null) : null;
      if (data) img.setAttribute('src', data);
      else {
        img.removeAttribute('src');
        if (el?.type !== 'video') missing.push(id);
      }
    }),
  );
  return missing;
}

async function rasterize(svg: string, width: number, height: number): Promise<Blob> {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The slide could not be encoded as PNG.'))), 'image/png'));
}
