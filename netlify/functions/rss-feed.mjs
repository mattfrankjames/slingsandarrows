import { route } from '../lib/http.mjs';
import { page } from '../lib/store.mjs';
import { escapeXml, rss, FEED_LIMIT } from '../lib/xml.mjs';

export const config = { path: ['/api/rss/feed', '/feed.xml'] };

export default route(async () => {
  const { items: posts } = await page('posts', { limit: FEED_LIMIT });

  const baseUrl = 'https://slingsandarrows.band';
  const feedUrl = `${baseUrl}/feed`;
  const lastBuildDate = posts.length > 0
    ? new Date(posts[0].createdAt).toUTCString()
    : new Date().toUTCString();

  const itemsXml = posts
    .map(post => {
      const isVideo = post.imageUrl?.includes('/video/upload/');
      // The composer's Read More marker is a feed-only truncation cue —
      // RSS readers get the full post body regardless.
      const fullBody = (post.body || '').split('<!--more-->').join('').trim();
      const postUrl = `${baseUrl}/post/${encodeURIComponent(post.id)}`;
      // Embed the post's own image in the item content so readers that don't
      // support media:content/enclosure (or that scrape a thumbnail from the
      // item body) still show the post's photo instead of falling back to
      // the channel-level image (the site's static hero/background photo).
      const contentHtml = post.imageUrl && !isVideo
        ? `<img src="${escapeXml(post.imageUrl)}" alt="" />\n<p>${escapeXml(fullBody)}</p>`
        : `<p>${escapeXml(fullBody)}</p>`;

      return `
  <item>
    <title>${escapeXml(post.title || '(Untitled)')}</title>
    <link>${postUrl}</link>
    <description>${escapeXml(fullBody)}</description>
    <content:encoded><![CDATA[${contentHtml}]]></content:encoded>
    ${post.imageUrl ? `<media:content url="${escapeXml(post.imageUrl)}" medium="${isVideo ? 'video' : 'image'}" />` : ''}
    ${post.imageUrl && !isVideo ? `<enclosure url="${escapeXml(post.imageUrl)}" type="image/jpeg" length="0" />` : ''}
    <author>${escapeXml(post.author)}</author>
    <pubDate>${new Date(post.createdAt).toUTCString()}</pubDate>
    <guid isPermaLink="false">${escapeXml(post.id)}</guid>
  </item>`;
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
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

  return rss(xml);
});

