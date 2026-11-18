/**
 * 证据展示口径的回归网（纯函数，node 环境，无需 DOM/Electron）。
 *
 * 盯住的核心口径：`source_changed`（提问时选区文字在当前页已找不到）造成的缺证
 * **不是模型编造**，必须与普通缺证分开计数/分别文案；历史消息只有摘要时也要能恢复。
 */
import { describe, expect, it } from 'vitest';
import type { ChatAuditSummary, ChatResponse } from '@studianda/shared';
import {
  auditSummaryLine,
  changedSelectionSnapshot,
  formatUsage,
  formatUsageCompact,
  hasTurnRecord,
  isSourceChangedClaim,
  splitUnsupportedClaims,
  turnRecordHasAlert,
  turnRecordSummary,
  unsupportedCounts
} from '../src/chat-audit.js';

type Audit = NonNullable<ChatResponse['audit']>;
type Claim = Audit['claims'][number];
type Snapshot = NonNullable<ChatResponse['selection_snapshot']>;

function response(overrides: Partial<ChatResponse> = {}): ChatResponse {
  return { answer: null, sources: [], ...overrides };
}

function claim(overrides: Partial<Claim> = {}): Claim {
  return { claim: 1, verdict: 'unsupported', ...overrides };
}

function audit(claims: Claim[], overrides: Partial<Audit> = {}): Audit {
  return { status: '已进行模型证据支持复核', issues: [], claims, ...overrides };
}

function summary(overrides: Partial<ChatAuditSummary> = {}): ChatAuditSummary {
  return {
    claims: 0,
    supported: 0,
    inference: 0,
    unsupported: 0,
    heading: 0,
    claim_types: {},
    ...overrides
  };
}

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: 'snapshot-1',
    page: 3,
    text_hash: 'hash',
    revision: 'rev-1',
    created: '2026-01-01T00:00:00.000Z',
    status: 'current',
    ...overrides
  };
}

describe('isSourceChangedClaim', () => {
  it('只有 unsupported + source_changed 才算原文已变更', () => {
    expect(isSourceChangedClaim(claim({ evidence_status: 'source_changed' }))).toBe(true);
  });

  it('普通 unsupported（没有归因）不算', () => {
    expect(isSourceChangedClaim(claim())).toBe(false);
  });

  it('verdict 不是 unsupported 时即使带归因也不算（归因只对缺证生效）', () => {
    expect(isSourceChangedClaim(claim({ verdict: 'supported', evidence_status: 'source_changed' }))).toBe(
      false
    );
  });
});

describe('splitUnsupportedClaims', () => {
  it('没有 response / 没有审计时两边都是空数组', () => {
    expect(splitUnsupportedClaims(undefined)).toEqual({ plain: [], sourceChanged: [] });
    expect(splitUnsupportedClaims(response())).toEqual({ plain: [], sourceChanged: [] });
  });

  it('按归因拆开，且只保留 unsupported（支持/推断不进缺证）', () => {
    const plain = claim({ claim: 2, reason: '找不到依据' });
    const changed = claim({ claim: 3, evidence_status: 'source_changed' });
    const { plain: plainClaims, sourceChanged } = splitUnsupportedClaims(
      response({
        audit: audit([claim({ claim: 1, verdict: 'supported' }), plain, changed])
      })
    );
    expect(plainClaims.map((item) => item.claim)).toEqual([2]);
    expect(sourceChanged.map((item) => item.claim)).toEqual([3]);
  });

  it('全部是原文已变更时普通缺证为空', () => {
    const { plain, sourceChanged } = splitUnsupportedClaims(
      response({
        audit: audit([
          claim({ claim: 1, evidence_status: 'source_changed' }),
          claim({ claim: 2, evidence_status: 'source_changed' })
        ])
      })
    );
    expect(plain).toEqual([]);
    expect(sourceChanged).toHaveLength(2);
  });
});

