/**
 * Checks for the shared server-side libraries: http, validate, store.
 *
 * No test framework and no network — `npm run verify:lib`. Phase 2 folds these
 * into Vitest alongside verify-auth.mjs.
 */
import { json, HttpError, route, badRequest, notFound } from '../netlify/lib/http.mjs';
import {
  readJson, requiredString, optionalString, cloudinaryUrl,
  requiredId, newId, readPageParams, LIMITS,
} from '../netlify/lib/validate.mjs';
import { selectPage } from '../netlify/lib/store.mjs';

let pass = 0, fail = 0;
const ok = (name, cond) => cond
  ? (pass++, console.log(`  ok   ${name}`))
  : (fail++, console.log(`  FAIL ${name}`));

const post = (body, url = 'https://x.test/api/v1/thing') =>
  new Request(url, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });

// ── http.json ────────────────────────────────────────────────────────────────
console.log('\nhttp — responses');
{
  const res = json({ a: 1 }, 201, { 'X-Test': 'y' });
  ok('sets the JSON content type', res.headers.get('Content-Type') === 'application/json');
  ok('honours the status', res.status === 201);
  ok('merges extra headers', res.headers.get('X-Test') === 'y');
  ok('serialises the body', (await res.json()).a === 1);
}

// ── http.route error handling ────────────────────────────────────────────────
console.log('\nhttp — route()');
{
  const handler = route(async () => json({ fine: true }));
  ok('passes a normal response through', (await handler(post({}), {})).status === 200);
}
{
  const handler = route(async () => { throw badRequest('threadId is required'); });
  const res = await handler(post({}), {});
  ok('HttpError maps to its status', res.status === 400);
  ok('HttpError message reaches the caller', (await res.json()).error === 'threadId is required');
}
{
  const handler = route(async () => { throw notFound(); });
  ok('notFound() defaults to 404', (await handler(post({}), {})).status === 404);
}
{
  // The bug this replaced: `return json({ error: err.message }, 500)` handed
  // internal detail to whoever asked.
  const quiet = console.error; console.error = () => {};
  const handler = route(async () => { throw new Error('BLOB_STORE_TOKEN=sekrit expired'); });
  const res = await handler(post({}), {});
  console.error = quiet;

  const body = await res.json();
  ok('an unexpected error is a 500', res.status === 500);
  ok('...and its message is NOT leaked', !body.error.includes('sekrit'));
  ok('...replaced with something generic', body.error === 'Something went wrong. Try again.');
}

// ── validate.readJson ────────────────────────────────────────────────────────
console.log('\nvalidate — readJson');
{
  ok('parses an object body', (await readJson(post({ a: 1 }))).a === 1);

  const reject = async (body, label) => {
    try { await readJson(post(body)); ok(label, false); }
    catch (e) { ok(label, e instanceof HttpError && e.status === 400); }
  };
  await reject('not json at all', 'malformed JSON → 400, not 500');
  await reject('[1,2,3]',        'a JSON array is rejected');
  await reject('"a string"',     'a bare JSON string is rejected');
  await reject('null',           'null is rejected');
}

// ── validate — strings ───────────────────────────────────────────────────────
console.log('\nvalidate — fields');
ok('trims a required string', requiredString('  hi  ', 'Body') === 'hi');
ok('empty required string throws', (() => { try { requiredString('   ', 'Body'); return false; } catch { return true; } })());
ok('non-string required throws',  (() => { try { requiredString(42, 'Body'); return false; } catch { return true; } })());
ok('over-length required throws', (() => { try { requiredString('abcdef', 'Body', 3); return false; } catch { return true; } })());
ok('error names the field',       (() => { try { requiredString('', 'Comment'); } catch (e) { return e.message.startsWith('Comment'); } })());
ok('optional string allows empty', optionalString(undefined, 'Title') === '');
ok('optional string still caps',   (() => { try { optionalString('abcdef', 'Title', 3); return false; } catch { return true; } })());
ok('comment limit is 2000',        LIMITS.comment === 2000);

// ── validate — media URLs ────────────────────────────────────────────────────
console.log('\nvalidate — cloudinaryUrl');
ok('accepts a Cloudinary URL',
  cloudinaryUrl('https://res.cloudinary.com/x/image/upload/a.jpg')
    === 'https://res.cloudinary.com/x/image/upload/a.jpg');
