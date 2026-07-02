import { getStore } from '@netlify/blobs';

function getUserFromRequest(req, context) {
  if (context.clientContext?.user) {
    return context.clientContext.user;
  }

  const auth = req.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  try {
    const payload = token.split('.')[1];
    const decoded = JSON.parse(
      Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    );
    return decoded.email ? { email: decoded.email } : null;
  } catch {
    return null;
  }
}

export default async (req, context) => {
  if (req.method !== 'DELETE') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    // ── Authentication ────────────────────────────────────────────────────
    const user = getUserFromRequest(req, context);
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Authorization — ALLOWED_AUTHORS only ──────────────────────────────
    const allowed = (process.env.ALLOWED_AUTHORS || '')
      .split(',')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean);

    if (!allowed.includes((user.email || '').toLowerCase())) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
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

    // ── Delete the thread ─────────────────────────────────────────────────
    const threadStore = getStore('board-threads');
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

export const config = { path: '/api/board/threads/delete' };
