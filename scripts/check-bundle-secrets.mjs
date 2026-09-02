/**
 * Fail the build if a database credential reached the browser bundles.
 *
 * NETLIFY_DATABASE_URL carries a password and grants the connecting role
 * everything. migrations/0001 has no row level security — deliberately, since
 * sign-in is Netlify Identity and Postgres cannot read those tokens — so there
 * is no second line of defence underneath. A connection string in a bundle is
 * the entire database, readable and writable, to anyone who views source.
 *
 * A script rather than a grep in the workflow for a reason worth keeping. This
 * started out guarding Supabase keys, and the legacy form of those is a JWT
 * claiming service_role — where the payload is base64url, and base64 encodes in
 * three-byte groups, so the same claim has three different encoded forms
 * depending on its byte offset. The grep version matched one of the three,
 * passed its own probe, and would have shipped. Decoding is the only honest way
 * to ask that question, and the JWT check is kept because a Supabase key is
 * still a credential if one ever finds its way in here.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A Postgres connection string carrying credentials.
 *
 * The `user:password@` part is required rather than optional. Matching bare
 * `postgres://` would fire on documentation, comments and error messages, and a
 * check people learn to wave through is worse than no check.
 */
const CONNECTION_STRING = /postgres(?:ql)?:\/\/[^\s:/@]+:[^\s@]+@[^\s/]+/;

/** Supabase's current key format. Kept: still a credential if one appears. */
const SECRET_KEY = /sb_secret_[A-Za-z0-9_-]{8,}/;

/**
 * Anything JWT-shaped. Decoded below rather than pattern-matched.
 *
 * The signature is matched loosely on purpose. A real key's is 43 characters,
 * so a tight bound would never miss one in practice — but the cost of being
 * wrong here is the entire database, and the cost of being permissive is
 * decoding a few more base64 strings that turn out not to be JSON. An earlier
 * version required four or more and a hand-written probe slipped under it,
 * which is a good illustration of how this fails: quietly, and looking clean.
 */
const JWT = /eyJ[A-Za-z0-9_-]{6,}\.([A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]*/g;

/**
 * The publishable key is deliberately not matched. It is designed to ship to
 * browsers and RLS is what makes that safe — flagging it would train people to
 * ignore this check.
 */
export function findSecrets(source) {
  const hits = [];

  const conn = source.match(CONNECTION_STRING);
  if (conn) {
    // Report the host, never the password.
    hits.push(`database connection string (host ${conn[0].split('@')[1] ?? '?'})`);
  }

  const literal = source.match(SECRET_KEY);
  if (literal) hits.push(`Supabase secret key (${literal[0].slice(0, 14)}…)`);

  for (const [, payload] of source.matchAll(JWT)) {
    let claims;
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      continue; // JWT-shaped but not a JWT, or not our concern.
    }
    if (claims?.role === 'service_role') {
      hits.push(`legacy service_role JWT (ref ${claims.ref ?? 'unknown'})`);
    }
  }

  return hits;
}

function* jsFiles(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* jsFiles(path);
    else if (/\.(js|mjs|map|html|json)$/.test(entry)) yield path;
  }
}

// Only run the scan when invoked directly, so the tests can import findSecrets.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const dir = process.argv[2] || 'dist';
  let failed = false;

  for (const file of jsFiles(dir)) {
    for (const hit of findSecrets(readFileSync(file, 'utf8'))) {
      console.error(`::error file=${file}::${hit} reached the built bundles.`);
      failed = true;
    }
  }

  if (failed) {
    console.error('Scope the variable to functions only in Netlify — anything in the');
    console.error('build context is reachable by the bundler.');
    process.exit(1);
  }
  console.log(`No database credentials in ${dir}/`);
}
