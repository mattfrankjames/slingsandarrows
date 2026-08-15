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

// Likes are keyed `${email}::${postId}` in the 'post-likes' store — the
// email-first key lets post-likes-mine.mjs list a user's likes with a single
// prefix query, while a toggle here is still an exact-key lookup.
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

    const { postId } = body;
    if (!postId || typeof postId !== 'string') {
      return new Response(JSON.stringify({ error: 'postId is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const postStore = getStore('posts');
    const post = await postStore.get(postId, { type: 'json' });
    if (!post) {
      return new Response(JSON.stringify({ error: 'Post not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const email = (user.email || '').toLowerCase();
    const likeStore = getStore('post-likes');
    const likeKey = `${email}::${postId}`;
    const existing = await likeStore.get(likeKey);

    let liked;
    if (existing) {
      await likeStore.delete(likeKey);
      post.likeCount = Math.max(0, (post.likeCount || 1) - 1);
      liked = false;
    } else {
      await likeStore.setJSON(likeKey, { postId, email, createdAt: new Date().toISOString() });
      post.likeCount = (post.likeCount || 0) + 1;
      liked = true;
    }

    await postStore.setJSON(postId, post);

    return new Response(JSON.stringify({ liked, likeCount: post.likeCount }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('post-likes-toggle error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/api/posts/likes/toggle' };
