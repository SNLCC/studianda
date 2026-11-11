const STOPWORDS = new Set([
  '的', '了', '和', '与', '及', '或', '在', '是', '有', '为', '对', '从', '到', '中',
  '这', '那', '一个', '一种', '什么', '如何', '怎么', '为什么', '是否', '可以', '能否',
  '请', '帮我', '关于', '以及', '进行', '通过', '相关', '问题', '文献', '文章',
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are',
  'was', 'were', 'be', 'been', 'this', 'that', 'these', 'those', 'how', 'what', 'why',
  'please', 'about', 'from', 'by', 'as', 'at', 'it', 'its'
]);

/** 本地关键词提取：不调用模型，不联网；用于搜索规划的关键词模式。 */
export function extractKeywords(text: string, limit = 8): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  const chunks = normalized
    .split(/[\s,，。；;：:！!？?、（）()《》【】\[\]"'“”‘’]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !STOPWORDS.has(part.toLowerCase()));
  const ascii = normalized.match(/[A-Za-z][A-Za-z0-9.+#-]{1,}/g) ?? [];
  const chinese = normalized.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of [...chunks, ...ascii, ...chinese]) {
    const value = item.trim();
    if (value.length < 2 || STOPWORDS.has(value.toLowerCase())) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
    if (result.length >= limit) break;
  }
  return result.join(' ');
}
