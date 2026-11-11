/**
 * contenteditable（富文本模式）→ Markdown 序列化。
 *
 * 只覆盖当前渲染/存储支持的语法子集：标题、粗斜/下划线/删除线/高亮、行内代码、
 * 代码块、引用、嵌套列表、任务清单、GFM 表格、分隔线、链接、内部引用、图片、
 * 文字颜色 `<c:#hex>`、对齐块 `::: align`。
 *
 * 文本节点做 Markdown 反斜杠转义，避免用户输入的 `*`、`[`、`|` 等被当成格式；
 * shared 的 renderInline 已支持这些字面量转义（`\*` 等）。
 */

const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'UL',
  'OL',
  'LI',
  'BLOCKQUOTE',
  'PRE',
  'TABLE',
  'THEAD',
  'TBODY',
  'TFOOT',
  'TR',
  'TD',
  'TH',
  'HR',
  'SECTION',
  'ARTICLE',
  'HEADER',
  'FOOTER',
  'ADDRESS',
  'FIGURE',
  'FIGCAPTION',
  'DL',
  'DT',
  'DD',
  'FORM',
  'FIELDSET'
]);

const ESCAPE_PATTERN = /[\\`*_~=+\[\]<>|]/g;

/** 对 Markdown 正文做反斜杠转义（保留普通文字，不让标点被解析成格式）。 */
export function escapeMarkdownText(value: string): string {
  return value.replace(ESCAPE_PATTERN, '\\$&');
}

/** HTML 文本转义（富文本 insertHTML 时使用）。 */
export function escapeHtmlText(value: string): string {
  const escapes: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  };
  return value.replace(/[&<>"']/g, (character) => escapes[character] ?? character);
}

/** HTML 属性值转义。 */
export function escapeHtmlAttribute(value: string): string {
  return escapeHtmlText(value).replace(/`/g, '&#96;');
}

function nodeChildren(node: Node): Node[] {
  const childNodes = node.childNodes as unknown as ArrayLike<Node> | undefined;
  if (!childNodes) return [];
  return Array.from(childNodes);
}

function isElement(node: Node): boolean {
  return node.nodeType === 1;
}

function isText(node: Node): boolean {
  return node.nodeType === 3;
}

function tagOf(node: Node): string {
  return String((node as Element).tagName ?? '').toLowerCase();
}

function getAttr(node: Node, name: string): string | null {
  const element = node as Element;
  if (typeof element.getAttribute !== 'function') return null;
  return element.getAttribute(name);
}

function styleOf(node: Node): { color?: string; textAlign?: string; backgroundColor?: string } {
  const style = (node as HTMLElement).style;
  if (!style) return {};
  return { color: style.color, textAlign: style.textAlign, backgroundColor: style.backgroundColor };
}

function textOf(node: Node): string {
  if (typeof node.textContent === 'string') return node.textContent;
  return nodeChildren(node).map(textOf).join('');
}

function hasBlockChildren(node: Node): boolean {
  return nodeChildren(node).some(
    (child) => isElement(child) && BLOCK_TAGS.has(tagOf(child).toUpperCase())
  );
}

/** 把浏览器可能返回的 rgb()/命名颜色尽量规范成 #rrggbb；无法识别时返回 null。 */
export function normalizeCssColor(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(trimmed) || /^#[0-9a-f]{6}$/.test(trimmed)) {
    return trimmed;
  }
  const rgb = /^rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})/.exec(trimmed);
  if (rgb) {
    const channel = (index: number): string =>
      Math.max(0, Math.min(255, Number(rgb[index]))).toString(16).padStart(2, '0');
    return `#${channel(1)}${channel(2)}${channel(3)}`;
  }
  return null;
}

function normalizeAlignment(value: string | null | undefined): string | null {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized === 'left' ||
    normalized === 'center' ||
    normalized === 'right' ||
    normalized === 'justify'
    ? normalized
    : null;
}

function normalizeInlineText(value: string): string {
  return escapeMarkdownText(
    value
      .replace(/\r\n?/g, '\n')
      .replace(/[\t ]+/g, ' ')
      .replace(/\n+/g, ' ')
  );
}

function wrapInline(node: Node, before: string, after: string): string {
  const inner = serializeInlineChildren(node).trim();
  if (!inner) return '';
  return `${before}${inner}${after}`;
}

