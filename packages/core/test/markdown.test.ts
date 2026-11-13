import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import {
  applyMarkdownCommand,
  formatMarkdownInternalLink,
  markdownPlainText,
  parseMarkdownInternalLink,
  renderMarkdown
} from '@studianda/shared';
import { searchLibrary, searchLibraryDocuments } from '../src/library-search.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'studianda-markdown-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('renderMarkdown（安全渲染）', () => {
  it('标题、段落与换行', () => {
    const html = renderMarkdown('# 标题\n\n第一行\n第二行');
    expect(html).toBe('<h1 class="kr-md-h1">标题</h1><p>第一行<br />第二行</p>');
  });

  it('加粗/斜体/下划线/删除线/高亮/行内代码', () => {
    const html = renderMarkdown('**粗体** *斜体* ++下划线++ ~~删除~~ ==高亮== `code`');
    expect(html).toContain('<strong>粗体</strong>');
    expect(html).toContain('<em>斜体</em>');
    expect(html).toContain('<u>下划线</u>');
    expect(html).toContain('<del>删除</del>');
    expect(html).toContain('<mark>高亮</mark>');
    expect(html).toContain('<code class="kr-md-code">code</code>');
  });

  it('列表、任务清单、表格、引用与代码块', () => {
    const list = renderMarkdown('- 项一\n- [x] 完成\n- [ ] 待办');
    expect(list).toContain('<ul class="kr-md-ul">');
    expect(list).toContain('<li>项一</li>');
    expect(list).toContain('checked aria-label="已完成" />完成');
    expect(list).toContain('aria-label="未完成" />待办');

    const table = renderMarkdown('| A | B |\n| --- | --- |\n| 1 | 2 |');
    expect(table).toContain('<table class="kr-md-table">');
    expect(table).toContain('<th>A</th><th>B</th>');
    expect(table).toContain('<td>1</td><td>2</td>');

    const quote = renderMarkdown('> 引用内容');
    expect(quote).toContain('<blockquote class="kr-md-quote"><p>引用内容</p></blockquote>');

    const code = renderMarkdown('```js\nconst a = 1;\n```');
    expect(code).toBe('<pre class="kr-md-pre"><code class="language-js">const a = 1;</code></pre>');
  });

  it('外链与图片只放行白名单协议，javascript: 不生成标签', () => {
    const safe = renderMarkdown(
      '[链接](https://example.com) 和 ![图](https://example.com/a.png)'
    );
    expect(safe).toContain('href="https://example.com"');
    expect(safe).toContain('target="_blank" rel="noreferrer"');
    expect(safe).toContain('src="https://example.com/a.png"');
    expect(safe).toContain('loading="lazy"');

    const mail = renderMarkdown('[邮件](mailto:a@example.com)');
    expect(mail).toContain('href="mailto:a@example.com"');

    const evil = renderMarkdown(
      '[危险](javascript:alert(1)) ![坏图](javascript:alert(1)) [数据](data:text/html,1)'
    );
    expect(evil).not.toContain('<a');
    expect(evil).not.toContain('<img');
    expect(evil).not.toContain('href="javascript');
    expect(evil).not.toContain('src="javascript');

    // data:image 允许（粘贴的小图）；data:text/html 不允许。
    const dataImage = renderMarkdown('![小图](data:image/png;base64,AAAA)');
    expect(dataImage).toContain('<img class="kr-md-image" src="data:image/png;base64,AAAA"');
  });

  it('图片支持宿主注入的资产 URL 解析，链接保持存储格式', () => {
    const html = renderMarkdown(
      '![图](studianda-asset://note-assets/a.png) [附件](studianda-asset://note-assets/a.pdf)',
      {
        resolveAssetUrl: (url) =>
          url.replace(
            'studianda-asset://note-assets/',
            'http://127.0.0.1:4321/api/v1/note-assets/'
          )
      }
    );
    expect(html).toContain('src="http://127.0.0.1:4321/api/v1/note-assets/a.png"');
    expect(html).toContain('href="studianda-asset://note-assets/a.pdf"');
  });

  it('编辑态保留原始资产地址，序列化不会把显示地址写回 Markdown', () => {
    const html = renderMarkdown('![图](studianda-asset://note-assets/a.png)', {
      resolveAssetUrl: (url) =>
        url.replace('studianda-asset://note-assets/', '/api/v1/note-assets/'),
      assetSourceAttribute: 'data-studianda-asset-src'
    });
    expect(html).toContain(
      'src="/api/v1/note-assets/a.png" data-studianda-asset-src="studianda-asset://note-assets/a.png"'
    );
  });

  it('HTML 注入被转义，<script> 不会生效', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expect(html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
    expect(html).not.toContain('<script>');
  });

  it('内部引用三种 kind 渲染成带 data 属性的链接', () => {
    const html = renderMarkdown(
      '[[doc:DOC1]] [[ann:DOC1/ANN1|批注A]] [[note:DOC1/NOTE1|笔记B]]'
    );
    expect(html).toContain('data-internal-kind="document" data-internal-doc="DOC1"');
    expect(html).toContain(
      'data-internal-kind="annotation" data-internal-doc="DOC1" data-internal-id="ANN1"'
    );
    expect(html).toContain(
      'data-internal-kind="note" data-internal-doc="DOC1" data-internal-id="NOTE1"'
    );
    expect(html).toContain('>批注A</a>');
    expect(html).toContain('>笔记B</a>');
    expect(html).toContain('>内部引用</a>');
  });

  it('内部引用解析与生成往返', () => {
    expect(parseMarkdownInternalLink('doc:DOC1|论文')).toEqual({
      target: { kind: 'document', documentId: 'DOC1', label: '论文' },
      label: '论文'
    });
    expect(parseMarkdownInternalLink('ann:DOC1/ANN1|批注')).toMatchObject({
      target: { kind: 'annotation', documentId: 'DOC1', annotationId: 'ANN1' }
    });
    expect(parseMarkdownInternalLink('note:DOC1/NOTE1')).toMatchObject({
      target: { kind: 'note', documentId: 'DOC1', noteId: 'NOTE1' }
    });
    expect(parseMarkdownInternalLink('不是引用')).toBeNull();
    expect(
      formatMarkdownInternalLink({ kind: 'annotation', documentId: 'DOC1', annotationId: 'ANN1' }, '批注')
    ).toBe('[[ann:DOC1/ANN1|批注]]');
  });

  it('独立笔记引用 [[note:<noteId>]]（无斜杠）与文献笔记引用互不混淆', () => {
    // 无斜杠 = 独立笔记：documentId 为空。
    expect(parseMarkdownInternalLink('note:N1')).toEqual({
      target: { kind: 'note', documentId: '', noteId: 'N1', label: '' },
      label: ''
    });
    expect(parseMarkdownInternalLink('note:N1|独立笔记标题')).toEqual({
      target: { kind: 'note', documentId: '', noteId: 'N1', label: '独立笔记标题' },
      label: '独立笔记标题'
    });
    // 有斜杠 = 依附文献的笔记，仍解析成 documentId/noteId。
    expect(parseMarkdownInternalLink('note:DOC1/NOTE1|文献笔记')).toEqual({
      target: { kind: 'note', documentId: 'DOC1', noteId: 'NOTE1', label: '文献笔记' },
      label: '文献笔记'
    });

    expect(formatMarkdownInternalLink({ kind: 'note', documentId: '', noteId: 'N1' }, '标签')).toBe(
      '[[note:N1|标签]]'
    );
    expect(
      formatMarkdownInternalLink({ kind: 'note', documentId: 'DOC1', noteId: 'N1' }, '标签')
    ).toBe('[[note:DOC1/N1|标签]]');
    expect(formatMarkdownInternalLink({ kind: 'note', documentId: '', noteId: 'N1' }, '')).toBe(
      '[[note:N1]]'
    );

    // 渲染：独立笔记的 data-internal-doc 为空串，由界面据此走独立笔记面板。
    const html = renderMarkdown('[[note:N1|独立笔记标题]]');
    expect(html).toContain('data-internal-kind="note"');
    expect(html).toContain('data-internal-doc=""');
    expect(html).toContain('data-internal-id="N1"');
    expect(html).toContain('>独立笔记标题</a>');
    // 文献笔记引用仍带 documentId。
    const documentNoteHtml = renderMarkdown('[[note:DOC1/NOTE1]]');
    expect(documentNoteHtml).toContain('data-internal-doc="DOC1"');
    expect(documentNoteHtml).toContain('data-internal-id="NOTE1"');
  });

  it('脚注按引用顺序输出', () => {
    const html = renderMarkdown('正文[^1]\n\n[^1]: 脚注内容');
    expect(html).toContain('<sup class="kr-md-fn-ref"><a href="#kr-md-fn-1">1</a></sup>');
    expect(html).toContain('<section class="kr-md-footnotes">');
    expect(html).toContain('<li id="kr-md-fn-1">脚注内容</li>');
  });
});

