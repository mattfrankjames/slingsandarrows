const { getStore } = require('@netlify/blobs');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const store = getStore('posts');
  const { blobs } = await store.list();

  if (!blobs.length) {
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
      },
      body: '[]',
    };
  }

  const posts = (
    await Promise.all(blobs.map(({ key }) => store.get(key, { type: 'json' })))
  ).filter(Boolean);

  posts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60',
    },
    body: JSON.stringify(posts),
  };
};
