const { getStore } = require('@netlify/blobs');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  // Netlify Identity injects the verified user into context when the client
  // sends: Authorization: Bearer <identity-jwt>
  const user = context.clientContext && context.clientContext.user;
  if (!user) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { title = '', text } = body;
  if (!text || !text.trim()) {
    return { statusCode: 400, body: 'Post body is required' };
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const post = {
    id,
    title: title.trim(),
    text: text.trim(),
    createdAt: Date.now(),
    author: user.email,
  };

  const store = getStore('posts');
  await store.set(id, JSON.stringify(post));

  return {
    statusCode: 201,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(post),
  };
};
