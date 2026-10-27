# Freeflow — home page

The page at <https://freeflow.im>. It lists every Freeflow tool and links out
to each one. The Flow page itself is in `../flowlandingpage/`
(<https://flow.freeflow.im>).

## Run it

```bash
pnpm install --ignore-workspace
pnpm dev
```

Use `--ignore-workspace`: this site is not part of the repo's pnpm workspace,
and the flag keeps `pnpm-lock.yaml` local. The deploy installs from that file.

Other scripts: `pnpm build` (static export to `out/`), `pnpm typecheck`.

## Change the content

| What | Where |
|---|---|
| The tools, their copy and links | `site.config.ts` |
| Hero, section headings, "How we build" | `app/page.tsx` |
| Tool card layout | `components/tool-card.tsx` |
| Old paths sent to flow.freeflow.im | `public/_redirects` |

`app/globals.css`, `components/ui.tsx`, `components/icons.tsx` and
`components/reveal.tsx` are copied from `flowlandingpage/` so the two sites
look the same. Change them in both places.

Deploys on merge to `main` — see BUILD.md.
