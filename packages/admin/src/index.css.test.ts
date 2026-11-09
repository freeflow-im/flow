// The theme's colour tokens must not be named after a font size: Tailwind makes a `text-<name>` colour utility of every
// `--color-<name>`, and `text-base` (the Card titles) is a font size. A `--color-base` once painted every title white.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const FONT_SIZES = ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl'];

describe('index.css', () => {
  it('names no colour token after a font size', () => {
    const css = readFileSync(resolve(__dirname, 'index.css'), 'utf8');
    const tokens = [...css.matchAll(/--color-([a-z0-9-]+)\s*:/g)].map((m) => m[1]!);
    expect(tokens.length).toBeGreaterThan(5);
    expect(tokens.filter((t) => FONT_SIZES.includes(t))).toEqual([]);
  });
});