function serializeAnchor(node: Node): string {
  const kind = getAttr(node, 'data-internal-kind');
  const documentId = getAttr(node, 'data-internal-doc') ?? '';
  const itemId = getAttr(node, 'data-internal-id') ?? '';
  const rawLabel =
    getAttr(node, 'data-internal-label') || serializeInlineChildren(node).trim() || '内部引用';
  if (kind && documentId) {
    const label = rawLabel.replace(/[|\]]/g, ' ').trim();
    const suffix = label ? `|${label}` : '';
    if (kind === 'document') return `[[doc:${documentId}${suffix}]]`;
    if (kind === 'annotation' && itemId) return `[[ann:${documentId}/${itemId}${suffix}]]`;
    if (kind === 'note' && itemId) return `[[note:${documentId}/${itemId}${suffix}]]`;
  }
  // 独立笔记：`[[note:<noteId>]]`（没有文档 id）。
  if (kind === 'note' && !documentId && itemId) {
    const label = rawLabel.replace(/[|\]]/g, ' ').trim();
    return `[[note:${itemId}${label ? `|${label}` : ''}]]`;
  }
  const href = getAttr(node, 'href') ?? '';
  const label = serializeInlineChildren(node).trim() || href;
  if (!href || href === '#') return label;
  return `[${label}](${href})`;
}

function serializeImage(node: Node): string {
  const src = getAttr(node, 'src') ?? '';
  if (!src) return '';
  const alt = (getAttr(node, 'alt') ?? '').replace(/[[\]()]/g, ' ');
  return `![${alt}](${src})`;
}

