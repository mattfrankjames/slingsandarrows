-- Phase 4, migration 1 of N: the schema the Blob stores become.
--
-- Runnable from zero on an empty database. Nothing here reads the Blob data —
-- that is a separate, re-runnable script (scripts/migrate-blobs-to-pg.mjs), so
-- a fresh install and a migration of this site take the same path up to here.
-- That path is what the template depends on, so it has to work without any of
-- this band's data existing.
--
-- Two decisions worth stating before the tables, because everything else
-- follows from them.
--
-- IDs stay text, not uuid. Existing records are keyed `<ms-timestamp>-<rand>`
-- (validate.newId), post URLs carry them, the service worker has them cached,
-- and the key format is *why* the current paging works — sorting keys sorts
-- chronologically. Switching to uuid would break shared links and force a
-- redirect table to avoid it. Keeping text makes the data migration a copy.
--
-- Authorship stays keyed by email, with a nullable link to auth.users. The
-- Blob records only ever stored an email, and the people they name do not have
-- Supabase identities until they next sign in. Inventing rows in auth.users to
-- satisfy a foreign key would be fabricating users. Email is the durable link;
-- author_id is backfilled when a profile appears and is never required.

-- ── Identity ─────────────────────────────────────────────────────────────────

-- Mirrors auth.users, which we cannot add columns to. Created on first sign-in
-- by the trigger at the bottom of this file.
create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null unique check (email = lower(email)),
  display_name text,
  created_at  timestamptz not null default now()
);

-- Replaces ALLOWED_AUTHORS / ALLOWED_ADMINS, which were comma-separated
-- environment variables — invisible to the app, unauditable, and requiring a
-- redeploy to change.
--
-- Keyed by email rather than by profile, deliberately: a role has to be
-- grantable to someone who has never signed in. Keying this to auth.users
-- would mean a new band member cannot be made an author until after their
-- first login, which is exactly backwards.
create table public.roles (
  email      text not null check (email = lower(email)),
  role       text not null check (role in ('author', 'admin')),
  granted_at timestamptz not null default now(),
  primary key (email, role)
);

-- ── Content ──────────────────────────────────────────────────────────────────

create table public.posts (
  id           text primary key,
  title        text check (length(title) <= 200),
  body         text not null check (length(body) between 1 and 20000),
  image_url    text,
  author_email text not null check (author_email = lower(author_email)),
  author_id    uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);

create table public.post_comments (
  id           text primary key,
  post_id      text not null references public.posts (id) on delete cascade,
  body         text not null check (length(body) between 1 and 2000),
  author_email text not null check (author_email = lower(author_email)),
  author_id    uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);

-- The unique constraint is the whole point. The Blob version keyed likes
-- `email::postId`, which gave uniqueness by accident of the key, but the
-- *count* lived on the post record and was maintained by read-modify-write:
-- two simultaneous likes read the same number and one was lost. Here the rows
-- are the count (see posts_with_counts below), so there is nothing to drift.
create table public.post_likes (
  post_id    text not null references public.posts (id) on delete cascade,
  email      text not null check (email = lower(email)),
  created_at timestamptz not null default now(),
  primary key (post_id, email)
);

create table public.threads (
  id           text primary key,
  title        text not null check (length(title) between 1 and 200),
  body         text not null check (length(body) between 1 and 10000),
  media_url    text,
  author_email text not null check (author_email = lower(author_email)),
  author_id    uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);

create table public.replies (
  id           text primary key,
  thread_id    text not null references public.threads (id) on delete cascade,
  body         text not null check (length(body) between 1 and 10000),
  media_url    text,
  author_email text not null check (author_email = lower(author_email)),
  author_id    uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);

create table public.gallery_items (
  id           text primary key,
  media_url    text not null,
  media_type   text not null default 'image' check (media_type in ('image', 'video')),
  caption      text check (length(caption) <= 500),
  author_email text not null check (author_email = lower(author_email)),
  author_id    uuid references public.profiles (id) on delete set null,
  created_at   timestamptz not null default now()
);

-- shows.json becomes a table. `status` was stored in the file and hand-edited,
-- which meant a gig stayed "upcoming" until someone remembered to change it.
-- It is computed from the date now and cannot be wrong.
create table public.shows (
  id         text primary key,
  show_date  date not null,
  venue      text not null,
  lineup     text[] not null default '{}',
  setlist    text[] not null default '{}',
  created_at timestamptz not null default now()
);

