import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { afterAll, describe, expect, it } from 'vitest';
import {
  getMarkdownImportStatus,
  importMarkdownNotes,
  previewMarkdownImportDuplicates,
  startMarkdownImport
} from '../src/markdown-import.js';
import { Store } from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'studianda-markdown-duplicates-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function storeAt(name: string): { store: Store; dataDir: string } {
  const dataDir = path.join(root, name);
  mkdirSync(dataDir, { recursive: true });
  return { store: new Store(dataDir), dataDir };
}

function writeFile(dir: string, relativePath: string, content: string | Buffer): string {
  const file = path.join(dir, relativePath);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

async function pngBytes(color: string): Promise<Buffer> {
  const canvas = createCanvas(2, 2);
  const context = canvas.getContext('2d');
  context.fillStyle = color;
  context.fillRect(0, 0, 2, 2);
  return Buffer.from(await canvas.encode('png'));
}

/** 从笔记内容里取出保存后的图片资源路径（dataDir/note-assets/<sha>.<ext>）。 */
function savedAssetPath(dataDir: string, content: string): string {
  const match = /studianda-asset:\/\/note-assets\/([A-Za-z0-9._-]+)/.exec(content);
  if (!match) throw new Error(`笔记内容里没有图片资源链接：${content}`);
  return path.join(dataDir, 'note-assets', match[1]!);
}

async function waitImportJob() {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const job = getMarkdownImportStatus();
    if (job.status !== 'running' && job.status !== 'idle') return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('import timeout');
}

describe('Markdown 导入重复检查（externalKey 身份，不用文件名）', () => {
  it('preview 按 vault 路径 hash + 相对路径识别；同名不同目录不误判', async () => {
    const vault = path.join(root, 'preview-vault');
    mkdirSync(vault, { recursive: true });
    writeFile(vault, 'a/Note.md', '# A 内容\n');
    writeFile(vault, 'b/Note.md', '# B 内容\n');
    const { store } = storeAt('preview-store');
    try {
      const first = await importMarkdownNotes(store, {
        vaultPath: vault,
        files: ['a/Note.md']
      });
      const noteId = first.notes[0]!.noteId as string;

      const preview = previewMarkdownImportDuplicates(store, {
        vaultPath: vault,
        files: ['a/Note.md', 'b/Note.md', 'a/Note.md']
      });
      expect(preview.total).toBe(3);
      expect(preview.alreadyImported).toBe(1);
      expect(preview.newCount).toBe(2);
      expect(preview.items).toEqual([
        { relativePath: 'a/Note.md', noteId, title: 'Note' }
      ]);

      // 尚未导入的 b/Note.md（同名但不同目录）不算重复。
      const onlyB = previewMarkdownImportDuplicates(store, {
        vaultPath: vault,
        files: ['b/Note.md']
      });
      expect(onlyB).toMatchObject({ total: 1, alreadyImported: 0, newCount: 1, items: [] });
    } finally {
      store.close();
    }
  });

  it('duplicatePolicy=skip 命中已有笔记：skipped/skippedExisting、不写库不改内容；默认 update 保持旧行为', async () => {
    const vault = path.join(root, 'policy-vault');
    mkdirSync(vault, { recursive: true });
    writeFile(vault, 'a.md', '原始内容\n');
    const { store } = storeAt('policy-store');
    try {
      const first = await importMarkdownNotes(store, { vaultPath: vault, files: ['a.md'] });
      expect(first).toMatchObject({
        requested: 1,
        imported: 1,
        updated: 0,
        skipped: 0,
        skippedExisting: 0
      });
      const noteId = first.notes[0]!.noteId as string;
      expect(store.getNote(noteId)?.content).toContain('原始内容');

      writeFile(vault, 'a.md', '修改后的内容\n');
      const skipped = await importMarkdownNotes(store, {
        vaultPath: vault,
        files: ['a.md'],
        duplicatePolicy: 'skip'
      });
      expect(skipped).toMatchObject({
        requested: 1,
        imported: 0,
        updated: 0,
        skipped: 1,
        skippedExisting: 1,
        failed: 0
      });
      expect(skipped.notes[0]).toMatchObject({ status: 'skipped', noteId });
      // 不写库：内容保持首次导入的版本，也不新增笔记。
      expect(store.getNote(noteId)?.content).toContain('原始内容');
      expect(store.getNote(noteId)?.content).not.toContain('修改后的内容');
      expect(store.listStandaloneNotes()).toHaveLength(1);

      // 不传 duplicatePolicy = update：覆盖旧内容。
      const updated = await importMarkdownNotes(store, { vaultPath: vault, files: ['a.md'] });
      expect(updated).toMatchObject({
        imported: 0,
        updated: 1,
        skippedExisting: 0
      });
      expect(updated.notes[0]).toMatchObject({ status: 'updated', noteId });
      expect(store.getNote(noteId)?.content).toContain('修改后的内容');
      expect(store.listStandaloneNotes()).toHaveLength(1);

      // 非法策略直接报错（路由层同样 400）。
      await expect(
        importMarkdownNotes(store, {
          vaultPath: vault,
          files: ['a.md'],
          duplicatePolicy: 'replace' as unknown as 'update'
        })
      ).rejects.toThrow('duplicatePolicy 必须是 update 或 skip');
    } finally {
      store.close();
    }
  });

  it('startMarkdownImport 透传 duplicatePolicy=skip，报告带 skippedExisting', async () => {
    const vault = path.join(root, 'policy-job-vault');
    mkdirSync(vault, { recursive: true });
    writeFile(vault, 'job.md', '任务原始\n');
    const { store } = storeAt('policy-job-store');
    try {
      expect(await importMarkdownNotes(store, { vaultPath: vault, files: ['job.md'] })).toMatchObject({
        imported: 1
      });
      writeFile(vault, 'job.md', '任务修改\n');
      const started = startMarkdownImport(store, {
        vaultPath: vault,
        files: ['job.md'],
        duplicatePolicy: 'skip'
      });
      expect(started.status).toBe('running');
      const job = await waitImportJob();
      expect(job.status).toBe('done');
      expect(job.report).toMatchObject({ imported: 0, updated: 0, skipped: 1, skippedExisting: 1 });
      const note = store.listStandaloneNotes()[0]!;
      expect(note.content).toContain('任务原始');
      expect(note.content).not.toContain('任务修改');
    } finally {
      store.close();
    }
  });
});

describe('Markdown 导入：附件重名解析', () => {
  it('笔记同目录优先（多候选时也不跳过）', async () => {
    const vault = path.join(root, 'attach-samedir');
    mkdirSync(vault, { recursive: true });
    const sameDir = await pngBytes('#aa0000');
    const otherDir = await pngBytes('#00aa00');
    writeFile(vault, 'sub/pic.png', sameDir);
    writeFile(vault, 'other/pic.png', otherDir);
    writeFile(vault, 'sub/note.md', '# 笔记\n\n![[pic.png]]\n');
    const { store, dataDir } = storeAt('attach-samedir-store');
    try {
      const report = await importMarkdownNotes(store, { vaultPath: vault, files: ['sub/note.md'] });
      expect(report.imagesCopied).toBe(1);
      const note = store.listStandaloneNotes()[0]!;
      const asset = readFileSync(savedAssetPath(dataDir, note.content));
      // 同目录的 pic.png 被选中（内容一致）。
      expect(asset.equals(sameDir)).toBe(true);
      expect(
        report.warnings.some((warning) => warning.includes('附件不存在') || warning.includes('无法读取'))
      ).toBe(false);
    } finally {
      store.close();
    }
  });

  it('basename 唯一候选直接用（vault 根相对路径不存在时）', async () => {
    const vault = path.join(root, 'attach-unique');
    mkdirSync(vault, { recursive: true });
    const bytes = await pngBytes('#0000aa');
    writeFile(vault, 'assets/unique.png', bytes);
    writeFile(vault, 'note.md', '![[unique.png]]\n');
    const { store, dataDir } = storeAt('attach-unique-store');
    try {
      const report = await importMarkdownNotes(store, { vaultPath: vault, files: ['note.md'] });
      expect(report.imagesCopied).toBe(1);
      const note = store.listStandaloneNotes()[0]!;
      expect(readFileSync(savedAssetPath(dataDir, note.content)).equals(bytes)).toBe(true);
      expect(report.warnings.some((warning) => warning.includes('附件不存在'))).toBe(false);
    } finally {
      store.close();
    }
  });

  it('多候选按「同目录 > 相对路径深度 > 字典序」选最近候选并 warning', async () => {
    const vault = path.join(root, 'attach-nearest');
    mkdirSync(vault, { recursive: true });
    const deepBytes = await pngBytes('#111111');
    const nearBytes = await pngBytes('#222222');
    writeFile(vault, 'x/y/dup.png', deepBytes);
    writeFile(vault, 'z/dup.png', nearBytes);
    writeFile(vault, 'note.md', '![[dup.png]]\n');
    const { store, dataDir } = storeAt('attach-nearest-store');
    try {
      const report = await importMarkdownNotes(store, { vaultPath: vault, files: ['note.md'] });
      expect(report.imagesCopied).toBe(1);
      expect(
        report.warnings.some(
          (warning) => warning.includes('附件重名') && warning.includes('z/dup.png')
        )
      ).toBe(true);
      const note = store.listStandaloneNotes()[0]!;
      expect(readFileSync(savedAssetPath(dataDir, note.content)).equals(nearBytes)).toBe(true);
    } finally {
      store.close();
    }
  });

  it('非图片附件的重名同样按最近候选复制（不因重名跳过）', async () => {
    const vault = path.join(root, 'attach-file-dup');
    mkdirSync(vault, { recursive: true });
    writeFile(vault, 'a/dup.pdf', Buffer.from('%PDF-1.4 A'));
    writeFile(vault, 'b/dup.pdf', Buffer.from('%PDF-1.4 B'));
    writeFile(vault, 'note.md', '![[dup.pdf]]\n');
    const { store } = storeAt('attach-file-dup-store');
    try {
      const report = await importMarkdownNotes(store, { vaultPath: vault, files: ['note.md'] });
      expect(report.attachmentsCopied).toBe(1);
      expect(report.skippedAttachments).toBe(0);
      expect(
        report.warnings.some(
          (warning) => warning.includes('附件重名') && warning.includes('a/dup.pdf')
        )
      ).toBe(true);
      expect(store.listStandaloneNotes()[0]?.content).toContain('[附件：dup.pdf]');
    } finally {
      store.close();
    }
  });

  it('路径越界/确实不存在时才带原因跳过', async () => {
    const vault = path.join(root, 'attach-outside-vault');
    mkdirSync(vault, { recursive: true });
    // 真正的越界目标：文件在库目录之外。
    writeFile(path.join(root, 'attach-outside-assets'), 'outside.png', await pngBytes('#333333'));
    writeFile(vault, 'note.md', '![越界](../attach-outside-assets/outside.png)\n![缺失](nope.png)\n');
    const { store } = storeAt('attach-outside-store');
    try {
      const report = await importMarkdownNotes(store, { vaultPath: vault, files: ['note.md'] });
      expect(report.imagesCopied).toBe(0);
      expect(report.warnings.some((warning) => warning.includes('附件路径越界'))).toBe(true);
      expect(report.warnings.some((warning) => warning.includes('附件不存在'))).toBe(true);
      const note = store.listStandaloneNotes()[0]!;
      // 无法解析的图片保留原文，不伪造链接。
      expect(note.content).toContain('../attach-outside-assets/outside.png');
      expect(note.content).toContain('nope.png');
      expect(note.content).not.toContain('studianda-asset://');
    } finally {
      store.close();
    }
  });
});

describe('Markdown 导入登记文件夹层级', () => {
  it('导入后 note_folders 存在，删除该文件夹不再报「文件夹不存在」', async () => {
    const vault = path.join(root, 'folder-register-vault');
    mkdirSync(vault, { recursive: true });
    writeFile(vault, 'deep/nested/note.md', '# 深层笔记\n');
    const { store } = storeAt('folder-register-store');
    try {
      const report = await importMarkdownNotes(store, {
        vaultPath: vault,
        files: ['deep/nested/note.md']
      });
      expect(report.imported).toBe(1);
      const paths = store.listNoteFolders().map((folder) => folder.path);
      expect(paths).toContain('deep');
      expect(paths).toContain('deep/nested');
      // 删除导入产生的文件夹：笔记上移到父级，而不是「文件夹不存在」。
      const deleted = store.deleteNoteFolder('deep/nested');
      expect(deleted).toMatchObject({ ok: true, movedNotes: 1 });
      expect(store.listStandaloneNotes()[0]?.folderPath).toBe('deep');
    } finally {
      store.close();
    }
  });
});