describe('unsupportedCounts', () => {
  it('没有 response / 没有计数时按 0 处理', () => {
    expect(unsupportedCounts(undefined)).toEqual({ plain: 0, sourceChanged: 0 });
    expect(unsupportedCounts(response({ audit_summary: summary() }))).toEqual({
      plain: 0,
      sourceChanged: 0
    });
  });

  it('有逐段明细时以明细为准（原文已变更从 unsupported 里扣掉）', () => {
    expect(
      unsupportedCounts(
        response({
          audit: audit([
            claim({ claim: 1 }),
            claim({ claim: 2 }),
            claim({ claim: 3, evidence_status: 'source_changed' })
          ])
        })
      )
    ).toEqual({ plain: 2, sourceChanged: 1 });
  });

  it('历史消息只有摘要时退回摘要计数（source_changed 仍单列）', () => {
    expect(
      unsupportedCounts(
        response({ audit_summary: summary({ claims: 5, unsupported: 3, source_changed: 1 }) })
      )
    ).toEqual({ plain: 2, sourceChanged: 1 });
  });

  it('旧摘要没有 source_changed 字段时按 0 处理', () => {
    expect(
      unsupportedCounts(response({ audit_summary: summary({ claims: 4, unsupported: 2 }) }))
    ).toEqual({ plain: 2, sourceChanged: 0 });
  });

  it('摘要归因数大于缺证总数时不出现负数（防止旧数据把文案算成 -1）', () => {
    expect(
      unsupportedCounts(
        response({ audit_summary: summary({ claims: 1, unsupported: 1, source_changed: 3 }) })
      )
    ).toEqual({ plain: 0, sourceChanged: 3 });
  });

  it('摘要里有 source_changed 时优先用摘要里的归因数', () => {
    expect(
      unsupportedCounts(
        response({
          audit: audit([claim({ claim: 1 })]),
          audit_summary: summary({ claims: 1, unsupported: 1, source_changed: 1 })
        })
      )
    ).toEqual({ plain: 0, sourceChanged: 1 });
  });
});

describe('auditSummaryLine', () => {
  it('没有摘要时返回空串', () => {
    expect(auditSummaryLine(undefined)).toBe('');
    expect(auditSummaryLine(response())).toBe('');
  });

  it('普通缺证不出现「原文已变更」尾项', () => {
    expect(
      auditSummaryLine(
        response({
          audit_summary: summary({ claims: 4, supported: 2, inference: 1, unsupported: 1, heading: 1 })
        })
      )
    ).toBe('支持 2 · 推断 1 · 缺证 1 · 标题 1');
  });

  it('原文已变更单独追加，且从缺证计数里扣掉', () => {
    expect(
      auditSummaryLine(
        response({
          audit_summary: summary({
            claims: 4,
            supported: 2,
            inference: 0,
            unsupported: 2,
            heading: 0,
            source_changed: 1
          })
        })
      )
    ).toBe('支持 2 · 推断 0 · 缺证 1 · 原文已变更 1 · 标题 0');
  });
});

describe('changedSelectionSnapshot', () => {
  it('没有快照时返回 null', () => {
    expect(changedSelectionSnapshot(undefined)).toBeNull();
    expect(changedSelectionSnapshot(response())).toBeNull();
  });

  it('快照状态为 source_changed 时返回快照', () => {
    expect(changedSelectionSnapshot(response({ selection_snapshot: snapshot({ status: 'source_changed' }) }))?.id).toBe(
      'snapshot-1'
    );
  });

  it('快照仍为 current 但列了原文已变更论断时也返回（这些缺证不由模型负责）', () => {
    expect(
      changedSelectionSnapshot(response({ selection_snapshot: snapshot({ source_changed_claims: [2] }) }))?.id
    ).toBe('snapshot-1');
  });

  it('current/unknown 且没有归因论断时不额外提示', () => {
    expect(changedSelectionSnapshot(response({ selection_snapshot: snapshot() }))).toBeNull();
    expect(
      changedSelectionSnapshot(response({ selection_snapshot: snapshot({ status: 'unknown' }) }))
    ).toBeNull();
  });
});