create view public.shows_with_status as
  select s.*,
         case when s.show_date >= current_date then 'upcoming' else 'past' end as status
    from public.shows s;

-- ── Indexes ──────────────────────────────────────────────────────────────────

-- Keyset pagination reads (created_at, id) descending. The id tiebreaks so a
-- page boundary is stable when two records share a timestamp — without it, a
-- row can be skipped or repeated between pages.
create index posts_created_idx    on public.posts        (created_at desc, id desc);
create index threads_created_idx  on public.threads      (created_at desc, id desc);
create index gallery_created_idx  on public.gallery_items (created_at desc, id desc);

-- Child lists read oldest-first under a parent.
create index comments_post_idx    on public.post_comments (post_id, created_at, id);
create index replies_thread_idx   on public.replies       (thread_id, created_at, id);

-- "Which posts has this person liked" — the /api/v1/me/likes query.
create index post_likes_email_idx on public.post_likes    (email);

-- ── Counts as aggregates ─────────────────────────────────────────────────────

-- What replaces the denormalised likeCount / commentCount / replyCount columns.
-- board-get-threads used to recount replies on every GET and write the number
-- back when it disagreed — a read endpoint performing writes, because the
-- stored count drifted. A count over the rows cannot disagree with the rows.
-- These views deliberately keep Postgres's default (non-security_invoker)
-- behaviour, so they read the underlying tables with the view owner's rights
-- and are not filtered by RLS. That is load-bearing for post_likes: the rows
-- are readable only by the person who liked (likes_own_read), but the *count*
-- is public — it is on every card. Turning security_invoker on here, as a
-- Supabase lint will suggest, would silently show every visitor a like count
-- of zero for posts they have not liked themselves.
--
-- Safe because everything else these views expose is already public-readable.
-- Any column added to posts or threads that is not should not be selected here.
create view public.posts_with_counts as
  select p.*,
         (select count(*) from public.post_likes    l where l.post_id = p.id) as like_count,
         (select count(*) from public.post_comments c where c.post_id = p.id) as comment_count
    from public.posts p;

create view public.threads_with_counts as
  select t.*,
         (select count(*) from public.replies r where r.thread_id = t.id) as reply_count
    from public.threads t;

-- ── Helpers used by the policies ─────────────────────────────────────────────

-- The signed-in caller's email, lowercased, or null when anonymous.
-- `stable` rather than `immutable`: it is constant within a statement but
-- depends on the request's JWT.
create function public.current_email()
  returns text
  language sql
  stable
as $$
  select lower(nullif(
    nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email',
    ''
  ));
$$;

-- The inner nullif is not decoration. current_setting(..., true) returns NULL
-- when the setting is absent, and NULL::json is NULL — but an *empty string*
-- is a value, and ''::json raises `invalid input syntax for type json`. That
-- would surface as a 500 on every anonymous read rather than as "not signed
-- in", and only in whatever conditions leave the claim set but empty.

-- security definer, and it has to be. This reads public.roles, and the policies
-- on public.roles call this function to decide who may read it. Without
-- definer rights the check recurses into itself and Postgres aborts the
-- statement with `infinite recursion detected in policy for relation "roles"`
-- — which would take out every policy that consults a role, i.e. all of them.
--
-- search_path is pinned for the usual definer reason: without it the function
-- resolves `roles` against the caller's search_path, and anyone able to create
-- a table could shadow it and grant themselves whatever they liked.
create function public.has_role(wanted text)
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select exists (
    select 1
      from public.roles
     where email = public.current_email()
       and role  = wanted
  );
$$;

-- An admin can moderate anyone; an author can moderate their own. This is
-- canModerate() from netlify/lib/auth.mjs, moved to where the data is so it
-- cannot be bypassed by a handler that forgets to call it.
create function public.can_moderate(owner_email text)
  returns boolean
  language sql
  stable
as $$
  select public.has_role('admin') or owner_email = public.current_email();
$$;

-- ── Row level security ───────────────────────────────────────────────────────

