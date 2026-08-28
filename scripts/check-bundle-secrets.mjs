/**
 * Fail the build if a Supabase secret reached the browser bundles.
 *
 * The secret key bypasses row level security completely. Every policy in
 * supabase/migrations is irrelevant to a caller holding one, so this is not a
 * leak of one resource — it is the whole database, readable and writable, to
 * anyone who views source.
 *
 * This is a script rather than a grep in the workflow because the legacy key
 * format cannot be grepped for. A legacy key is a JWT whose payload claims
 * `service_role`, and the payload is base64url — where the encoding of
 * "service_role" depends on its byte offset within the JSON, so the same
 * claim has three different encoded forms. A single needle catches one of
 * them. The first version of this check used one, tested clean against a
 * planted key, and would have shipped.
 *
 * Decoding is the only honest way to ask the question.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Current format: sb_secret_<random>. Unambiguous, so matched literally. */
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
    console.error('Scope the key to functions only in Netlify — a variable in the');
    console.error('build context is reachable by the bundler.');
    process.exit(1);
  }
  console.log(`No Supabase secret in ${dir}/`);
}