describe('markdownPlainText（导出/摘要用纯文本）', () => {
  it('去掉标题/加粗/斜体/代码等标记，只留可读文本', () => {
    expect(markdownPlainText('## 我的结论\n\n**重点**：这一段很重要，见 `code`。')).toBe(
      '我的结论\n重点：这一段很重要，见 code。'
    );
    expect(markdownPlainText('# 标题\n\n第一行\n第二行')).toBe('标题\n第一行\n第二行');
    expect(markdownPlainText('**加粗**与*斜体*')).toBe('加粗与斜体');
    expect(markdownPlainText('### 重要发现\n\n- 列表一\n- 列表二')).toBe(
      '重要发现\n列表一\n列表二'
    );
    expect(markdownPlainText('普通纯文本')).toBe('普通纯文本');
  });
});

describe('applyMarkdownCommand（工具栏命令）', () => {
  it('行内命令：有选区包裹选中的文字', () => {
    expect(applyMarkdownCommand('选中文字', 0, 4, 'bold')).toEqual({
      text: '**选中文字**',
      selectionStart: 2,
      selectionEnd: 6
    });
    expect(applyMarkdownCommand('abc', 1, 2, 'italic')).toEqual({
      text: 'a*b*c',
      selectionStart: 2,
      selectionEnd: 3
    });
  });

  it('行内命令：空选区插入占位文字并选中', () => {
    expect(applyMarkdownCommand('', 0, 0, 'bold')).toEqual({
      text: '**加粗文字**',
      selectionStart: 2,
      selectionEnd: 6
    });
  });

  it('标题命令：空选区加前缀，已有标题再点一次去掉前缀（toggle）', () => {
    expect(applyMarkdownCommand('标题行', 0, 3, 'h1')).toEqual({
      text: '# 标题行',
      selectionStart: 0,
      selectionEnd: 5
    });
    expect(applyMarkdownCommand('# 标题行', 2, 5, 'h1').text).toBe('# 标题行');
    expect(applyMarkdownCommand('## 标题行', 2, 5, 'h1').text).toBe('# 标题行');
    expect(applyMarkdownCommand('普通行', 0, 3, 'h2').text).toBe('## 普通行');
  });

  it('引用/列表/任务清单：整行加前缀，再点一次去掉（toggle）', () => {
    expect(applyMarkdownCommand('引用行', 0, 3, 'quote').text).toBe('> 引用行');
    expect(applyMarkdownCommand('> 引用行', 2, 5, 'quote').text).toBe('引用行');
    expect(applyMarkdownCommand('a\nb', 0, 3, 'ul').text).toBe('- a\n- b');
    expect(applyMarkdownCommand('- a\n- b', 0, 7, 'ul').text).toBe('a\nb');
    expect(applyMarkdownCommand('a\nb', 0, 3, 'ol').text).toBe('1. a\n2. b');
    expect(applyMarkdownCommand('待办', 0, 2, 'task').text).toBe('- [ ] 待办');
    expect(applyMarkdownCommand('- [ ] 待办', 0, 8, 'task').text).toBe('待办');
  });

  it('表格/链接/图片插入片段并把光标放到可编辑位置', () => {
    const table = applyMarkdownCommand('', 0, 0, 'table');
    expect(table.text).toContain('| 列1 | 列2 |');
    expect(table.text).toContain('| --- | --- |');
    expect(table.selectionStart).toBe(table.text.length);

    const link = applyMarkdownCommand('', 0, 0, 'link');
    expect(link.text).toBe('[链接文字](https://)');
    expect(link.text.slice(link.selectionStart, link.selectionEnd)).toBe('https://');

    const image = applyMarkdownCommand('', 0, 0, 'image');
    expect(image.text).toBe('![图片说明](https://)');
    // 图片默认选中「图片说明」，方便直接改名。
    expect(image.text.slice(image.selectionStart, image.selectionEnd)).toBe('图片说明');
  });

  it('清除格式去掉选中范围内的 Markdown 标记', () => {
    expect(applyMarkdownCommand('**加粗**', 0, 6, 'clear')).toEqual({
      text: '加粗',
      selectionStart: 0,
      selectionEnd: 2
    });
    expect(applyMarkdownCommand('前 **加粗** 后', 2, 8, 'clear')).toEqual({
      text: '前 加粗 后',
      selectionStart: 2,
      selectionEnd: 4
    });
  });
});

