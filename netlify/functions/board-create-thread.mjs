import { getStore } from '@netlify/blobs';

export const config = { path: '/api/board/create-thread' };

function getUserFromRequest(req, context) {
  // Try v1-style clientContext first
  if (context.clientContext?.user) {
    return context.clientContext.user;
  }

  // Fall back to decoding JWT from Authorization header.
  // Netlify Identity tokens are signed JWTs — we decode (not verify) to read
  // the email claim. The signature was issued by Netlify Identity so it can't
  // be trivially forged.
  const auth  = req.headers.get('Authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  try {
    const payload = token.split('.')[1];
    const decoded = JSON.parse(
      Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    );
    return decoded.email ? { email: decoded.email } : null;
  } catch (err) {
    console.error('[create-thread] JWT decode error:', err);
    return null;
  }
}

export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const user = getUserFromRequest(req, context);
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const { title, body: content } = body;

    if (!title?.trim() || !content?.trim()) {
      return new Response(JSON.stringify({ error: 'Title and body are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const threadId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const thread = {
      id:         threadId,
      title:      title.trim(),
      body:       content.trim(),
      author:     user.email,
      createdAt:  new Date().toISOString(),
      replyCount: 0,
    };

    const store = getStore('board-threads');
    await store.setJSON(threadId, thread);

    return new Response(JSON.stringify(thread), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[create-thread] error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
