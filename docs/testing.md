# Testing and CI

## Commands

```bash
npm run verify        # lint + typecheck + unit tests — run this before pushing
npm run lint          # ESLint
npm run typecheck     # tsc --checkJs over the shared libraries
npm test              # Vitest, 93 unit tests, no network
npm run test:watch    # Vitest in watch mode
npm run test:browser  # Playwright — needs a running site, see below
```

Browser tests need somewhere to point:

```bash
BASE_URL=https://slingsandarrows.band npm run test:browser
BASE_URL=https://deploy-preview-99--slingsandarrows.netlify.app npm run test:browser
```

## What runs where

| Layer | Tool | Where | When |
|---|---|---|---|
| Lint | ESLint | GitHub Actions | every push and PR |
| Types | `tsc --checkJs` | GitHub Actions | every push and PR |
| Unit | Vitest | GitHub Actions | every push and PR |
| Build + bundle audit | Parcel + grep | GitHub Actions | every push and PR |
| Smoke, routing, API contract, a11y | Playwright + axe | Netlify Deploy Preview | when a preview finishes |
| Performance budget | Lighthouse CI | Netlify Deploy Preview | when a preview finishes |
| Visual diffs | Playwright | on request | see below |

### Why browser tests run against a Deploy Preview

The clean-URL rewrites, the RSS routes, the cache headers and the functions all
live in `netlify.toml`. None of them exist in front of `parcel serve`, so a
suite that passed against localhost would have no opinion about the parts most
likely to break. `.github/workflows/e2e.yml` waits for Netlify's deployment
notification rather than guessing a URL or racing the build.

## ⚠️ Branch protection is the actual gate

**This needs one manual step, and without it none of the above stops anything.**

Netlify deploys on every push to `main`. A suite that only runs on pull
requests protects nothing if you can merge — or push — regardless of the result.

In **Settings → Branches → Add branch ruleset** for `main`:

- Require a pull request before merging
- Require status checks to pass → add **`Lint, types, unit tests`**
- Require branches to be up to date before merging

Repository settings are yours to change; nothing in this repo can set them.

## The rules ESLint enforces

Four of them encode invariants this codebase has already broken at least once.
They exist because a code review missed each one:

| Rule | Prevents |
|---|---|
| No interpolated `innerHTML` | User content becoming markup. Assigning a literal (`el.innerHTML = ''`) is still fine. |
| No `localStorage` outside `lib/session.js` | Six modules read `gotrue.user` directly; two forgot to check `expires_at`. |
| No `upload_preset` or `process.env.CLOUDINARY*` in `src/` | PR #86 moved the composer to a new file and carried the unsigned preset with it, reintroducing the leak #87 had just fixed. |
| No `@netlify/blobs` import in a function | A direct `list()` + `get()` loop reads the whole store on every request. Go through `lib/store.mjs`. |
| No `clientContext` in a function | Twelve functions each had a JWT decoder that never checked a signature. Identity lives in `lib/auth.mjs`. |

To break one deliberately, add an `eslint-disable-next-line` **with a reason**.

## Type checking

`jsconfig.json` runs `tsc --checkJs` over `netlify/lib/` and `src/js/lib/`
only. Files stay `.js`/`.mjs` and run unmodified in a browser — there is no
build step and no syntax to learn beyond JSDoc comments.

It is scoped to the shared libraries on purpose: they are what everything else
depends on, and they already carry JSDoc. Widen `include` as annotations spread
outward. Turning it on repo-wide today would produce a wall of errors nobody
would read, which is the same as having it off.

`types/globals.d.ts` declares the Netlify Identity widget, which arrives via a
`<script>` tag and is otherwise invisible to the checker.

## Visual baselines

Screenshot diffs are the safety net for Phase 3, which rebuilds every page
shell and moves ~83 KB of inline CSS. They are **not** part of the default run —
an absent baseline would fail CI with a file it had just written.

Capture them once, immediately before starting Phase 3, from a deployment that
reflects current `main`:

```bash
BASE_URL=https://slingsandarrows.band npm run test:visual -- --update-snapshots
git add tests/browser/__screenshots__ && git commit -m "test: capture visual baselines"
```

Then during Phase 3, `npm run test:visual` against that branch's preview. Every
diff should be either identical or an intentional, reviewed change.

Three sources of false positives are already handled, so resist lowering the
threshold when something fails:

- **Animation** — the glitch and static loops run indefinitely, so every frame
  differs. Handled by `reducedMotion: 'reduce'` plus `animations: 'disabled'`.
- **Fonts** — Typekit faces land after first paint. Handled by awaiting
  `document.fonts.ready` before capture.
- **Live content and remote media** — a new post would otherwise "fail" the
  feed. Handled by masking the content regions and Cloudinary images.

## What is not covered

- **Signed-in journeys.** Posting, commenting, liking, uploading and deleting
  all need a real Identity session. That needs a test account whose credentials
  live in Actions secrets; until then the API spec covers reads and the
  rejection paths only, and signed-in flows are checked by hand on the preview.
- **The studio** beyond its tab strip. Web Audio does not produce output that
  is meaningful to assert on in a headless browser.
- **Forks.** Pull requests from forks cannot read repository secrets, so any
  credentialed suite added later will not run on them. Split the workflow when
  that day comes: lint, types and unit tests for everyone, credentialed suites
  on branches you control.

## Formatting

Prettier is available (`npm run format <path>`) but **not enforced**. Running it
across the repo would reformat 36 of 43 files and flatten the aligned
assignments used throughout — a large diff that fights the house style and
buries real changes. `eslint-config-prettier` is loaded so the two never
disagree if you do run it on a file.
