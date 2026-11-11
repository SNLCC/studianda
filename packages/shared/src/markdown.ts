/**
 * 笔记 / 批注用的轻量 Markdown：渲染 + 编辑命令 + 内部引用语法。
 *
 * 设计原则：
 * - **存储保持 Markdown 文本**（纯文本即合法 Markdown，旧数据无需迁移）；
 * - `renderMarkdown` 输出的 HTML 由本模块自行转义所有用户输入，只生成白名单标签；
 * - 内部引用使用自定义语法：`[[doc:<id>|标签]]`、`[[ann:<docId>/<annId>|标签]]`、
 *   `[[note:<docId>/<noteId>|标签]]`，渲染成带 data 属性的链接，由界面负责跳转；
 * - 不引入第三方 Markdown/富文本依赖（Phase 1），格式范围与编辑器命令集中在这里，
 *   后续换 WYSIWYG 时可以替换渲染层而不改存储。
 */

export type MarkdownInternalTarget =
  | { kind: 'document'; documentId: string; label: string }
  | { kind: 'annotation'; documentId: string; annotationId: string; label: string }
  | { kind: 'note'; documentId: string; noteId: string; label: string };

export interface MarkdownInternalLink {
  target: MarkdownInternalTarget;
  label: string;
}

/** 解析 `[[...]]` 里的内容；不合法返回 null。 */
export function parseMarkdownInternalLink(raw: string): MarkdownInternalLink | null {
  const value = raw.trim();
  const separator = value.indexOf('|');
  const head = (separator >= 0 ? value.slice(0, separator) : value).trim();
  const label = (separator >= 0 ? value.slice(separator + 1) : '').trim();
  const match = /^(doc|document|ann|annotation|note):(.+)$/i.exec(head);
  if (!match) return null;
  const kind = match[1]!.toLowerCase();
  const payload = match[2]!.trim();
  if (!payload || payload.length > 200) return null;
  if (kind === 'doc' || kind === 'document') {
    return {
      target: { kind: 'document', documentId: payload, label },
      label
    };
  }
  if (kind === 'ann' || kind === 'annotation') {
    const [documentId, itemId] = payload.split('/');
    if (!documentId || !itemId) return null;
    return {
      target: { kind: 'annotation', documentId, annotationId: itemId, label },
      label
    };
  }
  // 独立笔记：`[[note:<noteId>]]`（没有斜杠，documentId 为空）；依附文献的笔记仍是
  // `[[note:<documentId>/<noteId>]]`。
  if (!payload.includes('/')) {
    return { target: { kind: 'note', documentId: '', noteId: payload, label }, label };
  }
  const [documentId, itemId] = payload.split('/');
  if (!documentId || !itemId) return null;
  return { target: { kind: 'note', documentId, noteId: itemId, label }, label };
}

export type MarkdownInternalTargetInput =
  | { kind: 'document'; documentId: string }
  | { kind: 'annotation'; documentId: string; annotationId: string }
  | { kind: 'note'; documentId: string; noteId: string };

/** 生成内部引用文本（供“插入引用”使用）。 */
export function formatMarkdownInternalLink(
  target: MarkdownInternalTargetInput,
  label: string
): string {
  const safeLabel = label.replace(/[|\]]/g, ' ').trim();
  const suffix = safeLabel ? `|${safeLabel}` : '';
  if (target.kind === 'document') return `[[doc:${target.documentId}${suffix}]]`;
  if (target.kind === 'annotation') {
    return `[[ann:${target.documentId}/${target.annotationId}${suffix}]]`;
  }
  return target.documentId
    ? `[[note:${target.documentId}/${target.noteId}${suffix}]]`
    : `[[note:${target.noteId}${suffix}]]`;
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function normalizedUrl(raw: string, mode: 'link' | 'image'): string | null {
  const value = raw.trim().replace(/^<|>$/g, '');
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  if (/^mailto:/i.test(value) && mode === 'link') return value;
  if (/^studianda-asset:/i.test(value)) return value;
  if (mode === 'image' && /^data:image\/(png|jpe?g|gif|webp);base64,[a-z0-9+/=]+$/i.test(value)) {
    return value;
  }
  // 本机绝对路径：只作为文本/链接展示，不在这里变成可执行协议。
  if (mode === 'link' && /^file:\/\//i.test(value)) return value;
  return null;
}

interface RenderState {
  /** 脚注定义：label → 内容，渲染时按引用顺序输出。 */
  footnotes: Map<string, string>;
  usedFootnotes: string[];
}

function footnoteId(label: string): string {
  return label.replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '_');
}

