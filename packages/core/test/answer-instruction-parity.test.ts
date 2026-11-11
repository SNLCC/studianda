import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { answerInstruction } from '../src/prompts.js';

const fixture = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'fixtures',
      'answer-instruction-parity.json'
    ),
    'utf8'
  )
) as { mode_full: string; mode_local: string; rules: string };

describe('answer prompt parity with Python chat_feature', () => {
  it('matches the full-document variant', () => {
    expect(answerInstruction(true)).toBe(fixture.mode_full + fixture.rules);
  });

  it('matches the scoped variant', () => {
    expect(answerInstruction(false)).toBe(fixture.mode_local + fixture.rules);
  });
});
