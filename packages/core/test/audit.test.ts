import { describe, expect, it } from 'vitest';
import {
  auditAnswer,
  auditGroups,
  rewriteAuditedAnswer,
  type AuditOriginal
} from '../src/audit.js';

const originals: AuditOriginal[] = [
  {
    source: 1,
    document_id: 'doc',
    page: 2,
    text: '作者认为制度差异只能解释一部分治理绩效，其余来自历史路径。',
    source_type: 'document'
  },
  {
    source: 2,
    document_id: 'doc',
    page: 5,
    text: '这一章的结论只适用于城市样本，农村样本未纳入。',
    source_type: 'document'
  }
];

function row(claim: number, verdict: string, extra: Record<string, unknown> = {}) {
  return { claim, verdict, reason: '判定', ...extra };
}

describe('answer audit', () => {
  it('verifies every supported quote against the original page', async () => {
    const report = await auditAnswer(
      '制度差异只能解释一部分治理绩效 [1]。',
      async () =>
        JSON.stringify({
          claims: [
            row(1, 'supported', {
              evidence: [{ source: 1, quote: '制度差异只能解释一部分治理绩效' }]
            })
          ]
        }),
      { originals }
    );
    expect(report.status).toBe('已进行模型证据支持复核');
    expect(report.claims[0]?.verdict).toBe('supported');
    expect(report.claims[0]?.evidence?.[0]?.quote).toBe('制度差异只能解释一部分治理绩效');
  });

  it('downgrades supported claims with fabricated or missing evidence', async () => {
    const report = await auditAnswer(
      '第一段 [1]。\n第二段 [2]。',
      async () =>
        JSON.stringify({
          claims: [
            row(1, 'supported', { evidence: [{ source: 1, quote: '原文里没有这句话' }] }),
            row(2, 'supported')
          ]
        }),
      { originals }
    );
    expect(report.claims[0]?.verdict).toBe('unsupported');
    expect(report.claims[0]?.reason).toContain('逐字');
    expect(report.claims[1]?.verdict).toBe('unsupported');
    expect(report.claims[1]?.reason).toContain('没有给出任何支持依据');
  });

  it('resolves evidence_keys only inside the verified bank', async () => {
    const report = await auditAnswer(
      '制度差异只能解释一部分治理绩效，其余来自历史路径 [1]。',
      async () =>
        JSON.stringify({
          claims: [row(1, 'supported', { evidence_keys: ['E1'] })]
        }),
      {
        originals,
        evidenceIndex: [
          {
            source: 1,
            evidence_key: 'E1',
            quote: '制度差异只能解释一部分治理绩效'
          }
        ]
      }
    );
    expect(report.claims[0]?.verdict).toBe('supported');
    expect(report.claims[0]?.evidence?.[0]?.evidence_key).toBe('E1');
  });

  it('marks missing claims and malformed output', async () => {
    const partial = await auditAnswer(
      '一\n二',
      async () => JSON.stringify({ claims: [row(1, 'heading')] }),
      { originals: [{ ...originals[0]!, text: '# 标题' }] }
    );
    expect(partial.status).toBe('部分段落未完成复核');
    expect(partial.claims[1]?.verdict).toBe('unsupported');

    const malformed = await auditAnswer('一', async () => 'not json', { originals });
    expect(malformed.status).toBe('部分段落未完成复核');
    expect(malformed.issues.length).toBeGreaterThan(0);
  });

  it('rebinds citations and strips unsupported page mentions', async () => {
    const report = await auditAnswer(
      '作者认为制度差异只能解释一部分治理绩效，详见第 9 页 [1]。',
      async () =>
        JSON.stringify({
          claims: [
            row(1, 'supported', {
              evidence: [{ source: 1, quote: '制度差异只能解释一部分治理绩效' }]
            })
          ]
        }),
      { originals }
    );
    const rewritten = rewriteAuditedAnswer(
      '作者认为制度差异只能解释一部分治理绩效，详见第 9 页 [1]。',
      report,
      originals
    );
    expect(rewritten.answer).toContain('[1]');
    expect(rewritten.answer).not.toContain('第 9 页');
    expect(rewritten.pageMentionsRemoved).toHaveLength(1);
  });

  it('replaces unsupported paragraphs instead of keeping confident text', async () => {
    const report = await auditAnswer(
      '工程干预提升了治理绩效 [1]。',
      async () => JSON.stringify({ claims: [row(1, 'unsupported')] }),
      { originals }
    );
    const rewritten = rewriteAuditedAnswer(
      '工程干预提升了治理绩效 [1]。',
      report,
      originals
    );
    expect(rewritten.answer).toContain('此处结论缺少本轮证据支持');
    expect(rewritten.answer).not.toContain('提升了治理绩效');
  });

  it('标题行不会被改写成缺证提示（模型把标题判成 unsupported 也一样）', async () => {
    // 回答是多行 Markdown：第一条论断实际是"标题"，模型却把它判成 unsupported。
    const answer = ['## 结论', '', '工程干预提升了治理绩效 [1]。'].join('\n');
    const report = await auditAnswer(
      answer,
      async () =>
        JSON.stringify({
          claims: [row(1, 'unsupported'), row(2, 'unsupported')]
        }),
      { originals }
    );
    const rewritten = rewriteAuditedAnswer(answer, report, originals);
    // 标题必须原样保留。
    expect(rewritten.answer).toContain('## 结论');
    // 标题不会被替换成免责话；正文那段仍然按缺证处理。
    expect(rewritten.answer.split('\n')[0]).toBe('## 结论');
    expect(rewritten.answer).toContain('此处结论缺少本轮证据支持');
  });

  it('编号与正文对得上时照旧替换缺证段落', async () => {
    const answer = '工程干预提升了治理绩效 [1]。';
    const report = await auditAnswer(
      answer,
      async () =>
        JSON.stringify({
          claims: [row(1, 'unsupported', { text: '工程干预提升了治理绩效' })]
        }),
      { originals }
    );
    const rewritten = rewriteAuditedAnswer(answer, report, originals);
    expect(rewritten.answer).toContain('此处结论缺少本轮证据支持');
    expect(report.unmatched_claims).toBeUndefined();
  });

  it('系统性核验失效时保留原文，只记账（不整篇替换成免责话）', () => {
    // 四段全部被判缺证：这是"材料里没有可核对引文"的典型信号，不是四段都该删。
    const lines = ['第一段讲制度延续。', '第二段讲灾异记录。', '第三段讲水利工程。', '第四段讲结论。'];
    const report = {
      status: '已进行模型证据支持复核' as const,
      issues: [] as string[],
      claims: lines.map((text, index) => ({
        claim: index + 1,
        text,
        verdict: 'unsupported' as const
      })),
      unverified_claims: undefined as number | undefined
    };
    const rewritten = rewriteAuditedAnswer(lines.join('\n'), report, []);
    expect(rewritten.answer).toBe(lines.join('\n'));
    expect(rewritten.answer).not.toContain('此处结论缺少本轮证据支持');
    expect(report.unverified_claims).toBe(4);
  });

  it('只有个别缺证时仍按原口径替换那一段', () => {
    const lines = ['第一段讲制度延续。', '第二段讲灾异记录。', '第三段讲水利工程。', '第四段讲结论。'];
    const report = {
      status: '已进行模型证据支持复核' as const,
      issues: [] as string[],
      claims: [
        { claim: 1, text: lines[0]!, verdict: 'inference' as const },
        { claim: 2, text: lines[1]!, verdict: 'inference' as const },
        { claim: 3, text: lines[2]!, verdict: 'unsupported' as const },
        { claim: 4, text: lines[3]!, verdict: 'inference' as const }
      ],
      unverified_claims: undefined as number | undefined
    };
    const rewritten = rewriteAuditedAnswer(lines.join('\n'), report, []);
    // 个别缺证照旧替换，其余保留。
    expect(rewritten.answer).toContain('此处结论缺少本轮证据支持');
    expect(rewritten.answer).toContain('第一段讲制度延续');
    expect(rewritten.answer).not.toContain('第三段讲水利工程');
    expect(report.unverified_claims).toBeUndefined();
  });

  it('论断与行按文本绑定：编号错位也能改对那一段', () => {
    const answer = ['## 标题', '甲段正文。', '乙段正文。'].join('\n');
    const report = {
      status: '已进行模型证据支持复核' as const,
      issues: [] as string[],
      claims: [
        // 编号与行顺序故意不一致：审计把"乙段"编成第 1 条。
        { claim: 1, text: '乙段正文。', verdict: 'unsupported' as const },
        { claim: 2, text: '甲段正文。', verdict: 'inference' as const }
      ],
      unverified_claims: undefined as number | undefined,
      unmatched_claims: undefined as number | undefined
    };
    const rewritten = rewriteAuditedAnswer(answer, report, []);
    // 乙段（缺证）被替换；甲段（推断）加前缀；标题原样。
    expect(rewritten.answer).toContain('此处结论缺少本轮证据支持');
    expect(rewritten.answer).not.toContain('乙段正文');
    expect(rewritten.answer).toContain('推断（有原文依据，但不是作者直接结论）：甲段正文');
    expect(rewritten.answer.split('\n')[0]).toBe('## 标题');
    expect(report.unmatched_claims).toBeUndefined();
  });

  it('groups long answers by budget and citation count', () => {
    const lines = Array.from({ length: 8 }, (_, index) => ({
      claim: index + 1,
      text: `第 ${index + 1} 段引用 [${(index % 7) + 1}]，`.repeat(6)
    }));
    const groups = auditGroups(lines, 2048, 100, 8000);
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.flat()).toHaveLength(8);
    for (const group of groups) {
      const citations = new Set(
        group.flatMap((item) => [...item.text.matchAll(/\[(\d+)\]/g)].map((match) => match[1]))
      );
      expect(citations.size).toBeLessThanOrEqual(6);
    }
  });
});

