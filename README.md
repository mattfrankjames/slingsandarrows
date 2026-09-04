# Slings & Arrows

The website for Slings & Arrows — a static site with a Netlify Functions
backend powering a community message board, a post feed with comments and
likes, a photo/video gallery, RSS feeds, custom auth, an installable PWA, and
an in-browser music sequencer.

## Stack

- **Frontend** — plain HTML/CSS/JS (ES modules). No framework. The build is two
  stages: [Eleventy](https://www.11ty.dev/) renders `src/*.njk` into
  `.eleventy/`, then [Parcel 2](https://parceljs.org/) bundles that into
  `dist/`. Shared browser modules live in `src/core/js/lib/`.
- **Styling** — hand-written CSS in cascade layers
  (`@layer tokens, base, components, page`). The band's palette, typefaces and
  imagery are tokens in `src/site/styles/`; everything in `src/core/` refers to
  those and names none of them. Per-page CSS lives in
  `src/core/_includes/page-styles/`. *(There is no Tailwind here and never was
  — `styles/tailwind.css` had its `@tailwind` directives commented out and was
  823 lines of hand-written CSS under a misleading name.)*
- **Backend** — [Netlify Functions](https://docs.netlify.com/functions/overview/)
  (`netlify/functions/*.mjs`) over **Postgres**, hosted on
  [Neon](https://neon.tech/). Shared server-side helpers live in `netlify/lib/`.
  [Netlify Blobs](https://docs.netlify.com/blobs/overview/) was the previous
  store and still holds a full copy — see *Storage* below.
- **Auth** — a custom sign-in modal (`src/core/js/auth-modal.js`) built on
  Netlify Identity's GoTrue API. The official Identity widget is loaded lazily,
  only when a page needs it or a confirmation token is present in the URL.
- **Media** — user uploads go to [Cloudinary](https://cloudinary.com/) via a
  *signed* upload. The browser holds no upload credential:
  `netlify/functions/cloudinary-sign.mjs` checks the caller is signed in and
  returns a one-shot signature, and `src/core/js/lib/media.js` uses it.
- **PWA** — a manifest and service worker (`src/sw.js`) provide offline
  support, an offline post queue with background sync, and
  stale-while-revalidate caching for the feed/board/gallery API responses.

## Storage

The site reads from Postgres. `USE_POSTGRES` in `netlify.toml` selects the
backend, and `netlify/lib/store.mjs` dispatches to `store-pg.mjs` or
`store-blobs.mjs` behind one interface — so the handlers never name a storage
model.

That variable does **not** reach the functions on its own. Netlify has two
environment-variable systems and they do not overlap: what is declared in
`netlify.toml` exists only while the build runs, and functions execute later in
a process that sees only UI/API values. `scripts/write-build-flags.mjs` runs
first in `npm run build`, reads the variable while it still exists, and writes
`netlify/lib/build-flags.mjs` into the function bundle. An explicitly set
environment variable still wins at runtime, so a value in the Netlify UI can
force a rollback with no redeploy.

`GET /api/v1/health` reports which backend a deploy is actually **serving**,
proven with a read that reaches the database, rather than the one it was
configured for:

```json
{ "ok": true, "backend": "postgres" }
```

Blobs still holds a full copy and is the rollback, but the rollback is not
symmetrical: writes made since the cutover exist only in Postgres, because
Blobs stopped receiving them. Rolling back hides those writes rather than
destroying them, and `scripts/migrate-blobs-to-pg.mjs` only ever copies
Blobs → Postgres.

## Pages

Templates are `src/*.njk`; Eleventy renders them through
`src/core/_includes/layouts/`.

| Route | Source | What it is |
|---|---|---|
| `/` | `src/index.njk` | Home page |
| `/feed` | `src/feed.njk` | Post feed — comments, likes, image lightbox |
| `/post/:id` | `src/post.njk` | Single-post permalink (200 rewrite) |
| `/community` | `src/community.njk` | Message board — threads, replies, media |
| `/gallery` | `src/gallery.njk` | Photo/video gallery with lightbox |
| `/shows` | `src/shows.njk` | Shows, driven by `src/site/data/shows.json` |
| `/studio` | `src/studio.njk` | In-browser drum machine / bass sequencer / mixer |
| `/app` | `src/app.njk` | Post composer — gated to authors |

## Backend (`netlify/functions/`)

### Routes

Endpoints live under `/api/v1`. Every function also answers on its original
`/api/*` path, so a page served from a stale cache keeps working; those aliases
can be dropped once no old bundles are in circulation.

| Method | Route | Function |
|---|---|---|
| GET | `/api/v1/health` | `health` |
| GET | `/api/v1/posts` | `get-posts` |
| POST | `/api/v1/posts` | `create-post` |
| DELETE | `/api/v1/posts/:id` | `delete-post` |
| GET | `/api/v1/posts/:postId/comments` | `post-comments-list` |
| POST | `/api/v1/posts/:postId/comments` | `post-comments-create` |
| DELETE | `/api/v1/posts/:postId/comments/:commentId` | `post-comments-delete` |
| POST | `/api/v1/posts/:postId/likes` | `post-likes-toggle` |
| GET | `/api/v1/me/likes` | `post-likes-mine` |
| GET | `/api/v1/board/threads` | `board-get-threads` |
| POST | `/api/v1/board/threads` | `board-create-thread` |
| DELETE | `/api/v1/board/threads/:id` | `board-delete-thread` |
| GET | `/api/v1/board/threads/:threadId/replies` | `board-get-replies` |
| POST | `/api/v1/board/threads/:threadId/replies` | `board-create-reply` |
| DELETE | `/api/v1/board/threads/:threadId/replies/:replyId` | `board-delete-reply` |
| GET | `/api/v1/gallery` | `gallery-list` |
| POST | `/api/v1/gallery` | `gallery-add` |
| DELETE | `/api/v1/gallery/:id` | `gallery-delete` |
| POST | `/api/v1/uploads/signature` | `cloudinary-sign` |
| GET | `/feed.xml`, `/community.xml` | `rss-feed`, `rss-community` |

List endpoints accept optional `?limit=` and `?cursor=`. Without `limit` they
return a bare array, as they always have. With one they return
`{ items, nextCursor, total }`.

### Shared modules (`netlify/lib/`)

- `auth.mjs` — who the caller is, and whether they may act. See below.
- `http.mjs` — `json()`, `route()`, and the `HttpError` family. `route()` wraps
  every handler: an `HttpError` becomes its status and message, anything else is
  logged and answered with a generic 500 so internal detail never reaches a caller.
- `validate.mjs` — body parsing, field limits, id and media-URL checks, `newId()`.
- `store.mjs` — the storage interface (`page`, `getRecord`, `putRecord`,
  `createChild`, `countUnder`, `toggleLike`, …) and the dispatcher that picks a
  backend per call.
- `store-pg.mjs` / `store-blobs.mjs` — the two implementations.
- `db.mjs` — the Postgres connection. Picks Neon's HTTP driver or a `pg.Pool`
  by hostname, and exposes a parameterised `query()`.
- `build-flags.mjs` — **generated** by `scripts/write-build-flags.mjs`. Do not edit.
- `xml.mjs` — RSS escaping and response helper.

### Authorization

All identity checks go through `netlify/lib/auth.mjs`. Functions never inspect
the JWT themselves.

- `getUser(req)` — resolves the caller's **verified** identity, or `null`.
  Verification is delegated to Netlify Identity's own
  `/.netlify/identity/user` endpoint, because Netlify signs Identity tokens
  with a symmetric secret it does not expose — local signature checking is not
  possible for this provider. Successful verifications are cached in-process
  for 60s; failures never are, and any error fails closed.
- `isAuthor(user)` — holds the `author` role. Required to publish a post or a
  gallery item.
- `isAdmin(user)` — holds the `admin` role.
- `canModerate(user, ownerEmail)` — the content's owner, or an admin. The owner
  check is a string comparison made *before* any query, so deleting your own
  content does not depend on the database being reachable.

Roles live in the `roles` table, managed with `scripts/grant-role.mjs`:

```bash
node --env-file=.env scripts/grant-role.mjs --list
node --env-file=.env scripts/grant-role.mjs --author someone@example.com
```

On the Blobs path they came from `ALLOWED_AUTHORS` / `ALLOWED_ADMINS` instead,
where an unset `ALLOWED_ADMINS` fell back to the author list. **The table has no
such fallback** — a role is granted or it is not.

Commenting, liking, board threads/replies, and media uploads are open to any
signed-in user and need no role.

## Environment variables

Set these in the Netlify dashboard (or a local `.env`):

- `DATABASE_URL` — the Neon connection string. Required by the functions, the
  migration runner, and the database tests.
- `CLOUDINARY_CLOUD_NAME` — the Cloudinary account uploads go to
- `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` — used **server-side only**, to
  sign uploads. The secret must never be exposed to the browser.
- `USE_POSTGRES` — set in `netlify.toml`, not the UI. Setting it to `"false"`
  in the UI is the fastest rollback, since UI values reach the runtime directly.
- `IDENTITY_URL` *(optional)* — override the Identity endpoint used for token
  verification. Only needed locally; in every Netlify deploy context it is
  derived from `URL`.
- `ALLOWED_AUTHORS`, `ALLOWED_ADMINS` — **only read on the Blobs path.** Keep
  them while Blobs remains the rollback; they do nothing while Postgres is live.

A Neon connection string contains `&`, so sourcing `.env` in a shell splits on
it and fails confusingly. Use `node --env-file=.env` instead of
`set -a && . ./.env`.

`CLOUDINARY_UPLOAD_PRESET` is no longer used and can be removed. The unsigned
preset it named should be **disabled in the Cloudinary console** — while it
stays enabled, it remains usable by anyone who saved a copy from a previously
deployed bundle.

## Development

```bash
npm install
npm start            # Eleventy + Parcel dev server for the static frontend
npm run build        # production build to dist/
npm run verify       # lint + typecheck + unit tests — run before pushing
npm run test:db      # unit tests against a real database (needs DATABASE_URL)
npm run test:browser # Playwright against BASE_URL (a deploy preview)
```

The frontend alone runs with `npm start`, but the `/api/*` endpoints are
Netlify Functions and will not respond without the
[Netlify CLI](https://docs.netlify.com/cli/get-started/) (`netlify dev`) and
the environment variables above. `netlify dev` also runs a local PostgreSQL
(a real Postgres 17 compiled to WebAssembly), which is the only way to execute
a migration on a machine with no Postgres installed.

### Migrations

```bash
node scripts/migrate.mjs --dry-run   # list what would run
node scripts/migrate.mjs             # apply anything pending
```

Migrations live in `migrations/`, are applied in order exactly once each, and
are recorded with a checksum so an edited file that has already run is caught
rather than silently skipped. CI runs them from zero against a clean Postgres
on every pull request.

## Deployment

Deployed on Netlify; `netlify.toml` defines the build command, redirects and
cache headers. Pushing to `main` triggers a deploy.

**If you add or change a redirect, verify it is actually live.** Netlify's
deploy-time redirect table can go stale while the rest of the config stays
current — this repo lost the `/post/:id` rewrite that way for six weeks, and
nothing reported an error. The deploy summary's *"N redirect rules processed"*
should match the number of `[[redirects]]` blocks in `netlify.toml`; if it does
not, clear the cache and redeploy. A quick check:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://slingsandarrows.band/post/x
```

## Docs

- [docs/refactor-status.md](docs/refactor-status.md) — the working state of the
  rebuild: what landed, what was decided and why, and the mistakes worth not
  repeating.
- [docs/testing.md](docs/testing.md) — what runs in CI, why browser tests
  target a Deploy Preview rather than localhost, the ESLint rules that encode
  past regressions, and the branch-protection settings that make any of it
  actually gate a deploy.
