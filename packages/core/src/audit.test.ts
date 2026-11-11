import { describe, expect, it } from 'vitest';
import { auditAnswer } from './audit.js';

const originals = [
  {
    source: 1,
    document_id: 'doc',
    page: 2,
    text: '这一结果表明显著的制度差异，并解释了治理绩效的变化。',
    source_type: 'document'
  }
];

describe('audit mislabel validation and reuse', () => {
  it('downgrades a substantive paragraph marked as heading', async () => {
    const report = await auditAnswer(
      '这一结果表明显著的制度差异，并解释了治理绩效的变化。',
      async () =>
        JSON.stringify({
          claims: [{ claim: 1, verdict: 'heading', reason: '标题' }]
        }),
      { originals }
    );
    expect(report.claims[0]?.verdict).toBe('unsupported');
    expect(report.claims[0]?.reason).toContain('标题');
    expect(report.issues.some((issue) => issue.includes('不像标题'))).toBe(true);
  });

  it('reuses an identical audit without asking the model again', async () => {
    let calls = 0;
    const answer = '### 方法\n概念界定是一个术语说明。';
    const ask = async (): Promise<string> => {
      calls += 1;
      return JSON.stringify({
        claims: [
          { claim: 1, verdict: 'heading', reason: '标题' },
          {
            claim: 2,
            verdict: 'supported',
            reason: '有依据',
            evidence: [{ source: 1, quote: '概念界定是一个术语说明。' }]
          }
        ]
      });
    };
    await auditAnswer(answer, ask, { originals: [{ ...originals[0]!, text: answer }] });
    await auditAnswer(answer, ask, { originals: [{ ...originals[0]!, text: answer }] });
    expect(calls).toBe(1);
  });
});
