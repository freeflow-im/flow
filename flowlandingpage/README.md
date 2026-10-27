# Freeflow — landing site

Marketing site for [Freeflow](https://github.com/freeflow-im/flow) — open-source,
free-forever team chat you run yourself.

## Run it

```bash
pnpm install --ignore-workspace
pnpm dev
```

The `--ignore-workspace` flag matters: this site is standalone, not part of the
repo's pnpm workspace, and the flag is what keeps `pnpm-lock.yaml` local. That
lockfile is the one the deploy installs from — use pnpm, not npm, so it stays
in step with `package.json`.

Open <http://localhost:3000>.

Other scripts: `pnpm build`, `pnpm start`, `pnpm typecheck`.

## Stack

Next.js 15 (App Router) · React 19 · TypeScript · Tailwind CSS v4.

No component library, no icon package, no animation library — icons are inline
SVG in `components/icons.tsx` and motion is CSS plus one IntersectionObserver
hook. The dependencies are Next, React, and three self-hosted font packages.

## Change the links

Every outbound URL lives in **`site.config.ts`**. Swap the placeholder repo,
Discord invite, and X handle there and the whole site updates — nav, footer,
every CTA, every doc link.

```ts
export const links = {
  github: "https://github.com/YOUR-ORG/YOUR-REPO",
  discord: "https://discord.gg/YOUR-INVITE",
  // …
};
```

## Change the copy

| What | Where |
|---|---|
| Headlines, hero, section intros | `components/sections/*.tsx` |
| Feature lists, FAQ, comparison table, non-goals | `lib/content.ts` |
| Code samples in the Agents and Migration panels | `lib/snippets.ts` |
| Colours, type, radii, motion | `app/globals.css` (`@theme` block) |
| Nav items | `components/nav.tsx` |
| Footer columns | `components/footer.tsx` |

## Routes

```
/            full landing page — 12 sections
/agents      building custom coding agents
/migrate     Slack & Discord migration
/self-host   requirements, commands, operations
```

## Design notes

- **Light canvas, one accent.** Indigo (`--color-accent`) marks anything
  clickable, emerald (`--color-free`) is reserved for open-source and
  free-forever signals, amber (`--color-warn`) for honest limitations. The
  colour language teaches itself in one scroll.
- **One italic serif word per headline.** Instrument Serif against Inter — the
  site's signature, applied with the `serif-accent` utility.
- **Section rhythm** alternates paper → mist → paper → dark so no two adjacent
  bands share a background. The two dark bands land on Agents and the final CTA.
- **No fabricated proof.** There are no invented testimonials, logos, or user
  counts anywhere on this site. Credibility comes from specifics — named
  algorithms, exact method counts, a public changelog, and a stated non-goals
  list.

`PLAN.md` has the full reasoning: ICP, message hierarchy, section-by-section
intent, and the copy anchors.

## Assets to add before launch

- `app/opengraph-image.png` (1200×630) — Open Graph card
- `app/icon.png` and `app/apple-icon.png` — favicons
- Set the real domain in `site.config.ts` → `site.url`

Next.js picks the first three up automatically from the `app/` directory.
