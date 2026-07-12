import { getStore } from '@netlify/blobs';

export const config = { path: ['/api/rss/feed', '/feed.xml'] };

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const store = getStore('posts');
    const { blobs } = await store.list();

    const posts = (
      await Promise.all(blobs.map(({ key }) => store.get(key, { type: 'json' })))
    ).filter(Boolean);

    posts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const baseUrl = 'https://slingsandarrows.band';
    const feedUrl = `${baseUrl}/feed`;
    const lastBuildDate = posts.length > 0
      ? new Date(posts[0].createdAt).toUTCString()
      : new Date().toUTCString();

    const itemsXml = posts
      .map(post => `
    <item>
      <title>${escapeXml(post.title || '(Untitled)')}</title>
      <link>${feedUrl}#post-${escapeXml(post.id)}</link>
      <description>${escapeXml(post.body)}</description>
      ${post.imageUrl ? `<media:content url="${escapeXml(post.imageUrl)}" medium="${post.imageUrl.includes('/video/upload/') ? 'video' : 'image'}" />` : ''}
      <author>${escapeXml(post.author)}</author>
      <pubDate>${new Date(post.createdAt).toUTCString()}</pubDate>
      <guid isPermaLink="false">${escapeXml(post.id)}</guid>
    </item>`)
      .join('\n');

    const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Slings &amp; Arrows | Feed</title>
    <link>${feedUrl}</link>
    <description>Latest posts from Slings &amp; Arrows</description>
    <language>en-us</language>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
    <image>
      <url>https://res.cloudinary.com/mjtestrun/image/upload/f_auto,q_80,w_200/v1738006890/hero_paeruh</url>
      <title>Slings &amp; Arrows | Feed</title>
      <link>${feedUrl}</link>
    </image>
    ${itemsXml}
  </channel>
</rss>`;

    return new Response(rss, {
      status: 200,
      headers: {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
      },
    });
  } catch (err) {
    console.error('rss-feed error:', err);
    return new Response(`Error: ${err.message}`, { status: 500 });
  }
};

function escapeXml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
