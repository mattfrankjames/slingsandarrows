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
likely to break.

`e2e.yml` derives the preview URL from the PR number and polls until it
answers, rather than reacting to a deployment event. Two reasons, both learned
the hard way:

- Netlify announces previews on this repo with a **commit status**, not a
  GitHub Deployment. The deployments API returns nothing, so a workflow
  triggered `on: deployment_status` never fires at all.
- `status` and `deployment_status` workflows only run from the copy of the file
  on the **default branch**, so a change to one cannot be tested in the pull
  request that makes it.

Polling has neither problem, at the cost of a job that waits.

## ⚠️ Branch protection is the actual gate

**This needs one manual step, and without it none of the above stops anything.**

Netlify deploys on every push to `main`. A suite that only runs on pull
requests protects nothing if you can merge — or push — regardless of the result.

In **Settings → Branches → Add branch ruleset** for `main`:

- Require a pull request before merging
- Require status checks to pass → add **`Lint, types, unit tests`**
- Require branches to be up to date before merging

Repository settings are yours to change; nothing in this repo can set them.

Require **`Lint, types, unit tests`** — it is fast and needs nothing deployed.
Adding the browser job as well is reasonable once it has run a few times; it
depends on Netlify finishing a build, so it is slower and has one more thing
that can be flaky.

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

Screenshot diffs are the safety net for Phase 3, which rebuilds every page shell
and moves ~83 KB of inline CSS. Baselines for all seven pages, desktop and
mobile, are committed under `tests/browser/__screenshots__/`.

They are **not** part of the default run — an absent baseline would fail CI with
a file it had just written — so run them deliberately:

```bash
BASE_URL=https://deploy-preview-99--slingsandarrows.netlify.app npm run test:visual
```

Every diff should be either identical or an intentional, reviewed change. To
accept a batch of intentional changes, re-run with `-- --update-snapshots` and
**look at the resulting images in the diff** before committing them.

### Why they are stable

Four sources of false positives are handled. Resist lowering the threshold when
something fails — it is far more likely to be a real change:

- **Content** — the read endpoints are stubbed with fixtures
  (`tests/browser/fixtures.js`), so post cards, thread cards and gallery tiles
  render from fixed data. Without this a new post changes every baseline.
- **Animation** — the glitch and static loops run indefinitely, so every frame
  differs. Handled by `reducedMotion: 'reduce'` plus `animations: 'disabled'`.
- **Fonts** — Typekit faces land after first paint. Handled by awaiting
  `document.fonts.ready` before capture.
- **The hero photograph** — flattened to a flat colour by
  `tests/browser/screenshot.css`. It is the background of `.wrapper` on every
  page, so leaving it in made the baselines 6 MB while being the one thing least
  likely to change. Contrast against the real background is axe's job.

### Two mistakes worth not repeating

Both were made while setting these up:

- **Masking the content containers instead of stubbing them.** The feed baseline
  came out as a single pink rectangle — every post card hidden, so the refactor
  the baselines exist to protect could have broken all of them without a single
  test failing. A baseline that cannot fail is worse than no baseline.
- **Omitting `{projectName}` from `snapshotPathTemplate`.** The desktop and
  mobile projects wrote to the same filenames and the second silently
  overwrote the first, leaving seven files for fourteen tests.

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
