import { describe, expect, it } from 'vitest';
import {
  CLAIM_TYPES,
  EVIDENCE_STANDARDS,
  EXTERNAL_KINDS,
  SOURCE_KINDS,
  claimType,
  externalBlocked,
  minimumStandard,
  resolveStandard,
  sourceOrder,
  sourcePlan
} from '../src/routing.js';

/**
 * 来源路由的回归测试。
 *
 * 三条口径必须被钉住：模型**压不低**证据标准下限；没有授权时只**建议**文献内来源并把
 * 「想找但没授权」如实记进 blocked_external；文献已足够回答时外部来源**不必要**。
 */

describe('词表与常量（对齐 routing.py:20-33）', () => {
  it('claim 性质、证据等级、来源种类、外部来源的顺序与内容与 Python 一致', () => {
    expect(CLAIM_TYPES).toEqual([
      'DOCUMENT_INTERPRETATION',
      'CONCEPT_DEFINITION',
      'SCHOLARLY_POSITION',
      'HISTORICAL_FACT',
      'BIBLIOGRAPHIC_FACT',
      'CONTESTED_INTERPRETATION',
      'CURRENT_INFORMATION',
      'BACKGROUND_EXPLANATION'
    ]);
    expect(EVIDENCE_STANDARDS).toEqual(['LIGHT', 'GROUNDED', 'SCHOLARLY']);
    expect(SOURCE_KINDS).toEqual([
      'CURRENT_DOCUMENT',
      'LIBRARY_DOCUMENT',
      'PRIMARY_EXTERNAL_SOURCE',
      'SCHOLARLY_REFERENCE',
      'OFFICIAL_SOURCE',
      'GENERAL_WEB',
      'MODEL_BACKGROUND',
      'SYSTEM_INFERENCE'
    ]);
    expect(EXTERNAL_KINDS).toEqual([
      'PRIMARY_EXTERNAL_SOURCE',
      'SCHOLARLY_REFERENCE',
      'OFFICIAL_SOURCE',
      'GENERAL_WEB'
    ]);
  });
});

describe('claimType（对齐 claim_type）', () => {
  it('词表内原样返回，词表外/非字符串退回 BACKGROUND_EXPLANATION', () => {
    expect(claimType('CONCEPT_DEFINITION')).toBe('CONCEPT_DEFINITION');
    expect(claimType('BACKGROUND_EXPLANATION')).toBe('BACKGROUND_EXPLANATION');
    expect(claimType('NOT_A_TYPE')).toBe('BACKGROUND_EXPLANATION');
    expect(claimType('')).toBe('BACKGROUND_EXPLANATION');
    expect(claimType(undefined)).toBe('BACKGROUND_EXPLANATION');
    expect(claimType(42)).toBe('BACKGROUND_EXPLANATION');
  });
});

describe('minimumStandard（对齐 minimum_standard）', () => {
  it('8 种性质各自的最低证据等级与 Python 表一致', () => {
    expect(minimumStandard('DOCUMENT_INTERPRETATION')).toBe('GROUNDED');
    expect(minimumStandard('BACKGROUND_EXPLANATION')).toBe('GROUNDED');
    expect(minimumStandard('CONCEPT_DEFINITION')).toBe('SCHOLARLY');
    expect(minimumStandard('SCHOLARLY_POSITION')).toBe('SCHOLARLY');
    expect(minimumStandard('HISTORICAL_FACT')).toBe('SCHOLARLY');
    expect(minimumStandard('BIBLIOGRAPHIC_FACT')).toBe('SCHOLARLY');
    expect(minimumStandard('CONTESTED_INTERPRETATION')).toBe('SCHOLARLY');
    expect(minimumStandard('CURRENT_INFORMATION')).toBe('SCHOLARLY');
  });

  it('词表外性质先归一化成 BACKGROUND_EXPLANATION，因此取 GROUNDED（Python 实际口径）', () => {
    expect(minimumStandard('NOT_A_TYPE')).toBe('GROUNDED');
    expect(minimumStandard(undefined)).toBe('GROUNDED');
  });
});

