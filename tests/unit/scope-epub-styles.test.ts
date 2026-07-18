import { describe, it, expect } from 'vitest';
import { scopeEpubStyles } from '../../src/components/BilingualReaderV2';

describe('scopeEpubStyles', () => {
  it('scopes selectors under .epub-content', () => {
    expect(scopeEpubStyles('p { margin: 1em; }')).toContain(
      '.epub-content p {'
    );
  });

  it('drops body/html rules', () => {
    const out = scopeEpubStyles('body { text-align: center; }');
    expect(out).toContain('.epub-content :not(*)');
  });

  it('strips color declarations so the theme owns text color', () => {
    const out = scopeEpubStyles('p { color: #333; margin: 1em; }');
    expect(out).not.toContain('color: #333');
    expect(out).toContain('margin: 1em');
  });

  it('strips background-color and colored background shorthands', () => {
    const out = scopeEpubStyles(
      'div { background-color: #fff; } span { background: black; }'
    );
    expect(out).not.toContain('background-color');
    expect(out).not.toContain('background: black');
  });

  it('keeps background shorthands that reference images', () => {
    const out = scopeEpubStyles(
      '.hero { background: url(cover.png) no-repeat; }'
    );
    expect(out).toContain('url(cover.png)');
  });

  it('strips colors inside @media blocks too', () => {
    const out = scopeEpubStyles(
      '@media (max-width: 600px) { p { color: black; font-size: 12px; } }'
    );
    expect(out).not.toContain('color: black');
    expect(out).toContain('font-size: 12px');
  });

  it('keeps non-color declarations intact', () => {
    const css = 'em { font-style: italic; text-indent: 2em; }';
    const out = scopeEpubStyles(css);
    expect(out).toContain('font-style: italic');
    expect(out).toContain('text-indent: 2em');
  });
});
