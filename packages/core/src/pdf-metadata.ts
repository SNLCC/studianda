/**
 * PDF 题录解析用的纯函数（DOI 归一/抽取、XMP 字段读取、发表处推断）。
 *
 * 这些规则主线程与 `pdf-worker`（worker 线程）都要用：为保持「逐字一致」，
 * 只有这一份实现。`pdfParseHelpers` 刻意写成**自包含**工厂——函数体不引用模块作用域
 * 的任何变量，因此可以把 `pdfParseHelpers.toString()` 投递给 eval worker，
 * 在 worker 里用 `new Function` 还原出同一套函数（与 ocr-worker/backup-worker 同手法）。
 */

/**
 * 自包含的题录辅助函数工厂（见文件头说明：不要引用模块级变量）。
 */
export function pdfParseHelpers() {
  const normalizeDoi = (value: string): string => {
    return value
      .trim()
      .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, '')
      .replace(/^doi:\s*/i, '')
      .replace(/[.,;:)\]}。]+$/g, '')
      .toLowerCase();
  };

  const extractDoi = (text: string): string => {
    const match = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/i.exec(text);
    return match ? normalizeDoi(match[0]) : '';
  };

  const metadataString = (metadata: unknown, keys: string[]): string => {
    const source = metadata as { metadata?: { get?: (name: string) => unknown } | null } | null;
    const reader = source?.metadata;
    if (!reader || typeof reader.get !== 'function') return '';
    for (const key of keys) {
      try {
        const value = reader.get(key);
        if (typeof value === 'string' && value.trim()) {
          return value.replace(/\s+/g, ' ').trim().slice(0, 240);
        }
      } catch {
        // 缺失的 XMP 字段直接跳过
      }
    }
    return '';
  };

  const publicationFromMetadata = (metadata: unknown): string => {
    return metadataString(metadata, [
      'prism:publicationName',
      'prism:publicationname',
      'dc:publisher',
      'dc:source'
    ]);
  };

  return { normalizeDoi, extractDoi, metadataString, publicationFromMetadata };
}

export const { normalizeDoi, extractDoi, metadataString, publicationFromMetadata } =
  pdfParseHelpers();
