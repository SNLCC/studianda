import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import {
  applyMarkdownCommand,
  applyMarkdownFormatting,
  captureMarkdownFormatting,
  markdownPlainText,
  renderMarkdown
} from '@studianda/shared';
import { searchLibrary, searchLibraryDocuments } from '../src/library-search.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'studianda-markdown-phase2-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('颜色扩展 <c:#hex>text</c>', () => {
  it('合法十六进制色值渲染为 kr-md-color span', () => {
    expect(renderMarkdown('<c:#b23b2e>红字</c>')).toBe(
      '<p><span class="kr-md-color" style="color:#b23b2e">红字</span></p>'
    );
    // 3 位缩写、大小写、8 位带透明度都按原值输出。
    expect(renderMarkdown('<c:#fff>白</c>')).toContain('style="color:#fff"');
    expect(renderMarkdown('<c:#B23B2E>红</c>')).toContain('style="color:#B23B2E"');
    expect(renderMarkdown('<c:#b23b2e80>淡红</c>')).toContain('style="color:#b23b2e80"');
  });

  it('颜色内可嵌套行内格式，HTML 内容仍被转义', () => {
    expect(renderMarkdown('<c:#b23b2e>**红**</c>')).toBe(
      '<p><span class="kr-md-color" style="color:#b23b2e"><strong>红</strong></span></p>'
    );
    const xss = renderMarkdown('<c:#b23b2e><script>alert(1)</script></c>');
    expect(xss).toContain('<span class="kr-md-color" style="color:#b23b2e">');
    expect(xss).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(xss).not.toContain('<script>');
  });

  it('非法颜色 / 非十六进制 / 未闭合都按纯文本处理，不生成 span', () => {
    const injected = renderMarkdown('<c:javascript:alert(1)>红</c>');
    expect(injected).not.toContain('<span');
    expect(injected).toContain('&lt;c:javascript:alert(1)&gt;');

    const eventHandler = renderMarkdown('<c:#fff onclick=alert(1)>红</c>');
    // 整段按文本转义显示（属性注入不生效），只留段落标签。
    expect(eventHandler).toBe('<p>&lt;c:#fff onclick=alert(1)&gt;红&lt;/c&gt;</p>');
    expect(eventHandler).not.toContain('style=');

    const cssInjection = renderMarkdown('<c:#b23b2e;background:url(javascript:1)>红</c>');
    expect(cssInjection).not.toContain('<span');
    expect(cssInjection).not.toContain('style=');

    // 没有闭合标签：按文本显示，不吞掉后面的内容。
    const unclosed = renderMarkdown('<c:#b23b2e>未闭合');
    expect(unclosed).toBe('<p>&lt;c:#b23b2e&gt;未闭合</p>');
  });

  it('markdownPlainText 去掉颜色标签只留文字', () => {
    expect(markdownPlainText('<c:#b23b2e>红</c>')).toBe('红');
    expect(markdownPlainText('前<c:#b23b2e>红</c>后')).toBe('前红后');
  });
});

