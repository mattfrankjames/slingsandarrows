import { getStore } from '@netlify/blobs';

export const config = { path: '/api/board/get-replies' };

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const url      = new URL(req.url);
  const threadId = url.searchParams.get('threadId');

  if (!threadId) {
    return new Response(JSON.stringify({ error: 'Missing threadId' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const store = getStore('board-replies');
    const { blobs } = await store.list({ prefix: `${threadId}/` });

    if (!blobs.length) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        },
      });
    }

    const replies = (
      await Promise.all(blobs.map(({ key }) => store.get(key, { type: 'json' })))
    ).filter(Boolean);

    // Sort oldest first so replies read chronologically
    replies.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

    return new Response(JSON.stringify(replies), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('[get-replies] error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
