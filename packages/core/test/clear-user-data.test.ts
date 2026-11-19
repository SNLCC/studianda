import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ClearUserDataResult } from '@studianda/shared';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';

// 「文件被占用」在 CI（Windows）上不稳定复现：仅对 `flows/` 下的删除操作注入 EBUSY/EPERM，
// 其余路径照常走真实 fs，用来验证残留路径被记录而不是让整次清空抛错。
const fsMock = vi.hoisted(() => ({ failFlowsDelete: false }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const isFlowsPath = (target: unknown): boolean =>
    fsMock.failFlowsDelete && /(^|[\\/])flows([\\/]|$)/.test(String(target));
  return {
    ...actual,
    rmSync: ((target: Parameters<typeof actual.rmSync>[0], options?: Parameters<typeof actual.rmSync>[1]) => {
      if (isFlowsPath(target)) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
      return actual.rmSync(target, options);
    }) as typeof actual.rmSync,
    unlinkSync: ((target: Parameters<typeof actual.unlinkSync>[0]) => {
      if (isFlowsPath(target)) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
      return actual.unlinkSync(target);
    }) as typeof actual.unlinkSync
  };
});

/**
 * 清空全部本地用户数据（合规整改 P1-6）。
 *
 * 关键验收：
 * - 必须显式 `confirm: true`，否则 400 且一条数据都不删；
 * - 文献及其派生数据、消息/会话、译文、笔记附件（记录+文件）、PDF 副本、备份、诊断包、
 *   检索缓存全部清空，返回 shared 的 ClearUserDataResult；
 * - settings 与 secrets（模型配置/密钥）保留；
 * - Windows 下打开的 DB 文件不直接删（只删行），文件删除失败也不让整单失败。
 */
const token = 'clear-user-data-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-clear-user-data-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
const server = buildServer({ token, version: 'test-version', store, secrets });

// 1x1 透明 PNG：saveNoteAsset 会完整解码校验，用真实图片字节而不是任意 base64。
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const settingsMarker = { key: '模型测试标记', value: 'clear-user-data-keep' };
const secretValue = 'demo-platform-secret';

let documentId = '';
let papersFile = '';
let noteAssetFile = '';

function headers(): Record<string, string> {
  return { 'x-studianda-token': token };
}

