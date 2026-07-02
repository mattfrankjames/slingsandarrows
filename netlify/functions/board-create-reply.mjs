import { getStore } from '@netlify/blobs';

export const config = { path: '/api/board/create-reply' };

function getUserFromRequest(req, context) {
  if (context.clientContext?.user) {
    return context.clientContext.user;
  }

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
    console.error('[create-reply] JWT decode error:', err);
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

    const { threadId, body: content } = body;

    if (!threadId?.trim() || !content?.trim()) {
      return new Response(JSON.stringify({ error: 'threadId and body are required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Verify the thread exists
    const threadStore = getStore('board-threads');
    const thread      = await threadStore.get(threadId, { type: 'json' });
    if (!thread) {
      return new Response(JSON.stringify({ error: 'Thread not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Create the reply
    const replyId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const reply   = {
      id:        replyId,
      threadId:  threadId.trim(),
      body:      content.trim(),
      author:    user.email,
      createdAt: new Date().toISOString(),
    };

    // Store reply keyed as threadId/replyId so we can list by prefix
    const replyStore = getStore('board-replies');
    await replyStore.setJSON(`${threadId}/${replyId}`, reply);

    // Increment the thread's replyCount
    const updatedThread = { ...thread, replyCount: (thread.replyCount || 0) + 1 };
    await threadStore.setJSON(threadId, updatedThread);

    return new Response(JSON.stringify(reply), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('[create-reply] error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
