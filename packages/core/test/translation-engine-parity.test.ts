import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildPrompt,
  detectLanguage,
  looksUnfinished,
  mapSentenceSpan,
  mapSentences,
  normalize,
  reflowLines,
  sentenceSpan,
  sourceHash,
  splitSegments,
  splitSentences,
  stripWrapper,
  targetLabel
} from '../src/translation-engine.js';

const fixture = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'fixtures',
      'translation-engine-parity.json'
    ),
    'utf8'
  )
) as {
  normalize: Array<[string, string]>;
  hash: string;
  language: string[];
  sentences: string[][];
  labels: string[];
  prompt: string[];
  wrapper: string[];
  unfinished: boolean[];
  sentence_span: Array<[number, number] | null>;
  map_span: Array<[number, number, boolean] | null>;
  map_sentences: Array<[string, boolean]>;
  source: string;
  translation: string;
  parts: string[];
  reflow: string;
  reflow_text: string;
  segments: Array<{ index: number; text: string; para: number }>;
};

const texts = [
  '第一句。第二句！第三句？',
  'U.S. policy changed in 2020. Next sentence.',
  '这是一个很长的句子，'.repeat(40) + '结尾。',
  'Version 3.14 is out. See Fig. 2.'
];

describe('translation engine parity with Python', () => {
  it('normalizes and hashes', () => {
    expect(normalize(fixture.normalize[0]![0])).toBe(fixture.normalize[0]![1]);
    expect(sourceHash(fixture.source)).toBe(fixture.hash);
  });

  it('detects language and splits sentences', () => {
    expect(texts.map(detectLanguage)).toEqual(fixture.language);
    expect(texts.map((text) => splitSentences(text))).toEqual(fixture.sentences);
  });

  it('builds labels and prompts', () => {
    expect(['zh', 'en', 'ja', 'de', 'xx', ''].map(targetLabel)).toEqual(
      fixture.labels
    );
    expect(buildPrompt('Hello world.', 'zh')).toBe(fixture.prompt[0]);
    expect(buildPrompt('你好世界。', 'en')).toBe(fixture.prompt[1]);
  });

  it('strips wrappers and detects unfinished output', () => {
    expect([
      stripWrapper('```\n译文内容\n```'),
      stripWrapper('译文：内容'),
      stripWrapper('Translation: content'),
      stripWrapper('plain')
    ]).toEqual(fixture.wrapper);
    expect([
      looksUnfinished('A'.repeat(120) + '.', '短'),
      looksUnfinished('A'.repeat(120) + '.', '。'),
      looksUnfinished('short.', '短')
    ]).toEqual(fixture.unfinished);
  });

  it('maps sentence spans', () => {
    expect(fixture.parts.map((part) => sentenceSpan(fixture.source, part))).toEqual(
      fixture.sentence_span
    );
    expect(
      fixture.parts.map((part) => mapSentenceSpan(fixture.source, fixture.translation, part))
    ).toEqual(fixture.map_span);
    expect(
      fixture.parts.map((part) => mapSentences(fixture.source, fixture.translation, part))
    ).toEqual(fixture.map_sentences);
  });

  it('reflows lines and splits stable segments', () => {
    expect(reflowLines(fixture.reflow_text)).toBe(fixture.reflow);
    expect(splitSegments(fixture.reflow_text)).toEqual(fixture.segments);
  });
});
