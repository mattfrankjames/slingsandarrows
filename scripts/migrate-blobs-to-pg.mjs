/**
 * Copy every Blob record into Postgres.
 *
 *   NETLIFY_SITE_ID=<id> NETLIFY_AUTH_TOKEN=<token> DATABASE_URL=<url> \
 *     node scripts/migrate-blobs-to-pg.mjs --dry-run
 *
 * Drop --dry-run to write.
 *
 * All three variables are needed and none is optional. Inside a function
 * @netlify/blobs finds the site and token from the ambient runtime, but this
 * runs as an ordinary node process, where it finds nothing and throws "The
 * environment has not been configured to use Netlify Blobs".
 *
 * `netlify dev:exec` looks like the answer and is not: it injects the site's
 * environment variables, and Blobs credentials are not among them. (It also
 * eats `--dry-run` as one of its own options unless separated with `--`.)
 *
 * The site id is in .netlify/state.json after `netlify link`. The token is a
 * personal access token from Netlify → User settings → Applications. It grants
 * full access to the account, so pass it on the command line for one run rather
 * than putting it anywhere it will persist.
 *
 * ── Re-runnable, not transactional ───────────────────────────────────────────
 *
 * Every write is an upsert on the primary key, so running this twice changes
 * nothing the second time and a half-finished run is repaired by starting
 * again. That is deliberately the recovery story instead of one big
 * transaction: the record-level writes go through store-pg's ordinary
 * `putRecord`, and threading a transaction client through it would mean giving
 * the whole storage layer a second code path used only here.
 *
 * With twelve posts and thirty-one gallery items that trade is obvious. It
 * would not be at ten thousand.
 *
 * ── Orphans are the reason this is not a loop ────────────────────────────────
 *
 * Blobs has no foreign keys, and `delete-post` never removed a post's comments
 * or likes — that is a known bug, recorded in the status doc, and it means the
 * source data almost certainly contains children whose parents are gone. In
 * Postgres those rows cannot exist: the foreign key is the fix.
 *
 * So the plan is computed before anything is written, orphans are reported by
 * id and parent, and they are skipped rather than aborting the run. They are
 * unreachable in the current site — nothing renders a comment whose post has
 * been deleted — so dropping them loses nothing a reader can see. Reporting
 * them matters anyway: it is the only moment anyone will ever count how much
 * of that bug accumulated.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Parents first: a child cannot be inserted before the row it references. */
export const ORDER = [
  'posts',
  'board-threads',
  'gallery',
  'post-comments',
  'board-replies',
  'post-likes',
];

/** Which store holds each child's parent, and where the child keeps its id. */
const PARENT_OF = {
  'post-comments': { store: 'posts', key: 'postId' },
  'board-replies': { store: 'board-threads', key: 'threadId' },
  'post-likes': { store: 'posts', key: 'postId' },
};

/**
 * What the schema will accept, checked here so a rejection is reported against
 * a record rather than surfacing as a constraint name.
 *
 * These mirror migrations/0001. They are duplicated rather than derived, which
 * is a real cost — change one and this drifts. The alternative is discovering
 * a bad record as a failed statement two thirds of the way through a run.
 */
const LIMITS = {
  posts: r => (!r.body ? 'body is empty' : r.body.length > 20000 ? 'body over 20000' : null),
  'board-threads': r =>
    !r.title ? 'title is empty' : !r.body ? 'body is empty' : null,
  'board-replies': r => (!r.body ? 'body is empty' : null),
  'post-comments': r => (!r.body ? 'body is empty' : null),
  gallery: r =>
    !r.mediaUrl
      ? 'mediaUrl is empty'
      : r.mediaType && !['image', 'video'].includes(r.mediaType)
        ? `mediaType "${r.mediaType}" is neither image nor video`
        : null,
  'post-likes': r => (!r.postId || !r.email ? 'like is missing postId or email' : null),
};

/**
 * Decide what to write and what to skip, without touching either database.
 *
 * @param {Record<string, object[]>} source  Records keyed by store name.
 * @returns {{ insert: Record<string, object[]>, skipped: {store: string, id: string, reason: string}[] }}
 */
export function plan(source) {
  const insert = {};
  const skipped = [];

  // Ids that will exist once the parents above have been written. Built from
  // the source rather than queried, so a dry run needs no destination at all.
  const present = {
    posts: new Set((source.posts || []).map(r => r.id)),
    'board-threads': new Set((source['board-threads'] || []).map(r => r.id)),
  };

  for (const store of ORDER) {
    const records = source[store] || [];
    insert[store] = [];

    for (const record of records) {
      const invalid = LIMITS[store]?.(record);
      if (invalid) {
        skipped.push({ store, id: record.id ?? `${record.email}::${record.postId}`, reason: invalid });
        continue;
      }

      const parent = PARENT_OF[store];
      if (parent && !present[parent.store].has(record[parent.key])) {
        skipped.push({
          store,
          id: record.id ?? `${record.email}::${record.postId}`,
          reason: `orphan — ${parent.store} ${record[parent.key]} does not exist`,
        });
        continue;
      }

      insert[store].push(record);
    }
  }

  return { insert, skipped };
}

