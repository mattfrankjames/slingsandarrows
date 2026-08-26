import { getStore } from '@netlify/blobs';
import { getUser, canModerate } from '../lib/auth.mjs';

export default async (req, context) => {
  if (req.method !== 'DELETE' && req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    // ── Authentication ────────────────────────────────────────────────────
    const user = await getUser(req);
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Parse body ────────────────────────────────────────────────────────
    let body;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { id } = body;
    if (!id || typeof id !== 'string') {
      return new Response(JSON.stringify({ error: 'Thread ID is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Authorization — owner or admin ────────────────────────────────────
    const threadStore = getStore('board-threads');
    const thread = await threadStore.get(id, { type: 'json' });
    if (!thread) {
      return new Response(JSON.stringify({ error: 'Thread not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!canModerate(user, thread.author)) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Delete the thread ─────────────────────────────────────────────────
    await threadStore.delete(id);

    // ── Delete all replies that belong to this thread ─────────────────────
    // Replies are keyed as `{threadId}/{replyId}`, so we can list by prefix.
    const replyStore = getStore('board-replies');
    const { blobs } = await replyStore.list({ prefix: `${id}/` });
    await Promise.all(blobs.map(({ key }) => replyStore.delete(key)));

    return new Response(JSON.stringify({ success: true, id, repliesDeleted: blobs.length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('board-delete-thread error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/api/board/threads/delete', method: ['DELETE', 'POST'] };
