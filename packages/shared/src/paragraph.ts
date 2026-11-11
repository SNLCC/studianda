/**
 * 段落识别（阅读区批注、内容块/章节识别共用）。
 *
 * PDF 没有"段落"这个概念，文本层只给出字形/行。这里用版面的几何关系还原自然段：
 * 行距突然变大、首行缩进、标题/列表/题注开头、字号突变都是段落边界；同一栏内其余
 * 相邻行属于同一段。用户只要选中一个字母，就返回它所在的那一整段。
 *
 * 输入坐标是归一化页面坐标：left/right 用页宽，top/bottom/size 用页高。
 * 只做纯函数计算，不碰 DOM，便于用真实 PDF 的行数据直接验证。
 *
 * 本模块放在 `@studianda/shared`：阅读器（选区批注）与 Core（问答索引的内容块）
 * 必须用**同一套**段落边界，否则同一段文字在界面与索引里会对不上。
 */

export interface ParagraphLine {
  text: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** 该行字号（页面高度占比）。 */
  size: number;
}

export interface ParagraphResult {
  /** 自然段内的行，按阅读顺序（从上到下）排列。 */
  lines: ParagraphLine[];
  /** 自然段文字：行间补空格、中文/英文断行不补空格、行尾连字符直接接上。 */
  quote: string;
  /** 自然段外接框 [x0, y0, x1, y1]。 */
  rect: [number, number, number, number];
}

/** 整页枚举出的一个自然段（含它在输入行数组里的下标范围）。 */
export interface ParagraphGroup extends ParagraphResult {
  /** 第一行在输入 `lines` 里的下标。 */
  startIndex: number;
  /** 最后一行在输入 `lines` 里的下标。 */
  endIndex: number;
}

const MIN_WIDTH = 0.03;
const NARROW_MAX = 0.62;
const WIDE_MIN = 0.5;
const CLUSTER_TOLERANCE = 0.05;
const TWO_COLUMN_MIN_GAP = 0.25;

const CJK = /[\u2e80-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

const NUMBERED_HEADING = /^(?:[IVXLC]{1,6}\.|\d+(?:\.\d+){0,3}\.|[A-Z]\.)\s+\p{Lu}/u;
const CJK_HEADING =
  /^(?:第[一二三四五六七八九十百千\d]+[章节节]|[一二三四五六七八九十百]{1,4}[、.)）]|\(?[一二三四五六七八九十百]{1,4}\)|[（(]?\d{1,2}[)）.、])\s*[\u4e00-\u9fff]/;
const SECTION_WORD_LINE =
  /^(?:abstract|index\s+terms|key\s*words|introduction|background|related\s+work|methodology|methods?|materials?\s+and\s+methods?|experimental\s+results|results?|discussion|conclusions?|acknowledg(?:e)?ments?|references|bibliography|appendix|摘要|引言|前言|方法|结果|讨论|结论|参考文献)(?:\s*[:：—–-]\s*\S{0,40})?$/i;
const BLOCK_START =
  /^(?:[•·▪◦※*+]\s+|[\[(]?\d{1,3}[.)\]]\s+|[a-zA-Z][.)]\s+|[一二三四五六七八九十百]{1,4}[、.)）]\s*|第[一二三四五六七八九十百千\d]+[章节节]|(?:table|figure|fig\.|表|图)\s*[IVXLC\d])/i;
const SENTENCE_END = /[.。！？!?；;：:…]["'”’）)】\]]?$/;
const CITATION_START = /^(?:\[\d{1,3}\]|\(\d{1,3}\)|\d{1,3}[.)])\s+/;

function quantile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)));
  return sorted[index]!;
}

function median(values: number[]): number {
  return quantile([...values].sort((a, b) => a - b), 0.5);
}

function validLines(lines: readonly ParagraphLine[]): ParagraphLine[] {
  return lines.filter(
    (line) =>
      line.text.trim().length > 0 &&
      line.right - line.left >= MIN_WIDTH &&
      line.bottom > line.top
  );
}

