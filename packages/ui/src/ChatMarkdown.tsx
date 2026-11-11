import type React from 'react';
import type { ChatSource } from '@studianda/shared';

function renderInline(
  text: string,
  sources: ChatSource[],
  onOpenSource: (source: ChatSource) => void,
  keyPrefix: string
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern =
    /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[W[0-9]+\]|\[[0-9]+\]|［[0-9]+］|\[[^\]\n]+\]\([^)\n]+\)|\*[^*\n]+\*)/g;
  const webSources = sources.filter((source) => source.kind === 'web' && source.url);
  let last = 0;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${index}`;
    index += 1;
    const citation = /^(?:\[([0-9]+)\]|［([0-9]+)］)$/.exec(token);
    const webCitation = /^\[W([0-9]+)\]$/.exec(token);
    if (citation) {
      const source = sources[Number(citation[1] ?? citation[2]) - 1];
      if (source?.kind === 'web' && source.url) {
        // 数字编号也可能指向网页来源（仅联网/合并来源的旧格式）：直接打开网页，不能当文献页跳转。
        nodes.push(
          <a
            key={key}
            className="kr-chat__web-citation"
            href={source.url}
            target="_blank"
            rel="noreferrer"
            title={source.documentName}
          >
            {token}
          </a>
        );
      } else if (source) {
        const excerpt = (source.snippet ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
        nodes.push(
          <button
            type="button"
            className="kr-chat__citation"
            key={key}
            onClick={() => onOpenSource(source)}
            title={
              `${source.documentName || '来源'} · 第 ${source.page} 页` +
              (source.sectionTitle ? ` · ${source.sectionTitle}` : '') +
              (excerpt ? `\n${excerpt}` : '') +
              '\n点击跳到原文并标出引用'
            }
          >
            {token}
          </button>
        );
      } else {
        nodes.push(token);
      }
    } else if (webCitation) {
      const source = webSources[Number(webCitation[1]) - 1];
      nodes.push(
        source?.url ? (
          <a
            key={key}
            className="kr-chat__web-citation"
            href={source.url}
            target="_blank"
            rel="noreferrer"
            title={source.documentName}
          >
            {token}
          </a>
        ) : (
          token
        )
      );
    } else if (token.startsWith('**') && token.endsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`') && token.endsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('*') && token.endsWith('*')) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token);
      if (link) {
        nodes.push(
          <a key={key} href={link[2]} target="_blank" rel="noreferrer">
            {link[1]}
          </a>
        );
      } else {
        nodes.push(token);
      }
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function isHeading(line: string): { level: number; text: string } | null {
  const match = /^(#{1,6})\s+(.+)$/.exec(line.trim());
  return match ? { level: match[1]!.length, text: match[2]! } : null;
}

export function ChatMarkdown({
  text,
  sources,
  onOpenSource
}: {
  text: string;
  sources: ChatSource[];
  onOpenSource: (source: ChatSource) => void;
}): React.JSX.Element {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] = [];
  let code: string[] | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    const content = paragraph.join(' ');
    blocks.push(
      <p key={`p-${blocks.length}`}>
        {renderInline(content, sources, onOpenSource, `p-${blocks.length}`)}
      </p>
    );
    paragraph = [];
  };
  const flushList = (): void => {
    if (!list) return;
    const items = list.items.map((item, index) => (
      <li key={`li-${index}`}>
        {renderInline(item, sources, onOpenSource, `li-${blocks.length}-${index}`)}
      </li>
    ));
    blocks.push(
      list.ordered ? (
        <ol key={`list-${blocks.length}`}>{items}</ol>
      ) : (
        <ul key={`list-${blocks.length}`}>{items}</ul>
      )
    );
    list = null;
  };
  const flushQuote = (): void => {
    if (quote.length === 0) return;
    blocks.push(
      <blockquote key={`quote-${blocks.length}`}>
        {renderInline(quote.join(' '), sources, onOpenSource, `q-${blocks.length}`)}
      </blockquote>
    );
    quote = [];
  };
  const flushAll = (): void => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (code) {
      if (line.trim().startsWith('```')) {
        blocks.push(
          <pre key={`code-${blocks.length}`}>
            <code>{code.join('\n')}</code>
          </pre>
        );
        code = null;
      } else {
        code.push(raw);
      }
      continue;
    }
    if (line.trim().startsWith('```')) {
      flushAll();
      code = [];
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    const heading = isHeading(line);
    if (heading) {
      flushAll();
      const Tag = (`h${Math.min(6, heading.level + 1)}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6');
      blocks.push(
        <Tag key={`h-${blocks.length}`}>
          {renderInline(heading.text, sources, onOpenSource, `h-${blocks.length}`)}
        </Tag>
      );
      continue;
    }
    const ordered = /^\s*\d+[.、)]\s+(.+)$/.exec(line);
    if (ordered) {
      flushParagraph();
      flushQuote();
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(ordered[1]!);
      continue;
    }
    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
    if (unordered) {
      flushParagraph();
      flushQuote();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(unordered[1]!);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flushParagraph();
      flushList();
      quote.push(line.replace(/^\s*>\s?/, ''));
      continue;
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) {
      flushAll();
      blocks.push(<hr key={`hr-${blocks.length}`} />);
      continue;
    }
    flushList();
    flushQuote();
    paragraph.push(line.trim());
  }
  if (code) {
    blocks.push(
      <pre key={`code-${blocks.length}`}>
        <code>{code.join('\n')}</code>
      </pre>
    );
  }
  flushAll();

  return (
    <div className="kr-chat__markdown" data-ai-copy="answer">
      {blocks}
    </div>
  );
}
