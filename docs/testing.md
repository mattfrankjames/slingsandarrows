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

## Branch protection is the actual gate

Netlify deploys on every push to `main`. A suite that only runs on pull
requests protects nothing if you can merge — or push — regardless of the
result. This is set up, as the **Main Gate** ruleset:

- a pull request is required, with zero approvals
- `main` cannot be deleted or force-pushed
- two checks must pass: **`Lint, types, unit tests`** and **`Smoke, routing,
  API contract, accessibility`**

Two things it does not cover:

- **`Performance budget` is not required.** A Lighthouse regression reports and
  does not block. It depends on a Netlify build and on runner timing, which is
  a fair reason to keep it advisory.
- **Branches need not be up to date with `main`.**
  `strict_required_status_checks_policy` is off, so a pull request can be green
  against a base that has since moved. Two branches can each pass alone and
  still break `main` together.

Repository settings are yours to change; nothing in this repo can set them. To
read what is actually in force — including after someone edits it in the UI:

```bash
gh api repos/mattfrankjames/slingsandarrows/rules/branches/main
```

Not `branches/main/protection`. That endpoint only knows the older per-branch
protection and answers `404 Branch not protected` while a ruleset is active and
enforcing — which is how `refactor-status.md` spent a day recording that `main`
was unprotected when it had been protected the whole time.

A required check is matched by the job's `name:`, verbatim. A near-miss fails
silently in whichever direction hurts — the ruleset waits on a check that never
reports, or ignores the one that does — so compare the API output against
`gh pr checks <n>` on a real pull request.

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
and moves ~83 KB of inline CSS. Thirty baselines are committed under
`tests/browser/__screenshots__/` — seven public pages plus eight interaction
states, each at desktop and mobile.

The interaction states (`visual-authed.spec.js`) matter most, because none of
them render on a plain page load:

- the composer at `/app`, and its link-insert panel;
- the feed's composer dialog, the gallery upload modal, the board's new-thread
  modal;
- **both lightboxes** — the gallery's own viewer, with previous/next and a
  counter, and the shared one in `lightbox.js` used by feed posts and board
  media, plus a paged state to cover navigation.

The lightboxes and the three modals are all hand-rolled
`<div role="dialog" aria-modal="true">` overlays that Phase 3 replaces with
native `<dialog>` (finding F-12). Their layout should survive that swap
unchanged, which is precisely what these baselines are for.

Signed out, the composer surfaces do not render at all, so a baseline taken
without a session captures a sign-in prompt and protects nothing. `signIn()` seeds the same localStorage record the sign-in modal
writes; it is a fixture, not a credential, and every write it might attempt is
stubbed.

They run in CI on every pull request, alongside the rest of the browser suite.
To run just them:

```bash
BASE_URL=https://deploy-preview-99--slingsandarrows.netlify.app npm run test:visual
```

### Baselines are captured on the runners, not on a laptop

Text rasterises differently on macOS and on the Linux runners — enough that a
set captured on a laptop fails in CI for reasons that have nothing to do with
the change under review. Only **`linux/`** is committed, and it is the set that
gates a merge.

`snapshotPathTemplate` still keys on `{platform}`, so running the visual specs
on a Mac writes a `darwin/` set rather than overwriting CI's. Those files are
throwaway: they are captured against whatever preview you pointed at, they gate
nothing, and they should not be committed. Delete them, or ignore them — but do
not treat a local green as CI having agreed.

To bootstrap a platform that has no baselines, let the browser job run once: a
missing baseline is written by Playwright and still fails the test, and the job
uploads the screenshot directory, so the red run produces exactly the files to
commit.

For an intentional visual change, run the **Update visual baselines** workflow,
then download and commit what it produces:

```bash
gh workflow run update-baselines.yml -f preview_url=<a preview URL>
gh run download <run-id> -n visual-baselines
```

Review the images before committing them. The CI job deliberately has no
`--update-snapshots`: a suite that rewrites its own expectations cannot fail.

The update workflow passes `--update-snapshots=all`, not the bare flag. The
default mode is `changed`, which rewrites only baselines whose comparison
already failed — so a change under `maxDiffPixelRatio` updates nothing and the
job still reports success.

Every diff should be either identical or an intentional, reviewed change. To
accept a batch of intentional changes, re-run with `-- --update-snapshots=all`
and **look at the resulting images in the diff** before committing them. The
`=all` matters for the same reason it does in the workflow: the default mode
leaves anything under the threshold untouched and still exits green.

### Why they are stable