describe('resolveStandard（对齐 resolve_standard：只能提不能降）', () => {
  it('模型降级被抬回下限', () => {
    expect(resolveStandard('CONCEPT_DEFINITION', 'LIGHT')).toBe('SCHOLARLY');
    expect(resolveStandard('CONCEPT_DEFINITION', 'GROUNDED')).toBe('SCHOLARLY');
    expect(resolveStandard('DOCUMENT_INTERPRETATION', 'LIGHT')).toBe('GROUNDED');
  });

  it('模型升级被采纳（模型确实可能更需要学术级依据）', () => {
    expect(resolveStandard('DOCUMENT_INTERPRETATION', 'SCHOLARLY')).toBe('SCHOLARLY');
    expect(resolveStandard('DOCUMENT_INTERPRETATION', 'GROUNDED')).toBe('GROUNDED');
  });

  it('词表外/缺失的声明一律取下限', () => {
    expect(resolveStandard('CONCEPT_DEFINITION', 'HIGHEST')).toBe('SCHOLARLY');
    expect(resolveStandard('CONCEPT_DEFINITION', undefined)).toBe('SCHOLARLY');
    expect(resolveStandard('DOCUMENT_INTERPRETATION', '')).toBe('GROUNDED');
  });

  it('只有 verdict=background 的段落才允许 LIGHT（未核验背景知识的唯一豁免）', () => {
    expect(resolveStandard('CONCEPT_DEFINITION', 'LIGHT', 'background')).toBe('LIGHT');
    expect(resolveStandard('DOCUMENT_INTERPRETATION', undefined, 'background')).toBe('LIGHT');
    // 同一段只要不是 background，LIGHT 一律被抬回下限。
    expect(resolveStandard('CONCEPT_DEFINITION', 'LIGHT', 'supported')).toBe('SCHOLARLY');
    expect(resolveStandard('CONCEPT_DEFINITION', 'LIGHT', 'inference')).toBe('SCHOLARLY');
    expect(resolveStandard('DOCUMENT_INTERPRETATION', 'LIGHT', 'unsupported')).toBe('GROUNDED');
  });
});

describe('sourceOrder（对齐 source_order）', () => {
  it('按性质给出完整偏好顺序；词表外退到 BACKGROUND_EXPLANATION', () => {
    expect(sourceOrder('BIBLIOGRAPHIC_FACT')).toEqual([
      'OFFICIAL_SOURCE',
      'SCHOLARLY_REFERENCE',
      'LIBRARY_DOCUMENT'
    ]);
    expect(sourceOrder('CURRENT_INFORMATION')).toEqual(['OFFICIAL_SOURCE', 'GENERAL_WEB']);
    expect(sourceOrder('NOT_A_TYPE')).toEqual(['CURRENT_DOCUMENT', 'MODEL_BACKGROUND']);
  });
});

