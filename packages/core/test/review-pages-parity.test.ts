import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pageMentions, stripUnsupportedPages } from '../src/review.js';

const fixture = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'fixtures',
      'review-pages-parity.json'
    ),
    'utf8'
  )
) as {
  text: string;
  allowed: number[];
  mentions: Array<{ raw: string; page: number | null }>;
  cleaned: string;
  removed: string[];
};

describe('review page mention parity with Python', () => {
  it('finds page mentions including Chinese numerals', () => {
    expect(pageMentions(fixture.text)).toEqual(fixture.mentions);
  });

  it('strips unsupported page mentions only', () => {
    expect(stripUnsupportedPages(fixture.text, new Set(fixture.allowed))).toEqual({
      text: fixture.cleaned,
      removed: fixture.removed
    });
  });
});
