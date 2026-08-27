import { describe, it, expect } from 'vitest';
import { selectPage } from '../../netlify/lib/store.mjs';

// Deliberately unsorted, the way list() hands them over.
const KEYS = ['3-c', '1-a', '5-e', '2-b', '4-d'];

describe('selectPage', () => {
  it('returns newest first by default', () => {
    expect(selectPage(KEYS, { limit: 2 }).keys).toEqual(['5-e', '4-d']);
  });

  it('reads oldest first when asked', () => {
    expect(selectPage(KEYS, { limit: 2, order: 'asc' }).keys).toEqual(['1-a', '2-b']);
  });

  it('reports the full total, not the page size', () => {
    expect(selectPage(KEYS, { limit: 2 }).total).toBe(5);
  });

  it('uses the last key of the page as the cursor', () => {
    expect(selectPage(KEYS, { limit: 2 }).nextCursor).toBe('4-d');
  });

  it('returns everything and no cursor when unlimited', () => {
    const page = selectPage(KEYS);
    expect(page.keys).toHaveLength(5);
    expect(page.nextCursor).toBeNull();
  });

  it('has no cursor when the limit exceeds the store', () => {
    expect(selectPage(KEYS, { limit: 99 }).nextCursor).toBeNull();
  });

  it('handles an empty store', () => {
    const page = selectPage([], { limit: 5 });
    expect(page.keys).toEqual([]);
    expect(page.total).toBe(0);
    expect(page.nextCursor).toBeNull();
  });

  it('does not mutate the caller\'s array', () => {
    const original = [...KEYS];
    selectPage(KEYS, { limit: 2 });
    expect(KEYS).toEqual(original);
  });

  // A cursor can outlive the record it points at. Restarting repeats a page,
  // which is recoverable; truncating silently loses records, which is not.
  it('restarts rather than truncating on an unknown cursor', () => {
    expect(selectPage(KEYS, { limit: 2, cursor: 'deleted-since' }).keys).toEqual(['5-e', '4-d']);
  });

  describe('walking every page', () => {
    const walk = (keys, limit, order) => {
      const seen = [];
      let cursor = null;
      for (let guard = 0; guard < 100; guard++) {
        const page = selectPage(keys, { limit, cursor, order });
        seen.push(...page.keys);
        if (!page.nextCursor) return seen;
        cursor = page.nextCursor;
      }
      throw new Error('paging did not terminate');
    };

    it.each([1, 2, 3, 5])('visits each key exactly once at limit=%i', limit => {
      expect(walk(KEYS, limit)).toEqual(['5-e', '4-d', '3-c', '2-b', '1-a']);
    });

    it('terminates when the page size divides the total exactly', () => {
      // The off-by-one trap: a final page that is exactly full must not
      // advertise another page that would come back empty.
      expect(walk(['1-a', '2-b', '3-c', '4-d'], 2)).toEqual(['4-d', '3-c', '2-b', '1-a']);
    });

    it('works ascending too', () => {
      expect(walk(KEYS, 2, 'asc')).toEqual(['1-a', '2-b', '3-c', '4-d', '5-e']);
    });

    it('scales to a realistic store without duplicating or dropping', () => {
      const many = Array.from({ length: 97 }, (_, i) => `${1700000000000 + i}-x`);
      const seen = walk(many, 10);
      expect(seen).toHaveLength(97);
      expect(new Set(seen).size).toBe(97);
    });
  });
});