beforeAll(async () => {
  // 原 PDF（在数据目录根；导入后副本进 papers/）。
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 300]);
  const source = path.join(dataDir, 'source.pdf');
  writeFileSync(source, await pdf.save());
  const document = await store.importDocument(source);
  documentId = document.id;
  const paperPath = store.getDocumentPath(documentId);
  expect(paperPath).toBeTruthy();
  papersFile = paperPath!;
  expect(papersFile.startsWith(path.join(dataDir, 'papers'))).toBe(true);
  expect(existsSync(papersFile)).toBe(true);

  // 文献派生数据。
  store.createAnnotation({ documentId, page: 1, quote: '原文', content: '批注内容' });
  store.createNote({ documentId, page: 1, quote: '原文', content: '笔记内容' });
  store.addMessage({ documentId, role: 'user', content: '阅读问题' });
  store.createDocumentChatSession(documentId, {
    id: 'sess-1',
    title: '阅读会话',
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z'
  });
  store.saveTranslationSegments([
    {
      id: 'seg-1',
      documentId,
      page: 1,
      segment: 0,
      source: 'Source sentence.',
      sourceHash: 'hash-1',
      text: '译文一。',
      engine: 'test',
      service: 'test',
      terms: '[]',
      unknownTerms: '[]',
      coverage: 0,
      edited: false,
      origin: 'machine',
      previousText: '',
      previousOrigin: ''
    },
    {
      id: 'seg-2',
      documentId,
      page: 1,
      segment: 1,
      source: 'Another sentence.',
      sourceHash: 'hash-2',
      text: '译文二。',
      engine: 'test',
      service: 'test',
      terms: '[]',
      unknownTerms: '[]',
      coverage: 0,
      edited: false,
      origin: 'machine',
      previousText: '',
      previousOrigin: ''
    }
  ]);
  // 笔记附件：记录 + 文件。
  const asset = await store.saveNoteAsset({
    dataUrl: `data:image/png;base64,${PNG_BASE64}`,
    filename: '附件.png'
  });
  noteAssetFile = path.join(dataDir, 'note-assets', `${asset.id}.png`);
  expect(existsSync(noteAssetFile)).toBe(true);

  // 备份 / 迁移前快照 / 诊断包 / 检索缓存 / 待恢复标记 / 恢复前快照目录。
  mkdirSync(path.join(dataDir, 'backups'), { recursive: true });
  writeFileSync(path.join(dataDir, 'backups', 'studianda-data-2026-01-01-000000.zip'), 'zip');
  mkdirSync(path.join(dataDir, 'migration-backups'), { recursive: true });
  writeFileSync(
    path.join(dataDir, 'migration-backups', 'reader-before-v17-2026-01-01.sqlite3'),
    'sqlite'
  );
  mkdirSync(path.join(dataDir, 'diagnostics'), { recursive: true });
  writeFileSync(path.join(dataDir, 'diagnostics', 'studianda-diagnostics-a.zip'), 'diag');
  // 用户自定义阅读流程（flows/<id>/flow.json + flow.md）：清空时整目录删除。
  mkdirSync(path.join(dataDir, 'flows', 'my-reading'), { recursive: true });
  writeFileSync(path.join(dataDir, 'flows', 'my-reading', 'flow.md'), '# 我的读法\n');
  writeFileSync(
    path.join(dataDir, 'flows', 'my-reading', 'flow.json'),
    JSON.stringify({
      id: 'my-reading',
      name: '我的读法',
      version: 1,
      updated_at: '2026-11-18T00:00:00Z',
      sha256: '0'.repeat(64)
    })
  );
  mkdirSync(path.join(dataDir, 'cache', 'retrieval-index'), { recursive: true });
  writeFileSync(path.join(dataDir, 'cache', 'retrieval-index', 'digest.json'), '{}');
  // 上传临时文件与 Markdown 扫描/导入结果文件（可能含用户笔记路径/报告）。
  mkdirSync(path.join(dataDir, 'imports'), { recursive: true });
  writeFileSync(path.join(dataDir, 'imports', 'temp.pdf'), 'pdf');
  writeFileSync(path.join(dataDir, 'markdown-scan-result.json.gz'), 'scan');
  writeFileSync(path.join(dataDir, 'markdown-import-result.json'), 'import');
  writeFileSync(path.join(dataDir, 'markdown-scan-result.json.gz.sha256'), 'sha');
  // 运行日志（清空时 best-effort 删除；可能含脱敏错误上下文）。
  writeFileSync(path.join(dataDir, 'application.log'), 'log');
  writeFileSync(path.join(dataDir, 'application.log.1'), 'old log');
  writeFileSync(
    path.join(dataDir, 'restore-pending.json'),
    `${JSON.stringify({ backup: 'studianda-data-2026-01-01-000000.zip' })}\n`
  );
  mkdirSync(path.join(dataDir, '.pre-restore-old'), { recursive: true });
  writeFileSync(path.join(dataDir, '.pre-restore-old', 'reader.sqlite3'), 'old');

  // schema 27：历史 platform_connections 可能残留旧版 API Key 密文（当前代码零读零写，
  // 所以直接写库模拟升级用户库里的旧行）；「清空全部本地数据」必须把这些行也删掉。
  const residue = new DatabaseSync(path.join(dataDir, 'reader.sqlite3'));
  try {
    residue
      .prepare('INSERT INTO platform_connections(id, value) VALUES (?, ?)')
      .run(
        'legacy-conn',
        JSON.stringify({ name: '旧平台', encrypted_key: 'AQAAANCM-should-be-cleared' })
      );
  } finally {
    residue.close();
  }

  // 必须保留的配置与密钥。
  store.updateSettings({
    [settingsMarker.key]: settingsMarker.value,
    // 旧版阅读会话清单 / Markdown 任务快照属于用户内容，清空时一并删除。
    'doc-chat.sessions.doc-1': '[{"id":"s1","title":"会话一"}]',
    'markdown.scan_job': '{"phase":"done","vaultPath":"D:/notes"}'
  });
  secrets.set('platform.demo.api_key', secretValue);
  secrets.set('search.api_key', 'search-secret');
});

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('POST /api/v1/maintenance/clear-user-data', () => {
  it('refuses without explicit confirm and removes nothing', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/maintenance/clear-user-data',
      headers: headers(),
      payload: {}
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.json())).toContain('confirm');
    // 400 不能有副作用：文献/文件都还在。
    expect(store.getDocument(documentId)).not.toBe(null);
    expect(existsSync(papersFile)).toBe(true);
  });

  it('clears user data but keeps settings/secrets', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/maintenance/clear-user-data',
      headers: headers(),
      payload: { confirm: true }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as ClearUserDataResult;
    expect(body.ok).toBe(true);
    expect(body.removed).toEqual({
      documents: 1,
      notes: 1,
      annotations: 1,
      messages: 1,
      sessions: 1,
      translations: 2,
      note_assets: 1,
      backups: 1
    });

    // 数据库里的用户内容全部清空（文档级联 + 文件夹）。
    expect(store.listDocuments()).toHaveLength(0);
    expect(store.listDocuments(true)).toHaveLength(0);
    expect(store.getDocument(documentId)).toBe(null);
    expect(store.getTranslationSegments(documentId, 1)).toHaveLength(0);
    expect(store.listNotes(documentId)).toHaveLength(0);
    expect(store.listAnnotations(documentId)).toHaveLength(0);

    // 附件/PDF 副本/备份/诊断/缓存文件与恢复标记都被清理。
    expect(existsSync(papersFile)).toBe(false);
    expect(existsSync(noteAssetFile)).toBe(false);
    expect(readdirSync(path.join(dataDir, 'note-assets'))).toHaveLength(0);
    expect(readdirSync(path.join(dataDir, 'backups'))).toHaveLength(0);
    expect(readdirSync(path.join(dataDir, 'migration-backups'))).toHaveLength(0);
    expect(readdirSync(path.join(dataDir, 'diagnostics'))).toHaveLength(0);
    expect(existsSync(path.join(dataDir, 'flows'))).toBe(false);
    expect(existsSync(path.join(dataDir, 'flows', 'my-reading', 'flow.md'))).toBe(false);
    expect(existsSync(path.join(dataDir, 'flows', 'my-reading', 'flow.json'))).toBe(false);
    expect(body.failed).toEqual([]);
    expect(existsSync(path.join(dataDir, 'cache'))).toBe(false);
    expect(readdirSync(path.join(dataDir, 'imports'))).toHaveLength(0);
    expect(existsSync(path.join(dataDir, 'markdown-scan-result.json.gz'))).toBe(false);
    expect(existsSync(path.join(dataDir, 'markdown-import-result.json'))).toBe(false);
    expect(existsSync(path.join(dataDir, 'markdown-scan-result.json.gz.sha256'))).toBe(false);
    expect(existsSync(path.join(dataDir, 'application.log'))).toBe(false);
    expect(existsSync(path.join(dataDir, 'application.log.1'))).toBe(false);
    expect(existsSync(path.join(dataDir, 'restore-pending.json'))).toBe(false);
    expect(existsSync(path.join(dataDir, '.pre-restore-old'))).toBe(false);

    // 保留：settings 与 secrets（模型配置与密钥不删）；用户内容的旧 settings 条目清掉。
    const settings = store.getSettings();
    expect(settings[settingsMarker.key]).toBe(settingsMarker.value);
    expect(settings['doc-chat.sessions.doc-1']).toBeUndefined();
    expect(settings['markdown.scan_job']).toBeUndefined();
    expect(secrets.get('platform.demo.api_key')).toBe(secretValue);
    expect(secrets.get('search.api_key')).toBe('search-secret');

    // 历史 platform_connections 的残留行同样被清掉（表保留、0 行）。
    const cleared = new DatabaseSync(path.join(dataDir, 'reader.sqlite3'), { readOnly: true });
    try {
      const row = cleared
        .prepare('SELECT COUNT(*) AS n FROM platform_connections')
        .get() as { n?: number } | undefined;
      expect(Number(row?.n ?? 0)).toBe(0);
    } finally {
      cleared.close();
    }

    // 数据库文件本身没有被删（Windows 上打开的文件删不掉），清空后仍可正常读写。
    expect(existsSync(path.join(dataDir, 'reader.sqlite3'))).toBe(true);
    expect(store.createFolder('清空后新建')).toMatchObject({ name: '清空后新建' });
  });
});

