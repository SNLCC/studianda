import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PDFDocument } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { saveModelServices } from '../src/model-services.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';
import { translatePage } from '../src/translation-service.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-segment-unique-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
let documentId = '';

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function configureTranslationModel(): void {
  saveModelServices(store, {
    connections: [
      {
        id: 'unique-conn',
        name: '测试平台',
        platform: 'custom',
        baseUrl: 'https://translate.example.com/v1',
        models: [
          {
            id: 'translate-model',
            name: 'translate-model',
            capabilities: ['translation'],
            source: 'user',
            enabled: true
          }
        ]
      }
    ],
    routing: {
      translation: { connectionId: 'unique-conn', model: 'translate-model' }
    }
  });
  secrets.set('platform.unique-conn.api_key', 'k-1');
}

function mockChat(handler: (userContent: string) => string): void {
  vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
    const user = messages.find((message) => message.role === 'user')?.content ?? '';
    return new Response(
      JSON.stringify({ choices: [{ message: { content: handler(user) } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  });
}

beforeAll(async () => {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]);
  const file = path.join(dataDir, 'segments.pdf');
  writeFileSync(file, await pdf.save());
  const imported = await store.importDocument(file);
  documentId = imported.id;
  store.savePageTextEdit(documentId, 1, '第一段内容。\n第二段内容。');
}, 120_000);

describe('translation_segments 唯一性', () => {
  it('强制重译整页两次不会累积重复段落，且段 id 稳定', async () => {
    configureTranslationModel();
    mockChat((user) => (user.includes('第一段内容') ? '第一段译文。' : '第二段译文。'));

    const first = await translatePage(store, secrets, documentId, 1, {
      language: 'zh',
      force: true
    });
    const second = await translatePage(store, secrets, documentId, 1, {
      language: 'zh',
      force: true
    });

    expect(first.segments).toHaveLength(2);
    expect(second.segments).toHaveLength(2);
    expect(store.getTranslationSegments(documentId, 1)).toHaveLength(2);
    expect(second.page?.total).toBe(2);
    expect(second.page?.done).toBe(2);

    for (const segment of second.segments) {
      const previous = first.segments.find((item) => item.segment === segment.segment);
      expect(previous?.id).toBeTruthy();
      expect(segment.id).toBe(previous!.id);
    }
  });

  it('同一页同一段用新 id 再保存会更新原行，而不是新增重复行', () => {
    const stored = store.getTranslationSegments(documentId, 1);
    expect(stored).toHaveLength(2);
    const original = stored[0]!;

    store.saveTranslationSegments([
      {
        ...original,
        id: 'another-id',
        text: '替换后的译文。',
        edited: true,
        origin: 'user'
      }
    ]);

    const after = store.getTranslationSegments(documentId, 1);
    expect(after).toHaveLength(2);
    const row = after.find((segment) => segment.segment === original.segment)!;
    expect(row.id).toBe(original.id);
    expect(row.text).toBe('替换后的译文。');
  });

  it('机器译文覆盖人工改稿时保留人工版本用于恢复', async () => {
    configureTranslationModel();
    const before = store.getTranslationSegments(documentId, 1);
    const target = before[0]!;
    store.saveTranslationSegments([
      { ...target, text: '人工改过的译文。', edited: true, origin: 'user' }
    ]);

    mockChat(() => '机器新译文。');
    const page = await translatePage(store, secrets, documentId, 1, {
      language: 'zh',
      force: true
    });

    expect(page.segments).toHaveLength(2);
    const stored = store.getTranslationSegments(documentId, 1);
    expect(stored).toHaveLength(2);
    const row = stored.find((segment) => segment.segment === target.segment)!;
    expect(row.id).toBe(target.id);
    expect(row.text).toBe('机器新译文。');
    expect(row.edited).toBe(false);
    expect(row.origin).toBe('machine');
    expect(row.previousText).toBe('人工改过的译文。');
    expect(row.previousOrigin).toBe('user');
  });
});

describe('历史重复行迁移', () => {
  it('打开旧库时按"人工改稿优先"去重，再建唯一索引', () => {
    const legacyDir = mkdtempSync(path.join(tmpdir(), 'studianda-legacy-dupe-'));
    const legacyStore = new Store(legacyDir);
    legacyStore.close();
    const dbPath = path.join(legacyDir, 'reader.sqlite3');
    const raw = new DatabaseSync(dbPath);
    raw.exec('DROP INDEX IF EXISTS translation_segments_doc_page_segment');
    const insert = raw.prepare(
      `INSERT INTO translation_segments(
         id, document_id, page, segment, source, source_hash, text, engine, service,
         terms, unknown_terms, coverage, edited, origin, previous_text, previous_origin,
         created, updated
       ) VALUES (?, 'doc-1', 1, 0, 'source', 'h', ?, 'remote', 'm', '[]', '[]', 0, ?,
                 ?, '', '', ?, ?)`
    );
    insert.run(
      'old-machine',
      '旧机器译文',
      0,
      'machine',
      '2026-11-01T00:00:00Z',
      '2026-11-01T00:00:00Z'
    );
    insert.run(
      'new-user',
      '人工改稿',
      1,
      'user',
      '2026-11-02T00:00:00Z',
      '2026-11-02T00:00:00Z'
    );
    raw.close();

    const reopened = new Store(legacyDir);
    try {
      const rows = reopened.getTranslationSegments('doc-1', 1);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.text).toBe('人工改稿');
      expect(rows[0]!.origin).toBe('user');
    } finally {
      reopened.close();
      rmSync(legacyDir, { recursive: true, force: true });
    }
  });
});
