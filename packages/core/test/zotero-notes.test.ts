import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';
import { zoteroNoteText } from '../src/zotero-annotations.js';
import { importZoteroAnnotations } from '../src/zotero.js';

/**
 * Zotero 笔记导入（与批注导入同一个 preview/import 调用）：
 * - 笔记是父条目 children 里 itemType=note 的子条目，data.note 是 HTML；
 * - 批注 annotationComment 必须写入 content（不能只有高亮/下划线标记）；
 * - 全程用 vi.stubGlobal('fetch') 模拟 Zotero 只读 API，不联网。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-zotero-notes-'));
const store = new Store(dataDir);
const secrets = new SecretStore();
let pdfPath = '';

const NOTE_HTML = [
  '<div data-schema-version="9">',
  '<h1>Heading</h1>',
  '<p>First <span>line</span> &amp; second</p>',
  '<p>Entities: &lt;tag&gt; &quot;quoted&quot; &#39;apos&#39;&nbsp;end</p>',
  '<ul><li>bullet one</li><li>bullet two</li></ul>',
  "<script>alert('x')</script>",
  '</div>'
].join('');

const NOTE_TEXT = [
  'Heading',
  'First line & second',
  'Entities: <tag> "quoted" \'apos\' end',
  'bullet one',
  'bullet two'
].join('\n');

beforeAll(async () => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([400, 600]);
  page.drawText('Evidence sentence for Zotero notes and annotations', {
    x: 40,
    y: 540,
    size: 12,
    font
  });
  pdfPath = path.join(dataDir, 'fixture.pdf');
  writeFileSync(pdfPath, await pdf.save());
});

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

interface MockResult {
  status?: number;
  body?: unknown;
}

/** 模拟 Zotero 只读 API：记录请求 URL，按 URL 返回预设 JSON。 */
function mockFetch(handler: (url: string) => MockResult): string[] {
  const urls: string[] = [];
  vi.stubGlobal('fetch', async (input: unknown) => {
    const url = String(input);
    urls.push(url);
    const result = handler(url);
    return new Response(
      result.status === 302 || result.body === undefined ? null : JSON.stringify(result.body),
      {
        status: result.status ?? 200,
        headers: new Headers({ 'content-type': 'application/json' })
      }
    );
  });
  return urls;
}

async function makeZoteroDocument(key: string): Promise<string> {
  const document = await store.importZoteroDocument({
    identity: `local:users:0:${key}:${pdfPath}`,
    title: `zotero notes ${key}`,
    author: '',
    externalPath: pdfPath
  });
  return document.id;
}

function annotationRow(key: string, comment: string): Record<string, unknown> {
  return {
    key,
    data: {
      itemType: 'annotation',
      annotationType: 'highlight',
      annotationText: 'Evidence sentence',
      annotationComment: comment,
      annotationColor: '#ffd400',
      annotationPosition: JSON.stringify({ pageIndex: 0 })
    }
  };
}

describe('Zotero note HTML → 纯文本', () => {
  it('块级标签换行、实体解码、去掉其余标签与多余空白', () => {
    expect(zoteroNoteText(NOTE_HTML)).toBe(NOTE_TEXT);
  });

  it('空正文与只含标签的笔记转出空字符串', () => {
    expect(zoteroNoteText('')).toBe('');
    expect(zoteroNoteText('<p> </p><p>&nbsp;</p>')).toBe('');
  });

  it('只解码一次实体，不把 &amp;lt; 变成 <', () => {
    expect(zoteroNoteText('<p>&amp;lt;</p>')).toBe('&lt;');
  });
});

