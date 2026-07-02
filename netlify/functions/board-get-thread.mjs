import { getStore } from '@netlify/blobs';

export const config = { path: '/api/board/get-thread' };

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  const url      = new URL(req.url);
  const threadId = url.searchParams.get('id');

  if (!threadId) {
    return new Response(JSON.stringify({ error: 'Missing thread id' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const store  = getStore('board-threads');
    const thread = await store.get(threadId, { type: 'json' });

    if (!thread) {
      return new Response(JSON.stringify({ error: 'Thread not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify(thread), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('[get-thread] error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
