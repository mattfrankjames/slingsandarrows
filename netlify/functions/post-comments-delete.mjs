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

    const { postId, commentId } = body;
    if (!postId || typeof postId !== 'string') {
      return new Response(JSON.stringify({ error: 'postId is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (!commentId || typeof commentId !== 'string') {
      return new Response(JSON.stringify({ error: 'commentId is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Authorization — owner or admin ────────────────────────────────────
    const commentStore = getStore('post-comments');
    const comment = await commentStore.get(`${postId}/${commentId}`, { type: 'json' });
    if (!comment) {
      return new Response(JSON.stringify({ error: 'Comment not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!canModerate(user, comment.author)) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // ── Delete the comment blob ───────────────────────────────────────────
    await commentStore.delete(`${postId}/${commentId}`);

    // ── Decrement comment count on the parent post ────────────────────────
    const postStore = getStore('posts');
    const post = await postStore.get(postId, { type: 'json' });
    if (post) {
      post.commentCount = Math.max(0, (post.commentCount || 1) - 1);
      await postStore.setJSON(postId, post);
    }

    return new Response(JSON.stringify({ success: true, postId, commentId }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('post-comments-delete error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/api/posts/comments/delete', method: ['DELETE', 'POST'] };