describe('Zotero 批注 + 笔记导入', () => {
  it('批注保留 annotationComment 正文，笔记写为 page 0 纯文本；预览不写库、导入可去重', async () => {
    const key = 'ATTCH001';
    const documentId = await makeZoteroDocument(key);
    const urls = mockFetch((url) => {
      if (url.includes(`/items/${key}/children`)) {
        return { body: [annotationRow('ANNOT001', '重要批注内容')] };
      }
      if (url.includes(`/items/${key}?format=json`)) {
        return { body: { data: { itemType: 'attachment', parentItem: 'PARENT01' } } };
      }
      if (url.includes('/items/PARENT01/children')) {
        return {
          body: [
            { key: 'ATTACHED', data: { itemType: 'attachment', contentType: 'application/pdf' } },
            { key: 'NOTE0001', data: { itemType: 'note', note: NOTE_HTML } },
            { key: 'NOTE0002', data: { itemType: 'note', note: '<p>&nbsp;</p>' } },
            { key: 'NOTE0003', data: { itemType: 'note', deleted: 1, note: '<p>已删除</p>' } },
            // 同一 key 返回两次：笔记也要去重，不能写两条。
            { key: 'NOTE0001', data: { itemType: 'note', note: NOTE_HTML } }
          ]
        };
      }
      return { body: [] };
    });

    const preview = await importZoteroAnnotations(
      store,
      secrets,
      documentId,
      false,
      'http://local.example/api'
    );
    expect(preview.mode).toBe('preview');
    // 批注：1 条可导入，预览不写库。
    expect(preview.total).toBe(1);
    expect(preview.wouldImport).toBe(1);
    expect(preview.imported).toBe(0);
    expect(preview.items).toHaveLength(1);
    expect(preview.items[0]!.kind).toBe('annotation');
    // 笔记：NOTE0001 有效、NOTE0002 空正文、NOTE0003 已删除、重复 NOTE0001 只算一次。
    expect(preview.noteTotal).toBe(2);
    expect(preview.notesWouldImport).toBe(1);
    expect(preview.notesImported).toBe(0);
    expect(preview.notesSkippedEmpty).toBe(1);
    expect(preview.noteItems).toHaveLength(2);
    expect(preview.noteItems[0]!.content).toContain('First line & second');
    expect(preview.noteItems[0]!.contentLength).toBe(NOTE_TEXT.length);
    expect(preview.noteItems[1]!.action).toBe('skip');
    expect(preview.noteItems[1]!.reason).toContain('正文为空');
    expect(store.listAnnotations(documentId)).toHaveLength(0);
    expect(store.listNotes(documentId)).toHaveLength(0);
    expect(urls.some((url) => url.includes('/items/PARENT01/children'))).toBe(true);

    const imported = await importZoteroAnnotations(
      store,
      secrets,
      documentId,
      true,
      'http://local.example/api'
    );
    expect(imported.imported).toBe(1);
    expect(imported.located + imported.pageLevel).toBe(1);
    expect(imported.notesImported).toBe(1);
    expect(imported.notesWouldImport).toBe(0);
    expect(imported.message).toContain('1 条批注');
    expect(imported.message).toContain('1 条笔记');

    const annotations = store.listAnnotations(documentId);
    expect(annotations).toHaveLength(1);
    // 批注必须同时带原文与批注内容：不能只有高亮/下划线标记。
    expect(annotations[0]!.quote).toContain('Evidence sentence');
    expect(annotations[0]!.content).toBe('重要批注内容');

    const notes = store.listNotes(documentId);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.page).toBe(0);
    expect(notes[0]!.quote).toBe('');
    expect(notes[0]!.content).toBe(NOTE_TEXT);

    const again = await importZoteroAnnotations(
      store,
      secrets,
      documentId,
      true,
      'http://local.example/api'
    );
    expect(again.imported).toBe(0);
    expect(again.skippedExisting).toBe(1);
    expect(again.notesImported).toBe(0);
    expect(again.notesSkippedExisting).toBe(1);
    expect(again.message).toContain('已存在');
    expect(store.listAnnotations(documentId)).toHaveLength(1);
    expect(store.listNotes(documentId)).toHaveLength(1);
  });

  it('父条目读取失败时只降级笔记，批注照常导入', async () => {
    const key = 'ATTCH002';
    const documentId = await makeZoteroDocument(key);
    mockFetch((url) => {
      if (url.includes(`/items/${key}/children`)) {
        return { body: [annotationRow('ANNOT002', '父条目失败也要保留批注')] };
      }
      if (url.includes(`/items/${key}?format=json`)) {
        // 附件条目的 parentItem 解析失败（HTTP 500）。
        return { status: 500, body: [] };
      }
      return { body: [] };
    });

    const preview = await importZoteroAnnotations(
      store,
      secrets,
      documentId,
      false,
      'http://local.example/api'
    );
    expect(preview.wouldImport).toBe(1);
    expect(preview.noteTotal).toBe(0);
    expect(preview.notesWouldImport).toBe(0);
    expect(preview.noteItems).toEqual([]);
    expect(preview.warnings.join('\n')).toContain('笔记');

    const imported = await importZoteroAnnotations(
      store,
      secrets,
      documentId,
      true,
      'http://local.example/api'
    );
    expect(imported.imported).toBe(1);
    expect(imported.notesImported).toBe(0);
    expect(store.listAnnotations(documentId)).toHaveLength(1);
    expect(store.listNotes(documentId)).toHaveLength(0);
  });

  it('父条目的笔记列表读取失败时，批注仍导入并给出 warning', async () => {
    const key = 'ATTCH003';
    const documentId = await makeZoteroDocument(key);
    mockFetch((url) => {
      if (url.includes(`/items/${key}/children`)) {
        return { body: [annotationRow('ANNOT003', '笔记列表失败不影响批注')] };
      }
      if (url.includes(`/items/${key}?format=json`)) {
        return { body: { data: { itemType: 'attachment', parentItem: 'PARENT03' } } };
      }
      if (url.includes('/items/PARENT03/children')) {
        return { status: 500, body: [] };
      }
      return { body: [] };
    });

    const preview = await importZoteroAnnotations(
      store,
      secrets,
      documentId,
      false,
      'http://local.example/api'
    );
    expect(preview.wouldImport).toBe(1);
    expect(preview.noteTotal).toBe(0);
    expect(preview.warnings.join('\n')).toContain('HTTP 500');
  });
});