function serializeInline(node: Node): string {
  if (isText(node)) return normalizeInlineText(node.nodeValue ?? '');
  if (!isElement(node)) return '';
  const tag = tagOf(node);
  switch (tag) {
    case 'br':
      return '\n';
    case 'strong':
    case 'b':
      return wrapInline(node, '**', '**');
    case 'em':
    case 'i':
      return wrapInline(node, '*', '*');
    case 'u':
      return wrapInline(node, '++', '++');
    case 'del':
    case 's':
    case 'strike':
      return wrapInline(node, '~~', '~~');
    case 'mark':
      return wrapInline(node, '==', '==');
    case 'code': {
      const content = textOf(node).replace(/`/g, '\\`').replace(/\n+/g, ' ');
      return content ? `\`${content}\`` : '';
    }
    case 'a':
      return serializeAnchor(node);
    case 'img':
      return serializeImage(node);
    case 'span': {
      const color = normalizeCssColor(styleOf(node).color);
      if (color) return `<c:${color}>${serializeInlineChildren(node)}</c>`;
      return serializeInlineChildren(node);
    }
    case 'font': {
      const color = normalizeCssColor(getAttr(node, 'color') ?? styleOf(node).color);
      if (color) return `<c:${color}>${serializeInlineChildren(node)}</c>`;
      return serializeInlineChildren(node);
    }
    case 'input':
      // 任务清单复选框在列表项里处理；其他输入控件忽略。
      return '';
    default: {
      if (BLOCK_TAGS.has(tag.toUpperCase())) return serializeBlocks(node);
      return serializeInlineChildren(node);
    }
  }
}

function serializeInlineChildren(node: Node): string {
  return nodeChildren(node).map(serializeInline).join('');
}

function serializeListItemContent(li: Node): { content: string; nested: string[]; task: boolean | null } {
  let content = '';
  let task: boolean | null = null;
  const nested: string[] = [];
  for (const child of nodeChildren(li)) {
    if (isElement(child)) {
      const tag = tagOf(child);
      if (tag === 'ul' || tag === 'ol') {
        const nestedMarkdown = serializeList(child, 0);
        if (nestedMarkdown) nested.push(nestedMarkdown);
        continue;
      }
      if (tag === 'input') {
        const type = (getAttr(child, 'type') ?? '').toLowerCase();
        if (type === 'checkbox') {
          const checkedAttr = getAttr(child, 'checked');
          task =
            checkedAttr !== null ||
            Boolean((child as HTMLInputElement).checked) ||
            (getAttr(child, 'aria-label') ?? '').includes('已完成');
          continue;
        }
      }
      if (tag === 'p' || tag === 'div') {
        content += serializeInlineChildren(child);
        continue;
      }
    }
    content += serializeInline(child);
  }
  return {
    content: content.replace(/[ \t]+/g, ' ').replace(/\n+/g, ' ').trim(),
    nested,
    task
  };
}

function serializeList(list: Node, depth: number): string {
  const ordered = tagOf(list) === 'ol';
  const indent = '  '.repeat(depth);
  const lines: string[] = [];
  const items = nodeChildren(list).filter((child) => isElement(child) && tagOf(child) === 'li');
  items.forEach((li, index) => {
    const { content, nested, task } = serializeListItemContent(li);
    const marker = ordered ? `${index + 1}. ` : task === null ? '- ' : task ? '- [x] ' : '- [ ] ';
    lines.push(`${indent}${marker}${content}`.trimEnd());
    for (const nestedMarkdown of nested) {
      const nestedLines = nestedMarkdown.split('\n').map((line) => `${indent}  ${line}`);
      lines.push(...nestedLines);
    }
  });
  return lines.join('\n');
}

function serializeTable(table: Node): string {
  const rows: string[][] = [];
  const collectRows = (node: Node): void => {
    for (const child of nodeChildren(node)) {
      if (!isElement(child)) continue;
      const tag = tagOf(child);
      if (tag === 'tr') {
        const cells = nodeChildren(child)
          .filter(
            (cell) => isElement(cell) && (tagOf(cell) === 'td' || tagOf(cell) === 'th')
          )
          .map((cell) => serializeInlineChildren(cell).trim().replace(/\|/g, '\\|'));
        rows.push(cells);
        continue;
      }
      if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') collectRows(child);
    }
  };
  collectRows(table);
  if (rows.length === 0) return '';
  const width = rows.reduce((max, row) => Math.max(max, row.length), 1);
  const pad = (row: string[]): string[] => {
    const next = [...row];
    while (next.length < width) next.push('');
    return next.slice(0, width);
  };
  const [header, ...body] = rows;
  const lines: string[][] = [
    pad(header ?? []),
    Array.from({ length: width }, () => '---'),
    ...body.map(pad)
  ];
  return lines.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function fenceFor(content: string): string {
  let fence = '```';
  while (content.includes(fence)) fence += '`';
  return fence;
}

function serializeCodeBlock(pre: Node): string {
  const codeNode = nodeChildren(pre).find((child) => isElement(child) && tagOf(child) === 'code');
  const content = (codeNode ? textOf(codeNode) : textOf(pre)).replace(/\r\n?/g, '\n');
  const className = codeNode ? getAttr(codeNode, 'class') ?? '' : '';
  const language = /(?:^|\s)language-([\w+-]+)/.exec(className)?.[1] ?? '';
  const fence = fenceFor(content);
  return `${fence}${language}\n${content.replace(/\n$/, '')}\n${fence}`;
}

function prefixBlockquote(markdown: string): string {
  return markdown
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

function serializeBlock(node: Node): string {
  const tag = tagOf(node);
  if (/^h[1-6]$/.test(tag)) {
    return `${'#'.repeat(Number(tag[1]))} ${serializeInlineChildren(node).trim()}`;
  }
  if (tag === 'p') return serializeInlineChildren(node).trim();
  if (tag === 'div') {
    const inner = hasBlockChildren(node)
      ? serializeBlocks(node)
      : serializeInlineChildren(node).trim();
    if (!inner) return '';
    const align = normalizeAlignment(styleOf(node).textAlign);
    return align ? `::: ${align}\n${inner}\n:::` : inner;
  }
  if (tag === 'ul' || tag === 'ol') return serializeList(node, 0);
  if (tag === 'blockquote') return prefixBlockquote(serializeBlocks(node));
  if (tag === 'pre') return serializeCodeBlock(node);
  if (tag === 'table') return serializeTable(node);
  if (tag === 'hr') return '---';
  if (tag === 'li') {
    const { content } = serializeListItemContent(node);
    return content ? `- ${content}` : '';
  }
  return hasBlockChildren(node) ? serializeBlocks(node) : serializeInlineChildren(node).trim();
}

function serializeBlocks(container: Node): string {
  const parts: string[] = [];
  let inlineBuffer = '';
  const flushInline = (): void => {
    const value = inlineBuffer.replace(/[ \t]+/g, ' ').trim();
    inlineBuffer = '';
    if (value) parts.push(value);
  };
  for (const child of nodeChildren(container)) {
    if (isElement(child) && BLOCK_TAGS.has(tagOf(child).toUpperCase())) {
      flushInline();
      const block = serializeBlock(child).trim();
      if (block) parts.push(block);
    } else {
      inlineBuffer += serializeInline(child);
    }
  }
  flushInline();
  return parts.join('\n\n');
}

/**
 * 把 contenteditable 的 DOM 序列化成 Markdown。
 *
 * `root` 可以是 contenteditable 元素，也可以是任意包含节点树的容器；
 * 纯函数、不访问全局 document，方便 SSR/单元测试（用最小 DOM 结构也能验证）。
 */
export function htmlToMarkdown(root: Node): string {
  return serializeBlocks(root)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