describe('sourcePlan（对齐 source_plan）', () => {
  it('没有授权外部来源时：只建议文献内来源，needs_external=false，blocked_external 如实列出', () => {
    const plan = sourcePlan('CONCEPT_DEFINITION');
    expect(plan.claim_type).toBe('CONCEPT_DEFINITION');
    expect(plan.standard).toBe('GROUNDED');
    expect(plan.sources).toEqual(['CURRENT_DOCUMENT']);
    expect(plan.needs_external).toBe(false);
    expect(plan.blocked_external).toEqual([
      'SCHOLARLY_REFERENCE',
      'PRIMARY_EXTERNAL_SOURCE',
      'GENERAL_WEB'
    ]);
    expect(plan.reason).toBe('需要外部资料，但本轮没有获得相应授权；不改动文献覆盖状态，只按现有材料作答');
  });

  it('有授权时 needs_external=true，来源按偏好表顺序追加（不是按 allowed 顺序）', () => {
    const plan = sourcePlan('CONCEPT_DEFINITION', 'SCHOLARLY', null, [
      'GENERAL_WEB',
      'SCHOLARLY_REFERENCE'
    ]);
    expect(plan.sources).toEqual(['CURRENT_DOCUMENT', 'SCHOLARLY_REFERENCE', 'GENERAL_WEB']);
    expect(plan.needs_external).toBe(true);
    expect(plan.blocked_external).toEqual(['PRIMARY_EXTERNAL_SOURCE']);
    expect(plan.reason).toBe('当前文献对这个问题是 未知，按 claim 性质需要外部依据');
  });

  it('answerability=SUFFICIENT + 文献解释类：外部资料不必要（即使有授权）', () => {
    const plan = sourcePlan('DOCUMENT_INTERPRETATION', 'GROUNDED', 'SUFFICIENT', ['SCHOLARLY_REFERENCE']);
    expect(plan.sources).toEqual(['CURRENT_DOCUMENT', 'LIBRARY_DOCUMENT']);
    expect(plan.needs_external).toBe(false);
    expect(plan.blocked_external).toEqual([]);
    expect(plan.reason).toBe('当前文献已给出界定或解释，外部资料不必要（有也不改变"文献说了什么"）');
  });

  it('SUFFICIENT 只对文献解释类成立：概念界定仍需要外部依据', () => {
    const plan = sourcePlan('CONCEPT_DEFINITION', 'SCHOLARLY', 'SUFFICIENT');
    expect(plan.needs_external).toBe(false);
    expect(plan.blocked_external).toEqual(['SCHOLARLY_REFERENCE', 'PRIMARY_EXTERNAL_SOURCE', 'GENERAL_WEB']);
    expect(plan.reason).toBe('需要外部资料，但本轮没有获得相应授权；不改动文献覆盖状态，只按现有材料作答');
  });

  it('LIGHT 等级不要求外部：现有材料与模型解释足够', () => {
    const plan = sourcePlan('CONCEPT_DEFINITION', 'LIGHT', null, ['GENERAL_WEB']);
    expect(plan.standard).toBe('LIGHT');
    expect(plan.sources).toEqual(['CURRENT_DOCUMENT']);
    expect(plan.needs_external).toBe(false);
    expect(plan.blocked_external).toEqual([]);
    expect(plan.reason).toBe('只需解释现有材料，不需要外部依据');
  });

  it('CURRENT_INFORMATION 需要官方/通用网页（偏好表只有外部来源）', () => {
    const noPermission = sourcePlan('CURRENT_INFORMATION', 'SCHOLARLY');
    expect(noPermission.sources).toEqual([]);
    expect(noPermission.needs_external).toBe(false);
    expect(noPermission.blocked_external).toEqual(['OFFICIAL_SOURCE', 'GENERAL_WEB']);

    const permitted = sourcePlan('CURRENT_INFORMATION', 'SCHOLARLY', null, [
      'OFFICIAL_SOURCE',
      'GENERAL_WEB'
    ]);
    expect(permitted.sources).toEqual(['OFFICIAL_SOURCE', 'GENERAL_WEB']);
    expect(permitted.needs_external).toBe(true);
    expect(permitted.blocked_external).toEqual([]);
    expect(permitted.reason).toBe('当前文献对这个问题是 未知，按 claim 性质需要外部依据');
  });

  it('BIBLIOGRAPHIC_FACT 优先官源：官源未授权时先给文献库并把官源记入 blocked', () => {
    const plan = sourcePlan('BIBLIOGRAPHIC_FACT', 'SCHOLARLY', null, ['SCHOLARLY_REFERENCE']);
    expect(plan.sources).toEqual(['LIBRARY_DOCUMENT', 'SCHOLARLY_REFERENCE']);
    expect(plan.needs_external).toBe(true);
    expect(plan.blocked_external).toEqual(['OFFICIAL_SOURCE']);
    expect(plan.reason).toBe('当前文献对这个问题是 未知，按 claim 性质需要外部依据');
  });

  it('answerability 明确说“只是提到/部分/没有”时原因里带上这个状态', () => {
    expect(sourcePlan('CONCEPT_DEFINITION', 'SCHOLARLY', 'MENTION_ONLY', ['GENERAL_WEB']).reason).toBe(
      '当前文献对这个问题是 MENTION_ONLY，按 claim 性质需要外部依据'
    );
    expect(sourcePlan('CONCEPT_DEFINITION', 'SCHOLARLY', 'ABSENT', ['GENERAL_WEB']).reason).toBe(
      '当前文献对这个问题是 ABSENT，按 claim 性质需要外部依据'
    );
    // 词表外的状态（例如 CONFLICTING 需要跨证据比较、本轮不做）落到中性文案。
    expect(sourcePlan('CONCEPT_DEFINITION', 'SCHOLARLY', 'CONFLICTING', ['GENERAL_WEB']).reason).toBe(
      '按 claim 性质需要外部依据'
    );
  });

  it('词表外的性质/等级退到 BACKGROUND_EXPLANATION 与 GROUNDED，且不要求外部', () => {
    const plan = sourcePlan('NOT_A_TYPE', 'NOT_A_LEVEL');
    expect(plan.claim_type).toBe('BACKGROUND_EXPLANATION');
    expect(plan.standard).toBe('GROUNDED');
    // BACKGROUND_EXPLANATION 的偏好表是 (CURRENT_DOCUMENT, MODEL_BACKGROUND)：两者都不是外部来源。
    expect(plan.sources).toEqual(['CURRENT_DOCUMENT', 'MODEL_BACKGROUND']);
    expect(plan.needs_external).toBe(false);
    expect(plan.blocked_external).toEqual([]);
    expect(plan.reason).toBe('按该 claim 的性质，优先使用当前文献与文献库');
  });

  it('needs_external 由“授权的外部来源”决定，与 blocked_external 互不覆盖', () => {
    const plan = sourcePlan('CONCEPT_DEFINITION', 'SCHOLARLY', null, ['SCHOLARLY_REFERENCE']);
    expect(plan.needs_external).toBe(true);
    expect(plan.blocked_external).toEqual(['PRIMARY_EXTERNAL_SOURCE', 'GENERAL_WEB']);
    expect(plan.sources).toEqual(['CURRENT_DOCUMENT', 'SCHOLARLY_REFERENCE']);
  });
});

describe('externalBlocked（对齐 external_blocked）', () => {
  it('返回副本；没有计划/没有 blocked 时为空数组', () => {
    const plan = sourcePlan('CONCEPT_DEFINITION');
    expect(externalBlocked(plan)).toEqual(plan.blocked_external);
    expect(externalBlocked(plan)).not.toBe(plan.blocked_external);
    expect(externalBlocked(null)).toEqual([]);
    expect(externalBlocked(undefined)).toEqual([]);
    expect(externalBlocked({})).toEqual([]);
  });
});
