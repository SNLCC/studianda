import { writeFileSync } from 'node:fs';
import { PDFDocument, StandardFonts } from 'pdf-lib';

/**
 * 生成仓库内的测试用 PDF（2 页、有文本层、原创内容）。
 * 运行：node packages/core/test/fixtures/generate-sample-pdf.mjs
 *
 * 只用于测试；不包含第三方论文/个人信息。生成结果 `sample-paper.pdf` 提交到仓库，
 * 使干净 clone 与 CI 不依赖本机被 .gitignore 忽略的 测试用pdf.pdf。
 */
const pdf = await PDFDocument.create();
const font = await pdf.embedFont(StandardFonts.Helvetica);

const pages = [
  {
    title: 'A Sample Two-Column Academic Paper',
    subtitle: 'Author One, Author Two\nDepartment of Sample Studies, Example University',
    heading: 'I. INTRODUCTION',
    lines: [
      'This synthetic two-page document exists only to exercise the reading,',
      'parsing, layout and export pipelines in automated tests.',
      'It contains a title, body paragraphs, section headings and references,',
      'but no third-party text, figures, personal data or copyrighted content.',
      'Abstract: a compact sample document for parser fixtures.',
      'Keywords: sample, fixture, parser, layout, two-column, demonstration.'
    ]
  },
  {
    title: 'II. RELATED WORK AND METHODOLOGY',
    subtitle: 'A second page so pagination and translation tests have enough input.',
    heading: 'III. EXPERIMENTAL RESULTS',
    lines: [
      'The sample reports illustrative results only; there are no real',
      'measurements, no citations to external works and no claims of novelty.',
      'REFERENCES',
      '[1] Sample Author. A synthetic reference entry for parser tests. 2026.',
      '[2] Another Sample Author. A second synthetic entry. 2026.'
    ]
  }
];

for (const [index, spec] of pages.entries()) {
  const page = pdf.addPage([595, 842]);
  let y = 780;
  // 第 2 页顶部放一条引用行：translation 测试要求"顶边引用行不能被当成 furniture 跳过"，
  // 并检查译文分段里包含 [3]。这是测试 fixture 的约定，不是论文内容。
  if (index === 1) {
    page.drawText('[3] Top-margin reference line for layout tests. 2026.', {
      x: 56,
      y: 818,
      size: 9,
      font
    });
    y = 780;
  }
  page.drawText(spec.title, { x: 56, y, size: 16, font });
  y -= 26;
  for (const line of spec.subtitle.split('\n')) {
    page.drawText(line, { x: 56, y, size: 10, font });
    y -= 14;
  }
  y -= 12;
  page.drawText(spec.heading, { x: 56, y, size: 13, font });
  y -= 22;
  for (const line of spec.lines) {
    page.drawText(line, { x: 56, y, size: 11, font });
    y -= 16;
  }
}

const bytes = await pdf.save();
writeFileSync(new URL('./sample-paper.pdf', import.meta.url), bytes);
console.log(`generated sample-paper.pdf (${bytes.byteLength} bytes)`);
