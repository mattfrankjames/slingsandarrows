import { describe, it, expect } from 'vitest';
import { renderBodyHtml } from '../../src/core/js/lib/post-body.js';

const SNIPPET =
  '<iframe width="560" height="315" src="https://www.youtube.com/embed/Ftu7pi6OdOg?si=TCvElBs3eMsjC7PB" ' +
  'title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; ' +
  'gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>';

const PLAYER = 'src="https://www.youtube-nocookie.com/embed/Ftu7pi6OdOg"';

describe('renderBodyHtml', () => {
  it('escapes arbitrary HTML', () => {
    expect(renderBodyHtml('<b>hi</b> & <script>x</script>')).toBe(
      '&lt;b&gt;hi&lt;/b&gt; &amp; &lt;script&gt;x&lt;/script&gt;'
    );
  });

  it('converts [text](url) links', () => {
    expect(renderBodyHtml('[Tix](https://a.test/x)')).toBe(
      '<a href="https://a.test/x" target="_blank" rel="noopener noreferrer">Tix</a>'
    );
  });

  it("turns YouTube's embed snippet into our own player", () => {
    const html = renderBodyHtml(`If you missed us, watch on YouTube.\n\n${SNIPPET}`);
    expect(html.startsWith('If you missed us, watch on YouTube.\n<span class="post-embed">')).toBe(true);
    expect(html).toContain(PLAYER);
    expect(html).not.toContain('si=');
    expect(html).not.toContain('&lt;iframe');
  });

  it('embeds bare YouTube URLs on their own line', () => {
    for (const url of [
      'https://www.youtube.com/watch?v=Ftu7pi6OdOg',
      'https://youtu.be/Ftu7pi6OdOg?si=abc',
      'https://m.youtube.com/watch?feature=share&v=Ftu7pi6OdOg',
      'https://www.youtube.com/shorts/Ftu7pi6OdOg',
    ]) {
      expect(renderBodyHtml(`Look:\n${url}\nNice`)).toContain(PLAYER);
    }
  });

  it('leaves a YouTube URL inside a sentence as text', () => {
    const html = renderBodyHtml('see https://youtu.be/Ftu7pi6OdOg now');
    expect(html).not.toContain('<iframe');
  });

  it('does not embed non-YouTube iframes or keep injected attributes', () => {
    expect(renderBodyHtml('<iframe src="https://evil.test/embed/Ftu7pi6OdOg"></iframe>')).not.toContain('<iframe');
    const html = renderBodyHtml(
      '<iframe onload="alert(1)" src="https://www.youtube.com/embed/Ftu7pi6OdOg"></iframe>'
    );
    expect(html).toContain(PLAYER);
    expect(html).not.toContain('onload');
  });

  it('ignores placeholder characters typed into the body', () => {
    expect(renderBodyHtml('0')).toBe('0');
  });
});
