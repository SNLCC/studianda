import { describe, expect, it } from 'vitest';
import type { ChatAuditSummary } from '@studianda/shared';
import {
  MAX_AUDIT_INVALID_CITATION_IDS,
  auditSummaryFromResponse,
  invalidCitationSummaryFields,
  parseAuditSummary,
  serializeAuditSummary
} from '../src/chat-audit-summary.js';

/**
 * 审计摘要里的越界引用编号（`invalid_citation_ids`）：
 *
 * - 新写入：编号与计数同源，去重升序；超过上限只存前 `MAX_AUDIT_INVALID_CITATION_IDS` 个，
 *   计数仍记全量并置 `invalid_citations_truncated`；
 * - 旧摘要（只有 `invalid_citations` 计数、没有编号数组）：读取保留计数、不造编号；
 * - 空/无越界：不出现编号与截断字段（摘要不膨胀）；
 * - 容错：坏编号丢弃、坏 JSON 返回 null，绝不让历史读取报错。
 */

/** 最小逐段审计：一条 supported 让摘要非空。 */
const AUDIT = {
  status: '已进行模型证据支持复核',
  claims: [{ claim: 1, verdict: 'supported' }]
};

/** 迁移前的旧摘要 JSON：只有计数，没有编号数组。 */
const LEGACY_RAW = JSON.stringify({
  claims: 3,
  supported: 1,
  inference: 0,
  unsupported: 2,
  heading: 0,
  claim_types: { HISTORICAL_FACT: 2 },
  source_changed: 0,
  invalid_citations: 2
});

describe('审计摘要的越界引用编号', () => {
  it('新写入：编号去重升序，编号与计数一致', () => {
    const summary = auditSummaryFromResponse({
      audit: AUDIT,
      invalid_citations: [7, 3, 3, 9]
    });
    expect(summary).toMatchObject({
      invalid_citations: 3,
      invalid_citation_ids: [3, 7, 9]
    });
    expect(summary?.invalid_citations_truncated).toBeUndefined();
  });

  it('超过上限：计数记全量，编号截断到上限并标注截断', () => {
    const ids = Array.from({ length: MAX_AUDIT_INVALID_CITATION_IDS + 5 }, (_, index) => index + 1);
    const fields = invalidCitationSummaryFields(ids);
    expect(fields.invalid_citations).toBe(ids.length);
    expect(fields.invalid_citation_ids).toEqual(ids.slice(0, MAX_AUDIT_INVALID_CITATION_IDS));
    expect(fields.invalid_citations_truncated).toBe(true);

    const summary = auditSummaryFromResponse({ audit: AUDIT, invalid_citations: ids });
    expect(summary?.invalid_citations).toBe(ids.length);
    expect(summary?.invalid_citation_ids).toHaveLength(MAX_AUDIT_INVALID_CITATION_IDS);
    expect(summary?.invalid_citations_truncated).toBe(true);
  });

  it('空/无越界：不写编号与截断字段；完全没有审计信息仍返回 null', () => {
    const summary = auditSummaryFromResponse({ audit: AUDIT, invalid_citations: [] });
    expect(summary).toBeDefined();
    expect(summary?.invalid_citations).toBe(0);
    expect(summary && 'invalid_citation_ids' in summary).toBe(false);
    expect(summary && 'invalid_citations_truncated' in summary).toBe(false);

    expect(auditSummaryFromResponse({})).toBeNull();
  });

  it('旧摘要只有计数：读取保留计数、不造编号（展示侧可退回 N 处）', () => {
    const parsed = parseAuditSummary(LEGACY_RAW);
    expect(parsed?.invalid_citations).toBe(2);
    expect(parsed?.invalid_citation_ids).toBeUndefined();
    expect(parsed?.invalid_citations_truncated).toBeUndefined();

    // 响应里只有旧摘要（没有顶层 invalid_citations 数组）时，重新压缩同样保留计数、不造编号。
    const recompressed = auditSummaryFromResponse({ audit: AUDIT, audit_summary: parsed });
    expect(recompressed?.invalid_citations).toBe(2);
    expect(recompressed?.invalid_citation_ids).toBeUndefined();
  });

  it('重新压缩已有摘要时不丢编号与截断标记', () => {
    const existing: ChatAuditSummary = {
      claims: 1,
      supported: 1,
      inference: 0,
      unsupported: 0,
      heading: 0,
      claim_types: {},
      invalid_citations: 25,
      invalid_citation_ids: Array.from(
        { length: MAX_AUDIT_INVALID_CITATION_IDS },
        (_, index) => index + 1
      ),
      invalid_citations_truncated: true
    };
    const summary = auditSummaryFromResponse({ audit: AUDIT, audit_summary: existing });
    expect(summary?.invalid_citations).toBe(25);
    expect(summary?.invalid_citation_ids).toEqual(existing.invalid_citation_ids);
    expect(summary?.invalid_citations_truncated).toBe(true);
  });

  it('解析容错：坏编号丢弃、去重升序、超限再截断；坏 JSON 返回 null', () => {
    const ids = Array.from({ length: 24 }, (_, index) => index + 1);
    const parsed = parseAuditSummary(
      JSON.stringify({
        claims: 1,
        supported: 1,
        inference: 0,
        unsupported: 0,
        heading: 0,
        claim_types: {},
        invalid_citations: 24,
        invalid_citation_ids: [...ids, '7', -1, 2.5, null]
      })
    );
    expect(parsed?.invalid_citations).toBe(24);
    expect(parsed?.invalid_citation_ids).toEqual(ids.slice(0, MAX_AUDIT_INVALID_CITATION_IDS));
    expect(parsed?.invalid_citations_truncated).toBe(true);

    expect(parseAuditSummary('{不是合法 JSON')).toBeNull();
    expect(parseAuditSummary(null)).toBeNull();
  });

  it('序列化 → 解析往返保留编号与截断标记', () => {
    const summary = auditSummaryFromResponse({
      audit: AUDIT,
      invalid_citations: Array.from({ length: 23 }, (_, index) => index + 1)
    });
    expect(summary).not.toBeNull();
    expect(parseAuditSummary(serializeAuditSummary(summary))).toEqual(summary);
  });
});
