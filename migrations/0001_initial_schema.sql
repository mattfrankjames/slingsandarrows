-- Migration 1: the schema the Blob stores become.
--
-- Plain Postgres, on Netlify DB (Neon). Runnable from zero against an empty
-- database — nothing here reads the Blob data, which is a separate and
-- re-runnable script. A fresh install and a migration of this site take the
-- same path up to this point, and that path is what the template depends on.
--
-- Two decisions everything else follows from.
--
-- IDs stay text, not uuid. Existing records are keyed `<ms-timestamp>-<rand>`
-- (validate.newId), post URLs carry them, the service worker has them cached,
-- and that key format is *why* the current paging works — sorting keys sorts
-- chronologically. Switching to uuid would break shared links and turn the data
-- migration into a rewrite. Keeping text makes it a copy.
--
-- Authorship is keyed by email, and only by email. The Blob records never
-- stored anything else, sign-in is Netlify Identity, and there is no users
-- table here to point a foreign key at. An earlier draft of this schema, when
-- the target was Supabase, carried a `profiles` table mirroring `auth.users`
-- and a nullable `author_id` beside every `author_email`. Neither had anything
-- to link to under this arrangement, so both are gone rather than left as
-- columns that are always null.
--
-- ── On the absence of row level security ─────────────────────────────────────
--
-- There is none, deliberately, and the reasoning is worth keeping.
--
-- The Supabase draft had 23 policies. They read the caller's identity from
-- `request.jwt.claims`, which PostgREST populates from a Supabase-issued JWT.
-- Sign-in here is Netlify Identity, so that claim would never have been set and
-- every policy would have evaluated against a null identity — and the server
-- key bypasses policies regardless. They would have sat in the schema looking
-- like an access-control layer while enforcing nothing at all.
--
-- That is worse than not having them: the next person to read this file would
-- reasonably assume the database was defending itself. Authorisation lives in
-- netlify/lib/auth.mjs, in front of the query, where it is visible and where it
-- has always actually been.
--
-- If sign-in ever moves to a provider whose tokens Postgres can read, policies
-- are worth adding then, against an identity that exists.

-- ── Roles ────────────────────────────────────────────────────────────────────

-- Replaces ALLOWED_AUTHORS / ALLOWED_ADMINS, which were comma-separated
-- environment variables: invisible to the app, unauditable, and needing a
-- redeploy to change. auth.mjs reads this table instead.
--
-- Keyed by email rather than by any user record, deliberately — a role has to
-- be grantable to someone who has never signed in, or a new band member cannot
-- be made an author until after their first login, which is backwards.
create table roles (
  email      text not null check (email = lower(email)),
  role       text not null check (role in ('author', 'admin')),
  granted_at timestamptz not null default now(),
  primary key (email, role)
);

-- ── Content ──────────────────────────────────────────────────────────────────

create table posts (
  id           text primary key,
  title        text check (length(title) <= 200),
  body         text not null check (length(body) between 1 and 20000),
  image_url    text,
  author_email text not null check (author_email = lower(author_email)),
  created_at   timestamptz not null default now()
);

create table post_comments (
  id           text primary key,
  post_id      text not null references posts (id) on delete cascade,
  body         text not null check (length(body) between 1 and 2000),
  author_email text not null check (author_email = lower(author_email)),
  created_at   timestamptz not null default now()
);

-- The primary key is the point. The Blob version keyed likes `email::postId`,
-- which gave uniqueness by accident of the key, but the *count* lived on the
-- post record and was maintained by read-modify-write: two simultaneous likes
-- read the same number and one was lost. Here the rows are the count, so there
-- is nothing to drift and nothing to reconcile.
create table post_likes (
  post_id    text not null references posts (id) on delete cascade,
  email      text not null check (email = lower(email)),
  created_at timestamptz not null default now(),
  primary key (post_id, email)
);

create table threads (
  id           text primary key,
  title        text not null check (length(title) between 1 and 200),
  body         text not null check (length(body) between 1 and 10000),
  media_url    text,
  author_email text not null check (author_email = lower(author_email)),
  created_at   timestamptz not null default now()
);

create table replies (
  id           text primary key,
  thread_id    text not null references threads (id) on delete cascade,
  body         text not null check (length(body) between 1 and 10000),
  media_url    text,
  author_email text not null check (author_email = lower(author_email)),
  created_at   timestamptz not null default now()
);

create table gallery_items (
  id           text primary key,
  media_url    text not null,
  media_type   text not null default 'image' check (media_type in ('image', 'video')),
  caption      text check (length(caption) <= 500),
  author_email text not null check (author_email = lower(author_email)),
  created_at   timestamptz not null default now()
);

-- shows.json becomes a table. `status` was stored in the file and hand-edited,
-- so a gig stayed "upcoming" until someone remembered to change it. It is
-- computed from the date now and cannot be wrong.
create table shows (
  id         text primary key,
  show_date  date not null,
  venue      text not null,
  lineup     text[] not null default '{}',
  setlist    text[] not null default '{}',
  created_at timestamptz not null default now()
);

create view shows_with_status as
  select s.*,
         case when s.show_date >= current_date then 'upcoming' else 'past' end as status
    from shows s;

-- ── Indexes ──────────────────────────────────────────────────────────────────

-- Keyset pagination reads (created_at, id) descending. The id tiebreaks, so a
-- page boundary is stable when two records share a timestamp — without it a row
-- can be skipped or repeated between pages.
create index posts_created_idx    on posts         (created_at desc, id desc);
create index threads_created_idx  on threads       (created_at desc, id desc);
create index gallery_created_idx  on gallery_items (created_at desc, id desc);

-- Child lists read oldest-first under a parent.
create index comments_post_idx    on post_comments (post_id, created_at, id);
create index replies_thread_idx   on replies       (thread_id, created_at, id);

-- "Which posts has this person liked" — the /api/v1/me/likes query.
create index post_likes_email_idx on post_likes    (email);

-- ── Counts as aggregates ─────────────────────────────────────────────────────

-- What replaces the denormalised likeCount / commentCount / replyCount fields.
-- board-get-threads used to recount replies on every GET and write the number
-- back when it disagreed — a read endpoint performing writes, because the
-- stored count drifted. A count over the rows cannot disagree with the rows.
create view posts_with_counts as
  select p.*,
         (select count(*) from post_likes    l where l.post_id = p.id) as like_count,
         (select count(*) from post_comments c where c.post_id = p.id) as comment_count
    from posts p;

create view threads_with_counts as
  select t.*,
         (select count(*) from replies r where r.thread_id = t.id) as reply_count
    from threads t;
