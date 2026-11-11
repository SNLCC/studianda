import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  MarkdownImportReportPage,
  MarkdownScanSearchResult,
  MarkdownScanTreePage,
  MarkdownSelectionResult
} from '@studianda/shared';
import {
  getMarkdownScanStatus,
  startMarkdownImport,
  startMarkdownScan
} from '../src/markdown-import.js';
import { resetJsonGzipStats, getJsonGzipStats } from '../src/json-gzip.js';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'studianda-phase23-'));
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

function makeVault(name: string): string {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFile(dir, 'a.md', '# A');
  writeFile(dir, 'b.md', '# B');
  writeFile(dir, 'pic.png', Buffer.from('png-bytes'));
  writeFile(dir, 'doc.pdf', Buffer.from('%PDF-1.4'));
  writeFile(dir, 'sub/c.md', '# C');
  writeFile(dir, 'sub/d.markdown', '# D');
  writeFile(dir, 'sub/deep/e.md', '# E');
  writeFile(dir, 'sub/deep/pic2.png', Buffer.from('png2'));
  writeFile(dir, 'other/f.md', '# F');
  return dir;
}

describe('扫描树 / 选择解析 / 报告分页', () => {
  const dataDir = path.join(root, 'store');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(dataDir);
  const server = buildServer({ token, version: 'test-version', store, secrets: new SecretStore() });
  const headers = (): Record<string, string> => ({ 'x-studianda-token': token });
  const vault = makeVault('vault');

  async function waitScanDone(timeoutMs = 8000): Promise<void> {
    const started = Date.now();
    for (;;) {
      const status = getMarkdownScanStatus();
      if (status.status === 'done') return;
      if (status.status === 'error' || Date.now() - started > timeoutMs) {
        throw new Error(`scan did not finish: ${status.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  beforeAll(async () => {
    // tree/selection/search 只使用最近完成的扫描结果，不做同步懒扫描。
    startMarkdownScan(store, vault);
    await waitScanDone();
  }, 20000);

  afterAll(async () => {
    await server.close();
    store.close();
  });

  it('GET /markdown/scan/tree：根/子目录直接子项、childCount/noteCount、分页与非法父路径', async () => {
    const rootPage = await server.inject({
      method: 'GET',
      url: `/api/v1/markdown/scan/tree?vaultPath=${encodeURIComponent(vault)}&parent=&offset=0&limit=100`,
      headers: headers()
    });
    expect(rootPage.statusCode).toBe(200);
    const rootTree = rootPage.json() as MarkdownScanTreePage;
    expect(rootTree.parent).toBe('');
    const rootNames = rootTree.entries.map((entry) => entry.name);
    // 文件夹在前，按名称排序；随后文件按名称排序。
    expect(rootNames.slice(0, 2)).toEqual(['other', 'sub']);
    expect(rootNames.slice(2)).toEqual(['a.md', 'b.md', 'doc.pdf', 'pic.png']);
    const subEntry = rootTree.entries.find((entry) => entry.path === 'sub')!;
    expect(subEntry.kind).toBe('folder');
    expect(subEntry.childCount).toBe(3); // c.md, d.markdown, deep
    expect(subEntry.noteCount).toBe(3); // c,d,e
    expect(subEntry.sizeBytes).toBeUndefined();

    // 子目录分页：limit=2 offset=1。
    const subPage = await server.inject({
      method: 'GET',
      url: `/api/v1/markdown/scan/tree?vaultPath=${encodeURIComponent(vault)}&parent=sub&offset=1&limit=2`,
      headers: headers()
    });
    expect(subPage.statusCode).toBe(200);
    const subTree = subPage.json() as MarkdownScanTreePage;
    expect(subTree.parent).toBe('sub');
    expect(subTree.total).toBe(3); // deep / c.md / d.markdown
    const allSubFirstPage = await server.inject({
      method: 'GET',
      url: `/api/v1/markdown/scan/tree?vaultPath=${encodeURIComponent(vault)}&parent=sub&offset=0&limit=10`,
      headers: headers()
    });
    const subAll = allSubFirstPage.json() as MarkdownScanTreePage;
    expect(subAll.entries.map((entry) => entry.name)).toEqual(['deep', 'c.md', 'd.markdown']);
    const deepEntry = subAll.entries.find((entry) => entry.path === 'sub/deep')!;
    expect(deepEntry.kind).toBe('folder');
    expect(deepEntry.childCount).toBe(2); // e.md + pic2.png
    expect(deepEntry.noteCount).toBe(1);

    // 非法父路径 → 400。
    const traversal = await server.inject({
      method: 'GET',
      url: `/api/v1/markdown/scan/tree?vaultPath=${encodeURIComponent(vault)}&parent=${encodeURIComponent('../x')}`,
      headers: headers()
    });
    expect(traversal.statusCode).toBe(400);
    const missing = await server.inject({
      method: 'GET',
      url: `/api/v1/markdown/scan/tree?vaultPath=${encodeURIComponent(vault)}&parent=no-such`,
      headers: headers()
    });
    expect(missing.statusCode).toBe(400);
    const badLimit = await server.inject({
      method: 'GET',
      url: `/api/v1/markdown/scan/tree?vaultPath=${encodeURIComponent(vault)}&parent=&limit=0`,
      headers: headers()
    });
    expect(badLimit.statusCode).toBe(400);
  });

  it('POST /markdown/selection/resolve：all/文件夹/文件/排除/去重', async () => {    const all = await server.inject({
      method: 'POST',
      url: '/api/v1/markdown/selection/resolve',
      headers: headers(),
      payload: { vaultPath: vault, all: true }
    });
    expect(all.statusCode).toBe(200);
    const allResult = all.json() as MarkdownSelectionResult;
    expect(allResult.count).toBe(6);
    expect(allResult.files).toEqual(
      expect.arrayContaining(['a.md', 'b.md', 'sub/c.md', 'sub/d.markdown', 'sub/deep/e.md', 'other/f.md'])
    );

    const mixed = await server.inject({
      method: 'POST',
      url: '/api/v1/markdown/selection/resolve',
      headers: headers(),
      payload: {
        vaultPath: vault,
        folders: ['sub'],
        files: ['a.md', 'a.md', 'pic.png'],
        excludedFolders: ['sub/deep'],
        excludedFiles: ['b.md']
      }
    });
    expect(mixed.statusCode).toBe(200);
    const mixedResult = mixed.json() as MarkdownSelectionResult;
    // sub 下 c,d,e；排除 deep 后剩 c,d；加 a.md；pic.png 非 Markdown 忽略；重复去重。
    expect(mixedResult.files).toEqual(['a.md', 'sub/c.md', 'sub/d.markdown']);
    expect(mixedResult.count).toBe(3);

    const excludedAll = await server.inject({
      method: 'POST',
      url: '/api/v1/markdown/selection/resolve',
      headers: headers(),
      payload: { vaultPath: vault, all: true, excludedFiles: ['a.md'], excludedFolders: ['sub'] }
    });
    const excludedResult = excludedAll.json() as MarkdownSelectionResult;
    expect(excludedResult.files).toEqual(['b.md', 'other/f.md']);

    const missing = await server.inject({
      method: 'POST',
      url: '/api/v1/markdown/selection/resolve',
      headers: headers(),
      payload: {
        vaultPath: vault,
        files: ['missing.md', 'a.md'],
        folders: ['no-such-folder', 'sub']
      }
    });
    expect(missing.statusCode).toBe(200);
    const missingResult = missing.json() as MarkdownSelectionResult;
    expect(missingResult.files).toEqual([
      'a.md',
      'sub/c.md',
      'sub/d.markdown',
      'sub/deep/e.md'
    ]);
    expect([...missingResult.missingFiles!].sort()).toEqual(['missing.md', 'no-such-folder']);

    const traversal = await server.inject({
      method: 'POST',
      url: '/api/v1/markdown/selection/resolve',
      headers: headers(),
      payload: { vaultPath: vault, all: true, folders: ['../x'] }
    });
    expect(traversal.statusCode).toBe(400);
    const badArrays = await server.inject({
      method: 'POST',
      url: '/api/v1/markdown/selection/resolve',
      headers: headers(),
      payload: { vaultPath: vault, files: 'a.md' }
    });
    expect(badArrays.statusCode).toBe(400);
  });

  it('GET /markdown/scan/search：大小写不敏感路径/文件名匹配、limit；未扫描 409', async () => {
    const byName = await server.inject({
      method: 'GET',
      url: `/api/v1/markdown/scan/search?vaultPath=${encodeURIComponent(vault)}&q=C&limit=50`,
      headers: headers()
    });
    expect(byName.statusCode).toBe(200);
    const nameResult = byName.json() as MarkdownScanSearchResult;
    expect(nameResult.entries.map((entry) => entry.path)).toContain('sub/c.md');

    const byPath = await server.inject({
      method: 'GET',
      url: `/api/v1/markdown/scan/search?vaultPath=${encodeURIComponent(vault)}&q=${encodeURIComponent('SUB/')}&limit=50`,
      headers: headers()
    });
    const pathResult = byPath.json() as MarkdownScanSearchResult;
    expect(pathResult.total).toBe(3);
    expect(pathResult.entries.map((entry) => entry.path)).toEqual([
      'sub/c.md',
      'sub/d.markdown',
      'sub/deep/e.md'
    ]);

    const limited = await server.inject({
      method: 'GET',
      url: `/api/v1/markdown/scan/search?vaultPath=${encodeURIComponent(vault)}&q=md&limit=2`,
      headers: headers()
    });
    const limitedResult = limited.json() as MarkdownScanSearchResult;
    expect(limitedResult.total).toBeGreaterThan(2);
    expect(limitedResult.entries).toHaveLength(2);
    expect(limitedResult.offset).toBe(0);
    expect(limitedResult.limit).toBe(2);
    expect(limitedResult.entries[0]?.kind).toBe('file');

    // 搜索分页：offset 生效且 total 保持完整。
    const secondPage = await server.inject({
      method: 'GET',
      url: `/api/v1/markdown/scan/search?vaultPath=${encodeURIComponent(vault)}&q=md&limit=2&offset=2`,
      headers: headers()
    });
    const secondPageResult = secondPage.json() as MarkdownScanSearchResult;
    expect(secondPageResult.total).toBe(limitedResult.total);
    expect(secondPageResult.offset).toBe(2);
    expect(secondPageResult.limit).toBe(2);
    expect(secondPageResult.entries).toHaveLength(Math.min(2, limitedResult.total - 2));
    expect(secondPageResult.entries[0]?.path).not.toBe(limitedResult.entries[0]?.path);

    const badOffset = await server.inject({
      method: 'GET',
      url: `/api/v1/markdown/scan/search?vaultPath=${encodeURIComponent(vault)}&q=md&offset=-1`,
      headers: headers()
    });
    expect(badOffset.statusCode).toBe(400);

    const badLimit = await server.inject({
      method: 'GET',
      url: `/api/v1/markdown/scan/search?vaultPath=${encodeURIComponent(vault)}&q=a&limit=500`,
      headers: headers()
    });
    expect(badLimit.statusCode).toBe(400);

    // 未完成扫描的另一个库：tree/selection/search 均 409。
    const unscanned = makeVault('vault-unscanned');
    const tree409 = await server.inject({
      method: 'GET',
      url: `/api/v1/markdown/scan/tree?vaultPath=${encodeURIComponent(unscanned)}&parent=`,
      headers: headers()
    });
    expect(tree409.statusCode).toBe(409);
    expect((tree409.json() as { message: string }).message).toContain('扫描结果不可用');
    const search409 = await server.inject({
      method: 'GET',
      url: `/api/v1/markdown/scan/search?vaultPath=${encodeURIComponent(unscanned)}&q=a`,
      headers: headers()
    });
    expect(search409.statusCode).toBe(409);
    const selection409 = await server.inject({
      method: 'POST',
      url: '/api/v1/markdown/selection/resolve',
      headers: headers(),
      payload: { vaultPath: unscanned, all: true }
    });
    expect(selection409.statusCode).toBe(409);
  });

  it('GET /markdown/import/report：无报告 404；有报告分页', async () => {
    const none = await server.inject({
      method: 'GET',
      url: '/api/v1/markdown/import/report?offset=0&limit=10',
      headers: headers()
    });
    expect(none.statusCode).toBe(404);
    expect(none.json()).toEqual({
      error: 'result_missing',
      message: '导入报告缺失，请重新导入'
    });

    // 触发一次导入（3 篇）生成报告。
    startMarkdownImport(store, {
      vaultPath: vault,
      files: ['a.md', 'sub/c.md', 'other/f.md']
    });
    // 轮询报告接口直到可用。
    let available: MarkdownImportReportPage | null = null;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const response = await server.inject({
        method: 'GET',
        url: '/api/v1/markdown/import/report?offset=0&limit=2',
        headers: headers()
      });
      if (response.statusCode === 200) {
        available = response.json() as MarkdownImportReportPage;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(available).not.toBeNull();
    expect(available!.total).toBe(3);
    expect(available!.offset).toBe(0);
    expect(available!.limit).toBe(2);
    expect(available!.items).toHaveLength(2);

    const second = await server.inject({
      method: 'GET',
      url: '/api/v1/markdown/import/report?offset=2&limit=2',
      headers: headers()
    });
    expect(second.statusCode).toBe(200);
    const secondPage = second.json() as MarkdownImportReportPage;
    expect(secondPage.items).toHaveLength(1);

    const badLimit = await server.inject({
      method: 'GET',
      url: '/api/v1/markdown/import/report?offset=0&limit=0',
      headers: headers()
    });
    expect(badLimit.statusCode).toBe(400);
  });

  it('/markdown/jobs?summary=1 返回 lite 摘要（无完整 scan/report/input）', async () => {
    const full = await server.inject({
      method: 'GET',
      url: '/api/v1/markdown/jobs',
      headers: headers()
    });
    expect(full.statusCode).toBe(200);
    const summary = await server.inject({
      method: 'GET',
      url: '/api/v1/markdown/jobs?summary=1',
      headers: headers()
    });
    expect(summary.statusCode).toBe(200);
    const snapshot = summary.json() as {
      scanJob: Record<string, unknown>;
      importJob: Record<string, unknown>;
      lite?: boolean;
      terminal?: boolean;
    };
    expect(snapshot.lite).toBe(true);
    expect(snapshot.scanJob.scan).toBeNull();
    expect(snapshot.scanJob.input).toBeNull();
    expect(snapshot.importJob.report).toBeNull();
    expect(snapshot.importJob.input).toBeNull();
    // 保留进度/状态/result 字段。
    for (const field of ['status', 'phase', 'total', 'done', 'currentPath', 'error', 'resultMissing', 'resultStale', 'resultCompletedAt']) {
      expect(snapshot.scanJob).toHaveProperty(field);
      expect(snapshot.importJob).toHaveProperty(field);
    }
    // 摘要是 lite，比完整响应小很多。
    expect(JSON.stringify(snapshot).length).toBeLessThan(JSON.stringify(full.json()).length);
    expect(JSON.stringify(snapshot).length).toBeLessThan(3000);

    // 摘要同样支持 gzip（小 payload 走完整 buffer，带 content-length）。
    const gzipSummary = await server.inject({
      method: 'GET',
      url: '/api/v1/markdown/jobs?summary=1',
      headers: { ...headers(), 'accept-encoding': 'gzip' }
    });
    expect(gzipSummary.headers['content-encoding']).toBe('gzip');
    expect(Number(gzipSummary.headers['content-length'])).toBeGreaterThan(0);
  });

  it('/markdown/jobs 大 payload gzip 走 worker（worker 统计增加）', async () => {
    resetJsonGzipStats();
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/markdown/jobs',
      headers: { 'x-studianda-token': token, 'accept-encoding': 'gzip' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBe('gzip');
    expect(Number(response.headers['content-length'])).toBeGreaterThan(0);
    expect(getJsonGzipStats().worker).toBeGreaterThanOrEqual(1);
  }, 20000);

  it('大 payload（>阈值）gzip 走 worker 流式：chunked、无 content-length、可解压', async () => {
    const bigVault = path.join(root, 'vault-big');
    mkdirSync(bigVault, { recursive: true });
    for (let index = 0; index < 600; index += 1) {
      writeFile(bigVault, `notes/n-${index}.md`, `# note ${index}\n${'x'.repeat(200)}`);
    }
    startMarkdownScan(store, bigVault);
    await waitScanDone();
    resetJsonGzipStats();
    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/markdown/jobs',
      headers: { 'x-studianda-token': token, 'accept-encoding': 'gzip' }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-encoding']).toBe('gzip');
    // 流式：chunked，且不设置 content-length。
    expect(response.headers['content-length']).toBeUndefined();
    expect(String(response.headers['transfer-encoding'] ?? '')).toContain('chunked');
    const decoded = JSON.parse(gunzipSync(response.rawPayload).toString('utf8')) as {
      scanJob: { scan: { notes: unknown[] } };
    };
    expect(decoded.scanJob.scan.notes).toHaveLength(600);
    expect(getJsonGzipStats().worker).toBeGreaterThanOrEqual(1);
  }, 20000);

  it('流式响应中途断连后无 worker/队列泄漏，后续请求仍正常', async () => {
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${new URL(address).port}`;
    const controller = new AbortController();
    try {
      const streamed = await fetch(`${base}/api/v1/markdown/jobs`, {
        headers: { 'x-studianda-token': token, 'accept-encoding': 'gzip' },
        signal: controller.signal
      });
      expect(streamed.status).toBe(200);
      const reader = streamed.body!.getReader();
      // 读取第一块后立刻断开，模拟客户端中途放弃。
      await reader.read();
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 150));

      // 后续完整请求仍成功且可解压（worker 池没有被破坏）。
      const again = await fetch(`${base}/api/v1/markdown/jobs`, {
        headers: { 'x-studianda-token': token, 'accept-encoding': 'gzip' }
      });
      expect(again.status).toBe(200);
      const buffer = Buffer.from(await again.arrayBuffer());
      // Node fetch 会自动解压 gzip，这里兼容「已解压」与「仍为 gzip」两种。
      let text: string;
      try {
        text = gunzipSync(buffer).toString('utf8');
      } catch {
        text = buffer.toString('utf8');
      }
      const decoded = JSON.parse(text) as {
        scanJob: { scan: { notes: unknown[] } };
      };
      expect(decoded.scanJob.scan.notes).toHaveLength(600);

      await new Promise((resolve) => setTimeout(resolve, 100));
      const stats = getJsonGzipStats();
      expect(stats.activeWorkers).toBe(0);
      expect(stats.queued).toBe(0);
    } finally {
      controller.abort();
    }
  }, 20000);
});
