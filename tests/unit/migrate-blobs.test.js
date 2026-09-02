import { describe, it, expect } from 'vitest';
import { plan, ORDER, readShows } from '../../scripts/migrate-blobs-to-pg.mjs';

const post = (id, over = {}) => ({ id, body: 'a post', author: 'band@x.test', ...over });
const thread = (id, over = {}) => ({ id, title: 'T', body: 'b', author: 'f@x.test', ...over });
const comment = (id, postId, over = {}) => ({ id, postId, body: 'c', author: 'f@x.test', ...over });
const reply = (id, threadId, over = {}) => ({ id, threadId, body: 'r', author: 'f@x.test', ...over });
const like = (postId, email) => ({ postId, email });
const item = (id, over = {}) => ({ id, mediaUrl: 'https://x/y.jpg', author: 'band@x.test', ...over });

describe('migration planning', () => {
  it('writes parents before children', () => {
    // A child inserted first would violate the foreign key, so the order this
    // exports is load-bearing rather than cosmetic.
    expect(ORDER.indexOf('posts')).toBeLessThan(ORDER.indexOf('post-comments'));
    expect(ORDER.indexOf('posts')).toBeLessThan(ORDER.indexOf('post-likes'));
    expect(ORDER.indexOf('board-threads')).toBeLessThan(ORDER.indexOf('board-replies'));
  });

  it('passes everything through when the data is whole', () => {
    const { insert, skipped } = plan({
      posts: [post('p1')],
      'board-threads': [thread('t1')],
      gallery: [item('g1')],
      'post-comments': [comment('c1', 'p1')],
      'board-replies': [reply('r1', 't1')],
      'post-likes': [like('p1', 'fan@x.test')],
    });

    expect(skipped).toEqual([]);
    expect(insert.posts).toHaveLength(1);
    expect(insert['post-comments']).toHaveLength(1);
    expect(insert['post-likes']).toHaveLength(1);
  });

  /*
   * The reason this script computes a plan instead of looping over the stores.
   *
   * `delete-post` never removed a post's comments or likes — a known bug — so
   * the source data contains children whose parents are gone. Postgres will not
   * accept them, and a plain loop would abort partway with a constraint name
   * for an error message.
   */
  it('skips a comment whose post was deleted, and says which post', () => {
    const { insert, skipped } = plan({
      posts: [post('p1')],
      'post-comments': [comment('c1', 'p1'), comment('c2', 'deleted-post')],
    });

    expect(insert['post-comments'].map(c => c.id)).toEqual(['c1']);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toMatchObject({ store: 'post-comments', id: 'c2' });
    expect(skipped[0].reason).toContain('deleted-post');
    expect(skipped[0].reason).toContain('orphan');
  });

  it('skips orphaned likes and replies too', () => {
    const { insert, skipped } = plan({
      posts: [post('p1')],
      'board-threads': [thread('t1')],
      'post-likes': [like('p1', 'a@x.test'), like('gone', 'b@x.test')],
      'board-replies': [reply('r1', 't1'), reply('r2', 'gone')],
    });

    expect(insert['post-likes']).toHaveLength(1);
    expect(insert['board-replies']).toHaveLength(1);
    expect(skipped.map(s => s.store).sort()).toEqual(['board-replies', 'post-likes']);
  });

  it('identifies a skipped like by both halves of its key', () => {
    // Likes have no id of their own — they are keyed by post and person, and a
    // report saying "undefined" would be useless for finding it afterwards.
    const { skipped } = plan({ posts: [], 'post-likes': [like('gone', 'fan@x.test')] });
    expect(skipped[0].id).toBe('fan@x.test::gone');
  });

  it('skips records the schema would reject, rather than failing mid-run', () => {
    const { insert, skipped } = plan({
      posts: [post('p1'), post('p2', { body: '' })],
      gallery: [item('g1'), item('g2', { mediaUrl: '' }), item('g3', { mediaType: 'audio' })],
    });

    expect(insert.posts.map(p => p.id)).toEqual(['p1']);
    expect(insert.gallery.map(g => g.id)).toEqual(['g1']);
    expect(skipped.map(s => s.reason)).toEqual([
      'body is empty',
      'mediaUrl is empty',
      'mediaType "audio" is neither image nor video',
    ]);
  });

  it('handles a store being absent entirely', () => {
    const { insert, skipped } = plan({ posts: [post('p1')] });
    expect(skipped).toEqual([]);
    expect(insert['post-comments']).toEqual([]);
    expect(Object.keys(insert).sort()).toEqual([...ORDER].sort());
  });
});

describe('shows.json', () => {
  it('derives stable, unique ids from date and venue', () => {
    const shows = readShows();
    expect(shows.length).toBeGreaterThan(0);
    expect(new Set(shows.map(s => s.id)).size).toBe(shows.length);
    // Stable across reordering, because it is derived rather than positional.
    expect(readShows().map(s => s.id)).toEqual(shows.map(s => s.id));
  });

  it('carries lineup and setlist through as arrays', () => {
    const show = readShows().find(s => s.show_date === '2026-09-16');
    expect(show.venue).toBe('The Heavy Anchor');
    expect(show.lineup).toEqual(['Unwed Sailor', 'Flow Clinic']);
    expect(Array.isArray(show.setlist)).toBe(true);
  });
});