describe('对齐块 ::: left|center|right|justify … :::', () => {
  it('四种对齐渲染为 kr-md-align div + text-align', () => {
    expect(renderMarkdown('::: center\n居中内容\n:::')).toBe(
      '<div class="kr-md-align" style="text-align:center"><p>居中内容</p></div>'
    );
    expect(renderMarkdown('::: left\n左\n:::')).toContain('style="text-align:left"');
    expect(renderMarkdown('::: right\n右\n:::')).toContain('style="text-align:right"');
    expect(renderMarkdown('::: justify\n两端\n:::')).toContain('style="text-align:justify"');
  });

  it('对齐块内支持多段与行内格式，HTML 仍转义', () => {
    const html = renderMarkdown('::: center\n**重点** 与 `code`\n:::');
    expect(html).toContain('<div class="kr-md-align" style="text-align:center">');
    expect(html).toContain('<strong>重点</strong>');
    expect(html).toContain('<code class="kr-md-code">code</code>');

    const escaped = renderMarkdown('::: center\n<script>alert(1)</script>\n:::');
    expect(escaped).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escaped).not.toContain('<script>');
  });

  it('未闭合对齐块容错到文末；孤立的 ::: 按文本显示', () => {
    const unclosed = renderMarkdown('::: center\n没有结束');
    expect(unclosed).toBe('<div class="kr-md-align" style="text-align:center"><p>没有结束</p></div>');

    const orphan = renderMarkdown(':::\n普通');
    expect(orphan).toBe('<p>:::<br />普通</p>');
  });

  it('嵌套对齐块不会抛错，内外层都保留；多余的闭合符按文本显示', () => {
    const nested = renderMarkdown('::: center\n::: left\n内层\n:::\n:::\n尾行');
    expect(nested).toContain('<div class="kr-md-align" style="text-align:center">');
    expect(nested).toContain('<div class="kr-md-align" style="text-align:left">');
    expect(nested).toContain('<p>内层</p>');
    // 嵌套时内层先消耗掉一个 :::，外层多出来的闭合符保留为文本，不被静默吞掉。
    expect(nested).toContain(':::');
    expect(nested).toContain('尾行');
  });

  it('markdownPlainText 不产生 ::: 或标签', () => {
    expect(markdownPlainText('::: center\n居中内容\n:::')).toBe('居中内容');
    expect(markdownPlainText('::: center\n第一段\n\n第二段\n:::')).toBe('第一段\n第二段');
    expect(markdownPlainText('::: center\n<c:#b23b2e>红字</c>居中\n:::')).toBe('红字居中');
  });
});

describe('行首缩进', () => {
  it('2/4 个行首空格渲染成段落左缩进', () => {
    expect(renderMarkdown('  两个空格开头')).toBe(
      '<p class="kr-md-indent" style="padding-left:1em">两个空格开头</p>'
    );
    expect(renderMarkdown('    四个空格开头')).toBe(
      '<p class="kr-md-indent" style="padding-left:2em">四个空格开头</p>'
    );
    expect(renderMarkdown('普通段落')).toBe('<p>普通段落</p>');
  });

  it('多行段落按最小缩进整体左缩进，换行保留', () => {
    expect(renderMarkdown('  第一行\n  第二行')).toBe(
      '<p class="kr-md-indent" style="padding-left:1em">第一行<br />第二行</p>'
    );
  });

  it('markdownPlainText 去掉缩进空格', () => {
    expect(markdownPlainText('  缩进段落')).toBe('缩进段落');
  });
});

