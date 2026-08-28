/**
 * Eleventy renders the page shells; Parcel still owns the asset pipeline.
 *
 * Two stages rather than one. Eleventy writes HTML plus a copy of everything
 * those pages reference into .eleventy/, and Parcel builds from there into
 * dist/ exactly as it did from src/ before. Keeping Parcel means the asset
 * hashing, the service-worker importmap and the manifest transform all keep
 * working — replacing them at the same time as the templating would be two
 * risky changes wearing one coat.
 *
 * The includes live in core/ and the data in site/, which is the boundary from
 * step 1 doing real work: a layout cannot name this band, only read it.
 */
export default function (eleventyConfig) {
  // Copied through untouched for Parcel to pick up and hash.
  eleventyConfig.addPassthroughCopy({ 'src/core/js': 'core/js' });
  eleventyConfig.addPassthroughCopy({ 'src/core/styles': 'core/styles' });
  eleventyConfig.addPassthroughCopy({ 'src/site': 'site' });
  eleventyConfig.addPassthroughCopy({ 'src/sw.js': 'sw.js' });

  // Eleventy's own directories are not site content.
  eleventyConfig.ignores.add('src/site/_data/**');

  // The copyright year, previously produced by a document.write() in each
  // page's footer. It is known at build time.
  eleventyConfig.addGlobalData('buildYear', () => new Date().getFullYear());

  // Pages are written flat (/feed.html) so that relative asset paths and the
  // existing netlify.toml rewrites keep working. Visitors only ever see the
  // clean URL, so that is what canonical, og:url and twitter:url must use.
  eleventyConfig.addFilter('cleanUrl', url =>
    String(url).replace(/index\.html$/, '').replace(/\.html$/, '')
  );

  return {
    dir: {
      input: 'src',
      output: '.eleventy',
      includes: 'core/_includes',
      data: 'site/_data',
    },
    htmlTemplateEngine: 'njk',
    markdownTemplateEngine: 'njk',
  };
}
