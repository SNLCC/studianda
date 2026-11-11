import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditInstruction } from '../src/audit.js';

const fixture = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'fixtures',
      'audit-instruction-parity.json'
    ),
    'utf8'
  )
) as { with_index: string; without_index: string; with_background: string };

describe('audit instruction parity with Python review.audit_instruction', () => {
  it('matches the evidence-key variant', () => {
    expect(auditInstruction(false, [{ source: 1 }])).toBe(fixture.with_index);
  });

  it('matches the quote-hint variant', () => {
    expect(auditInstruction(false, undefined)).toBe(fixture.without_index);
  });

  it('matches the background-enabled variant', () => {
    expect(auditInstruction(true, [{ source: 1 }])).toBe(fixture.with_background);
  });
});
