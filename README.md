# Slings & Arrows

The website for Slings & Arrows — a static site (Parcel + Tailwind CSS) with a Netlify Functions backend powering a community message board, a post feed with comments and likes, a photo/video gallery, RSS feeds, custom auth, an installable PWA, and an in-browser music sequencer.

## Stack

- **Frontend** — plain HTML/CSS/JS (ES modules), bundled with [Parcel 2](https://parceljs.org/). No framework. Shared browser-side modules live in `src/js/lib/`.
- **Styling** — Tailwind utility output committed directly at `styles/tailwind.css`; page-specific styling lives in inline `<style>` blocks in each HTML file rather than a Tailwind build pipeline.
- **Backend** — [Netlify Functions](https://docs.netlify.com/functions/overview/) (`netlify/functions/*.mjs`) backed by [Netlify Blobs](https://docs.netlify.com/blobs/overview/) for storage — no database. Shared server-side helpers live in `netlify/lib/`.
- **Auth** — a custom sign-in modal (`src/js/auth-modal.js`) built on Netlify Identity's GoTrue API, with optional interop with the official Netlify Identity widget.
- **Media** — user-uploaded images, video, and audio go to [Cloudinary](https://cloudinary.com/) via a *signed* upload. The browser holds no upload credential: `netlify/functions/cloudinary-sign.mjs` checks the caller is signed in and returns a one-shot signature, and `src/js/lib/media.js` uses it.
- **PWA** — a manifest and service worker (`src/sw.js`) provide offline support, an offline post queue with background sync, and stale-while-revalidate caching for the feed/board/gallery API responses.

## Pages

| Route | Source | What it is |
|---|---|---|
| `/` | `src/index.html` | Home page |
| `/feed` | `src/feed.html` | Post feed — comments, likes, image lightbox |
| `/community` | `src/community.html` | Message board — threads, replies, media attachments |
| `/gallery` | `src/gallery.html` | Photo/video gallery with lightbox |
| `/shows` | `src/shows.html` | Upcoming/past shows, driven by `src/data/shows.json` |
| `/studio` | `src/studio.html` | In-browser drum machine / bass sequencer / mixer |
| `/app` | `src/app.html` | Post composer — gated to allowed authors |

## Backend (`netlify/functions/`)

### Routes

Endpoints live under `/api/v1`. Every function also answers on its original
`/api/*` path, so a page served from a stale cache keeps working; those aliases
can be dropped once no old bundles are in circulation.

| Method | Route | Function |
|---|---|---|
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
`{ items, nextCursor, total }` — the frontend does not send it yet.

### Shared modules (`netlify/lib/`)

- `auth.mjs` — who the caller is, and whether they may act. See below.
- `http.mjs` — `json()`, `route()`, and the `HttpError` family. `route()` wraps
  every handler: an `HttpError` becomes its status and message, anything else is
  logged and answered with a generic 500 so internal detail never reaches a caller.
- `validate.mjs` — body parsing, field limits, id and media-URL checks, `newId()`.
- `store.mjs` — Blob access and `page()`, which sorts keys and reads only the
  requested page instead of every record in the store.
- `xml.mjs` — RSS escaping and response helper.

### Authorization

All identity checks go through `netlify/lib/auth.mjs`. Functions never inspect the JWT themselves.

- `getUser(req)` — resolves the caller's **verified** identity, or `null`. Verification is delegated to Netlify Identity's own `/.netlify/identity/user` endpoint, because Netlify signs Identity tokens with a symmetric secret it does not expose — local signature checking is not possible for this provider. Successful verifications are cached in-process for 60s; failures never are, and any error fails closed.
- `isAuthor(user)` — in `ALLOWED_AUTHORS`. Required to publish a post or a gallery item.
- `isAdmin(user)` — in `ALLOWED_ADMINS`, falling back to `ALLOWED_AUTHORS` when unset.
- `canModerate(user, ownerEmail)` — the content's owner, or an admin. Used by the delete endpoints.

Commenting, liking, board threads/replies, and media uploads are open to any signed-in user.

## Environment variables

Set these in the Netlify dashboard (or a local `.env` for `netlify dev`):

- `CLOUDINARY_CLOUD_NAME` — the Cloudinary account uploads go to
- `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` — used **server-side only**, to sign uploads. Find them under Settings → API Keys in the Cloudinary console. The secret must never be exposed to the browser.
- `ALLOWED_AUTHORS` — comma-separated emails allowed to publish posts and gallery items
- `ALLOWED_ADMINS` *(optional)* — comma-separated emails allowed to delete anyone's board/comment content; defaults to `ALLOWED_AUTHORS` if unset
- `IDENTITY_URL` *(optional)* — override the Identity endpoint used for token verification. Only needed for local development; in every Netlify deploy context it is derived from `URL`.

`CLOUDINARY_UPLOAD_PRESET` is no longer used and can be removed. The unsigned preset it named should be **disabled in the Cloudinary console** — while it stays enabled, it remains usable by anyone who saved a copy from a previously deployed bundle.

## Development

```bash
npm install
npm start           # Parcel dev server for the static frontend
npm run build       # production build to dist/
npm run verify      # check the shared libraries (auth, http, validate, store)
```

The frontend alone will run with `npm start`, but the `/api/*` endpoints are Netlify Functions and won't respond without the [Netlify CLI](https://docs.netlify.com/cli/get-started/) (`netlify dev`) and the environment variables above.

## Deployment

Deployed on Netlify; `netlify.toml` defines the build command, redirects (clean URLs, RSS routes), and cache headers. Pushing to `main` triggers a deploy.