Four sources of false positives are handled. Resist *raising* the threshold when
something fails — a failure is far more likely to be a real change, and the
number has already been too generous once: at 0.02 it absorbed the entire page
background changing. It is 0.005.

- **Content** — the read endpoints are stubbed with fixtures
  (`tests/browser/fixtures.js`), so post cards, thread cards and gallery tiles
  render from fixed data. Without this a new post changes every baseline.
- **Media** — Cloudinary requests are answered with a fixed SVG placeholder, so
  aspect ratio, `object-fit` and the tile grid stay under test. Matched by
  hostname rather than a URL glob, because the same image is requested at
  several transformation paths and `srcset` candidates.
- **The service worker** — blocked in the visual specs only
  (`test.use({ serviceWorkers: 'block' })`). See below.
- **Animation** — the glitch and static loops run indefinitely, so every frame
  differs. Handled by `reducedMotion: 'reduce'` plus `animations: 'disabled'`.
- **Fonts** — Typekit faces land after first paint. Handled by awaiting
  `document.fonts.ready` before capture.
- **The hero photograph** — replaced, not removed, by
  `tests/browser/screenshot.css`: a local SVG that scales under
  `background-size: cover` exactly as a photograph does. Leaving the real image
  in would tie every baseline to Cloudinary re-encoding; taking it out
  altogether hides more than it saves (see below).

### Two mistakes worth not repeating

Both were made while setting these up:

- **Masking the content containers instead of stubbing them.** The feed baseline
  came out as a single pink rectangle — every post card hidden, so the refactor
  the baselines exist to protect could have broken all of them without a single
  test failing. A baseline that cannot fail is worse than no baseline.
- **Hiding images rather than serving fixture bytes.** Same mistake, quieter:
  the gallery baseline was two empty boxes. The tile frames were captured and
  nothing inside them was.
- **Removing the hero instead of replacing it.** With no image behind it,
  `background-size: cover` has nothing to scale and `backdrop-filter` has
  nothing to blur — so both became invisible to the diff. A regression where the
  hero scaled 6.8x on the feed and 0.83x on the home page, and where two pages
  were missing the frosting the others had, passed all 30 comparisons in
  silence. A substitute has to exercise the same properties as the thing it
  stands in for.
- **Forgetting that a service worker is not interceptable.** `sw.js` serves
  Cloudinary media cache-first, and a service worker's own fetch does not pass
  through `page.route`. The result was a lightbox baseline containing
  Cloudinary's demo photograph while the thumbnail behind it showed the
  placeholder — the tile had loaded before the worker claimed the page and the
  lightbox image after. Registration is now blocked in the visual specs.
  The smoke suite still exercises a page that registers a worker, because that
  is what real visitors get.
- **Omitting `{projectName}` from `snapshotPathTemplate`.** The desktop and
  mobile projects wrote to the same filenames and the second silently
  overwrote the first, leaving seven files for fourteen tests.

## Known inconsistencies, inherited not introduced

Two things are uneven across pages today. Both are single decisions once the
page shells are consolidated, and both are deliberately left alone until then:

- **The service worker registers on `/feed`, `/community`, `/gallery` and
  `/app` only.** Registration lives in five feature modules, so the three pages
  that load none of them — `/`, `/shows`, `/studio` — get no worker, and a
  visitor landing there has no offline support until they navigate. The smoke
  suite asserts registration on the four that do, and pins the scope to the
  origin root.
- **The PWA manifest is linked from `app.html` alone**, so installability
  depends on which page you happen to be on.

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

## Stylesheets

```
src/site/styles/theme.css      the band's palette, typefaces and imagery
src/core/styles/index.css      layer order, then the imports below
src/core/styles/base.css       element defaults and the page frame
src/core/styles/components.css buttons, modals, forms, the auth bar
src/core/_includes/page-styles/*.css   per page, inlined into its <style>
```

`@layer tokens, base, components, page` fixes precedence once, so a component
never has to out-specify a base rule to win.

**Everything must be in a layer, including the per-page CSS.** Unlayered rules
beat every layer regardless of specificity, so a half-extracted component fails
in a way that looks like nothing at all: hoisting `.modal.active { display: flex }`
into a layer while `.modal { display: none }` stayed unlayered on the page meant
the modals silently stopped opening.

## Formatting

Prettier is available (`npm run format <path>`) but **not enforced**. Running it
across the repo would reformat 36 of 43 files and flatten the aligned
assignments used throughout — a large diff that fights the house style and
buries real changes. `eslint-config-prettier` is loaded so the two never
disagree if you do run it on a file.
