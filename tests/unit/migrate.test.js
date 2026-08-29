import { describe, it, expect } from 'vitest';
import { plan, readMigrations } from '../../scripts/migrate.mjs';

const m = (name, checksum) => ({ name, checksum, sql: '' });

describe('migration planning', () => {
  it('treats everything as pending against an empty database', () => {
    const available = [m('0001_a', 'aaa'), m('0002_b', 'bbb')];
    expect(plan(available, []).pending.map(p => p.name)).toEqual(['0001_a', '0002_b']);
  });

  it('applies nothing when everything has run', () => {
    const available = [m('0001_a', 'aaa')];
    const { pending, altered } = plan(available, [{ name: '0001_a', checksum: 'aaa' }]);
    expect(pending).toEqual([]);
    expect(altered).toEqual([]);
  });

  it('only runs the new one when a migration is added', () => {
    const available = [m('0001_a', 'aaa'), m('0002_b', 'bbb')];
    const { pending } = plan(available, [{ name: '0001_a', checksum: 'aaa' }]);
    expect(pending.map(p => p.name)).toEqual(['0002_b']);
  });

  /*
   * The check that earns its keep.
   *
   * Editing an applied migration is the easiest way to end up with two
   * databases that disagree while both report being up to date: the change
   * reaches every environment created afterwards and none created before. It
   * cannot be detected by name, only by content.
   */
  it('refuses to ignore a migration that changed after it was applied', () => {
    const available = [m('0001_a', 'EDITED')];
    const { pending, altered } = plan(available, [{ name: '0001_a', checksum: 'aaa' }]);
    expect(altered).toEqual(['0001_a']);
    expect(pending, 'an altered migration must not be re-run silently').toEqual([]);
  });

  it('reads the real migrations directory in filename order', () => {
    const found = readMigrations();
    expect(found.length).toBeGreaterThan(0);
    expect(found.map(f => f.name)).toEqual([...found.map(f => f.name)].sort());
    expect(found[0].name).toBe('0001_initial_schema.sql');
    // A checksum has to actually depend on the contents.
    expect(found[0].checksum).toMatch(/^[0-9a-f]{16}$/);
  });
});
