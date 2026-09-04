/**
 * Grant, revoke and list the roles that decide who may publish.
 *
 *   node scripts/grant-role.mjs --list
 *   node scripts/grant-role.mjs --author you@example.com
 *   node scripts/grant-role.mjs --author a@x.com --admin a@x.com
 *   node scripts/grant-role.mjs --from-env
 *   node scripts/grant-role.mjs --revoke --admin someone@x.com
 *
 * Needs DATABASE_URL and nothing else — no Netlify token, unlike the data
 * migration.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * Phase 4 moved authorship from ALLOWED_AUTHORS / ALLOWED_ADMINS to a table,
 * and the data migration was never taught to carry them over. It copies posts,
 * comments, likes, gallery items and threads — everything except the one table
 * that grants permission. So on Postgres the `roles` table was empty, `hasRole`
 * correctly returned false for everyone, and an account that could publish in
 * production could not publish on the preview.
 *
 * Nothing was broken, which is why it went unnoticed until someone tried to
 * post: the read paths a smoke test exercises need no role at all.
 *
 * The migration could not have picked these up by itself in any case. They live
 * in the Netlify UI, so a local run does not see them — which is the argument
 * for a tool that takes the addresses explicitly rather than one that quietly
 * infers them.
 *
 * ── The admin fallback is not reproduced silently ────────────────────────────
 *
 * On the environment-variable path, an unset ALLOWED_ADMINS falls back to
 * ALLOWED_AUTHORS: every author is an admin. The table has no such fallback,
 * deliberately — a role is granted or it is not.
 *
 * `--from-env` therefore refuses to invent admins. If ALLOWED_ADMINS is unset
 * it seeds authors, says plainly that production also treated those authors as
 * admins, and leaves the decision to a human. Widening a delete-anyone's-content
 * privilege is not a thing a migration script should do on inference.
 */

import { query } from '../netlify/lib/db.mjs';

const ROLES = /** @type {const} */ (['author', 'admin']);

/** @param {string} value */
export function parseList(value) {
  return [
    ...new Set(
      (value || '')
        .split(',')
        .map(entry => entry.trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
}

/**
 * The schema has `check (email = lower(email))`, so a mixed-case address is a
 * constraint violation rather than a silently separate row. Normalise here and
 * let the check stay a backstop.
 *
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  /** @type {{author: string[], admin: string[]}} */
  const grants = { author: [], admin: [] };
  let revoke = false;
  let list = false;
  let fromEnv = false;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--revoke') revoke = true;
    else if (arg === '--list') list = true;
    else if (arg === '--from-env') fromEnv = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--author' || arg === '--admin') {
      const email = argv[++i];
      if (!email || email.startsWith('--')) throw new Error(`${arg} needs an email address`);
      if (!email.includes('@')) throw new Error(`"${email}" is not an email address`);
      grants[arg === '--author' ? 'author' : 'admin'].push(email.trim().toLowerCase());
    } else throw new Error(`Unknown argument "${arg}"`);
  }

  return { grants, revoke, list, fromEnv, dryRun };
}

/**
 * What --from-env should do, given an environment. Separated from the doing so
 * the admin-fallback decision is testable without a database.
 *
 * @param {Record<string, string|undefined>} env
 */
export function planFromEnv(env) {
  const authors = parseList(env.ALLOWED_AUTHORS ?? '');
  const admins = parseList(env.ALLOWED_ADMINS ?? '');

  return {
    authors,
    admins,
    // The env path treats authors as admins when ALLOWED_ADMINS is unset. Say
    // so rather than replicating it.
    unstatedAdmins: admins.length === 0 ? authors : [],
  };
}

async function main() {
  const { grants, revoke, list, fromEnv, dryRun } = parseArgs(process.argv.slice(2));

  if (list || (!fromEnv && !grants.author.length && !grants.admin.length)) {
    const rows = await query('select email, role, granted_at from roles order by role, email');
    if (!rows.length) {
      console.log('No roles granted. Nobody can publish.');
    } else {
      for (const row of rows) console.log(`  ${row.role.padEnd(6)} ${row.email}`);
      console.log(`\n${rows.length} grant(s).`);
    }
    if (!list) console.log('\nNothing to do. See the header of this file for usage.');
    return;
  }

  if (fromEnv) {
    const plan = planFromEnv(process.env);
    if (!plan.authors.length && !plan.admins.length) {
      console.error('ALLOWED_AUTHORS and ALLOWED_ADMINS are both unset or empty.');
      console.error('They live in the Netlify UI, not in .env — pass addresses explicitly instead.');
      process.exitCode = 1;
      return;
    }
    grants.author.push(...plan.authors);
    grants.admin.push(...plan.admins);

    if (plan.unstatedAdmins.length) {
      console.log('ALLOWED_ADMINS is unset. On the environment-variable path that means');
      console.log('every author is also an admin. Not replicating that automatically —');
      console.log('re-run with --admin <email> for each person who should keep it:\n');
      for (const email of plan.unstatedAdmins) console.log(`  --admin ${email}`);
      console.log('');
    }
  }

  for (const role of ROLES) {
    for (const email of [...new Set(grants[role])]) {
      if (dryRun) {
        console.log(`${revoke ? 'would revoke' : 'would grant'} ${role} ${email}`);
        continue;
      }
      if (revoke) {
        await query('delete from roles where email = $1 and role = $2', [email, role]);
        console.log(`revoked ${role} ${email}`);
      } else {
        // Idempotent: re-running must not fail, and must not reset granted_at.
        await query(
          'insert into roles (email, role) values ($1, $2) on conflict (email, role) do nothing',
          [email, role]
        );
        console.log(`granted ${role} ${email}`);
      }
    }
  }

  const remaining = await query("select count(*)::int as n from roles where role = 'author'");
  if (remaining[0].n === 0) {
    console.log('\nWarning: no author role is granted. Nobody can publish.');
  }
}

if (process.argv[1] && process.argv[1].endsWith('grant-role.mjs')) {
  main().catch(err => {
    console.error(`Failed: ${err.message}`);
    process.exit(1);
  });
}
