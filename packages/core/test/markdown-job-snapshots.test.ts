import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import type { MarkdownScanJob } from '@studianda/shared';
import {
  cancelMarkdownScan,
  getMarkdownImportStatus,
  getMarkdownScanStatus,
  hydrateMarkdownJobs,
  startMarkdownImport,
  startMarkdownScan
} from '../src/markdown-import.js';
import { Store } from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'studianda-phase16-'));

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

async function waitImport(timeoutMs = 8000) {
  const started = Date.now();
  for (;;) {
    const job = getMarkdownImportStatus();
    if (job.status !== 'running' && job.status !== 'idle') return job;
    if (Date.now() - started > timeoutMs) throw new Error('import timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function waitScan(timeoutMs = 8000): Promise<MarkdownScanJob> {
  const started = Date.now();
  for (;;) {
    const job = getMarkdownScanStatus();
    if (job.status !== 'running' && job.status !== 'idle') return job;
    if (Date.now() - started > timeoutMs) throw new Error('scan timeout');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function settingsJson(store: Store, key: string): Record<string, unknown> {
  return JSON.parse(String(store.getSettings()[key] ?? '{}')) as Record<string, unknown>;
}

function readGzJson(file: string): Record<string, unknown> {
  const parsed = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as Record<
    string,
    unknown
  >;
  // 兼容旧格式（直接 data）与 envelope `{version, completedAt, data}`。
  if (parsed && typeof parsed === 'object' && 'data' in parsed && 'version' in parsed) {
    return parsed.data as Record<string, unknown>;
  }
  return parsed;
}

describe('renameNoteFolder 合并目标已存在的文件夹', () => {
  it('源子树前缀并入目标、同路径笔记共存、空目录保留、movedNotes 正确', () => {
    const store = storeAt('folder-merge');
    try {
      store.createNoteFolder('a/sub');
      store.createNoteFolder('a/empty');
      const noteA1 = store.createNote({ documentId: '', page: 0, content: 'a1', folderPath: 'a' });
      const noteA2 = store.createNote({ documentId: '', page: 0, content: 'a2', folderPath: 'a/sub' });
      // 回收站里的笔记也搬，但只计入 movedDeletedNotes。
      const trashedA = store.createNote({ documentId: '', page: 0, content: 'a-trash', folderPath: 'a' });
      store.deleteNote(trashedA.id);
      const trashedSub = store.createNote({
        documentId: '',
        page: 0,
        content: 'sub-trash',
        folderPath: 'a/sub'
      });
      store.deleteNote(trashedSub.id);
      store.createNoteFolder('b/existing');
      const noteB1 = store.createNote({ documentId: '', page: 0, content: 'b1', folderPath: 'b' });
      store.createNote({ documentId: '', page: 0, content: 'b2', folderPath: 'b/existing' });

      const result = store.renameNoteFolder('a', 'b');
      expect(result).toMatchObject({ ok: true, movedNotes: 2, movedDeletedNotes: 2 });
      // 源笔记前缀替换为目标前缀（同路径允许共存）。
      expect(store.getNote(noteA1.id)?.folderPath).toBe('b');
      expect(store.getNote(noteA2.id)?.folderPath).toBe('b/sub');
      expect(store.getNote(noteB1.id)?.folderPath).toBe('b');
      // 空目录并入，目标原有目录保留。
      const paths = store.listNoteFolders().map((folder) => folder.path);
      expect(paths).toContain('b');
      expect(paths).toContain('b/sub');
      expect(paths).toContain('b/empty');
      expect(paths).toContain('b/existing');
      expect(paths.some((value) => value === 'a' || value.startsWith('a/'))).toBe(false);
      // 合并后 b 下 2 条笔记（源 1 条 + 目标原有 1 条）。
      expect(store.listNoteFolders().find((folder) => folder.path === 'b')?.noteCount).toBe(2);
      expect(store.listNoteFolders().find((folder) => folder.path === 'b/sub')?.noteCount).toBe(1);

      // 合并到祖先也允许（目标在源外）。
      store.createNoteFolder('b/sub/deep');
      const ancestorMerge = store.renameNoteFolder('b/sub', 'b');
      expect(ancestorMerge.ok).toBe(true);
      expect(store.getNote(noteA2.id)?.folderPath).toBe('b');
      expect(store.listNoteFolders().some((folder) => folder.path === 'b/sub')).toBe(false);

      // 目标在源子树内仍拒绝。
      expect(() => store.renameNoteFolder('b', 'b/2')).toThrow('不能重命名到自己的子文件夹');
    } finally {
      store.close();
    }
  });
});

describe('扫描快照瘦身 + 完整结果独立文件', () => {
  it('settings 不含 scan 列表且体积小；hydrate 从文件恢复完整结果；input 保留', async () => {
    const dir = path.join(root, 'scan-slim-vault');
    mkdirSync(dir, { recursive: true });
    for (let index = 0; index < 30; index += 1) {
      writeFile(dir, `n-${index}.md`, `# N${index}`);
    }
    const store = storeAt('scan-slim-store');
    try {
      startMarkdownScan(store, dir);
      const job = await waitScan();
      expect(job.status).toBe('done');
      expect(job.scan?.notes).toHaveLength(30);
      const snapshot = settingsJson(store, 'markdown.scan_job');
      expect(snapshot.scan).toBeNull();
      expect(snapshot.status).toBe('done');
      expect(snapshot.total).toBe(30);
      expect(snapshot.input).toEqual({ vaultPath: expect.stringContaining('scan-slim-vault') });
      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toContain('"notes"');
      expect(serialized.length).toBeLessThan(2000);

      const resultFile = path.join(store.dataDir, 'markdown-scan-result.json.gz');
      expect(existsSync(resultFile)).toBe(true);
      expect(readGzJson(resultFile).notes).toHaveLength(30);
      // gzip 体积小于等价 JSON。
      expect(readFileSync(resultFile).length).toBeLessThan(
        Buffer.byteLength(JSON.stringify(job.scan))
      );

      // 重新 hydrate 后仍返回完整 scan。
      hydrateMarkdownJobs(store);
      const restored = getMarkdownScanStatus();
      expect(restored.status).toBe('done');
      expect(restored.scan?.notes).toHaveLength(30);
      expect(restored.input?.vaultPath).toContain('scan-slim-vault');
    } finally {
      store.close();
    }
  });

  it('超大模拟：2 万条 gzip 结果文件可恢复，体积显著小于 JSON，settings 仍为小体积', () => {
    const store = storeAt('scan-huge-store');
    try {
      const notes = Array.from({ length: 20000 }, (_, index) => ({
        relativePath: `n/n-${index}.md`,
        name: `n-${index}.md`,
        sizeBytes: 10,
        modified: '2026-01-01T00:00:00.000Z'
      }));
      const scanJson = JSON.stringify({
        vaultPath: '/vault',
        vaultName: 'vault',
        notes,
        attachments: []
      });
      writeFileSync(
        path.join(store.dataDir, 'markdown-scan-result.json.gz'),
        gzipSync(Buffer.from(scanJson))
      );
      store.updateSettings({
        'markdown.scan_job': JSON.stringify({
          status: 'done',
          phase: 'done',
          total: 20000,
          done: 20000,
          currentPath: '',
          scan: null,
          error: '',
          input: { vaultPath: '/vault' }
        })
      });
      hydrateMarkdownJobs(store);
      const restored = getMarkdownScanStatus();
      expect(restored.scan?.notes).toHaveLength(20000);
      const gzipSize = readFileSync(
        path.join(store.dataDir, 'markdown-scan-result.json.gz')
      ).length;
      expect(gzipSize).toBeLessThan(Buffer.byteLength(scanJson));
      expect(JSON.stringify(settingsJson(store, 'markdown.scan_job')).length).toBeLessThan(2000);
    } finally {
      store.close();
    }
  });

  it('旧格式兼容（scan 内联）与结果文件损坏容错', () => {
    const store = storeAt('scan-legacy-store');
    try {
      const legacyScan = {
        vaultPath: '/old-vault',
        vaultName: 'old-vault',
        notes: [
          { relativePath: 'a.md', name: 'a.md', sizeBytes: 1, modified: '2026-01-01T00:00:00.000Z' }
        ],
        attachments: []
      };
      store.updateSettings({
        'markdown.scan_job': JSON.stringify({
          status: 'done',
          phase: 'done',
          total: 1,
          done: 1,
          currentPath: '',
          scan: legacyScan,
          error: ''
        })
      });
      hydrateMarkdownJobs(store);
      expect(getMarkdownScanStatus().scan?.notes).toHaveLength(1);
      // 旧格式迁移：settings 变瘦且结果写入 gzip 文件。
      expect(settingsJson(store, 'markdown.scan_job').scan).toBeNull();
      expect(existsSync(path.join(store.dataDir, 'markdown-scan-result.json.gz'))).toBe(true);

      // 旧未压缩 .json 兼容：只有 .json 时 hydrate 自动迁移成 .json.gz 并删除旧文件。
      const legacyJsonFile = path.join(store.dataDir, 'markdown-scan-result.json');
      const gzipFile = path.join(store.dataDir, 'markdown-scan-result.json.gz');
      writeFileSync(legacyJsonFile, JSON.stringify(legacyScan));
      rmSync(gzipFile, { force: true });
      store.updateSettings({
        'markdown.scan_job': JSON.stringify({
          status: 'done',
          phase: 'done',
          total: 1,
          done: 1,
          currentPath: '',
          scan: null,
          error: ''
        })
      });
      hydrateMarkdownJobs(store);
      expect(getMarkdownScanStatus().scan?.notes).toHaveLength(1);
      expect(existsSync(gzipFile)).toBe(true);
      expect(existsSync(legacyJsonFile)).toBe(false);

      // 结果文件损坏：hydrate 后 scan=null 且给出重新扫描提示。
      writeFileSync(gzipFile, '{broken');
      store.updateSettings({
        'markdown.scan_job': JSON.stringify({
          status: 'done',
          phase: 'done',
          total: 1,
          done: 1,
          currentPath: '',
          scan: null,
          error: ''
        })
      });
      hydrateMarkdownJobs(store);
      expect(getMarkdownScanStatus().scan).toBeNull();
      expect(getMarkdownScanStatus().error).toContain('重新扫描');
    } finally {
      store.close();
    }
  });
});

describe('任务参数持久化 + 导入报告瘦身', () => {
  it('import job settings 含 input；report 明细写独立文件，hydrate 恢复完整 report', async () => {
    const dir = path.join(root, 'input-vault');
    mkdirSync(dir, { recursive: true });
    const files: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      writeFile(dir, `i-${index}.md`, `# I${index}`);
      files.push(`i-${index}.md`);
    }
    const store = storeAt('input-store');
    try {
      startMarkdownImport(store, { vaultPath: dir, files });
      const job = await waitImport();
      expect(job.status).toBe('done');
      expect(job.report?.imported).toBe(12);

      const snapshot = settingsJson(store, 'markdown.import_job');
      expect(snapshot.input).toMatchObject({ vaultPath: expect.stringContaining('input-vault') });
      expect((snapshot.input as { files: string[] }).files).toHaveLength(12);
      // settings 里的 report 已裁剪：只保留统计，notes 明细为空（全部成功）。
      const trimmed = snapshot.report as { imported: number; notes: unknown[] };
      expect(trimmed.imported).toBe(12);
      expect(trimmed.notes).toEqual([]);
      expect(JSON.stringify(snapshot).length).toBeLessThan(3000);

      // 完整 report 在独立 gzip 文件里。
      const resultFile = path.join(store.dataDir, 'markdown-import-result.json.gz');
      expect(existsSync(resultFile)).toBe(true);
      expect(readGzJson(resultFile).notes).toHaveLength(12);
      expect(readFileSync(resultFile).length).toBeLessThan(
        Buffer.byteLength(JSON.stringify(job.report))
      );

      hydrateMarkdownJobs(store);
      const restored = getMarkdownImportStatus();
      expect(restored.status).toBe('done');
      expect(restored.report?.imported).toBe(12);
      expect(restored.report?.notes).toHaveLength(12);
      expect(restored.input?.files).toHaveLength(12);
    } finally {
      store.close();
    }
  });

  it('interrupted 保留 input 供重新开始；失败/取消不覆盖旧结果文件', async () => {
    const dir = path.join(root, 'interrupt-vault');
    mkdirSync(dir, { recursive: true });
    writeFile(dir, 'a.md', '# A');
    const store = storeAt('interrupt-store');
    try {
      // 模拟上次运行中的快照（含 input）→ hydrate 后 interrupted。
      store.updateSettings({
        'markdown.import_job': JSON.stringify({
          status: 'running',
          phase: 'importing',
          total: 5,
          done: 2,
          currentPath: 'a.md',
          report: null,
          error: '',
          input: { vaultPath: dir, files: ['a.md'] }
        })
      });
      hydrateMarkdownJobs(store);
      const interrupted = getMarkdownImportStatus();
      expect(interrupted.status).toBe('interrupted');
      expect(interrupted.input).toEqual({ vaultPath: dir, files: ['a.md'] });

      // 旧扫描结果文件（gzip）：失败/取消不覆盖（新扫描成功才覆盖）。
      const resultFile = path.join(store.dataDir, 'markdown-scan-result.json.gz');
      writeFileSync(
        resultFile,
        gzipSync(
          Buffer.from(
            JSON.stringify({ vaultPath: '/old', vaultName: 'old', notes: [], attachments: [] })
          )
        )
      );
      // 残留 tmp 会在新任务启动时清理。
      const leftoverTemp = `${resultFile}.tmp`;
      writeFileSync(leftoverTemp, 'leftover');
      const cancelVault = path.join(root, 'cancel-vault');
      mkdirSync(cancelVault, { recursive: true });
      for (let index = 0; index < 400; index += 1) {
        writeFile(cancelVault, `c-${index}.md`, `# C${index}`);
      }
      startMarkdownScan(store, cancelVault);
      cancelMarkdownScan();
      const cancelledJob = await waitScan();
      expect(cancelledJob.status).toBe('cancelled');
      // 取消不覆盖上一次成功扫描结果文件，且残留 tmp 已清理。
      expect(readGzJson(resultFile).vaultPath).toBe('/old');
      expect(existsSync(leftoverTemp)).toBe(false);
    } finally {
      store.close();
    }
  });
});
