const { getStore } = require('@netlify/blobs');

exports.handler = async (event, context) => {
  try {
    if (event.httpMethod !== 'POST') {
      return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const { user } = context.clientContext || {};
    if (!user) {
      return {
        statusCode: 401,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Unauthorized' }),
      };
    }

    const allowed = (process.env.ALLOWED_AUTHORS || '')
      .split(',')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean);

    if (!allowed.includes((user.email || '').toLowerCase())) {
      return {
        statusCode: 403,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Forbidden' }),
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(event.body);
    } catch {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Invalid JSON body' }),
      };
    }

    const { title, body: postBody } = parsed;
    if (!postBody || !postBody.trim()) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Post body is required' }),
      };
    }

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const post = {
      id,
      title: (title || '').trim(),
      body: postBody.trim(),
      author: user.email,
      createdAt: new Date().toISOString(),
    };

    const store = getStore('posts');
    await store.setJSON(id, post);

    return {
      statusCode: 201,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(post),
    };
  } catch (err) {
    console.error('create-post error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