ok('drops another host', cloudinaryUrl('https://evil.test/x.jpg') === '');
ok('drops a javascript: URL', cloudinaryUrl('javascript:alert(1)') === '');
ok('drops a lookalike host', cloudinaryUrl('https://res.cloudinary.com.evil.test/x.jpg') === '');
ok('drops a non-string', cloudinaryUrl(null) === '');

// ── validate — ids ───────────────────────────────────────────────────────────
console.log('\nvalidate — ids');
ok('accepts a normal id', requiredId('1756-abc', 'postId') === '1756-abc');
ok('rejects a slash (blob prefix escape)',
  (() => { try { requiredId('a/b', 'postId'); return false; } catch { return true; } })());
ok('rejects traversal',
  (() => { try { requiredId('..', 'postId'); return false; } catch { return true; } })());
ok('rejects missing',
  (() => { try { requiredId(undefined, 'postId'); return false; } catch { return true; } })());

// newId must stay compatible with ids already in the blob stores, which are
// unpadded 13-digit timestamps — padding would sort new records before old.
{
  const id = newId();
  ok('newId is <13-digit timestamp>-<random>', /^\d{13}-[a-z0-9]{1,7}$/.test(id));
  ok('newId sorts after an existing-format id', id > '1700000000000-aaaaaaa');
  ok('newId is unique across calls', new Set(Array.from({ length: 500 }, newId)).size === 500);
}

// ── validate — paging params ─────────────────────────────────────────────────
console.log('\nvalidate — readPageParams');
{
  const at = q => new Request(`https://x.test/api/v1/posts${q}`);
  ok('defaults when absent', readPageParams(at('')).limit === 25);
  ok('honours an explicit limit', readPageParams(at('?limit=10')).limit === 10);
  ok('clamps to maxLimit', readPageParams(at('?limit=9999')).limit === 100);
  ok('reads the cursor', readPageParams(at('?cursor=abc')).cursor === 'abc');
  ok('null cursor when absent', readPageParams(at('')).cursor === null);
  ok('rejects limit=0', (() => { try { readPageParams(at('?limit=0')); return false; } catch { return true; } })());
  ok('rejects a non-numeric limit', (() => { try { readPageParams(at('?limit=abc')); return false; } catch { return true; } })());
}

// ── store.selectPage ─────────────────────────────────────────────────────────
console.log('\nstore — selectPage');
{
  // Deliberately unsorted, as list() returns them.
  const keys = ['3-c', '1-a', '5-e', '2-b', '4-d'];

  const desc = selectPage(keys, { limit: 2 });
  ok('newest first by default', desc.keys.join() === '5-e,4-d');
  ok('reports the full total, not the page size', desc.total === 5);
  ok('cursor is the last key of the page', desc.nextCursor === '4-d');

  const second = selectPage(keys, { limit: 2, cursor: desc.nextCursor });
  ok('the next page continues after the cursor', second.keys.join() === '3-c,2-b');

  const third = selectPage(keys, { limit: 2, cursor: second.nextCursor });
  ok('the final page returns the remainder', third.keys.join() === '1-a');
  ok('the final page has no cursor', third.nextCursor === null);

  ok('asc order reads oldest first',
    selectPage(keys, { limit: 2, order: 'asc' }).keys.join() === '1-a,2-b');

  ok('no limit returns everything', selectPage(keys).keys.length === 5);
  ok('no limit means no cursor', selectPage(keys).nextCursor === null);

  // A cursor pointing at a since-deleted record must not truncate the list.
  const orphaned = selectPage(keys, { limit: 2, cursor: 'nonexistent' });
  ok('an unknown cursor restarts rather than returning nothing', orphaned.keys.join() === '5-e,4-d');

  ok('an empty store is handled', selectPage([], { limit: 5 }).keys.length === 0);
  ok('a limit larger than the store has no cursor', selectPage(keys, { limit: 99 }).nextCursor === null);

  // Paging must visit every record exactly once.
  const seen = [];
  let cur = null;
  for (let i = 0; i < 10; i++) {
    const p = selectPage(keys, { limit: 2, cursor: cur });
    seen.push(...p.keys);
    if (!p.nextCursor) break;
    cur = p.nextCursor;
  }
  ok('walking every page yields each key once', seen.join() === '5-e,4-d,3-c,2-b,1-a');

  ok('does not mutate the caller\'s array', keys.join() === '3-c,1-a,5-e,2-b,4-d');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