/** 行内渲染：所有文本都先转义，只生成白名单标签。 */
function renderInline(raw: string, state: RenderState): string {
  let out = '';
  let index = 0;
  const text = raw.replace(/\r\n?/g, '\n');
  const pushText = (value: string): void => {
    out += escapeHtml(value);
  };
  while (index < text.length) {
    const rest = text.slice(index);
    // 反斜杠转义：富文本序列化时用来保护普通标点，不渲染成格式。
    if (rest.startsWith('\\') && rest.length > 1 && '\\`*_{}[]()#+-.!~=+<>|'.includes(rest[1]!)) {
      out += escapeHtml(rest[1]!);
      index += 2;
      continue;
    }
    // 文字颜色扩展：<c:#b23b2e>文字</c>（只接受十六进制色值，避免任意 HTML）。
    if (rest.startsWith('<c:')) {
      const open = /^<c:(#[0-9a-fA-F]{3,8})>/.exec(rest);
      if (open) {
        const close = rest.indexOf('</c>', open[0].length);
        if (close > open[0].length) {
          const inner = rest.slice(open[0].length, close);
          out += `<span class="kr-md-color" style="color:${open[1]}">${renderInline(
            inner,
            state
          )}</span>`;
          index += close + 4;
          continue;
        }
      }
    }
    // 内部引用 [[...]]
    if (rest.startsWith('[[')) {
      const end = rest.indexOf(']]', 2);
      if (end > 2) {
        const parsed = parseMarkdownInternalLink(rest.slice(2, end));
        if (parsed) {
          const label = parsed.label || '内部引用';
          const target = parsed.target;
          const attrs =
            target.kind === 'document'
              ? `data-internal-kind="document" data-internal-doc="${escapeHtml(target.documentId)}"`
              : target.kind === 'annotation'
                ? `data-internal-kind="annotation" data-internal-doc="${escapeHtml(
                    target.documentId
                  )}" data-internal-id="${escapeHtml(target.annotationId)}"`
                : `data-internal-kind="note" data-internal-doc="${escapeHtml(
                    target.documentId
                  )}" data-internal-id="${escapeHtml(target.noteId)}"`;
          out += `<a class="kr-md-link kr-md-internal" href="#" ${attrs} data-internal-label="${escapeHtml(
            label
          )}" title="内部引用：${escapeHtml(label)}">${escapeHtml(label)}</a>`;
          index += end + 2;
          continue;
        }
      }
    }
    // 脚注引用 [^label]
    const footnote = /^\[\^([^\]\s]+)\]/.exec(rest);
    if (footnote) {
      const label = footnote[1]!;
      if (state.footnotes.has(label)) {
        if (!state.usedFootnotes.includes(label)) state.usedFootnotes.push(label);
        const id = footnoteId(label);
        out += `<sup class="kr-md-fn-ref"><a href="#kr-md-fn-${id}">${escapeHtml(label)}</a></sup>`;
        index += footnote[0].length;
        continue;
      }
      // 没有定义的脚注按普通文本显示（不伪造链接）。
    }
    // 图片
    if (rest.startsWith('![')) {
      const match = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
      if (match) {
        const url = normalizedUrl(match[2]!, 'image');
        if (url) {
          out += `<img class="kr-md-image" src="${escapeHtml(url)}" alt="${escapeHtml(
            match[1] ?? ''
          )}" loading="lazy" />`;
          index += match[0].length;
          continue;
        }
      }
    }
    // 普通链接
    if (rest.startsWith('[')) {
      const match = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
      if (match) {
        const label = match[1] ?? '';
        const url = normalizedUrl(match[2]!, 'link');
        if (url) {
          const external = /^https?:/i.test(url);
          out += `<a class="kr-md-link" href="${escapeHtml(url)}"${
            external ? ' target="_blank" rel="noreferrer"' : ''
          }>${renderInline(label, state)}</a>`;
          index += match[0].length;
          continue;
        }
      }
    }
    // 行内代码
    if (rest.startsWith('`')) {
      const end = rest.indexOf('`', 1);
      if (end > 1) {
        out += `<code class="kr-md-code">${escapeHtml(rest.slice(1, end))}</code>`;
        index += end + 1;
        continue;
      }
    }
    // 自动链接（裸 http/https）
    const auto = /^https?:\/\/[^\s<>)]+/.exec(rest);
    if (auto) {
      const url = auto[0];
      out += `<a class="kr-md-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(
        url
      )}</a>`;
      index += url.length;
      continue;
    }
    // 强调类：成对标记，递归渲染内部
    const pairs: Array<{ marker: string; open: string; close: string }> = [
      { marker: '**', open: '<strong>', close: '</strong>' },
      { marker: '~~', open: '<del>', close: '</del>' },
      { marker: '==', open: '<mark>', close: '</mark>' },
      { marker: '++', open: '<u>', close: '</u>' },
      { marker: '*', open: '<em>', close: '</em>' },
      { marker: '_', open: '<em>', close: '</em>' }
    ];
    let matched = false;
    for (const pair of pairs) {
      if (!rest.startsWith(pair.marker)) continue;
      const end = rest.indexOf(pair.marker, pair.marker.length);
      if (end <= pair.marker.length) continue;
      const inner = rest.slice(pair.marker.length, end);
      if (!inner.trim() || inner.includes('\n')) continue;
      out += `${pair.open}${renderInline(inner, state)}${pair.close}`;
      index += end + pair.marker.length;
      matched = true;
      break;
    }
    if (matched) continue;
    // 普通字符
    pushText(rest[0]!);
    index += 1;
  }
  return out;
}

