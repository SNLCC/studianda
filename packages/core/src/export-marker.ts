import { withAiExportHeader } from '@studianda/shared';

/**
 * AI 标识拒绝文案（中文，可直接给用户看）。
 *
 * 导出是 fail-closed：只要内容里确实带 AI 生成内容的标识（`looksLikeAiContent` 命中），
 * 而机器可读的 `aigc` 标识没有成功写进产物，就拒绝产出文件——宁可不导出，也不产出
 * “去标识”的 AI 内容。上层路由按本文案前缀返回 4xx 与明确错误。
 */
export const AI_EXPORT_REFUSED_PHRASE = '拒绝导出未标识的 AI 内容';
export const AI_EXPORT_REFUSED_MESSAGE =
  `${AI_EXPORT_REFUSED_PHRASE}：导出内容包含 AI 生成内容，但 AI 标识没有成功写入；` +
  '为避免产出无标识文件，已中止导出。';

const YAML_FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/**
 * Markdown 产物是否真的带导出文件头（YAML frontmatter 里的 `aigc: true`）。
 *
 * 只认文件**最前面**的 frontmatter：`renderMarkdown` 也只把最前面的 frontmatter 当元数据。
 */
export function markdownHasAiExportHeader(markdown: string): boolean {
  const frontmatter = YAML_FRONTMATTER_RE.exec(markdown);
  if (!frontmatter) return false;
  return /^aigc:\s*true\s*$/m.test(frontmatter[1]!);
}

/** 是否命中 fail-closed 拒绝（server 据此映射 4xx，而不是当成普通导出失败）。 */
export function isAiExportRefused(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(AI_EXPORT_REFUSED_PHRASE);
}

export interface MarkdownExportOptions {
  /**
   * 可注入的写头函数。
   *
   * 生产路径固定用 shared 的 `withAiExportHeader`；参数只为测试保留——用来模拟
   * 「写头失败/漏写」并验证 fail-closed 守卫真的拒绝产出，而不是形同虚设。
   */
  writeHeader?: (markdown: string, containsAi: boolean) => string;
}

/**
 * Markdown 导出的唯一入口：含 AI 内容时强制写文件头，并**核验写进去了**。
 *
 * - 纯用户内容（`containsAi=false`）：原样返回，不加任何 AI 元数据；
 * - 含 AI 内容：写头后校验 frontmatter `aigc: true`，缺失就抛 `AI_EXPORT_REFUSED_MESSAGE`。
 */
export function buildMarkedMarkdownExport(
  body: string,
  containsAi: boolean,
  options: MarkdownExportOptions = {}
): string {
  const writeHeader = options.writeHeader ?? withAiExportHeader;
  const markdown = writeHeader(body, containsAi);
  if (containsAi && !markdownHasAiExportHeader(markdown)) {
    throw new Error(AI_EXPORT_REFUSED_MESSAGE);
  }
  return markdown;
}
