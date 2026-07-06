import { getStore } from '@netlify/blobs';

export const config = { path: '/api/rss/community' };

export default async (req) => {
  if (req.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    const store = getStore('board-threads');
    const { blobs } = await store.list();

    const threads = (
      await Promise.all(blobs.map(({ key }) => store.get(key, { type: 'json' })))
    ).filter(Boolean);

    threads.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const baseUrl = 'https://slingsandarrows.band';
    const communityUrl = `${baseUrl}/community`;
    const lastBuildDate = threads.length > 0
      ? new Date(threads[0].createdAt).toUTCString()
      : new Date().toUTCString();

    const itemsXml = threads
      .map(thread => `
    <item>
      <title>${escapeXml(thread.title)}</title>
      <link>${communityUrl}#thread-${escapeXml(thread.id)}</link>
      <description>${escapeXml(thread.body)}</description>
      <author>${escapeXml(thread.author)}</author>
      <pubDate>${new Date(thread.createdAt).toUTCString()}</pubDate>
      <guid isPermaLink="false">${escapeXml(thread.id)}</guid>
      <comments>${thread.replyCount || 0}</comments>
    </item>`)
      .join('\n');

    const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>Slings &amp; Arrows | Community</title>
    <link>${communityUrl}</link>
    <description>Discussion threads from the Slings &amp; Arrows community</description>
    <language>en-us</language>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
    <image>
      <url>https://res.cloudinary.com/mjtestrun/image/upload/f_auto,q_80,w_200/v1738006890/hero_paeruh</url>
      <title>Slings &amp; Arrows | Community</title>
      <link>${communityUrl}</link>
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
    console.error('rss-community error:', err);
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
