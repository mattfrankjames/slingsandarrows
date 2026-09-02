import { describe, it, expect } from 'vitest';
import { diff } from '../../scripts/compare-backends.mjs';

const post = (id, over = {}) => ({ id, title: 'T', author: 'a@x.test', likeCount: 1, ...over });

describe('backend comparison', () => {
  it('reports nothing when both sides agree', () => {
    const d = diff([post('1'), post('2')], [post('1'), post('2')]);
    expect(d).toEqual({ ordering: null, missing: [], extra: [], fields: [], counts: [] });
  });

  it('names a record missing from postgres', () => {
    const d = diff([post('1'), post('2')], [post('1')]);
    expect(d.missing).toEqual(['2']);
    expect(d.extra).toEqual([]);
  });

  it('names a record that only postgres has', () => {
    const d = diff([post('1')], [post('1'), post('2')]);
    expect(d.extra).toEqual(['2']);
  });

  /*
   * Counts are separated because a difference there may be Blobs being wrong
   * rather than the migration being wrong: they were denormalised fields
   * maintained by read-modify-write, and drifting is the bug this phase fixes.
   * Anything else differing is a mapping fault and must block.
   */
  it('separates count drift from real field differences', () => {
    const d = diff([post('1', { likeCount: 3, title: 'Old' })], [post('1', { likeCount: 2, title: 'New' })]);

    expect(d.counts).toEqual([{ id: '1', field: 'likeCount', a: 3, b: 2 }]);
    expect(d.fields).toEqual([{ id: '1', field: 'title', a: 'Old', b: 'New' }]);
  });

  it('treats every kind of count the same way', () => {
    const d = diff(
      [{ id: '1', commentCount: 1, replyCount: 2 }],
      [{ id: '1', commentCount: 9, replyCount: 9 }]
    );
    expect(d.counts).toHaveLength(2);
    expect(d.fields).toEqual([]);
  });

  it('catches a field that exists on only one side', () => {
    // A mapping that forgot to emit `imageUrl` would render a feed with no
    // images and no error anywhere.
    const d = diff([post('1', { imageUrl: 'https://x/y.jpg' })], [post('1')]);
    expect(d.fields).toEqual([
      { id: '1', field: 'imageUrl', a: 'https://x/y.jpg', b: undefined },
    ]);
  });

  it('catches reordering even when every record matches', () => {
    // The feed renders in the order it is given, so order is part of the answer.
    const d = diff([post('1'), post('2')], [post('2'), post('1')]);
    expect(d.ordering).toContain('order differs');
    expect(d.fields).toEqual([]);
  });

  it('ignores ordering of records that only one side has', () => {
    const d = diff([post('1'), post('2')], [post('1'), post('3')]);
    expect(d.ordering).toBeNull();
    expect(d.missing).toEqual(['2']);
    expect(d.extra).toEqual(['3']);
  });
});
