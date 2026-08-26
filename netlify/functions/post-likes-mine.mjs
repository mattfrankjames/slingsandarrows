import { getStore } from '@netlify/blobs';
import { getUser } from '../lib/auth.mjs';

// Returns the postIds the signed-in user has liked, via a single prefix
// query against the email-first `${email}::${postId}` keys — lets the feed
// initialise heart-fill state for every post in one request.
export default async (req, context) => {
  if (req.method !== 'GET') {
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

    const email = (user.email || '').toLowerCase();
    const store = getStore('post-likes');
    const { blobs } = await store.list({ prefix: `${email}::` });

    const postIds = blobs.map(({ key }) => key.slice(`${email}::`.length));

    return new Response(JSON.stringify({ postIds }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('post-likes-mine error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/api/posts/likes/mine' };
