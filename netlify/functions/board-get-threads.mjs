import { getStore } from '@netlify/blobs';

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const store = getStore('board-threads');
    const { blobs } = await store.list();

    if (!blobs.length) {
      return new Response('[]', {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=30',
        },
      });
    }

    const threads = (
      await Promise.all(blobs.map(({ key }) => store.get(key, { type: 'json' })))
    ).filter(Boolean);

    threads.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    // Reconcile each thread's replyCount against the actual stored replies so
    // the badge shown before a user opens the thread is always accurate.
    const replyStore = getStore('board-replies');
    await Promise.all(threads.map(async thread => {
      try {
        const { blobs: replyBlobs } = await replyStore.list({ prefix: `${thread.id}/` });
        const actualCount = replyBlobs.length;
        if (thread.replyCount !== actualCount) {
          thread.replyCount = actualCount;
          // Persist the corrected value so future reads are cheaper
          await store.setJSON(thread.id, thread);
        }
      } catch {
        // If the reply store is unavailable, leave the stored count as-is
      }
    }));

    return new Response(JSON.stringify(threads), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=30',
      },
    });
  } catch (err) {
    console.error('board-get-threads error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/api/board/threads' };
