# Refactor status

Where the rebuild stands, what was decided and why, and what Phase 4 needs.
Written to be picked up cold — by a new session, or by you in three months.

The full plan (findings, target stack, all eight phases) is the artifact
"Slings & Arrows Refactor". This file is the working state.

---

## Done

| Phase | PR | What landed |
|---|---|---|
| 0 — Security | #87 | Verified Identity tokens, per-user cache fix, signed uploads |
| 1 — Shared libraries | #88 | `netlify/lib/`, `/api/v1` routes, opt-in paging |
| 2 — Guardrails | #89 | ESLint, `checkJs`, Vitest, Playwright + axe, CI |
| 3.0 — Baselines | #90 | 30 visual baselines before the risky work |
| 3.1 — core/site split | #91 | `src/core/` and `src/site/`, boundary enforced |
| 3.2 — Eleventy | #92 | Eight page shells become one layout |
| 3.3 — CSS layers | #93 | Tokens, cascade layers, components defined once |
| 3.4 — Accessibility | #94 | Native `<dialog>`, reduced motion, focus ring |

**#94 is open at time of writing.** Its browser job failed once on
`net::ERR_ABORTED` — preview redeploying mid-run, not assertion failures. The
full suite passes locally against its preview (163/163).

---

## The shape of things now

```
src/
  core/                 nothing here knows the band's name
    _includes/
      layouts/          base.njk, home.njk
      partials/         head, fonts, header, nav, footer, social-icons
      page-styles/      per-page CSS, inlined into each page's <style>
    js/
      lib/              api.js, session.js, media.js
      …                 feature modules (posts, board, gallery, studio, composer)
    styles/             index.css (layer order), base.css, components.css
  site/                 everything that is about this band
    _data/site.json     name, social, nav, fonts, Cloudinary account, announcement
    styles/theme.css    palette, typefaces, hero imagery — all tokens
    images/ media/ data/ favicon.svg manifest.json
  *.njk                 eight pages: front matter + content blocks
  sw.js                 at the root because a worker can only claim its own path

netlify/
  lib/                  auth, http, validate, store, xml
  functions/            20 handlers, all on the shared libraries
```

**Build:** Eleventy renders `src/**/*.njk` into `.eleventy/`, Parcel builds
`dist/` from there. Two stages so Parcel keeps owning asset hashing, the
service-worker importmap and the manifest transform.

**Storage:** still Netlify Blobs. Six stores — `posts`, `post-comments`,
`post-likes`, `board-threads`, `board-replies`, `gallery`.

---

## Decisions already made

Settled — don't relitigate without a reason:

- **Supabase** for Postgres + auth. Chosen over Neon for GoTrue continuity: the
  existing sign-in modal already speaks that protocol.
- **Eleventy**, not Astro. Compiles to plain HTML, no client runtime.
- **JSDoc + `checkJs`**, not TypeScript. Files stay `.js`, no build step.
- **Keep Cloudinary.** Only the upload path needed fixing, and it was.
- **Physical goods only** — records, shirts, pins. No digital delivery.
- **Standing catalogue, not drops.** Refund-on-oversell, no stock reservation.
- **You ship the orders.** Print-on-demand stays possible behind a `fulfill()`
  interface, unbuilt.
- **Template is a real goal, not urgent.** Folder boundary now, npm packaging in
  Phase 7.
- **Bands bring their own fonts** — `fonts.provider` in site.json, separate from
  the font-name tokens.

---

## Phase 4 — Postgres

The next phase, and a prerequisite for the store. Blobs cannot do what a shop
needs: no transactions, no unique constraints, no atomic counters.

### Why it is blocking

- `post-likes-toggle` and `post-comments-create` do read-modify-write on the
  post record. Two simultaneous likes lose one. Applied to `inventory_qty`, that
  oversells stock.
- `board-get-threads` reconciles reply counts on a GET, and writes back when
  they disagree — because the denormalised count drifts. In SQL it is an
  aggregate and cannot.
- `store.page()` reduces the read amplification but `list()` still enumerates
  every key. There is no index to do better.

### Scope

- Schema: `profiles`, `posts`, `post_comments`, `post_likes` (unique on user +
  post), `threads`, `replies`, `gallery_items`, `shows`, `roles`.
- Counts become aggregates or trigger-maintained columns.
- Keyset pagination on `(created_at, id)`.
- One migration script: read every Blob store, insert, verify counts. **Little
  live data**, so a single pass — no batching. Cut reads over behind a flag,
  confirm, then writes. Leave the Blob data as a rollback for a few deploys.
- RLS replaces `ALLOWED_AUTHORS` / `ALLOWED_ADMINS`; roles move to a table.
- `shows.json` becomes a table, with upcoming/past computed from the date.
- Migrations committed and runnable from zero — CI runs them on a Supabase
  preview branch per PR, which continuously proves the bootstrap path the
  template will depend on.

### Where the seams already are

- `netlify/lib/store.mjs` is the only file importing `@netlify/blobs` (ESLint
  enforces it). Rewriting it is most of the data layer.
- `netlify/lib/auth.mjs` exports `getUser` / `isAuthor` / `isAdmin` /
  `canModerate` / `require*`. Swapping Identity for Supabase changes the body,
  not the exports.
