# pcskit website

Landing page and documentation for PCS, built with Next.js (App Router) and Nextra. It lives in its own package inside the pcskit repo and does not affect the CLI.

## Develop

Requires Node 22.13 or newer.

```
cd website
npm ci
npm run dev          # http://localhost:3000
```

| Script | Purpose |
| --- | --- |
| `npm run dev` | Dev server |
| `npm run build` | Production build, then the Pagefind search index (`postbuild`) |
| `npm run lint` | Biome lint, warnings fail |
| `npm run format:check` / `npm run format` | Biome formatting |
| `npm run typecheck` | Route types and `tsc --noEmit` |

CI (`.github/workflows/website.yml`) runs lint, format check, typecheck, build and `npm audit` for changes under `website/`.

## Structure

```
app/(marketing)/   landing page (/), its layout and styles
app/docs/          Nextra docs layout and catch-all page (/docs/...)
components/        marketing sections, motion helpers, brand
content/           docs pages (MDX) and _meta.js sidebar order
lib/               site constants, demo media, structured data
patches/           patch-package patches applied on install
```

- **Add a docs page:** create `content/<section>/<page>.mdx` with `title` and `description` frontmatter (quote a description that contains a colon), and add it to that folder's `_meta.js`. It joins the sidebar, sitemap and search automatically.
- **Site constants** (version, install command, links) are in `lib/site.ts`. Bump `version` on release.
- **Colours:** the evidence levels (`--verified`, `--reported`, `--inferred`) are defined in `app/globals.css` and used by both the landing page and the docs.
- **Motion:** use `m.*` components from `motion/react` inside `MotionProvider` (reduced-motion is respected). Do not use `motion.*`.

## Add the demo video later

The "See it in action" section is built but hidden. Put the recording in `public/` (for example `public/demo.mp4`) and a poster image next to it, then set both paths in `lib/media.ts`. Nothing else changes.

## Deploy on Vercel

1. Import `KNIHAL/pcskit` in Vercel.
2. Set **Root Directory** to `website`. The framework is detected as Next.js, and `vercel.json` sets the install and build commands.
3. Optional: set `NEXT_PUBLIC_SITE_URL` (for example `https://your-domain.com`) once a custom domain exists. It feeds canonical URLs, the sitemap and Open Graph tags. Without it, the Vercel production URL is used.

## Notes

- `patches/nextra-theme-docs+4.6.1.patch` makes the docs Layout's `children` optional. Nextra 4.6.1 validates its props with `children` removed, which fails under zod 4.6 (`expected nonoptional`). Delete the patch and the `postinstall` script once Nextra fixes it. Dependabot bumping `nextra-theme-docs` will make `patch-package` complain, which is the signal to re-check.
- The tamper-evident demo on the landing page uses real SHA-256 in the browser with a simplified hash input. The real algorithm is documented under Concepts, Event log and integrity.
- Decisions and changelog pages are condensed copies. The repo's `docs/DECISIONS.md` and `CHANGELOG.md` are the source of truth.