describe('notes 表 external_key 迁移（schema_version 6 → 7）', () => {
  it('给老库补列、幂等重开，并支持 createNote(externalKey) + noteExternalKeys', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'studianda-notes-migration-'));
    try {
      // 模拟 schema_version 6 的老库：notes 表没有 external_key。
      const legacy = new DatabaseSync(path.join(dir, 'reader.sqlite3'));
      legacy.exec(`
        CREATE TABLE notes(
          id TEXT PRIMARY KEY,
          document_id TEXT,
          page INTEGER,
          quote TEXT,
          content TEXT,
          created TEXT DEFAULT CURRENT_TIMESTAMP,
          deleted INTEGER DEFAULT 0
        );
      `);
      legacy
        .prepare(
          'INSERT INTO notes(id, document_id, page, quote, content, created) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run('old-note', 'old-doc', 0, '', '迁移前的旧笔记', '2026-01-01T00:00:00Z');
      legacy.close();

      const migrated = new Store(dir);
      const document = await migrated.importDocument(pdfPath);
      const note = migrated.createNote({
        documentId: document.id,
        page: 0,
        content: '来自 Zotero 的笔记',
        externalKey: 'NOTE0001'
      });
      expect(note.page).toBe(0);
      expect(note.content).toBe('来自 Zotero 的笔记');
      expect([...migrated.noteExternalKeys(document.id)]).toEqual(['NOTE0001']);
      // 老行 external_key 为空，不会被当成某条外部笔记的“已存在”。
      expect([...migrated.noteExternalKeys('old-doc')]).toEqual([]);
      expect(migrated.listNotes('old-doc')).toHaveLength(1);
      migrated.close();

      // 幂等：再打开一次不抛错，列与数据都还在。
      const reopened = new Store(dir);
      expect([...reopened.noteExternalKeys(document.id)]).toEqual(['NOTE0001']);
      reopened.close();

      const raw = new DatabaseSync(path.join(dir, 'reader.sqlite3'));
      const version = raw
        .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
        .get() as { value: string };
      // 迁移链继续前进到最新版（9 → 10 增加笔记图片资源引用表）。
      expect(version.value).toBe('19');
      const columns = (
        raw.prepare('PRAGMA table_info(notes)').all() as unknown as Array<{ name: string }>
      ).map((column) => column.name);
      expect(columns).toContain('external_key');
      const oldRow = raw.prepare("SELECT content FROM notes WHERE id = 'old-note'").get() as {
        content: string;
      };
      expect(oldRow.content).toBe('迁移前的旧笔记');
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