/** shows.json, which is a file rather than a blob store. */
export function readShows(path = join(HERE, '..', 'src', 'site', 'data', 'shows.json')) {
  return JSON.parse(readFileSync(path, 'utf8')).map((show, index) => ({
    // The file has no ids. Derived from date and venue so re-running is an
    // upsert rather than a duplicate, and stable if the file is reordered.
    //
    // The index fallback is for an entry missing either field. Written first as
    // `\`${date}-${slug(venue)}\` || \`show-${index}\``, which cannot work — a
    // template literal is always truthy, so a row with no date would have been
    // given the id "undefined-" and then collided with the next one.
    id: show.date && show.venue ? `${show.date}-${slug(show.venue)}` : `show-${index}`,
    show_date: show.date,
    venue: show.venue,
    lineup: show.lineup ?? [],
    setlist: show.setlist ?? [],
  }));
}

const slug = text =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

async function main() {
  const dryRun = process.argv.includes('--dry-run');

  const blobs = await import('../netlify/lib/store-blobs.mjs');
  const pg = await import('../netlify/lib/store-pg.mjs');
  const { query } = await import('../netlify/lib/db.mjs');

  console.log('Reading the Blob stores…');
  const source = {};
  for (const store of ORDER) {
    const { items } = await blobs.page(store, {});
    source[store] = items;
    console.log(`  ${store.padEnd(16)} ${items.length}`);
  }

  const shows = readShows();
  console.log(`  ${'shows.json'.padEnd(16)} ${shows.length}`);

  const { insert, skipped } = plan(source);

  if (skipped.length) {
    console.log(`\n${skipped.length} record(s) will be skipped:`);
    for (const s of skipped) console.log(`  ${s.store} ${s.id} — ${s.reason}`);
  } else {
    console.log('\nNothing to skip: every child has its parent.');
  }

  if (dryRun) {
    console.log('\n--dry-run: nothing written.');
    return;
  }

  console.log('\nWriting…');
  for (const store of ORDER) {
    for (const record of insert[store]) await pg.putRecord(store, record);
    console.log(`  ${store.padEnd(16)} ${insert[store].length}`);
  }

  for (const show of shows) {
    await query(
      `insert into shows (id, show_date, venue, lineup, setlist)
       values ($1, $2, $3, $4, $5)
       on conflict (id) do update set
         show_date = excluded.show_date, venue = excluded.venue,
         lineup = excluded.lineup, setlist = excluded.setlist`,
      [show.id, show.show_date, show.venue, show.lineup, show.setlist]
    );
  }
  console.log(`  ${'shows'.padEnd(16)} ${shows.length}`);

  // Count the destination rather than trusting the writes. A silent failure
  // here would look exactly like a successful migration of less data.
  console.log('\nVerifying…');
  const TABLES = {
    posts: 'posts',
    'board-threads': 'threads',
    gallery: 'gallery_items',
    'post-comments': 'post_comments',
    'board-replies': 'replies',
    'post-likes': 'post_likes',
  };

  let wrong = 0;
  for (const store of ORDER) {
    const [{ n }] = await query(`select count(*)::int as n from ${TABLES[store]}`);
    const expected = insert[store].length;
    const ok = n >= expected;
    if (!ok) wrong++;
    console.log(`  ${store.padEnd(16)} expected >= ${expected}, found ${n} ${ok ? '' : '  MISMATCH'}`);
  }

  const [{ n: showCount }] = await query('select count(*)::int as n from shows');
  console.log(`  ${'shows'.padEnd(16)} expected >= ${shows.length}, found ${showCount}`);

  if (wrong) {
    console.error(`\n${wrong} table(s) hold fewer rows than were written. Re-run; writes are upserts.`);
    process.exit(1);
  }

  // Roles are not Blob data — they were ALLOWED_AUTHORS / ALLOWED_ADMINS, and
  // they live in the Netlify UI, so there is nothing here for this script to
  // copy. That is exactly why it is worth checking: a migration that reports
  // success while nobody can publish looks finished and is not. Every read path
  // works without a role, so the gap only surfaces when someone tries to post.
  const [{ n: authors }] = await query("select count(*)::int as n from roles where role = 'author'");
  if (authors === 0) {
    console.error('\nNo author role is granted, so nobody can publish. Content migrated,');
    console.error('permissions did not — they were environment variables, not Blobs.');
    console.error('\n  node scripts/grant-role.mjs --author <email>\n');
    process.exit(1);
  }
  console.log(`  ${'roles'.padEnd(16)} ${authors} author(s) granted`);

  console.log('\nDone. Blob data is untouched — it stays the rollback.');
}

if (process.argv[1] && process.argv[1].endsWith('migrate-blobs-to-pg.mjs')) {
  main().catch(err => {
    console.error(`\nMigration failed: ${err.message}`);

    // The likeliest way to run this wrong, and the underlying message does not
    // say what to do about it.
    if (/not been configured to use Netlify Blobs/i.test(err.message)) {
      console.error('\nThe Blob store needs explicit credentials outside a function:');
      console.error('  NETLIFY_SITE_ID=<id> NETLIFY_AUTH_TOKEN=<token> \\');
      console.error('    node scripts/migrate-blobs-to-pg.mjs --dry-run');
      console.error('\nSite id: .netlify/state.json. Token: Netlify user settings.');
    }
    if (/401/.test(err.message)) {
      console.error('\nBlobs answered 401. NETLIFY_AUTH_TOKEN is set but rejected —');
      console.error('check it is a current personal access token for this account.');
    }
    if (/connection string/i.test(err.message)) {
      console.error('\nSet DATABASE_URL to the destination, or run under a site that has it.');
    }

    process.exit(1);
  });
}
