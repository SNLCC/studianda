import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { conservativePlan, planFromRules } from '../src/planning.js';

interface PlanningCase {
  name: string;
  query: string;
  selection: string;
  expected: {
    breadth: string;
    reason: string;
    origin: string;
    pages: number[];
  };
}

const fixturePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'planning-parity.json'
);

describe('question planning rules match Python plan_question', () => {
  const cases = JSON.parse(readFileSync(fixturePath, 'utf8')) as PlanningCase[];
  for (const testCase of cases) {
    it(testCase.name, () => {
      const plan =
        planFromRules(testCase.query, testCase.selection) ??
        conservativePlan();
      expect(plan.breadth).toBe(testCase.expected.breadth);
      expect(plan.reason).toBe(testCase.expected.reason);
      expect(plan.origin).toBe(testCase.expected.origin);
      expect(plan.pages).toEqual(testCase.expected.pages);
    });
  }
});