describe('audit packet progress', () => {
  /** 全部段落判 unsupported 的假模型：不需要原文，专门用来数包与回调。 */
  function unsupportedAsk() {
    return async (_instruction: string, material: string) => {
      const start = material.indexOf('{');
      const parsed = JSON.parse(material.slice(start)) as {
        answer_lines?: Array<{ claim: number; text: string }>;
      };
      return JSON.stringify({
        claims: (parsed.answer_lines ?? []).map((line) => ({
          claim: line.claim,
          verdict: 'unsupported',
          reason: '缺证'
        }))
      });
    };
  }

  it('多包时逐包回调开始/结束：done 单调，结束等于 total', async () => {
    const text = Array.from(
      { length: 30 },
      (_, index) => `进度测试第 ${index + 1} 段：该段没有证据。`
    ).join('\n');
    const events: Array<[number, number]> = [];
    const report = await auditAnswer(text, unsupportedAsk(), {
      originals: [],
      onPacket: (done, total) => events.push([done, total])
    });
    expect(report.claims).toHaveLength(30);
    expect(report.status).toBe('已进行模型证据支持复核');
    const totals = new Set(events.map(([, total]) => total));
    expect(totals.size).toBe(1);
    const total = [...totals][0]!;
    expect(total).toBeGreaterThan(1);
    // 每个包两个事件（开始 + 结束）。
    expect(events).toHaveLength(total * 2);
    expect(events[0]?.[0]).toBe(0);
    expect(events[events.length - 1]?.[0]).toBe(total);
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index]![0]).toBeGreaterThanOrEqual(events[index - 1]![0]);
    }
  });

  it('单包也回调 (0,1)/(1,1)，且不影响审计结果', async () => {
    const text = '单包进度测试：该段没有证据。\n另一段也没有证据。';
    const events: Array<[number, number]> = [];
    const withProgress = await auditAnswer(text, unsupportedAsk(), {
      originals: [],
      onPacket: (done, total) => events.push([done, total])
    });
    const withoutProgress = await auditAnswer(
      `${text}\n第三段仍然没有证据。`,
      unsupportedAsk(),
      { originals: [] }
    );
    expect(events).toEqual([
      [0, 1],
      [1, 1]
    ]);
    expect(withProgress.claims.map((claim) => claim.verdict)).toEqual([
      'unsupported',
      'unsupported'
    ]);
    expect(withoutProgress.claims).toHaveLength(3);
  });
});