describe('turnRecordSummary', () => {
  it('没有 response 或没有任何诊断字段时返回空串', () => {
    expect(turnRecordSummary(undefined)).toBe('');
    expect(turnRecordSummary(response())).toBe('');
  });

  it('回答方式 + 紧凑用量', () => {
    expect(
      turnRecordSummary(
        response({
          answer_mode: 'reading',
          usage: { input_tokens: 1200, output_tokens: 400 }
        })
      )
    ).toBe('文献精读 · 输入 1,200 / 输出 400');
  });

  it('依据与引用条数', () => {
    expect(
      turnRecordSummary(
        response({
          sources: [
            { documentId: 'd1', documentName: 'A', page: 1, snippet: 's' },
            { documentId: 'd2', documentName: 'B', page: 2, snippet: 's' }
          ],
          citation_support: { citations: 3, verified: 3, anchor_only: 0, page_only: [] }
        })
      )
    ).toBe('依据 2 条 · 引用 3 条');
  });

  it('缺证与原文已变更同时存在时分成两段', () => {
    expect(
      turnRecordSummary(
        response({
          audit: audit([
            claim({ claim: 1 }),
            claim({ claim: 2, evidence_status: 'source_changed' })
          ])
        })
      )
    ).toBe('缺证 1 段 · 原文已变更 1 段');
  });

  it('只有原文已变更时不能写成「缺证」', () => {
    expect(
      turnRecordSummary(
        response({ audit: audit([claim({ evidence_status: 'source_changed' })]) })
      )
    ).toBe('原文已变更 1 段');
  });

  it('审计全部通过时只报审计段数，并标出审计未完成', () => {
    expect(
      turnRecordSummary(
        response({
          audit: audit([claim({ claim: 1, verdict: 'supported' })], { status: '部分段落未完成复核' })
        })
      )
    ).toBe('审计 1 段 · 审计部分未完成');
  });
});

describe('turnRecordHasAlert', () => {
  it('没有 response 时不标红', () => {
    expect(turnRecordHasAlert(undefined)).toBe(false);
  });

  it('只有原文已变更缺证时不算错误（不是模型编造）', () => {
    expect(
      turnRecordHasAlert(
        response({ audit: audit([claim({ evidence_status: 'source_changed' })]) })
      )
    ).toBe(false);
  });

  it('普通缺证标红', () => {
    expect(
      turnRecordHasAlert(
        response({ audit: audit([claim({ claim: 1 }), claim({ claim: 2, verdict: 'supported' })]) })
      )
    ).toBe(true);
  });

  it('审计状态异常标红，正常完成不标红', () => {
    expect(turnRecordHasAlert(response({ audit: audit([], { status: '未完成' }) }))).toBe(true);
    expect(turnRecordHasAlert(response({ audit: audit([]) }))).toBe(false);
  });
});

describe('hasTurnRecord', () => {
  it('没有 response 或只有空回答时不渲染折叠项', () => {
    expect(hasTurnRecord(undefined)).toBe(false);
    expect(hasTurnRecord(response())).toBe(false);
  });

  it('有回答方式 / 用量 / 来源时渲染', () => {
    expect(hasTurnRecord(response({ answer_mode: 'direct' }))).toBe(true);
    expect(hasTurnRecord(response({ usage: { total_tokens: 1 } }))).toBe(true);
    expect(
      hasTurnRecord(response({ sources: [{ documentId: 'd1', documentName: 'A', page: 1, snippet: 's' }] }))
    ).toBe(true);
  });

  it('只有审计摘要（历史消息）也渲染', () => {
    expect(hasTurnRecord(response({ audit_summary: summary() }))).toBe(true);
  });
});

describe('formatUsage / formatUsageCompact', () => {
  it('输入/输出分别列，缓存与思考挂在各自项后面，并标出调用次数与估算', () => {
    expect(
      formatUsage({
        input_tokens: 1200,
        output_tokens: 400,
        cached_tokens: 300,
        reasoning_tokens: 100,
        calls: 2,
        estimated: true
      })
    ).toBe('本轮 tokens：输入 1,200（缓存命中 300） · 输出 400（其中思考 100）（2 次模型调用）（估算）');
  });

  it('没有输入/输出时退回总数', () => {
    expect(formatUsage({ total_tokens: 999 })).toBe('本轮 tokens：合计 999');
    expect(formatUsageCompact({ total_tokens: 999 })).toBe('共 999 tokens');
  });

  it('没有可用数字时返回空（不渲染空用量行）', () => {
    expect(formatUsage({})).toBeNull();
    expect(formatUsage({ input_tokens: Number.NaN })).toBeNull();
    expect(formatUsageCompact({})).toBe('');
  });

  it('负数按 0 展示，不做负数 token', () => {
    expect(formatUsage({ input_tokens: -5 })).toBe('本轮 tokens：输入 0');
    expect(formatUsageCompact({ input_tokens: -5, output_tokens: 10 })).toBe('输入 0 / 输出 10');
  });
});
