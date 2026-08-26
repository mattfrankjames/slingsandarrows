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

    const { threadId, replyId } = body;
    if (!threadId || typeof threadId !== 'string') {
      return new Response(JSON.stringify({ error: 'threadId is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!replyId || typeof replyId !== 'string') {
      return new Response(JSON.stringify({ error: 'replyId is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Authorization — owner or admin ────────────────────────────────────
    const replyStore = getStore('board-replies');
    const reply = await replyStore.get(`${threadId}/${replyId}`, { type: 'json' });
    if (!reply) {
      return new Response(JSON.stringify({ error: 'Reply not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!canModerate(user, reply.author)) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Delete the reply blob ─────────────────────────────────────────────
    await replyStore.delete(`${threadId}/${replyId}`);

    // ── Decrement reply count on the parent thread ────────────────────────
    const threadStore = getStore('board-threads');
    const thread = await threadStore.get(threadId, { type: 'json' });
    if (thread) {
      thread.replyCount = Math.max(0, (thread.replyCount || 1) - 1);
      await threadStore.setJSON(threadId, thread);
    }

    return new Response(JSON.stringify({ success: true, threadId, replyId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('board-delete-reply error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/api/board/replies/delete', method: ['DELETE', 'POST'] };
