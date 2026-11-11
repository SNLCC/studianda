const CN_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9
};
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const PAGE_MENTION =
  /第\s*([0-9]{1,4}|[零〇一二两三四五六七八九十百千]{1,8})\s*[页頁]|\b[Pp](?:age|\.)\s*([0-9]{1,4})\b/g;

export interface PageMention {
  raw: string;
  page: number | null;
}

export function chineseNumber(text: string): number | null {
  let total = 0;
  let section = 0;
  let number = 0;
  for (const char of text) {
    if (char in CN_DIGITS) {
      number = CN_DIGITS[char]!;
    } else if (char in CN_UNITS) {
      section += (number || 1) * CN_UNITS[char]!;
      number = 0;
    } else {
      return null;
    }
  }
  return section + number;
}

function mentionPage(match: RegExpExecArray): number | null {
  if (match[1] !== undefined) {
    return /^[0-9]+$/.test(match[1]) ? Number(match[1]) : chineseNumber(match[1]);
  }
  return Number(match[2]);
}

export function pageMentions(text: string): PageMention[] {
  const found: PageMention[] = [];
  for (const match of text.matchAll(PAGE_MENTION)) {
    found.push({ raw: match[0], page: mentionPage(match) });
  }
  return found;
}

/** 删除没有来源页支持的页码表述，并返回删除记录。 */
export function stripUnsupportedPages(
  text: string,
  allowed: Set<number>
): { text: string; removed: string[] } {
  const removed: string[] = [];
  const cleaned = text.replace(PAGE_MENTION, (raw, first: string, second: string) => {
    const page = first !== undefined
      ? /^[0-9]+$/.test(first) ? Number(first) : chineseNumber(first)
      : Number(second);
    if (page !== null && allowed.has(page)) return raw;
    removed.push(raw);
    return '';
  });
  return {
    text: cleaned
      .replace(/[（(]\s*[)）]/g, '')
      .replace(/[ \t]{2,}/g, ' ')
      .trim(),
    removed
  };
}
