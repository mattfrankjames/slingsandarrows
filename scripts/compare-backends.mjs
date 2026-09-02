/**
 * Diff two deployments' public API, to decide whether Postgres can be promoted.
 *
 *   node scripts/compare-backends.mjs <blobs-url> <postgres-url>
 *   node scripts/compare-backends.mjs https://slingsandarrows.band \
 *     https://deploy-preview-98--slingsandarrows.netlify.app
 *
 * Reads only. Compares what a visitor would receive, because that is the thing
 * that must not change — not row counts, which can match while the JSON differs.
 *
 * ── Counts are compared separately, and a difference there may be correct ────
 *
 * likeCount, commentCount and replyCount were denormalised fields on the Blob
 * side, maintained by read-modify-write. They drift: that is the concurrency
 * bug this phase exists to fix, and `board-get-threads` used to repair reply
 * counts on every GET because of it. In Postgres they are aggregates over the
 * rows and cannot disagree with the rows.
 *
 * So a count mismatch is not automatically a regression — it may be Blobs
 * having been wrong. It is reported apart from other fields so that judgement
 * is available rather than buried, and Postgres's number is the trustworthy one
 * when they differ.
 *
 * Anything else differing — a title, an author, a URL, an ordering — is a
 * migration or mapping fault and should block the promotion.
 */

const ENDPOINTS = [
  { path: '/api/v1/posts', name: 'posts', key: 'id' },
  { path: '/api/v1/gallery', name: 'gallery', key: 'id' },
  { path: '/api/v1/board/threads', name: 'threads', key: 'id' },
];

/** Fields whose disagreement is expected and possibly an improvement. */
const COUNT_FIELDS = new Set(['likeCount', 'commentCount', 'replyCount']);

async function fetchJson(base, path) {
  // Cache-bust: /api/* responses sit at Netlify's edge for 30-60s, and a
  // comparison against a cached body proves nothing about what was deployed.
  const url = `${base}${path}?_cmp=${Date.now()}`;
  const res = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const body = await res.json();
  return Array.isArray(body) ? body : (body.posts ?? body.items ?? body.threads ?? []);
}

/**
 * @returns {{ ordering: string|null, missing: string[], extra: string[],
 *             fields: {id: string, field: string, a: unknown, b: unknown}[],
 *             counts: {id: string, field: string, a: unknown, b: unknown}[] }}
 */
export function diff(a, b, key = 'id') {
  const byId = list => new Map(list.map(r => [r[key], r]));
  const A = byId(a);
  const B = byId(b);

  const missing = [...A.keys()].filter(id => !B.has(id));
  const extra = [...B.keys()].filter(id => !A.has(id));

  const fields = [];
  const counts = [];

  for (const [id, recordA] of A) {
    const recordB = B.get(id);
    if (!recordB) continue;

    for (const field of new Set([...Object.keys(recordA), ...Object.keys(recordB)])) {
      const left = recordA[field];
      const right = recordB[field];
      if (JSON.stringify(left) === JSON.stringify(right)) continue;
      (COUNT_FIELDS.has(field) ? counts : fields).push({ id, field, a: left, b: right });
    }
  }

  // Order is part of the response: the feed renders in the order it is given.
  const orderA = a.map(r => r[key]).filter(id => B.has(id));
  const orderB = b.map(r => r[key]).filter(id => A.has(id));
  const ordering =
    JSON.stringify(orderA) === JSON.stringify(orderB)
      ? null
      : `order differs — blobs: ${orderA.slice(0, 4).join(', ')}… postgres: ${orderB.slice(0, 4).join(', ')}…`;

  return { ordering, missing, extra, fields, counts };
}

async function main() {
  const [blobsUrl, pgUrl] = process.argv.slice(2);
  if (!blobsUrl || !pgUrl) {
    console.error('Usage: node scripts/compare-backends.mjs <blobs-url> <postgres-url>');
    process.exit(2);
  }

  console.log(`  blobs    ${blobsUrl}`);
  console.log(`  postgres ${pgUrl}\n`);

  let blocking = 0;
  let advisory = 0;

  for (const { path, name, key } of ENDPOINTS) {
    const [a, b] = await Promise.all([fetchJson(blobsUrl, path), fetchJson(pgUrl, path)]);
    const d = diff(a, b, key);

    const problems = d.missing.length + d.extra.length + d.fields.length + (d.ordering ? 1 : 0);
    const mark = problems ? 'DIFFERS' : 'match';
    console.log(`${name.padEnd(9)} ${String(a.length).padStart(3)} vs ${String(b.length).padStart(3)}  ${mark}`);

    if (d.ordering) console.log(`  ${d.ordering}`);
    for (const id of d.missing) console.log(`  missing from postgres: ${id}`);
    for (const id of d.extra) console.log(`  only in postgres:      ${id}`);
    for (const f of d.fields) {
      console.log(`  ${f.id} .${f.field}`);
      console.log(`      blobs:    ${JSON.stringify(f.a)?.slice(0, 90)}`);
      console.log(`      postgres: ${JSON.stringify(f.b)?.slice(0, 90)}`);
    }
    for (const c of d.counts) {
      console.log(`  ${c.id} .${c.field}: blobs ${c.a} vs postgres ${c.b}  (aggregate — postgres is authoritative)`);
    }

    blocking += problems;
    advisory += d.counts.length;
  }

  console.log('');
  if (advisory) {
    console.log(`${advisory} count difference(s). Expected where a denormalised`);
    console.log('count had drifted; Postgres computes them from the rows.');
  }
  if (blocking) {
    console.error(`\n${blocking} difference(s) that are not counts. Do not promote.`);
    process.exit(1);
  }
  console.log('No differences outside the counts. Safe to promote.');
}

if (process.argv[1] && process.argv[1].endsWith('compare-backends.mjs')) {
  main().catch(err => {
    console.error(`Comparison failed: ${err.message}`);
    process.exit(1);
  });
}
