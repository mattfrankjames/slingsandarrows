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

**The gate:** `main` is protected by the "Main Gate" ruleset — pull request
required (zero approvals), no deletion, no force-push — and all three CI checks
must pass to merge: `Lint, types, unit tests`, `Smoke, routing, API contract,
accessibility`, and `Performance budget`. CI genuinely blocks now; it did not
until 2026-08-28.

One thing it still does not do: `strict_required_status_checks_policy` is off,
so a branch need not be up to date with `main` before merging — a pull request
can be green against a stale base. Worth revisiting in Phase 4, where two
branches touching migrations could each pass alone and conflict once both land.

Requiring `Performance budget` means the Lighthouse job now blocks. It depends
on a Netlify build and on runner timing, so if it starts failing for reasons
unrelated to a change, fix the flakiness rather than dropping the requirement.

---

## Decisions already made

Settled — don't relitigate without a reason:

- **Neon for Postgres, direct rather than through Netlify DB.** **Reversed
  2026-08-29, amended 2026-08-30** — this entry
  previously read "Supabase, chosen over Neon for GoTrue continuity: the
  existing sign-in modal already speaks that protocol." Two things made that
  reasoning stop applying, and both are worth recording so this does not get
  reopened a third time.

  Auth is not moving. The original argument was about migrating sign-in *to*
  Supabase; Phase 4 instead keeps Netlify Identity and does authorisation in
  `auth.mjs`, so Supabase Auth and RLS would have gone unused. And Netlify
  Identity is not being deprecated after all — announced, then
  [reversed in February 2026](https://answers.netlify.com/t/netlify-identity-is-staying-feb-2026-reversal-what-changed-whos-affected-and-how-to-proceed/162733)
  — so there is no forcing function to move it.

  The deciding argument was not cost. On Supabase the schema carried 23 row
  level security policies that could not work: they read the caller from
  `request.jwt.claims`, which only a Supabase-issued JWT populates, and the
  server key bypasses policies regardless. They would have sat in the schema
  looking like access control while enforcing nothing — the same failure shape
  as a test that cannot fail. Dropping them made the schema smaller and honest:
  17 statements instead of 55.

  Cost agrees: Neon's free tier scales to zero and wakes itself, where a free
  Supabase project pauses after a week and needs a manual restore, and Neon's
  paid tier is usage-based against $25/month per project.

  **The store is what could reverse this again.** Customer accounts are where
  Supabase's auth-plus-database bundle earns its price. The plan is a separate
  store on a subdomain with its own stack, which is a normal shape for band
  merch and keeps that decision out of this one.
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
- Migrations committed and runnable from zero, applied by `scripts/migrate.mjs`
  rather than pasted into a console. CI should run them against a throwaway
  Postgres per pull request, which continuously proves the bootstrap path the
  template will depend on. Not built yet.

### What Phase 4 will not fix

Measured on the live site before starting, because the assumption was that
Postgres would take the loading states with it. It will not.

A cold visit to `/gallery`: `DOMContentLoaded` at 550ms, the request for
`/api/v1/gallery` *starting* at 549ms and taking 1102ms, content on screen at
1651ms. Three costs, and this phase only touches the smallest:

| Cost | Measured | Phase 4 |
|---|---|---|
| Nothing fetched until the JS module graph runs | ~550ms | no effect |
| Netlify function cold start | ~1000ms | likely worse |
| The query itself | ~50ms warm | this is the part it fixes |

`board/threads` took 1053ms on its first call and 2ms on the next; `posts` and
`gallery` answer in ~52ms once warm, with 12 and 31 items. So the reader is
waiting on a function booting, not on Blobs enumerating keys. Opening a
Postgres connection during that boot adds to it rather than removing it — worth
watching once the first endpoint is cut over, and an argument for a pooler.

Two related things found in the same pass:

- **The service worker cache cannot help a first visit.** It is not yet
  controlling the page, so that load always pays full price, and the cache is
  keyed per URL — a warm `/feed` does nothing for `/gallery`. This is what
  "loading states as if nothing is cached" actually is.
- **`netlify.toml` and the functions disagree about edge caching.** The config
  sets `/api/*` to `no-cache, no-store, must-revalidate` and comments that API
  responses are never cached at the edge. The functions override it through
  `cacheFor()`, and a live response carries `public,max-age=60` with
  `cache-status: "Netlify Edge"; hit`. Not a leak — every user-specific
  endpoint (`post-likes-mine`, `cloudinary-sign`, `post-likes-toggle`) uses
  `noStore`, so Phase 0's fix holds — but the config's stated intent is not what
  happens, and the header block should say what it means.

### Verification status

**The schema has been executed and its behaviour tested.** Not on Neon — on the
local database, which turned out to be the useful discovery of this phase.

`netlify dev` runs a real PostgreSQL 17.5 compiled to WebAssembly (`compiled by
emcc`), on this machine, with no Docker. `netlify database connect --query` runs
one-shot statements against it and the data persists between invocations. That
is the difference between a schema that parses and one that works.

`migrations/0001` applies cleanly: 8 tables, 3 views, 14 indexes, 3 foreign
keys, 18 check constraints. More usefully, the four things this phase exists to
fix were tested by trying to violate them:

| Attempt | Result |
|---|---|
| Like the same post twice | `duplicate key value violates unique constraint` |
| Delete a post with comments and likes | 0 orphans — the cascade works |
| Insert a mixed-case author email | rejected by check constraint |
| Read a show's status | computed `upcoming` / `past` from the date |

The first is the concurrency bug that loses a like, now structurally
impossible. The second is the "deleting a post leaves its comments behind" entry
under *Known and deliberately unfixed*, which can come off the list once the
handlers are cut over.

`netlify/lib/db.mjs` was exercised against the same database: the tagged
template returns rows, an id containing `'; drop table posts; --` matches
nothing and leaves the table standing, and a throwing `withTransaction` leaves
no row behind.

**Two things this does not prove.** The local database is Postgres compiled to
WASM, not Neon — close, but not the same build, and only the `pg` transport is
exercised locally. The Neon HTTP path in `db.mjs` has never run. And **no
database is provisioned**, so nothing has been tested end to end against the
one this will actually use.

One caveat worth writing down: **the local connection string changes on every
run.** Capturing it once and reusing it fails with a connection error that
surfaces as a query failure, which reads like a schema problem. Re-read it each
time.

### Why Neon directly, and not Netlify DB

Attempted first, and it does not work on this account. Installing
`@netlify/database` makes every Netlify build try to provision a database, and
the API answers:

    API error on "createSiteDatabase"
      status: 403
      message: 'database feature not available for this account'

Two deploys failed on that before the cause was found, reporting only `Build
script returned non-zero exit code: 4`. It built locally and in a clean clone
with `npm ci`; `netlify build --context deploy-preview` runs the real pipeline
locally and named it immediately. **Reach for that before guessing at a Netlify
build failure** — the first guess here was a Node version, which was wrong and
got pushed.

The account is on Netlify's *legacy* Free plan (`credit_features: included:
false`). Netlify Database requires the newer credit-based plans, whose Free tier
is also $0 — so this is a plan migration rather than a price. Not worth doing:
on credit-based plans an active database draws down the same credits as builds
and bandwidth, and it is the same Neon underneath either way. A Neon account
keeps the database's limits separate from the host's.

The package is gone. `db.mjs` selects the transport itself — Neon's HTTP client
for a `*.neon.tech` host, `pg` for anything else — which is a dozen lines and
was the only thing that package was doing for us.

### Phase 4.5 — first paint without a loading state

Agreed to follow this phase rather than join it, so the migration stays
reviewable on its own.

Render the first screen into the HTML at build time. Eleventy already builds
these pages; having `feed.njk` and `gallery.njk` emit the first N items
server-side means first paint has content and the client only revalidates.
That removes the loading state on cold *and* warm visits, and it is the only
one of the three costs above that can be removed rather than reduced.

It works against Blobs or Postgres. Doing it after the migration means the
build step gets written once, against the data source it will keep.

### Where the seams already are

- `netlify/lib/store.mjs` is the only file importing `@netlify/blobs` (ESLint
  enforces it). Rewriting it is most of the data layer.
- `netlify/lib/auth.mjs` exports `getUser` / `isAuthor` / `isAdmin` /
  `canModerate` / `require*`. These keep their signatures; `isAuthor` and
  `isAdmin` change from reading `ALLOWED_AUTHORS` / `ALLOWED_ADMINS` to querying
  the `roles` table. Sign-in stays on Netlify Identity, so token verification is
  untouched.
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

**Rulesets are invisible to the branch-protection API.** `main` was protected
by a ruleset for a day while this file confidently recorded that it was not,
because `repos/:owner/:repo/branches/main/protection` answers a literal
`404 Branch not protected` whenever the protection comes from a ruleset rather
than the older per-branch setting. Ask `repos/:owner/:repo/rules/branches/main`,
which reports every rule actually in force and which ruleset supplied it.

**A required check is matched by its name.** The context string in the ruleset
has to equal the job's `name:` exactly — `Lint, types, unit tests`, not the
workflow's name or the file's. A near-miss does not error anywhere; the ruleset
waits for a check that will never report, or ignores one that does. Compare
`rules/branches/main` against `gh pr checks` on a real pull request rather than
trusting either alone.

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
