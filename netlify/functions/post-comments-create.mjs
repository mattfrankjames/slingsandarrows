import { getStore } from '@netlify/blobs';
import { getUser } from '../lib/auth.mjs';

export default async (req, context) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const user = await getUser(req);
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

    const { postId, body: commentBody } = body;

    if (!postId || typeof postId !== 'string') {
      return new Response(JSON.stringify({ error: 'postId is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!commentBody || !commentBody.trim()) {
      return new Response(JSON.stringify({ error: 'Comment body is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Verify the post exists
    const postStore = getStore('posts');
    const post = await postStore.get(postId, { type: 'json' });
    if (!post) {
      return new Response(JSON.stringify({ error: 'Post not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const commentId = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const comment = {
      id: commentId,
      postId,
      body: commentBody.trim().slice(0, 2000),
      author: user.email,
      createdAt: new Date().toISOString(),
    };

    // Store comment under a namespaced key: postId/commentId
    const commentStore = getStore('post-comments');
    await commentStore.setJSON(`${postId}/${commentId}`, comment);

    // Keep a running count on the post for cheap feed-list display
    post.commentCount = (post.commentCount || 0) + 1;
    await postStore.setJSON(postId, post);

    return new Response(JSON.stringify(comment), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('post-comments-create error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/api/posts/comments/create' };
