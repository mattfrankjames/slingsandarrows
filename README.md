# Slings & Arrows

The website for Slings & Arrows — a static site (Parcel + Tailwind CSS) with a Netlify Functions backend powering a community message board, a post feed with comments and likes, a photo/video gallery, RSS feeds, custom auth, an installable PWA, and an in-browser music sequencer.

## Stack

- **Frontend** — plain HTML/CSS/JS (ES modules), bundled with [Parcel 2](https://parceljs.org/). No framework.
- **Styling** — Tailwind utility output committed directly at `styles/tailwind.css`; page-specific styling lives in inline `<style>` blocks in each HTML file rather than a Tailwind build pipeline.
- **Backend** — [Netlify Functions](https://docs.netlify.com/functions/overview/) (`netlify/functions/*.mjs`) backed by [Netlify Blobs](https://docs.netlify.com/blobs/overview/) for storage — no database.
- **Auth** — a custom sign-in modal (`src/js/auth-modal.js`) built on Netlify Identity's GoTrue API, with optional interop with the official Netlify Identity widget.
- **Media** — user-uploaded images, video, and audio go to [Cloudinary](https://cloudinary.com/) via an unsigned upload preset.
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

- `create-post` / `get-posts` / `delete-post` — the feed
- `post-comments-create` / `post-comments-list` / `post-comments-delete` — feed comments
- `post-likes-toggle` / `post-likes-mine` — feed likes
- `board-create-thread` / `board-get-threads` / `board-delete-thread` / `board-create-reply` / `board-get-replies` / `board-delete-reply` — the message board
- `gallery-add` / `gallery-list` / `gallery-delete` — the gallery
- `rss-feed` / `rss-community` — RSS feeds, served at `/feed.xml` and `/community.xml`

Authorization pattern: functions that create/delete content require a signed-in user (decoded from the `Authorization: Bearer` JWT). Creating a *post* or a *gallery item* is further restricted to the `ALLOWED_AUTHORS` allowlist; deleting a thread/reply/comment is allowed for its owner or anyone in `ALLOWED_ADMINS` (falling back to `ALLOWED_AUTHORS` if unset). Commenting and liking are open to any signed-in user.

## Environment variables

Set these in the Netlify dashboard (or a local `.env` for `netlify dev`):

- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_UPLOAD_PRESET` — unsigned Cloudinary upload target for post/thread/gallery media
- `ALLOWED_AUTHORS` — comma-separated emails allowed to publish posts and gallery items
- `ALLOWED_ADMINS` *(optional)* — comma-separated emails allowed to delete anyone's board/comment content; defaults to `ALLOWED_AUTHORS` if unset

## Development

```bash
npm install
npm start          # Parcel dev server for the static frontend
npm run build       # production build to dist/
```

The frontend alone will run with `npm start`, but the `/api/*` endpoints are Netlify Functions and won't respond without the [Netlify CLI](https://docs.netlify.com/cli/get-started/) (`netlify dev`) and the environment variables above.

## Deployment

Deployed on Netlify; `netlify.toml` defines the build command, redirects (clean URLs, RSS routes), and cache headers. Pushing to `main` triggers a deploy.