- `src/core/js/lib/api.js` names every endpoint in one place.
- `store.page()` returns `{ items, nextCursor, total }`; list endpoints already
  accept `?limit` and `?cursor`. **The frontend does not send them yet** —
  wiring that up is part of Phase 4.

---

## Things that cost time to learn

Worth reading before touching the test suite or CI.

**A test that cannot fail is worse than no test.** Four separate versions of
this: the feed baseline masked to a pink rectangle, the gallery baseline with
images hidden, `/app` baselined while signed out (so it captured a sign-in
prompt), and a hero substitute that removed the very properties it was meant to
guard. Each looked like passing coverage.

A fifth, found while fixing the dialog colours: `screenshot.css` flattened the
hero by targeting `.wrapper`, and kept doing so after the hero moved to
`.wrapper::before`. The captures filled with the fixture placeholder blurred
over the navy body colour, and all 30 comparisons passed — `maxDiffPixelRatio`
was 0.02, wide enough to absorb the page's entire ground. It is 0.005 now, and
the flattening covers the pseudo-element. Note what that number can and cannot
do: the black-on-black dialog text measured 0.0015 of the frame, so no workable
threshold catches a recolouring. That belongs in an assertion, and is one now.

**Screenshots are bad at "is this consistent across pages."** The hero
regression — 6.8× scaling on the feed, missing frosting on two pages — passed 30
comparisons. Explicit cross-page assertions found it and now guard it.

**Verify a lint rule actually fires.** ESLint flat config *replaces* a rule
rather than merging it; a later block silently disabled the `innerHTML` rule. A
throwaway probe file is the only way to know.

**Everything must be in a cascade layer.** Unlayered rules beat every layer
regardless of specificity. Hoisting `.modal.active` into a layer while
`.modal { display: none }` stayed unlayered meant the modals silently stopped
opening.

**`<dialog>` carries its own colour.** The UA stylesheet sets `color:
CanvasText` on the element, which beats anything inherited from `body` no
matter how dark the page is. Four of the five dialogs shipped black text on
their own near-black surface; the composer escaped only by declaring
`color: white` itself. It is one rule on `dialog` in `base.css` now. The
focus-trap tests passed throughout — they assert behaviour, and the behaviour
was correct — and axe never saw a dialog open.

**A cross-page assertion only guards what it reads.** The hero check compares
`background-image`, `background-size` and `position` across all eight pages and
said nothing when the crop moved: switching `background-position` from `0 0` to
`center` pushed the band out of frame on the home page and off both edges on a
phone, with every assertion still green. `background-position` is compared now.

**`:focus-visible` does not match programmatic focus.** A test calling
`el.focus()` measures `:focus` only and reports no ring where one works.

**`em` on `font-size` resolves against the parent**, not the element's other
declarations. `.btn-sm` at `0.85em` inside a `0.85em` auth bar was 11.56px, not
13.6px.

**A service worker's fetch is not interceptable by `page.route`.** Visual specs
block worker registration for this reason.

**Never `|| true` a CI step.** The baseline capture swallowed
`net::ERR_ABORTED`, reported success, and shipped stale files that were
indistinguishable from a good capture.

**This repo lives in iCloud Drive**, which periodically creates `foo 2.js`
duplicates. Two have nearly reached CI. Sweep before committing:
`find . -path ./node_modules -prune -o -name "* 2*" -print`

**Baselines come from the runners.** Only `linux/` is committed — every
workflow is `ubuntu-latest`, and that set gates the merge. Running the visual
specs on a Mac writes a throwaway `darwin/` set that gates nothing; do not
commit it. Regenerate via the *Update visual baselines* workflow, then download
and commit — reviewing the images first.

---

## Known and deliberately unfixed

- **`main` is protected, but no check is required.** The "Main Gate" ruleset
  blocks deletion and force-pushes and requires a pull request (zero approvals).
  It has no `required_status_checks` rule, so a red CI run does not block the
  merge button — the gap the earlier note here described, though it described it
  as protection being off entirely, which it is not. Note that rulesets do not
  appear under the branch-protection API: `branches/main/protection` returns 404
  on this repo while the ruleset is active. Check `rules/branches/main` instead.
  Repository settings, not code.
- Deleting a post leaves its comments and likes behind. Blobs has no cascade;
  Phase 4's foreign keys fix it.
- Like and comment counts can drift under concurrency. Same fix.
- The service worker registers on `/feed`, `/community`, `/gallery`, `/app`
  only — registration lives in five feature modules, so the other three pages
  get none. One decision once the composer work consolidates it.
- The PWA manifest is linked from every page now, but `start_url` is `/app`,
  which is the admin composer.
- `src/site/rss/feed.xml` and `src/site/media/anhedonia.m4a` are referenced by
  nothing.
- `font-display` for the Adobe kits is set in the Adobe Fonts account, not in
  code. Setting it to `swap` is the largest remaining font win.

---

## Commands

```bash
npm run verify        # lint + typecheck + unit tests — before pushing
npm test              # Vitest, 101 unit tests, no network
npm run build         # Eleventy then Parcel
BASE_URL=<preview> npx playwright test          # 163 browser tests
BASE_URL=<preview> npm run test:visual          # 60 baselines
```

Browser tests need a deployed target — `netlify.toml`'s rewrites, headers and
functions do not exist in front of `parcel serve`. See
[testing.md](testing.md).