describe('颜色/对齐/缩进命令', () => {
  it('color：有选区包裹、空选区插占位、默认色与非法色回退', () => {
    expect(applyMarkdownCommand('选中文字', 0, 4, 'color', '#b23b2e')).toEqual({
      text: '<c:#b23b2e>选中文字</c>',
      selectionStart: 11,
      selectionEnd: 15
    });
    expect(applyMarkdownCommand('', 0, 0, 'color', '#b23b2e')).toEqual({
      text: '<c:#b23b2e>彩色文字</c>',
      selectionStart: 11,
      selectionEnd: 15
    });
    // 未传色值 / 非法色值都回退默认色。
    expect(applyMarkdownCommand('文字', 0, 2, 'color').text).toBe('<c:#b23b2e>文字</c>');
    expect(applyMarkdownCommand('文字', 0, 2, 'color', 'red').text).toBe(
      '<c:#b23b2e>文字</c>'
    );
    expect(applyMarkdownCommand('文字', 0, 2, 'color', '#B23B2E80').text).toBe(
      '<c:#B23B2E80>文字</c>'
    );
  });

  it('align-center：包裹、再点同对齐取消、切换不同对齐替换', () => {
    const wrapped = applyMarkdownCommand('居中内容', 0, 4, 'align-center');
    expect(wrapped).toEqual({
      text: '::: center\n居中内容\n:::',
      selectionStart: 0,
      selectionEnd: 19
    });

    // 包裹后选区覆盖整块；再点同一对齐 → 取消指令只留内容。
    expect(
      applyMarkdownCommand(wrapped.text, wrapped.selectionStart, wrapped.selectionEnd, 'align-center')
    ).toEqual({ text: '居中内容', selectionStart: 0, selectionEnd: 4 });

    // 切换为右对齐：替换原指令，不叠加。
    expect(
      applyMarkdownCommand(wrapped.text, wrapped.selectionStart, wrapped.selectionEnd, 'align-right')
        .text
    ).toBe('::: right\n居中内容\n:::');

    expect(applyMarkdownCommand('内容', 0, 2, 'align-left').text).toBe('::: left\n内容\n:::');
    expect(applyMarkdownCommand('内容', 0, 2, 'align-justify').text).toBe(
      '::: justify\n内容\n:::'
    );

    // 多行选区整块包裹。
    expect(applyMarkdownCommand('第一行\n第二行', 0, 7, 'align-center').text).toBe(
      '::: center\n第一行\n第二行\n:::'
    );
  });

  it('indent/outdent：整行缩进两格、空行不动、可往返', () => {
    expect(applyMarkdownCommand('第一行\n第二行', 0, 7, 'indent')).toEqual({
      text: '  第一行\n  第二行',
      selectionStart: 0,
      selectionEnd: 11
    });
    // 空行不缩进，避免把空段落变成缩进块。
    expect(applyMarkdownCommand('第一行\n\n第三行', 0, 9, 'indent').text).toBe(
      '  第一行\n\n  第三行'
    );
    const indented = applyMarkdownCommand('第一行\n第二行', 0, 7, 'indent');
    expect(
      applyMarkdownCommand(indented.text, indented.selectionStart, indented.selectionEnd, 'outdent')
        .text
    ).toBe('第一行\n第二行');
    // 最多只去两个空格；没有缩进时保持原样。
    expect(applyMarkdownCommand(' 第一行\n   第二行', 0, 12, 'outdent').text).toBe(
      '第一行\n 第二行'
    );
    expect(applyMarkdownCommand('第一行', 0, 3, 'outdent').text).toBe('第一行');
  });

  it('move-up/move-down：首末行边界、多行块移动、选区跟随', () => {
    // 首行上移 / 末行下移：边界不动。
    expect(applyMarkdownCommand('第一行\n第二行', 0, 3, 'move-up')).toEqual({
      text: '第一行\n第二行',
      selectionStart: 0,
      selectionEnd: 3
    });
    expect(applyMarkdownCommand('第一行\n第二行', 4, 7, 'move-down')).toEqual({
      text: '第一行\n第二行',
      selectionStart: 4,
      selectionEnd: 7
    });

    // 单行上下移动，选区跟着移动后的行。
    expect(applyMarkdownCommand('第一行\n第二行\n第三行', 4, 7, 'move-up')).toEqual({
      text: '第二行\n第一行\n第三行',
      selectionStart: 0,
      selectionEnd: 3
    });
    expect(applyMarkdownCommand('第一行\n第二行\n第三行', 0, 3, 'move-down')).toEqual({
      text: '第二行\n第一行\n第三行',
      selectionStart: 4,
      selectionEnd: 7
    });

    // 多行块整体上移/下移。
    expect(applyMarkdownCommand('A\nB\nC\nD', 2, 5, 'move-up')).toEqual({
      text: 'B\nC\nA\nD',
      selectionStart: 0,
      selectionEnd: 3
    });
    expect(applyMarkdownCommand('A\nB\nC\nD', 2, 5, 'move-down')).toEqual({
      text: 'A\nD\nB\nC',
      selectionStart: 4,
      selectionEnd: 7
    });
  });
});