describe('库内搜索使用 Markdown 纯文本', () => {
  async function makeStore(name: string): Promise<{ store: Store; documentId: string }> {
    const dir = path.join(root, name);
    mkdirSync(dir, { recursive: true });
    const store = new Store(dir);
    const pdf = await PDFDocument.create();
    pdf.addPage([300, 400]).drawText('Markdown search fixture', { x: 40, y: 350, size: 16 });
    const file = path.join(dir, 'fixture.pdf');
    writeFileSync(file, await pdf.save());
    const document = await store.importDocument(file, 'markdown-search.pdf', true);
    return { store, documentId: document.id };
  }

  it('笔记/批注里的加粗、标题语法中的中文词可命中，摘要不含 Markdown 标记', async () => {
    const { store, documentId } = await makeStore('search');
    try {
      store.createNote({
        documentId,
        page: 0,
        content: '## 重要发现\n\n**重点结论**：这一段是加粗的'
      });
      store.createAnnotation({
        documentId,
        page: 1,
        quote: '原文引用 **保持原样**',
        content: '**批注重点** 与 `code`',
        style: 'page'
      });
      const secrets = new SecretStore();

      const noteHits = searchLibrary(store, secrets, '重点结论', ['note']);
      expect(noteHits).toHaveLength(1);
      expect(noteHits[0]?.kind).toBe('note');
      expect(noteHits[0]?.snippet).toContain('重点结论');
      expect(noteHits[0]?.snippet).not.toContain('**');
      expect(noteHits[0]?.snippet).not.toContain('##');

      const annotationHits = searchLibrary(store, secrets, '批注重点', ['annotation']);
      expect(annotationHits).toHaveLength(1);
      expect(annotationHits[0]?.snippet).toContain('批注重点');
      // quote 是 PDF 原文，保持原样（不被当成 Markdown 清洗）。
      expect(annotationHits[0]?.snippet).toContain('原文引用 **保持原样**');
      // 批注正文那一段是纯文本，不含 Markdown 标记。
      const comment = annotationHits[0]?.snippet.split('\n批注：')[1] ?? '';
      expect(comment).toContain('批注重点');
      expect(comment).toContain('code');
      expect(comment).not.toContain('**');
      expect(comment).not.toContain('`');

      // 文献列表过滤走同一口径。
      expect(searchLibraryDocuments(store, secrets, '重要发现', ['note'])).toEqual([documentId]);
      expect(searchLibraryDocuments(store, secrets, '批注重点', ['annotation'])).toEqual([
        documentId
      ]);
      expect(searchLibraryDocuments(store, secrets, '不存在的词', ['note', 'annotation'])).toEqual(
        []
      );
    } finally {
      store.close();
    }
  });
});