function isFence(line: string): { marker: string; language: string } | null {
  const match = /^\s*(```+|~~~+)\s*([\w+-]*)\s*$/.exec(line);
  return match ? { marker: match[1]!, language: match[2] ?? '' } : null;
}

function isHr(line: string): boolean {
  return /^\s*(?:-\s*){3,}$/.test(line) || /^\s*(?:\*\s*){3,}$/.test(line) || /^\s*(?:_\s*){3,}$/.test(line);
}

function isHeading(line: string): boolean {
  return /^\s{0,3}#{1,6}\s+\S/.test(line);
}

function isQuote(line: string): boolean {
  return /^\s{0,3}>\s?/.test(line);
}

function isListLine(line: string): boolean {
  return /^(\s*)([-*+]|\d+[.)])\s+\S/.test(line);
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(line) && line.includes('-') && line.includes('|');
}

/** 对齐扩展：`::: center` … `:::` 块。 */
function alignmentDirective(line: string): 'left' | 'center' | 'right' | 'justify' | null {
  const match = /^\s*:::\s*(left|center|right|justify)\s*$/.exec(line);
  return match ? (match[1] as 'left' | 'center' | 'right' | 'justify') : null;
}

function isAlignmentClose(line: string): boolean {
  return /^\s*:::\s*$/.test(line);
}

function splitTableRow(line: string): string[] {
  let value = line.trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|')) value = value.slice(0, -1);
  return value.split('|').map((cell) => cell.trim());
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? '';
  return (
    line.trim() === '' ||
    Boolean(isFence(line)) ||
    isHeading(line) ||
    isHr(line) ||
    isQuote(line) ||
    isListLine(line) ||
    Boolean(alignmentDirective(line)) ||
    (line.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1] ?? ''))
  );
}

function renderList(
  lines: string[],
  start: number,
  state: RenderState
): { html: string; next: number } {
  const first = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[start] ?? '');
  if (!first) return { html: '', next: start + 1 };
  const baseIndent = first[1]!.length;
  const ordered = /\d/.test(first[2]!);
  const items: string[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const match = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (!match) break;
    const indent = match[1]!.length;
    if (indent < baseIndent) break;
    if (indent > baseIndent) {
      const nested = renderList(lines, index, state);
      if (items.length > 0) {
        items[items.length - 1] = items[items.length - 1]!.replace(/<\/li>$/, `${nested.html}</li>`);
      }
      index = nested.next;
      continue;
    }
    const isOrdered = /\d/.test(match[2]!);
    if (isOrdered !== ordered) break;
    let content = match[3] ?? '';
    let checkbox = '';
    const task = /^\[( |x|X)\]\s+(.*)$/.exec(content);
    if (task) {
      const checked = task[1]!.toLowerCase() === 'x';
      checkbox = `<input class="kr-md-task" type="checkbox" disabled${
        checked ? ' checked' : ''
      } aria-label="${checked ? '已完成' : '未完成'}" />`;
      content = task[2] ?? '';
    }
    items.push(`<li>${checkbox}${renderInline(content, state)}</li>`);
    index += 1;
  }
  const tag = ordered ? 'ol' : 'ul';
  const suffix = ordered ? '' : '';
  return {
    html: `<${tag} class="kr-md-${tag}">${items.join('')}</${tag}>${suffix}`,
    next: index
  };
}

function renderTable(
  lines: string[],
  start: number,
  state: RenderState
): { html: string; next: number } {
  const header = splitTableRow(lines[start] ?? '');
  const separator = splitTableRow(lines[start + 1] ?? '');
  const alignments = separator.map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return '';
  });
  const cellHtml = (tag: 'th' | 'td', content: string, column: number): string => {
    const align = alignments[column];
    return `<${tag}${align ? ` style="text-align:${align}"` : ''}>${renderInline(
      content,
      state
    )}</${tag}>`;
  };
  let index = start + 2;
  const rows: string[] = [];
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim() || !line.includes('|')) break;
    const cells = splitTableRow(line);
    rows.push(`<tr>${cells.map((cell, column) => cellHtml('td', cell, column)).join('')}</tr>`);
    index += 1;
  }
  return {
    html: `<div class="kr-md-table-wrap"><table class="kr-md-table"><thead><tr>${header
      .map((cell, column) => cellHtml('th', cell, column))
      .join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`,
    next: index
  };
}

/**
 * 渲染 Markdown 为安全 HTML。
 * 所有用户文本都会转义；只生成固定白名单标签；危险 URL 协议直接按文本显示。
 */
export function renderMarkdown(source: string): string {
  const lines = (source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const state: RenderState = { footnotes: new Map(), usedFootnotes: [] };
  const body: string[] = [];
  for (const line of lines) {
    const footnote = /^\s*\[\^([^\]\s]+)\]:\s*(.*)$/.exec(line);
    if (footnote) {
      state.footnotes.set(footnote[1]!, footnote[2] ?? '');
    } else {
      body.push(line);
    }
  }

  /** 渲染一段块级内容；引用块递归调用时拥有独立的 blocks，不会吞掉外层内容。 */
  const renderBlockLines = (inputLines: string[]): string => {
    const blocks: string[] = [];

    const renderParagraph = (items: string[]): void => {
      // 行首 2 空格缩进在 Markdown 里通常被忽略；这里保留为段落左缩进，供工具栏「增加缩进」使用。
      const nonEmpty = items.filter((line) => line.trim() !== '');
      const leadingSpaces = nonEmpty.length
        ? Math.min(...nonEmpty.map((line) => (/^ */.exec(line)?.[0].length ?? 0)))
        : 0;
      const indent = Math.min(8, leadingSpaces);
      const normalized = indent > 0 ? items.map((line) => line.slice(indent)) : items;
      const text = normalized.join('\n');
      if (!text.trim()) return;
      blocks.push(
        `<p${indent > 0 ? ` class="kr-md-indent" style="padding-left:${(indent / 2) * 1}em"` : ''}>${renderInline(
          text,
          state
        ).replace(/\n/g, '<br />')}</p>`
      );
    };

    const inlineBlock = (lines: string[]): void => {
      let index = 0;
      while (index < lines.length) {
        const line = lines[index] ?? '';
        if (!line.trim()) {
          index += 1;
          continue;
        }
        const fence = isFence(line);
        if (fence) {
          const code: string[] = [];
          index += 1;
          while (index < lines.length) {
            const current = lines[index] ?? '';
            if (current.trim().startsWith(fence.marker.slice(0, 3))) {
              index += 1;
              break;
            }
            code.push(current);
            index += 1;
          }
          blocks.push(
            `<pre class="kr-md-pre"><code${
              fence.language ? ` class="language-${escapeHtml(fence.language)}"` : ''
            }>${escapeHtml(code.join('\n'))}</code></pre>`
          );
          continue;
        }
        const heading = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
          const level = heading[1]!.length;
          blocks.push(
            `<h${level} class="kr-md-h${level}">${renderInline(heading[2] ?? '', state)}</h${level}>`
          );
          index += 1;
          continue;
        }
        if (isHr(line)) {
          blocks.push('<hr class="kr-md-hr" />');
          index += 1;
          continue;
        }
        const align = alignmentDirective(line);
        if (align) {
          const inner: string[] = [];
          index += 1;
          while (index < lines.length && !isAlignmentClose(lines[index] ?? '')) {
            inner.push(lines[index] ?? '');
            index += 1;
          }
          if (index < lines.length) index += 1;
          blocks.push(
            `<div class="kr-md-align" style="text-align:${align}">${renderBlockLines(inner)}</div>`
          );
          continue;
        }
        if (isQuote(line)) {
          const quoted: string[] = [];
          while (index < lines.length && isQuote(lines[index] ?? '')) {
            quoted.push((lines[index] ?? '').replace(/^\s{0,3}>\s?/, ''));
            index += 1;
          }
          blocks.push(
            `<blockquote class="kr-md-quote">${renderBlockLines(quoted)}</blockquote>`
          );
          continue;
        }
        if (isListLine(line)) {
          const rendered = renderList(lines, index, state);
          blocks.push(rendered.html);
          index = rendered.next;
          continue;
        }
        if (line.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1] ?? '')) {
          const rendered = renderTable(lines, index, state);
          blocks.push(rendered.html);
          index = rendered.next;
          continue;
        }
        // 普通段落：收集到空行/下一个块开始。
        const paragraph: string[] = [];
        while (index < lines.length) {
          const current = lines[index] ?? '';
          if (!current.trim()) break;
          if (paragraph.length > 0 && startsBlock(lines, index)) break;
          paragraph.push(current);
          index += 1;
        }
        renderParagraph(paragraph);
      }
    };

    inlineBlock(inputLines);
    return blocks.join('');
  };

  let html = renderBlockLines(body);
  if (state.usedFootnotes.length > 0) {
    const items = state.usedFootnotes
      .map((label) => {
        const id = footnoteId(label);
        const content = renderInline(state.footnotes.get(label) ?? '', state);
        return `<li id="kr-md-fn-${id}">${content}</li>`;
      })
      .join('');
    html += `<section class="kr-md-footnotes"><hr /><ol>${items}</ol></section>`;
  }
  return html;
}

/** 渲染后取纯文本：用于导出 PDF 批注、摘要、搜索等需要无格式文本的地方。 */
export function markdownPlainText(source: string): string {
  const html = renderMarkdown(source);
  return decodeEntities(
    html
      // 块级边界换成换行，行内标签直接删掉，避免“重点 ：”这种行内标记留下的空格。
      .replace(/<\/(p|li|h[1-6]|blockquote|pre|tr|div|section|ol|ul|table|thead|tbody)>/gi, '\n')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

export type MarkdownCommand =
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bold'
  | 'italic'
  | 'underline'
  | 'strike'
  | 'highlight'
  | 'quote'
  | 'ul'
  | 'ol'
  | 'task'
  | 'code'
  | 'table'
  | 'link'
  | 'image'
  | 'color'
  | 'align-left'
  | 'align-center'
  | 'align-right'
  | 'align-justify'
  | 'indent'
  | 'outdent'
  | 'move-up'
  | 'move-down'
  | 'clear';

export interface MarkdownEditResult {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

function selectedLineRange(
  text: string,
  start: number,
  end: number
): { from: number; to: number } {
  const from = text.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
  let to = text.indexOf('\n', end);
  if (to < 0) to = text.length;
  return { from, to };
}

function transformLines(
  text: string,
  start: number,
  end: number,
  transform: (line: string, index: number) => string
): MarkdownEditResult {
  const { from, to } = selectedLineRange(text, start, end);
  const block = text.slice(from, to);
  const lines = block.split('\n').map((line, index) => transform(line, index));
  const next = lines.join('\n');
  return {
    text: text.slice(0, from) + next + text.slice(to),
    selectionStart: from,
    selectionEnd: from + next.length
  };
}

function stripInlineMarkers(value: string): string {
  return value
    .replace(/[*_~=+`]{1,3}/g, '')
    .replace(/<c:#[0-9a-fA-F]{3,8}>|<\/c>/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[[^\]]*\]\]/g, '')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*\[[ xX]\]\s+/gm, '');
}

function wrap(
  text: string,
  start: number,
  end: number,
  before: string,
  after: string,
  placeholder: string
): MarkdownEditResult {
  const selected = text.slice(start, end) || placeholder;
  const next = text.slice(0, start) + before + selected + after + text.slice(end);
  return {
    text: next,
    selectionStart: start + before.length,
    selectionEnd: start + before.length + selected.length
  };
}

/** 对齐块：把选中行包进 `::: center` … `:::`，再次点击同一对齐则取消。 */
function toggleAlignmentBlock(
  text: string,
  start: number,
  end: number,
  align: 'left' | 'center' | 'right' | 'justify'
): MarkdownEditResult {
  const { from, to } = selectedLineRange(text, start, end);
  const block = text.slice(from, to);
  const lines = block.split('\n');
  const existingOpen = lines.findIndex((line) => alignmentDirective(line) !== null);
  const existingAlign = existingOpen >= 0 ? alignmentDirective(lines[existingOpen] ?? '') : null;
  const cleaned = lines.filter(
    (line) => alignmentDirective(line) === null && !isAlignmentClose(line)
  );
  if (existingAlign === align) {
    // 再次点击同一对齐：去掉指令，保留内容缩进。
    const next = cleaned.join('\n');
    return {
      text: text.slice(0, from) + next + text.slice(to),
      selectionStart: from,
      selectionEnd: from + next.length
    };
  }
  const wrapped = [`::: ${align}`, ...cleaned, ':::'];
  const next = wrapped.join('\n');
  return {
    text: text.slice(0, from) + next + text.slice(to),
    selectionStart: from,
    selectionEnd: from + next.length
  };
}

/** 上移/下移当前选中的整行块（Markdown 源文本命令）。 */
function moveSelectedLines(
  text: string,
  start: number,
  end: number,
  direction: 'up' | 'down'
): MarkdownEditResult {
  const { from, to } = selectedLineRange(text, start, end);
  const block = text.slice(from, to);
  if (!block) return { text, selectionStart: start, selectionEnd: end };
  if (direction === 'up') {
    if (from === 0) return { text, selectionStart: start, selectionEnd: end };
    const previousEnd = from - 1;
    const previousStart = text.lastIndexOf('\n', Math.max(0, previousEnd - 1)) + 1;
    const previous = text.slice(previousStart, previousEnd);
    const next = text.slice(0, previousStart) + block + '\n' + previous + text.slice(to);
    return {
      text: next,
      selectionStart: previousStart,
      selectionEnd: previousStart + block.length
    };
  }
  if (to >= text.length) return { text, selectionStart: start, selectionEnd: end };
  const nextEnd = text.indexOf('\n', to + 1);
  const following = text.slice(to + 1, nextEnd < 0 ? text.length : nextEnd);
  const next = text.slice(0, from) + following + '\n' + block + text.slice(to + 1 + following.length);
  return {
    text: next,
    selectionStart: from + following.length + 1,
    selectionEnd: from + following.length + 1 + block.length
  };
}

/** 选中文字里可识别的行内格式（用于格式刷）。 */
export interface MarkdownFormatting {
  markers: string[];
  color?: string;
}

const CAPTURE_MARKERS = ['**', '~~', '==', '++'] as const;

export function captureMarkdownFormatting(selected: string): MarkdownFormatting {
  const markers = CAPTURE_MARKERS.filter((marker) => {
    const first = selected.indexOf(marker);
    return first >= 0 && selected.indexOf(marker, first + marker.length) > first;
  });
  const color = /<c:(#[0-9a-fA-F]{3,8})>/.exec(selected)?.[1];
  return color ? { markers, color } : { markers };
}

/** 格式刷：把从源选区吸取的格式套到目标选区（先清掉目标原有的行内标记）。 */
export function applyMarkdownFormatting(
  text: string,
  start: number,
  end: number,
  formatting: MarkdownFormatting
): MarkdownEditResult {
  const selected = stripInlineMarkers(text.slice(start, end)) || '文字';
  const before = formatting.markers.map((marker) => marker).join('');
  const after = formatting.markers
    .slice()
    .reverse()
    .map((marker) => marker)
    .join('');
  const closedBefore = formatting.color ? `<c:${formatting.color}>` : '';
  const closedAfter = formatting.color ? '</c>' : '';
  const next =
    text.slice(0, start) + closedBefore + before + selected + after + closedAfter + text.slice(end);
  const selectionStart = start + closedBefore.length + before.length;
  return {
    text: next,
    selectionStart,
    selectionEnd: selectionStart + selected.length
  };
}


export function applyMarkdownCommand(
  text: string,
  start: number,
  end: number,
  command: MarkdownCommand,
  value?: string
): MarkdownEditResult {
  const safeStart = Math.max(0, Math.min(start, text.length));
  const safeEnd = Math.max(safeStart, Math.min(end, text.length));
  switch (command) {
    case 'bold':
      return wrap(text, safeStart, safeEnd, '**', '**', '加粗文字');
    case 'italic':
      return wrap(text, safeStart, safeEnd, '*', '*', '斜体文字');
    case 'underline':
      return wrap(text, safeStart, safeEnd, '++', '++', '下划线文字');
    case 'strike':
      return wrap(text, safeStart, safeEnd, '~~', '~~', '删除线文字');
    case 'highlight':
      return wrap(text, safeStart, safeEnd, '==', '==', '高亮文字');
    case 'code':
      return wrap(text, safeStart, safeEnd, '`', '`', '代码');
    case 'h1':
    case 'h2':
    case 'h3': {
      const prefix = command === 'h1' ? '# ' : command === 'h2' ? '## ' : '### ';
      return transformLines(text, safeStart, safeEnd, (line) => {
        const stripped = line.replace(/^\s*#{1,6}\s+/, '');
        return `${prefix}${stripped}`;
      });
    }
    case 'quote':
      return transformLines(text, safeStart, safeEnd, (line) =>
        /^\s*>\s?/.test(line) ? line.replace(/^\s*>\s?/, '') : `> ${line}`
      );
    case 'ul':
      return transformLines(text, safeStart, safeEnd, (line) =>
        /^\s*([-*+]|\d+[.)])\s+/.test(line)
          ? line.replace(/^\s*([-*+]|\d+[.)])\s+/, '')
          : `- ${line}`
      );
    case 'ol':
      return transformLines(text, safeStart, safeEnd, (line, index) =>
        /^\s*([-*+]|\d+[.)])\s+/.test(line)
          ? line.replace(/^\s*([-*+]|\d+[.)])\s+/, '')
          : `${index + 1}. ${line}`
      );
    case 'task':
      return transformLines(text, safeStart, safeEnd, (line) =>
        /^\s*[-*+]\s+\[[ xX]\]\s+/.test(line)
          ? line.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '')
          : `- [ ] ${line}`
      );
    case 'color': {
      const color = /^#[0-9a-fA-F]{3,8}$/.test(value ?? '') ? (value as string) : '#b23b2e';
      return wrap(text, safeStart, safeEnd, `<c:${color}>`, '</c>', '彩色文字');
    }
    case 'align-left':
    case 'align-center':
    case 'align-right':
    case 'align-justify':
      return toggleAlignmentBlock(
        text,
        safeStart,
        safeEnd,
        command === 'align-left'
          ? 'left'
          : command === 'align-center'
            ? 'center'
            : command === 'align-right'
              ? 'right'
              : 'justify'
      );
    case 'indent':
      return transformLines(text, safeStart, safeEnd, (line) =>
        line.trim() ? `  ${line}` : line
      );
    case 'outdent':
      return transformLines(text, safeStart, safeEnd, (line) =>
        line.replace(/^ {1,2}/, '')
      );
    case 'move-up':
      return moveSelectedLines(text, safeStart, safeEnd, 'up');
    case 'move-down':
      return moveSelectedLines(text, safeStart, safeEnd, 'down');
    case 'clear':
      return {
        text: text.slice(0, safeStart) + stripInlineMarkers(text.slice(safeStart, safeEnd)) + text.slice(safeEnd),
        selectionStart: safeStart,
        selectionEnd: safeStart + stripInlineMarkers(text.slice(safeStart, safeEnd)).length
      };
    case 'table': {
      const snippet = '| 列1 | 列2 |\n| --- | --- |\n| 内容 | 内容 |\n';
      const needNewline = safeStart > 0 && text[safeStart - 1] !== '\n';
      const insert = `${needNewline ? '\n' : ''}${snippet}`;
      return {
        text: text.slice(0, safeStart) + insert + text.slice(safeEnd),
        selectionStart: safeStart + insert.length,
        selectionEnd: safeStart + insert.length
      };
    }
    case 'link': {
      const selected = text.slice(safeStart, safeEnd) || '链接文字';
      const snippet = `[${selected}](https://)`;
      return {
        text: text.slice(0, safeStart) + snippet + text.slice(safeEnd),
        selectionStart: safeStart + selected.length + 3,
        selectionEnd: safeStart + snippet.length - 1
      };
    }
    case 'image': {
      const snippet = '![图片说明](https://)';
      return {
        text: text.slice(0, safeStart) + snippet + text.slice(safeEnd),
        selectionStart: safeStart + 2,
        selectionEnd: safeStart + 6
      };
    }
    default:
      return { text, selectionStart: safeStart, selectionEnd: safeEnd };
  }
}

/**
 * 提取正文中引用的本地图片资源文件名。
 *
 * 兼容 `studianda-asset://note-assets/<file>`、`studianda-asset://<file>`、
 * `studianda-asset:<file>`；最多解两层 URL 编码；只返回纯文件名（含分隔符的一律忽略）。
 */
export function extractNoteAssetFilenames(content: string): string[] {
  const result = new Set<string>();
  const pattern = /studianda-asset:(?:\/\/?)?(?:note-assets\/)?([^\s)\]>"']+)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content ?? '')) !== null) {
    let value = (match[1] ?? '').replace(/[?#].*$/, '');
    for (let depth = 0; depth < 2; depth += 1) {
      try {
        const decoded = decodeURIComponent(value);
        if (decoded === value) break;
        value = decoded;
      } catch {
        break;
      }
    }
    if (!value || value.includes('/') || value.includes('\\')) continue;
    result.add(value);
  }
  return [...result];
}
