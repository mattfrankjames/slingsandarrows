import { getStore } from '@netlify/blobs';
import { getUser, isAuthor } from '../lib/auth.mjs';

export default async (req, context) => {
  try {
    if (req.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const user = await getUser(req);
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (!isAuthor(user)) {
      return new Response(JSON.stringify({ error: 'Forbidden' }), {
        status: 403,
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

    const { title, body: postBody, imageUrl } = body;
    if (!postBody || !postBody.trim()) {
      return new Response(JSON.stringify({ error: 'Post body is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Only allow Cloudinary URLs — reject anything else
    const rawImage = (imageUrl || '').trim();
    const safeImageUrl = rawImage.startsWith('https://res.cloudinary.com/') ? rawImage : '';

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const post = {
      id,
      title: (title || '').trim(),
      body: postBody.trim(),
      imageUrl: safeImageUrl,
      author: user.email,
      createdAt: new Date().toISOString(),
    };

    const store = getStore('posts');
    await store.setJSON(id, post);

    return new Response(JSON.stringify(post), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('create-post error:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};

export const config = { path: '/api/create-post' };