describe('格式刷 capture/apply', () => {
  it('捕获加粗标记并套到目标选区（先清掉目标原有标记）', () => {
    expect(captureMarkdownFormatting('**重点**')).toEqual({ markers: ['**'] });
    expect(captureMarkdownFormatting('普通文字')).toEqual({ markers: [] });
    expect(
      applyMarkdownFormatting('目标文字', 0, 4, captureMarkdownFormatting('**重点**'))
    ).toEqual({ text: '**目标文字**', selectionStart: 2, selectionEnd: 6 });
    // 目标已有标记：先清掉再套用，不会叠加。
    expect(
      applyMarkdownFormatting('**旧加粗**文字', 0, 10, captureMarkdownFormatting('普通文字'))
    ).toEqual({ text: '旧加粗文字', selectionStart: 0, selectionEnd: 5 });
    // 空选区套用占位文字。
    expect(applyMarkdownFormatting('', 0, 0, captureMarkdownFormatting('**重点**'))).toEqual({
      text: '**文字**',
      selectionStart: 2,
      selectionEnd: 4
    });
  });

  it('捕获颜色并套用；多种标记按顺序嵌套', () => {
    expect(captureMarkdownFormatting('<c:#36c>红</c>')).toEqual({ markers: [], color: '#36c' });
    expect(captureMarkdownFormatting('**<c:#b23b2e>红</c>**')).toEqual({
      markers: ['**'],
      color: '#b23b2e'
    });
    expect(
      applyMarkdownFormatting('目标', 0, 2, { markers: [], color: '#b23b2e' })
    ).toEqual({
      text: '<c:#b23b2e>目标</c>',
      selectionStart: 11,
      selectionEnd: 13
    });
    expect(applyMarkdownFormatting('目标', 0, 2, { markers: ['**', '=='] })).toEqual({
      text: '**==目标==**',
      selectionStart: 4,
      selectionEnd: 6
    });
  });
});

describe('新扩展的安全边界', () => {
  it('颜色指令不接受任何非十六进制内容，对齐块内容全部转义', () => {
    for (const bad of [
      '<c:javascript:alert(1)>危险</c>',
      '<c:#fff onclick=alert(1)>危险</c>',
      '<c:#b23b2e;background:url(javascript:1)>危险</c>',
      '<c:red>危险</c>'
    ]) {
      const html = renderMarkdown(bad);
      expect(html).not.toContain('<span');
      expect(html).not.toContain('style=');
    }
    const inlineHtml = renderMarkdown('::: right\n<img src=x onerror=alert(1)>\n:::');
    expect(inlineHtml).not.toContain('<img');
    expect(inlineHtml).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('Phase 2a 回归：搜索与纯文本', () => {
  it('带颜色/对齐语法的笔记与批注仍能搜索，摘要无标记', async () => {
    const dir = path.join(root, 'search');
    mkdirSync(dir, { recursive: true });
    const store = new Store(dir);
    try {
      const pdf = await PDFDocument.create();
      pdf.addPage([300, 400]).drawText('Phase2 search fixture', { x: 40, y: 350, size: 16 });
      const file = path.join(dir, 'fixture.pdf');
      writeFileSync(file, await pdf.save());
      const document = await store.importDocument(file, 'phase2-search.pdf', true);
      store.createNote({
        documentId: document.id,
        page: 0,
        content: '::: center\n<c:#b23b2e>重点结论</c>\n:::'
      });
      store.createAnnotation({
        documentId: document.id,
        page: 1,
        quote: '原文保持 **原样**',
        content: '<c:#36c>批注颜色</c> 与 **加粗**',
        style: 'page'
      });
      const secrets = new SecretStore();

      const noteHits = searchLibrary(store, secrets, '重点结论', ['note']);
      expect(noteHits).toHaveLength(1);
      expect(noteHits[0]?.snippet).toContain('重点结论');
      expect(noteHits[0]?.snippet).not.toContain('<c:');
      expect(noteHits[0]?.snippet).not.toContain(':::');

      const annotationHits = searchLibrary(store, secrets, '批注颜色', ['annotation']);
      expect(annotationHits).toHaveLength(1);
      expect(annotationHits[0]?.snippet).toContain('原文保持 **原样**');
      const comment = annotationHits[0]?.snippet.split('\n批注：')[1] ?? '';
      expect(comment).toContain('批注颜色');
      expect(comment).not.toContain('<c:');
      expect(comment).not.toContain('**');

      expect(searchLibraryDocuments(store, secrets, '重点结论', ['note'])).toEqual([document.id]);
    } finally {
      store.close();
    }
  });
});
