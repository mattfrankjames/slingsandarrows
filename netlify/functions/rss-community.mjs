import { route } from '../lib/http.mjs';
import { page } from '../lib/store.mjs';
import { escapeXml, rss, FEED_LIMIT } from '../lib/xml.mjs';

export const config = { path: ['/api/rss/community', '/community.xml'] };

export default route(async () => {
  const { items: threads } = await page('board-threads', { limit: FEED_LIMIT });

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

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
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

  return rss(xml);
});