describe('flows 文件被占用时', () => {
  it('把删不掉的 flows 文件路径记进 failed，而不是让清空抛错', () => {
    const lockedDataDir = mkdtempSync(path.join(tmpdir(), 'studianda-clear-user-data-locked-'));
    const lockedStore = new Store(lockedDataDir);
    try {
      mkdirSync(path.join(lockedDataDir, 'flows', 'my-reading'), { recursive: true });
      writeFileSync(path.join(lockedDataDir, 'flows', 'my-reading', 'flow.md'), '# 被占用');
      writeFileSync(path.join(lockedDataDir, 'flows', 'my-reading', 'flow.json'), '{}');
      fsMock.failFlowsDelete = true;
      const result = lockedStore.clearUserData();
      expect(result.ok).toBe(true);
      expect(result.failed).toEqual(
        expect.arrayContaining(['flows/my-reading/flow.md', 'flows/my-reading/flow.json'])
      );
      // 模拟占用中：文件仍在，界面按 failed 列出的路径提示用户关闭占用程序后手动删除。
      expect(existsSync(path.join(lockedDataDir, 'flows', 'my-reading', 'flow.md'))).toBe(true);
    } finally {
      fsMock.failFlowsDelete = false;
      lockedStore.close();
      rmSync(lockedDataDir, { recursive: true, force: true });
    }
  });
});
