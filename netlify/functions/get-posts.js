const { getStore } = require('@netlify/blobs');

exports.handler = async () => {
  const store = getStore('posts');
  const { blobs } = await store.list();

  const posts = await Promise.all(
    blobs.map(async ({ key }) => {
      const raw = await store.get(key);
      return JSON.parse(raw);
    })
  );

  posts.sort((a, b) => b.createdAt - a.createdAt);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(posts),
  };
};
