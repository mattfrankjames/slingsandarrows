/**
 * Role granting, and the admin fallback it deliberately refuses to reproduce.
 *
 * Phase 4 moved authorship out of ALLOWED_AUTHORS / ALLOWED_ADMINS and into a
 * table, and nothing carried the values across. The `roles` table was empty on
 * Postgres, so an account that could publish in production could not publish on
 * a preview — and no test noticed, because every read path works without a role
 * and the read paths are what the suites exercise.
 */

import { describe, it, expect } from 'vitest';
import { parseArgs, parseList, planFromEnv } from '../../scripts/grant-role.mjs';

describe('parseList', () => {
  it('lowercases, trims and de-duplicates', () => {
    expect(parseList(' A@x.com , a@X.com ,b@x.com ')).toEqual(['a@x.com', 'b@x.com']);
  });

  it('is empty for an unset variable rather than [""]', () => {
    expect(parseList('')).toEqual([]);
    expect(parseList(undefined)).toEqual([]);
  });

  it('drops empty entries from a trailing comma', () => {
    expect(parseList('a@x.com,')).toEqual(['a@x.com']);
  });
});

describe('parseArgs', () => {
  it('collects grants by role', () => {
    const { grants } = parseArgs(['--author', 'a@x.com', '--admin', 'b@x.com']);
    expect(grants).toEqual({ author: ['a@x.com'], admin: ['b@x.com'] });
  });

  // The schema has `check (email = lower(email))`, so this is a constraint
  // violation rather than a quietly separate row.
  it('lowercases addresses to match the column check', () => {
    expect(parseArgs(['--author', 'A@X.com']).grants.author).toEqual(['a@x.com']);
  });

  it('sets the flags it is given', () => {
    const parsed = parseArgs(['--revoke', '--dry-run', '--admin', 'a@x.com']);
    expect(parsed.revoke).toBe(true);
    expect(parsed.dryRun).toBe(true);
  });

  // `--author --admin b@x.com` would otherwise grant author to the literal
  // string "--admin" and silently drop the real grant.
  it('rejects a flag where an address should be', () => {
    expect(() => parseArgs(['--author', '--admin', 'b@x.com'])).toThrow(/needs an email/);
  });

  it('rejects a missing address at the end', () => {
    expect(() => parseArgs(['--author'])).toThrow(/needs an email/);
  });

  it('rejects something that is not an address', () => {
    expect(() => parseArgs(['--author', 'matt'])).toThrow(/not an email/);
  });

  it('rejects an unknown argument rather than ignoring it', () => {
    expect(() => parseArgs(['--owner', 'a@x.com'])).toThrow(/Unknown argument/);
  });
});

describe('planFromEnv', () => {
  it('reads both lists when both are set', () => {
    const plan = planFromEnv({ ALLOWED_AUTHORS: 'a@x.com,b@x.com', ALLOWED_ADMINS: 'a@x.com' });
    expect(plan.authors).toEqual(['a@x.com', 'b@x.com']);
    expect(plan.admins).toEqual(['a@x.com']);
    expect(plan.unstatedAdmins).toEqual([]);
  });

  // The env path falls back to ALLOWED_AUTHORS when ALLOWED_ADMINS is unset, so
  // every author is an admin. Widening a delete-anyone's-content privilege is
  // not something to do on inference: report it, grant nothing.
  it('does not invent admins when ALLOWED_ADMINS is unset', () => {
    const plan = planFromEnv({ ALLOWED_AUTHORS: 'a@x.com,b@x.com' });
    expect(plan.admins).toEqual([]);
    expect(plan.unstatedAdmins).toEqual(['a@x.com', 'b@x.com']);
  });

  it('treats an empty ALLOWED_ADMINS the same as unset', () => {
    expect(planFromEnv({ ALLOWED_AUTHORS: 'a@x.com', ALLOWED_ADMINS: '  ' }).unstatedAdmins).toEqual(
      ['a@x.com']
    );
  });

  it('has nothing to do when neither is set', () => {
    const plan = planFromEnv({});
    expect(plan.authors).toEqual([]);
    expect(plan.unstatedAdmins).toEqual([]);
  });
});