/** 按左边界把行分栏：首行缩进与正文左边只差约一个字号，远小于栏间距。 */
function clusterByLeft(lines: ParagraphLine[]): ParagraphLine[][] {
  const sorted = [...lines].sort((a, b) => a.left - b.left || a.top - b.top);
  const clusters: ParagraphLine[][] = [];
  let current: ParagraphLine[] = [];
  for (const line of sorted) {
    const previous = current[current.length - 1];
    if (previous && line.left - previous.left > CLUSTER_TOLERANCE) {
      clusters.push(current);
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

/**
 * 是否像标题行（标题/题注/列表项本身自成一个"块"，不与正文并段）。
 *
 * `bodySize` 用页面字号中位数（同 ParagraphLine.size 的口径，页面高度占比）。
 */
export function isHeadingLine(line: ParagraphLine, bodySize: number): boolean {
  const text = line.text.trim();
  if (!text || text.length > 120) return false;
  if (NUMBERED_HEADING.test(text) || CJK_HEADING.test(text)) return true;
  if (text.length <= 72 && SECTION_WORD_LINE.test(text)) return true;
  // 标题块/作者/单位这类居中短行各自独立，别把上下行并成一段。
  const width = line.right - line.left;
  if (width < 0.55 && Math.abs((line.left + line.right) / 2 - 0.5) < 0.055) return true;
  return bodySize > 0 && line.size > bodySize * 1.06 + 0.0004 && width < 0.6;
}

/**
 * 这一行是否以"块起始标记"开头：编号标题、列表项、图表题注、章节词。
 *
 * 只做文字规则判断；是否真的另起一段还取决于上一行是否结束（见 `isBoundary`）。
 */
export function startsBlockLine(text: string): boolean {
  const line = text.trim();
  if (!line) return false;
  return NUMBERED_HEADING.test(line) || BLOCK_START.test(line) || SECTION_WORD_LINE.test(line);
}

function joinLines(lines: ParagraphLine[]): string {
  let output = '';
  for (const line of lines) {
    const text = line.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (!output) {
      output = text;
      continue;
    }
    if (output.endsWith('-')) {
      // 行尾连字符：直接接下一行（保留连字符，兼容 "two-column" 这类复合词）。
      output += text;
      continue;
    }
    const previous = output.slice(-1);
    const next = text.charAt(0);
    output += CJK.test(previous) || CJK.test(next) ? text : ` ${text}`;
  }
  return output.trim();
}

interface RegionContext {
  lines: ParagraphLine[];
  colLeft: number;
  colRight: number;
  indent: number;
  bodySize: number;
  gap: number;
  lineHeight: number;
  justified: boolean;
  shortLine: number;
  useIndent: boolean;
  /** 参考文献这类悬挂缩进的续行：它们缩进但不该另起一段。 */
  hanging: Set<ParagraphLine>;
}

function buildContext(
  lines: ParagraphLine[],
  colLeft: number,
  colRight: number,
  bodySize: number,
  aspect: number,
  useIndent: boolean
): RegionContext {
  const sorted = [...lines].sort((a, b) => a.top - b.top || a.left - b.left);
  const heights = sorted
    .filter((line) => line.right - line.left > 0.12)
    .map((line) => line.bottom - line.top);
  const lineHeight = heights.length > 0 ? median(heights) : Math.max(0.008, bodySize);

  const gaps: number[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    const pitch = current.top - previous.top;
    if (pitch <= 0.002) continue;
    const gap = current.top - previous.bottom;
    if (gap > -pitch) gaps.push(gap);
  }
  const sortedGaps = gaps.sort((a, b) => a - b);
  const medianGap = sortedGaps.length > 0 ? median(sortedGaps) : lineHeight * 0.2;
  const q75 = quantile(sortedGaps, 0.75);
  const q25 = quantile(sortedGaps, 0.25);
  const gapThreshold =
    sortedGaps.length >= 8
      ? Math.max(q75 + (q75 - q25) * 1.5, medianGap * 1.6, lineHeight * 0.14)
      : Math.max(medianGap * 1.8, lineHeight * 0.16);

  const body = sorted.filter(
    (line) => line.right - line.left <= NARROW_MAX && line.right - line.left > 0.12
  );
  const em = Math.max(0.002, bodySize * aspect);
  const tolerance = Math.max(0.02, em * 1.5);
  const aligned = body.filter((line) => colRight - line.right < tolerance).length;
  const justified = body.length >= 3 && aligned / body.length >= 0.6;
  const indent = Math.max(0.45 * em, 0.004);

  const hanging = new Set<ParagraphLine>();
  let reference = false;
  for (const line of sorted) {
    const text = line.text.trim();
    const atMargin = line.left <= colLeft + indent;
    if (atMargin && CITATION_START.test(text)) {
      reference = true;
    } else if (atMargin) {
      reference = false;
    }
    if (reference && !atMargin) hanging.add(line);
  }

  return {
    lines: sorted,
    colLeft,
    colRight,
    indent,
    bodySize,
    gap: gapThreshold,
    lineHeight,
    justified,
    shortLine: Math.max(3.5 * em, 0.05),
    useIndent,
    hanging
  };
}

function isBoundary(upper: ParagraphLine, lower: ParagraphLine, context: RegionContext): boolean {
  const pitch = lower.top - upper.top;
  if (pitch <= 0.0005) return true;
  if (lower.top - upper.bottom > context.gap) return true;

  if (context.bodySize > 0) {
    const smaller = Math.min(upper.size, lower.size);
    const larger = Math.max(upper.size, lower.size);
    if (
      larger > smaller * 1.08 &&
      larger - smaller > Math.max(0.0012, context.bodySize * 0.08)
    ) {
      return true;
    }
  }

  if (lower.left < context.colLeft - context.indent) return true;
  if (context.useIndent && lower.left - context.colLeft > context.indent && !context.hanging.has(lower)) {
    return true;
  }
  if (startsBlockLine(lower.text)) return true;

  // 上一行本身是标题/题注时，下面这行必须另起一段（"Acknowledgment" 这种
  // 字号与正文相同的单行标题只能靠文字与短行判断）。
  const upperText = upper.text.trim();
  const columnWidth = Math.max(0.01, context.colRight - context.colLeft);
  const shortLineOk = upper.right - upper.left < columnWidth * 0.65;
  if (
    upperText.length <= 80 &&
    shortLineOk &&
    (SECTION_WORD_LINE.test(upperText) ||
      NUMBERED_HEADING.test(upperText) ||
      (context.bodySize > 0 && upper.size > context.bodySize * 1.06 + 0.0004))
  ) {
    return true;
  }

  // 两端对齐的正文里，段落最后一行会明显短于右边界；下一行接着正文左边界，
  // 且上一行以句末标点收尾时，这就是段落结束（适用于段间不缩进的版式）。
  if (
    context.justified &&
    upper.right < context.colRight - context.shortLine &&
    lower.left <= context.colLeft + context.indent &&
    SENTENCE_END.test(upper.text.trim())
  ) {
    return true;
  }

  return false;
}

function regionForFullWidth(lines: ParagraphLine[], aspect: number): RegionContext {
  const wide = lines.filter((line) => line.right - line.left >= WIDE_MIN);
  const source = wide.length >= 2 ? wide : lines;
  const lefts = [...source.map((line) => line.left)].sort((a, b) => a - b);
  const rights = [...source.map((line) => line.right)].sort((a, b) => a - b);
  const sizes = source.map((line) => line.size);
  return buildContext(
    source,
    quantile(lefts, 0.05),
    quantile(rights, 0.95),
    median(sizes),
    aspect,
    false
  );
}

function regionForColumn(
  lines: ParagraphLine[],
  cluster: ParagraphLine[],
  aspect: number
): RegionContext {
  const lefts = [...cluster.map((line) => line.left)].sort((a, b) => a - b);
  const rights = [...cluster.map((line) => line.right)].sort((a, b) => a - b);
  const colLeft = quantile(lefts, 0.05);
  const colRight = quantile(rights, 0.95);
  const candidates = lines.filter((line) => {
    const center = (line.left + line.right) / 2;
    return center >= colLeft && center <= colRight + 0.005;
  });
  const bodySizes = cluster
    .filter((line) => line.right - line.left > 0.12)
    .map((line) => line.size);
  return buildContext(
    candidates,
    colLeft,
    colRight,
    bodySizes.length > 0 ? median(bodySizes) : 0,
    aspect,
    true
  );
}

function regionForPage(lines: ParagraphLine[], aspect: number): RegionContext {
  const body = lines.filter((line) => {
    const center = (line.left + line.right) / 2;
    return center > 0.06 && center < 0.94;
  });
  const source = body.length >= 2 ? body : lines;
  const lefts = [...source.map((line) => line.left)].sort((a, b) => a - b);
  const rights = [...source.map((line) => line.right)].sort((a, b) => a - b);
  return buildContext(
    source,
    quantile(lefts, 0.1),
    quantile(rights, 0.9),
    median(source.map((line) => line.size)),
    aspect,
    true
  );
}

/** 取 index 所在自然段；识别不出时返回 null（调用方退回选区本身）。 */
export function paragraphAt(
  lines: readonly ParagraphLine[],
  index: number,
  aspect = 1.414
): ParagraphResult | null {
  const available = validLines(lines);
  const selected = available.find((line) => line === lines[index]);
  if (!selected) return null;

  const globalSizes = available
    .filter((line) => line.right - line.left > 0.12)
    .map((line) => line.size);
  const globalBodySize = globalSizes.length > 0 ? median(globalSizes) : 0;

  // 标题/题注/列表项本身不是一个自然段：只标它自己，别把正文并进来。
  if (isHeadingLine(selected, globalBodySize)) {
    return {
      lines: [selected],
      quote: joinLines([selected]),
      rect: [selected.left, selected.top, selected.right, selected.bottom]
    };
  }

  const narrow = available.filter(
    (line) => line.right - line.left <= NARROW_MAX && line.right - line.left > 0.06
  );
  const clusters = clusterByLeft(narrow).filter((cluster) => cluster.length >= 2);
  // 判双栏看"两条主栏"的间距与栏区不重叠，而不是任意相邻左边界：
  // 居中标题、作者行会插在两栏之间，用相邻差会被它们撑小，误判成单栏。
  const edgeOf = (cluster: ParagraphLine[]): { left: number; right: number } => {
    const lefts = cluster.map((line) => line.left).sort((a, b) => a - b);
    const rights = cluster.map((line) => line.right).sort((a, b) => a - b);
    return { left: quantile(lefts, 0.05), right: quantile(rights, 0.95) };
  };
  const strongClusters = clusters.filter(
    (cluster) => cluster.length >= Math.max(4, Math.round(narrow.length * 0.08))
  );
  let twoColumns = false;
  for (let first = 0; first < strongClusters.length && !twoColumns; first += 1) {
    for (let second = first + 1; second < strongClusters.length; second += 1) {
      const a = edgeOf(strongClusters[first]!);
      const b = edgeOf(strongClusters[second]!);
      const leftCluster = a.left <= b.left ? a : b;
      const rightCluster = a.left <= b.left ? b : a;
      if (
        rightCluster.left - leftCluster.left >= TWO_COLUMN_MIN_GAP &&
        rightCluster.left - leftCluster.right > 0.005
      ) {
        twoColumns = true;
        break;
      }
    }
  }

  let context: RegionContext;
  const selectedWidth = selected.right - selected.left;
  // 通栏段落的最后一行可能很短：看它上下紧邻的行是不是明显跨过栏间空白。
  const nearFullWidth = available.some((line) => {
    if (line.right - line.left <= NARROW_MAX) return false;
    if (line.right < selected.right - 0.01 || line.left > selected.left + 0.01) return false;
    const distance = Math.abs(
      (line.top + line.bottom) / 2 - (selected.top + selected.bottom) / 2
    );
    return distance < Math.max(0.04, (selected.bottom - selected.top) * 2.6);
  });
  const fullWidthLine =
    selectedWidth > NARROW_MAX || (selected.left < 0.28 && selected.right > 0.72) || nearFullWidth;

  if (twoColumns && fullWidthLine) {
    context = regionForFullWidth(available, aspect);
  } else if (twoColumns) {
    // 先看选中行横向覆盖哪一栏，再按栏内行数排序：缩进很大的首行也能对上它的栏。
    const chosen = clusters
      .map((cluster) => {
        const band = edgeOf(cluster);
        const overlap = Math.max(
          0,
          Math.min(band.right, selected.right) - Math.max(band.left, selected.left)
        );
        return {
          cluster,
          coverage: overlap / Math.max(0.001, selectedWidth),
          count: cluster.length,
          distance: Math.abs(band.left - selected.left)
        };
      })
      .filter((item) => item.coverage >= 0.5)
      .sort((a, b) => b.count - a.count || b.coverage - a.coverage || a.distance - b.distance)[0];
    context = chosen
      ? regionForColumn(available, chosen.cluster, aspect)
      : regionForPage(available, aspect);
  } else {
    context = regionForPage(available, aspect);
  }

  let selectedIndex = context.lines.indexOf(selected);
  if (selectedIndex < 0) {
    // 选区行不在该栏候选里（例如分栏估计有偏差）：按中心距离取最近的一行。
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    context.lines.forEach((line, position) => {
      const lineCenter = (line.left + line.right) / 2;
      const selectedCenter = (selected.left + selected.right) / 2;
      const distance =
        Math.abs((line.top + line.bottom) / 2 - (selected.top + selected.bottom) / 2) +
        Math.abs(lineCenter - selectedCenter) * 2;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = position;
      }
    });
    selectedIndex = best;
  }

  let start = selectedIndex;
  while (start > 0 && !isBoundary(context.lines[start - 1]!, context.lines[start]!, context)) {
    start -= 1;
  }
  let end = selectedIndex;
  while (
    end + 1 < context.lines.length &&
    !isBoundary(context.lines[end]!, context.lines[end + 1]!, context)
  ) {
    end += 1;
  }

  const paragraph = context.lines.slice(start, end + 1).sort((a, b) => a.top - b.top);
  if (paragraph.length === 0) return null;
  return {
    lines: paragraph,
    quote: joinLines(paragraph),
    rect: [
      Math.min(...paragraph.map((line) => line.left)),
      Math.min(...paragraph.map((line) => line.top)),
      Math.max(...paragraph.map((line) => line.right)),
      Math.max(...paragraph.map((line) => line.bottom))
    ]
  };
}

/**
 * 枚举整页/整篇的自然段（按输入行顺序，同一段只出现一次）。
 *
 * 只对"还没归入任何段"的行调用 `paragraphAt`：一次调用就把整段标掉，
 * 因此 N 行页面只需 O(段数) 次识别，而不是 N 次。
 * 无效行（空文字/过窄）直接跳过，不生成段落。
 *
 * 输入行必须是**阅读顺序**（`structure.orderPageLines` 的结果）；双栏页请按栏顺序传入，
 * 这样段落在两栏之间不会串行。
 */
export function paragraphGroups(
  lines: readonly ParagraphLine[],
  aspect = 1.414
): ParagraphGroup[] {
  const available = new Set(validLines(lines));
  const indexOfLine = new Map<ParagraphLine, number>();
  lines.forEach((line, index) => {
    if (!indexOfLine.has(line)) indexOfLine.set(line, index);
  });
  const assigned = new Set<number>();
  const groups: ParagraphGroup[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (assigned.has(index)) continue;
    const line = lines[index]!;
    if (!available.has(line)) {
      assigned.add(index);
      continue;
    }
    const paragraph = paragraphAt(lines, index, aspect);
    if (!paragraph) {
      assigned.add(index);
      continue;
    }
    const positions = paragraph.lines
      .map((item) => indexOfLine.get(item))
      .filter((value): value is number => value !== undefined);
    if (positions.length === 0) {
      assigned.add(index);
      continue;
    }
    for (const position of positions) assigned.add(position);
    groups.push({
      ...paragraph,
      startIndex: Math.min(...positions),
      endIndex: Math.max(...positions)
    });
  }
  return groups;
}
