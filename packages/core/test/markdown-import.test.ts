import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createCanvas } from '@napi-rs/canvas';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  MarkdownImportJob,
  MarkdownImportReport,
  MarkdownVaultScan
} from '@studianda/shared';
import {
  cancelMarkdownImport,
  getMarkdownImportStatus,
  importMarkdownNotes,
  scanMarkdownVault,
  startMarkdownImport
} from '../src/markdown-import.js';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'studianda-markdown-'));
const token = 'test-token';

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function storeAt(name: string): Store {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  return new Store(dir);
}

function writeFile(dir: string, relativePath: string, content: string | Buffer): string {
  const file = path.join(dir, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

const PNG_BYTES = Buffer.from(
  await (async () => {
    const canvas = createCanvas(2, 2);
    const context = canvas.getContext('2d');
    context.fillStyle = '#884422';
    context.fillRect(0, 0, 2, 2);
    return canvas.encode('png');
  })()
);

interface VaultFixture {
  dir: string;
}

function createMainVault(name: string): VaultFixture {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFile(dir, 'pic.png', PNG_BYTES);
  writeFile(dir, 'doc.pdf', Buffer.from('%PDF-1.4 fake attachment'));
  writeFile(dir, '.hidden-note.md', '隐藏笔记');
  writeFile(dir, '.markdown/config.json', '{}');
  writeFile(dir, '.markdown/plugins/x/secret.md', '隐藏插件笔记');
  writeFile(dir, 'node_modules/pkg/readme.md', '依赖笔记');
  writeFile(dir, '.git/HEAD', 'ref');
  writeFile(
    dir,
    'a.md',
    [
      '---',
      'tags: [x]',
      'title: A',
      '---',
      '# A 标题',
      '',
      '%%这是多行',
      '注释%%',
      '嵌入图片 ![[pic.png]] 和 markdown 图片 ![pic](pic.png)',
      '附件 ![[doc.pdf]]',
      '缺失图片 ![[missing.png]]',
      '内部链接 [[b]] / [[sub/c]]',
      '未知链接 [[missing-note]]',
      '自锚点 [[#本地标题]]',
      'Markdown 链接 [B 笔记](b.md)',
      '外链 [官网](https://example.com)'
    ].join('\n')
  );
  writeFile(dir, 'b.md', '# B 标题\n\n指向 A：[[a]]\n');
  writeFile(dir, 'sub/c.md', '# C 标题\n\n内容 C\n');
  return { dir };
}

describe('scanMarkdownVault', () => {
  it('跳过隐藏/配置/依赖目录，返回 notes/attachments 元数据', () => {
    const { dir } = createMainVault('scan-vault');
    const scan: MarkdownVaultScan = scanMarkdownVault(dir);
    expect(scan.vaultName).toBe('scan-vault');
    expect(path.isAbsolute(scan.vaultPath)).toBe(true);
    expect(scan.notes.map((file) => file.relativePath)).toEqual([
      'a.md',
      'b.md',
      'sub/c.md'
    ]);
    expect(scan.attachments.map((file) => file.relativePath)).toEqual(['doc.pdf', 'pic.png']);
    for (const file of [...scan.notes, ...scan.attachments]) {
      expect(file.name).toBe(path.basename(file.relativePath));
      expect(file.sizeBytes).toBeGreaterThan(0);
      expect(Number.isNaN(Date.parse(file.modified))).toBe(false);
    }
  });

  it('不存在的路径 / 普通文件路径报中文错误', () => {
    expect(() => scanMarkdownVault(path.join(root, 'not-exist-vault'))).toThrow('笔记文件夹不存在');
    const file = writeFile(path.join(root, 'scan-file-root'), 'plain.md', 'x');
    expect(() => scanMarkdownVault(file)).toThrow('路径不是目录');
    expect(() => scanMarkdownVault('')).toThrow('需要笔记文件夹路径');
  });
});

describe('importMarkdownNotes', () => {
  it('选择性导入：清理 frontmatter/注释、图片复制、附件跳过、链接重写与 unresolved', async () => {
    const { dir } = createMainVault('import-vault');
    const store = storeAt('import-store');
    try {
      const scan = scanMarkdownVault(dir);
      const report: MarkdownImportReport = await importMarkdownNotes(store, {
        vaultPath: dir,
        files: ['a.md', 'b.md', 'sub/c.md']
      });
      expect(report).toMatchObject({
        requested: 3,
        imported: 3,
        updated: 0,
        skipped: 0,
        failed: 0,
        imagesCopied: 2, // ![[pic.png]] + ![pic](pic.png) 各一次（同内容去重为一个资源）
        skippedAttachments: 0,
        attachmentsCopied: 1
      });
      expect(report.linksRewritten).toBeGreaterThanOrEqual(3);
      expect(report.unresolvedLinks).toBe(1);
      expect(report.notes).toHaveLength(3);

      const byPath = new Map(
        report.notes.map((item) => [item.relativePath, item])
      );
      expect(byPath.get('a.md')?.status).toBe('imported');
      expect(byPath.get('b.md')?.status).toBe('imported');
      const noteIdA = byPath.get('a.md')?.noteId as string;
      const noteIdB = byPath.get('b.md')?.noteId as string;
      const noteIdC = byPath.get('sub/c.md')?.noteId as string;
      expect(noteIdA).toBeTruthy();
      expect(noteIdB).toBeTruthy();
      expect(noteIdC).toBeTruthy();

      // 独立笔记全部导入，external_key 保留。
      const notes = store.listStandaloneNotes();
      expect(notes).toHaveLength(3);
      const noteA = notes.find((note) => note.id === noteIdA)!;
      expect(noteA.content).not.toContain('tags: [x]');
      expect(noteA.content).not.toContain('---');
      expect(noteA.content).not.toContain('%%');
      expect(noteA.content).toContain('# A 标题');
      // 图片已复制为 studianda-asset 链接。
      expect(noteA.content).toContain('studianda-asset://note-assets/');
      expect(noteA.content).not.toContain('![[pic.png]]');
      // 非图片附件 → 复制到资源目录并替换为附件链接（不再有 embed 语法）。
      expect(noteA.content).not.toContain('![[doc.pdf]]');
      expect(noteA.content).toContain('doc.pdf');
      expect(noteA.content).toContain('studianda-asset://note-assets/');
      expect(noteA.content).toContain('[附件：doc.pdf]');
      // 未选中目标 → 保留原 wikilink 文本（等待后续导入 resolving 改写）。
      expect(noteA.content).toContain('[[missing-note]]');
      expect(noteA.content).not.toContain('[[note:missing-note]]');
      // 选中笔记的 wikilink / Markdown 链接在 resolving 阶段改写为内部引用。
      expect(noteA.content).toContain(`[[note:${noteIdB}|b]]`);
      expect(noteA.content).toContain(`[[note:${noteIdC}|sub/c]]`);
      expect(noteA.content).toContain(`[[note:${noteIdB}|B 笔记]]`);
      // 自锚点 → 纯文本；外链保留。
      expect(noteA.content).not.toContain('[[#本地标题]]');
      expect(noteA.content).toContain('https://example.com');
      // 文件夹层级：根目录 ''，子目录 'sub'。
      expect(noteA.folderPath).toBe('');
      const noteC = notes.find((note) => note.id === noteIdC)!;
      expect(noteC.folderPath).toBe('sub');
      expect(report.attachmentsCopied).toBe(1);
      // 缺失图片有 warning。
      expect(report.warnings.some((warning) => warning.includes('missing.png'))).toBe(true);
      // B 指向 A 的链接在第二遍也能解析。
      const noteB = notes.find((note) => note.id === noteIdB)!;
      expect(noteB.content).toContain(`[[note:${noteIdA}|a]]`);

      // 选中的外部链接/未选笔记（未导入）不会误改。
      void scan;
    } finally {
      store.close();
    }
  });

  it('重复导入同一文件 → updated 且不新增笔记；external_key 去重', async () => {
    const { dir } = createMainVault('reimport-vault');
    const store = storeAt('reimport-store');
    try {
      const first = await importMarkdownNotes(store, { vaultPath: dir, files: ['a.md'] });
      const firstNoteId = first.notes[0]?.noteId;
      expect(first.imported).toBe(1);
      expect(store.listStandaloneNotes()).toHaveLength(1);

      const second = await importMarkdownNotes(store, { vaultPath: dir, files: ['a.md'] });
      expect(second.imported).toBe(0);
      expect(second.updated).toBe(1);
      expect(second.notes[0]?.noteId).toBe(firstNoteId);
      expect(store.listStandaloneNotes()).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it('重名 basename ambiguous：无法确定目标记 unresolved + warning，路径全名可解析', async () => {
    const dir = path.join(root, 'ambiguous-vault');
    mkdirSync(dir, { recursive: true });
    writeFile(dir, 'x/Note.md', '# X\n');
    writeFile(dir, 'y/Note.md', '# Y\n');
    writeFile(dir, 'z.md', '链接 [[Note]] 与 [[x/Note]]\n');
    const store = storeAt('ambiguous-store');
    try {
      const report = await importMarkdownNotes(store, {
        vaultPath: dir,
        files: ['x/Note.md', 'y/Note.md', 'z.md']
      });
      expect(report.imported).toBe(3);
      expect(report.unresolvedLinks).toBe(1);
      expect(report.warnings.some((warning) => warning.includes('链接目标重名'))).toBe(true);
      const noteZ = store.listStandaloneNotes().find(
        (note) => note.content.includes('链接')
      )!;
      const noteX = report.notes.find((item) => item.relativePath === 'x/Note.md')?.noteId as string;
      // 重名目标无法确定：保留原 wikilink 文本（不再替换为错误内部链接）。
      expect(noteZ.content).toContain('[[Note]]');
      expect(noteZ.content).toContain(`[[note:${noteX}|x/Note]]`);
    } finally {
      store.close();
    }
  });

  it('大图（超像素上限）自动压缩后导入；无法解码的图片降级为纯文本', async () => {
    const dir = path.join(root, 'oversize-vault');
    mkdirSync(dir, { recursive: true });
    // 4000×4000 = 16MP，超过默认 8MP 像素上限 → 应压缩后导入。
    const canvas = createCanvas(4000, 4000);
    const context = canvas.getContext('2d');
    context.fillStyle = '#335577';
    context.fillRect(0, 0, 4000, 4000);
    writeFile(dir, 'huge.png', Buffer.from(await canvas.encode('png')));
    // PNG magic 合法但内容损坏：无法解码/压缩 → 降级文本。
    writeFile(
      dir,
      'broken.png',
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)])
    );
    writeFile(dir, 'big.md', '大图 ![[huge.png]] 坏图 ![[broken.png]]\n');
    const store = storeAt('oversize-store');
    try {
      const report = await importMarkdownNotes(store, {
        vaultPath: dir,
        files: ['big.md', '../outside.md', 'not-markdown.txt']
      });
      expect(report.requested).toBe(3);
      expect(report.imported).toBe(1);
      expect(report.skipped).toBe(2);
      expect(report.imagesCopied).toBe(1); // 大图压缩成功后计入
      expect(report.warnings.some((warning) => warning.includes('已压缩'))).toBe(true);
      expect(report.warnings.some((warning) => warning.includes('broken.png'))).toBe(true);
      const note = store.listStandaloneNotes()[0]!;
      expect(note.content).not.toContain('![[huge.png]]');
      expect(note.content).toContain('studianda-asset://note-assets/');
      expect(note.content).toContain('图片未导入：broken.png');
      // 压缩后的图片资源确实存在且不超过 2MB。
      const db = (store as unknown as { db: DatabaseSync }).db;
      const rows = db.prepare('SELECT filename, size_bytes FROM note_assets').all() as Array<{
        filename: string;
        size_bytes: number;
      }>;
      expect(rows.length).toBe(1);
      expect(Number(rows[0]!.size_bytes)).toBeLessThanOrEqual(2 * 1024 * 1024);
    } finally {
      store.close();
    }
  });
});

describe('Markdown 语法映射', () => {
  it('BOM/前导空白 frontmatter、tags→正文标签、callouts、block refs、Mermaid 围栏保留', async () => {
    const dir = path.join(root, 'syntax-vault');
    mkdirSync(dir, { recursive: true });
    writeFile(dir, 'target.md', '# Target\n');
    writeFile(
      dir,
      'syntax.md',
      '\uFEFF\n---\ntags:\n  - alpha\n  - beta\nother: 丢弃\n---\n' +
        '# 标题\n\n> [!warning]- 注意安全\n> callout 正文\n\n' +
        '带 block id ^blockid\n\n单独行：\n^anotherid\n\n' +
        '```mermaid\ngraph TD\n  A[[inside-fence]] --> B\n```\n\n' +
        '行内标签 #tag 保留；链接 [[target]]\n'
    );
    const store = storeAt('syntax-store');
    try {
      const report = await importMarkdownNotes(store, {
        vaultPath: dir,
        files: ['syntax.md', 'target.md']
      });
      expect(report.imported).toBe(2);
      expect(report.warnings.some((warning) => warning.includes('frontmatter'))).toBe(true);
      expect(
        report.warnings.some((warning) => warning.includes('Mermaid/Dataview 未渲染'))
      ).toBe(true);
      const note = store.listStandaloneNotes().find((item) => item.content.includes('标题'))!;
      expect(note.content).not.toContain('other: 丢弃');
      expect(note.content).toContain('> 标签：alpha, beta');
      expect(note.content).toContain('> **注意安全**');
      expect(note.content).toContain('> callout 正文');
      expect(note.content).not.toContain('^blockid');
      expect(note.content).not.toContain('^anotherid');
      // Mermaid 围栏内容原样保留，不被当作笔记链接处理。
      expect(note.content).toContain('```mermaid');
      expect(note.content).toContain('A[[inside-fence]] --> B');
      expect(note.content).toContain('#tag');
      void report;
    } finally {
      store.close();
    }
  });

  it('重名 basename ambiguous 时保留原 wikilink', async () => {
    const dir = path.join(root, 'ambiguous-links-vault');
    mkdirSync(dir, { recursive: true });
    writeFile(dir, 'p/Note.md', '# P\n');
    writeFile(dir, 'q/Note.md', '# Q\n');
    writeFile(dir, 'src.md', '[[Note]]\n');
    const store = storeAt('ambiguous-links-store');
    try {
      const report = await importMarkdownNotes(store, {
        vaultPath: dir,
        files: ['p/Note.md', 'q/Note.md', 'src.md']
      });
      expect(report.unresolvedLinks).toBe(1);
      expect(report.warnings.some((warning) => warning.includes('重名'))).toBe(true);
      const src = store.listStandaloneNotes().find((note) => note.content.includes('[[Note]]'))!;
      expect(src).toBeTruthy();
    } finally {
      store.close();
    }
  });
});

describe('链接保留与后续 resolving 自动改写', () => {
  it('未选中的 wikilink 保留原样；后续导入目标后自动解析（大小写/同目录/basename/block ref）', async () => {
    const dir = path.join(root, 'resolving-vault');
    mkdirSync(dir, { recursive: true });
    writeFile(
      dir,
      'src.md',
      '目标 [[target]] 大小写 [[TARGET]] 同目录 [[folder/two]] basename [[two]] 唯一 [[target]]\n'
    );
    writeFile(dir, 'folder/one.md', '同目录唯一 [[two]]\n');
    writeFile(dir, 'target.md', '# Target\n');
    writeFile(dir, 'folder/two.md', '# Two\n');
    writeFile(dir, 'blocks.md', '块引用 [[target#^blk]]\n');

    const store = storeAt('resolving-store');
    try {
      // 第一轮：只导 src（目标尚未导入）→ wikilink 保留原样 + unresolved。
      const first = await importMarkdownNotes(store, { vaultPath: dir, files: ['src.md'] });
      expect(first.imported).toBe(1);
      expect(first.unresolvedLinks).toBeGreaterThan(0);
      const srcNote = store.listStandaloneNotes()[0]!;
      expect(srcNote.content).toContain('[[target]]');
      expect(srcNote.content).toContain('[[TARGET]]');

      // 第二轮：导入目标（含同目录、block ref 来源）→ resolving 自动改写前一轮笔记。
      const second = await importMarkdownNotes(store, {
        vaultPath: dir,
        files: ['target.md', 'folder/two.md', 'folder/one.md', 'blocks.md']
      });
      expect(second.imported).toBe(4);
      expect(second.linksRewritten).toBeGreaterThan(0);
      const targetId = second.notes.find((item) => item.relativePath === 'target.md')?.noteId as string;
      const twoId = second.notes.find((item) => item.relativePath === 'folder/two.md')?.noteId as string;
      const srcAfter = store.listStandaloneNotes().find((note) =>
        note.content.includes('大小写')
      )!;
      expect(srcAfter.content).toContain(`[[note:${targetId}|target]]`);
      expect(srcAfter.content).toContain(`[[note:${targetId}|TARGET]]`);
      expect(srcAfter.content).toContain(`[[note:${twoId}|two]]`);
      expect(srcAfter.content).toContain(`[[note:${twoId}|folder/two]]`);
      // 同目录相对解析：folder/one.md 的 [[two]] → folder/two。
      const oneAfter = store.listStandaloneNotes().find((note) => note.content.includes('同目录唯一'))!;
      expect(oneAfter.content).toContain(`[[note:${twoId}|two]]`);
      // block ref：[[target#^blk]] 解析到 target，不残留 #^blk 内部链接。
      const blocksAfter = store.listStandaloneNotes().find((note) => note.content.includes('块引用'))!;
      expect(blocksAfter.content).toContain(`[[note:${targetId}|target § ^blk]]`);
      expect(store.listStandaloneNotes().find((note) => note.id === srcNote.id)?.folderPath).toBe('');
    } finally {
      store.close();
    }
  });

  it('external_key 使用规范化小写 relpath：Windows 大小写不同路径不重复导入', async () => {
    const dir = path.join(root, 'case-vault');
    mkdirSync(dir, { recursive: true });
    writeFile(dir, 'Sub/Note.MD', '# 大小写\n');
    const store = storeAt('case-store');
    try {
      const first = await importMarkdownNotes(store, {
        vaultPath: dir,
        files: ['Sub/Note.MD']
      });
      expect(first.imported).toBe(1);
      expect(first.notes[0]?.noteId).toBeTruthy();
      const note = store.listStandaloneNotes()[0]!;
      expect(note.folderPath).toBe('Sub');

      const second = await importMarkdownNotes(store, {
        vaultPath: dir,
        files: ['sub/note.md']
      });
      // 同一文件大小写不同 → 命中同一 external_key，不再新建。
      expect(second.imported + second.updated).toBe(1);
      expect(store.listStandaloneNotes()).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});

async function waitJob(timeoutMs = 8000): Promise<MarkdownImportJob> {
  const started = Date.now();
  for (;;) {
    const job = getMarkdownImportStatus();
    // 取消会先置 status=cancelled，再在异步循环停下后补上最终 report；
    // 等待最终态时要等 report 落定，避免把“刚取消、尚未收尾”的快照当成完成。
    const settled =
      job.status !== 'running' &&
      job.status !== 'idle' &&
      (job.status !== 'cancelled' || job.report !== null);
    if (settled) return job;
    if (Date.now() - started > timeoutMs) throw new Error('markdown import job timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('后台 Markdown 导入任务', () => {
  it('start 后轮询到 done：进度/总数/报告/folderPath；并发 start 返回 running', async () => {
    const dir = path.join(root, 'job-vault');
    mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      const relativePath = index % 2 === 0 ? `n${index}.md` : `sub/n${index}.md`;
      writeFile(dir, relativePath, `# 笔记 ${index}\n链接 [[n0]]\n`);
      files.push(relativePath);
    }
    const store = storeAt('job-store');
    try {
      const started = startMarkdownImport(store, { vaultPath: dir, files });
      expect(started.status).toBe('running');
      expect(started.total).toBe(30);
      const second = startMarkdownImport(store, { vaultPath: dir, files });
      expect(second.status).toBe('running');

      const job = await waitJob();
      expect(job.status).toBe('done');
      expect(job.error).toBe('');
      expect(job.done).toBe(30);
      expect(job.total).toBe(30);
      expect(job.currentPath).toBe('');
      expect(job.report).not.toBeNull();
      expect(job.report?.imported).toBe(30);
      expect(job.report?.attachmentsCopied).toBeGreaterThanOrEqual(0);
      // folderPath 来自相对路径目录。
      const subNote = store.listStandaloneNotes().find((note) => note.folderPath === 'sub');
      expect(subNote).toBeTruthy();
      const rootNote = store.listStandaloneNotes().find((note) => note.folderPath === '');
      expect(rootNote).toBeTruthy();
    } finally {
      store.close();
    }
  });

  it('cancel 置 status=cancelled 并停止后续处理', async () => {
    const dir = path.join(root, 'cancel-vault');
    mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    for (let index = 0; index < 300; index += 1) {
      writeFile(dir, `c${index}.md`, `# C${index}\n`);
      files.push(`c${index}.md`);
    }
    const store = storeAt('cancel-store');
    try {
      startMarkdownImport(store, { vaultPath: dir, files });
      const cancelled = cancelMarkdownImport();
      expect(cancelled.status).toBe('cancelled');
      const job = await waitJob();
      expect(job.status).toBe('cancelled');
      expect(job.report).not.toBeNull();
      expect(job.done).toBeLessThan(300);
      // 已处理的笔记仍在库中，但明显少于请求数。
      expect(store.listStandaloneNotes().length).toBeLessThan(300);
    } finally {
      store.close();
    }
  });
});

describe('HTTP /markdown', () => {
  const dataDir = path.join(root, 'http');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(dataDir);
  const server = buildServer({ token, version: 'test-version', store, secrets: new SecretStore() });
  const { dir } = createMainVault('http-vault');

  afterAll(async () => {
    await server.close();
    store.close();
  });

  const headers = (): Record<string, string> => ({ 'x-studianda-token': token });

  it('POST /markdown/scan 200；非法路径 400', async () => {
    const scan = await server.inject({
      method: 'POST',
      url: '/api/v1/markdown/scan',
      headers: headers(),
      payload: { vaultPath: dir }
    });
    expect(scan.statusCode).toBe(200);
    const body = scan.json() as MarkdownVaultScan;
    expect(body.vaultName).toBe('http-vault');
    expect(body.notes.map((file) => file.relativePath)).toContain('a.md');

    const missing = await server.inject({
      method: 'POST',
      url: '/api/v1/markdown/scan',
      headers: headers(),
      payload: { vaultPath: path.join(root, 'no-such-vault') }
    });
    expect(missing.statusCode).toBe(400);
    expect((missing.json() as { message: string }).message).toContain('笔记文件夹不存在');

    const badBody = await server.inject({
      method: 'POST',
      url: '/api/v1/markdown/scan',
      headers: headers(),
      payload: {}
    });
    expect(badBody.statusCode).toBe(400);
  });

  it('POST /markdown/import 200 report；非法参数 400', async () => {
    const imported = await server.inject({
      method: 'POST',
      url: '/api/v1/markdown/import',
      headers: headers(),
      payload: { vaultPath: dir, files: ['b.md'] }
    });
    expect(imported.statusCode).toBe(200);
    expect((imported.json() as MarkdownImportReport).imported).toBe(1);

    const badFiles = await server.inject({
      method: 'POST',
      url: '/api/v1/markdown/import',
      headers: headers(),
      payload: { vaultPath: dir, files: 'b.md' }
    });
    expect(badFiles.statusCode).toBe(400);

    const badVault = await server.inject({
      method: 'POST',
      url: '/api/v1/markdown/import',
      headers: headers(),
      payload: { vaultPath: path.join(root, 'no-such-vault'), files: [] }
    });
    expect(badVault.statusCode).toBe(400);
  });

  it('后台导入 HTTP：start/status 轮询到 done，cancel 接口 200', async () => {
    const started = await server.inject({
      method: 'POST',
      url: '/api/v1/markdown/import/start',
      headers: headers(),
      payload: { vaultPath: dir, files: ['a.md', 'b.md', 'sub/c.md'] }
    });
    expect(started.statusCode).toBe(200);
    expect((started.json() as MarkdownImportJob).status).toBe('running');

    let job: MarkdownImportJob = started.json() as MarkdownImportJob;
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/markdown/import/status',
        headers: headers()
      });
      expect(response.statusCode).toBe(200);
      job = response.json() as MarkdownImportJob;
      if (job.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(job.status).toBe('done');
    expect(job.report?.imported).toBeGreaterThanOrEqual(1);

    const cancelResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/markdown/import/cancel',
      headers: headers()
    });
    expect(cancelResponse.statusCode).toBe(200);
    expect((cancelResponse.json() as MarkdownImportJob).status).toBe('done');
  });
});