alter table public.profiles      enable row level security;
alter table public.roles         enable row level security;
alter table public.posts         enable row level security;
alter table public.post_comments enable row level security;
alter table public.post_likes    enable row level security;
alter table public.threads       enable row level security;
alter table public.replies       enable row level security;
alter table public.gallery_items enable row level security;
alter table public.shows         enable row level security;

-- Everything the site shows a visitor is readable by anyone. This is a public
-- band site; the read side has never been access-controlled and should not
-- start being.
create policy posts_public_read    on public.posts         for select using (true);
create policy comments_public_read on public.post_comments for select using (true);
create policy threads_public_read  on public.threads       for select using (true);
create policy replies_public_read  on public.replies       for select using (true);
create policy gallery_public_read  on public.gallery_items for select using (true);
create policy shows_public_read    on public.shows         for select using (true);

-- Likes are the exception on the read side. The rows carry who liked what, and
-- that is nobody else's business — the feed needs counts, which come from the
-- view, and each reader needs their own rows, which this allows.
create policy likes_own_read on public.post_likes
  for select using (email = public.current_email());

create policy profiles_own_read on public.profiles
  for select using (id = auth.uid() or public.has_role('admin'));

-- Roles are readable by admins only: the list of who can publish is not
-- something a visitor needs, and enumerating it invites targeting.
create policy roles_admin_read on public.roles
  for select using (public.has_role('admin'));

-- Publishing is the author role, and the author_email must be the caller's own
-- — an author cannot publish under someone else's name.
create policy posts_author_write on public.posts
  for insert with check (public.has_role('author') and author_email = public.current_email());

create policy gallery_author_write on public.gallery_items
  for insert with check (public.has_role('author') and author_email = public.current_email());

-- The board is open to any signed-in visitor, which is what a message board is.
create policy threads_signed_in_write on public.threads
  for insert with check (public.current_email() is not null and author_email = public.current_email());

create policy replies_signed_in_write on public.replies
  for insert with check (public.current_email() is not null and author_email = public.current_email());

create policy comments_signed_in_write on public.post_comments
  for insert with check (public.current_email() is not null and author_email = public.current_email());

create policy likes_own_write on public.post_likes
  for insert with check (email = public.current_email());

create policy likes_own_delete on public.post_likes
  for delete using (email = public.current_email());

-- Deletion follows canModerate: your own, or anything if you are an admin.
create policy posts_moderate_delete    on public.posts         for delete using (public.can_moderate(author_email));
create policy comments_moderate_delete on public.post_comments for delete using (public.can_moderate(author_email));
create policy threads_moderate_delete  on public.threads       for delete using (public.can_moderate(author_email));
create policy replies_moderate_delete  on public.replies       for delete using (public.can_moderate(author_email));
create policy gallery_moderate_delete  on public.gallery_items for delete using (public.can_moderate(author_email));

-- Shows and roles are administered, not user-generated.
create policy shows_admin_write  on public.shows for all using (public.has_role('admin')) with check (public.has_role('admin'));
create policy roles_admin_write  on public.roles for all using (public.has_role('admin')) with check (public.has_role('admin'));

-- ── Profile on first sign-in ─────────────────────────────────────────────────

-- Also links any content this person already authored under the same email,
-- which is what makes the email-keyed migration converge on real identities
-- without a backfill script that has to guess.
create function public.handle_new_user()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
as $$
begin
  -- Not every identity provider returns an email. profiles.email is NOT NULL,
  -- so without this guard the insert raises inside an AFTER INSERT trigger on
  -- auth.users and takes the whole sign-up down with it. A profile can be
  -- created later; a failed registration cannot be recovered by the user.
  if new.email is null or new.email = '' then
    return new;
  end if;

  insert into public.profiles (id, email)
  values (new.id, lower(new.email))
  on conflict (id) do nothing;

  update public.posts         set author_id = new.id where author_email = lower(new.email) and author_id is null;
  update public.post_comments set author_id = new.id where author_email = lower(new.email) and author_id is null;
  update public.threads       set author_id = new.id where author_email = lower(new.email) and author_id is null;
  update public.replies       set author_id = new.id where author_email = lower(new.email) and author_id is null;
  update public.gallery_items set author_id = new.id where author_email = lower(new.email) and author_id is null;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