describe('阅读笔记 Markdown 导出保持原始 Markdown', () => {
  it('导出内容保留 **、# 等标记，不做纯文本清洗', async () => {
    const dir = path.join(root, 'export-markdown');
    mkdirSync(dir, { recursive: true });
    const store = new Store(dir);
    try {
      const pdf = await PDFDocument.create();
      pdf.addPage([300, 400]).drawText('Export markdown fixture', { x: 40, y: 350, size: 16 });
      const file = path.join(dir, 'export.pdf');
      writeFileSync(file, await pdf.save());
      const document = await store.importDocument(file, '导出测试.pdf', true);
      store.createNote({
        documentId: document.id,
        page: 0,
        content: '## 全篇结论\n\n- **要点一**\n- 要点二'
      });
      store.createAnnotation({
        documentId: document.id,
        page: 1,
        quote: '原文一句',
        content: '**加粗批注** 与 `code`',
        style: 'page'
      });

      const exported = store.exportMarkdown(document.id);
      expect(exported.markdown.startsWith('# 导出测试.pdf · 阅读笔记')).toBe(true);
      // 笔记与批注正文都按原始 Markdown 导出。
      expect(exported.markdown).toContain('## 全篇结论');
      expect(exported.markdown).toContain('- **要点一**');
      expect(exported.markdown).toContain('**加粗批注** 与 `code`');
      // 原文 quote 以引用块导出，内容不动。
      expect(exported.markdown).toContain('> 原文一句');
      expect(exported.filename).toBe('导出测试-批注.md');
    } finally {
      store.close();
    }
  });
});
