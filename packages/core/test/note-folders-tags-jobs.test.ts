import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import type {
  NoteFolderOperationResult,
  NoteFolderRecord,
  MarkdownScanJob
} from '@studianda/shared';
import {
  cancelMarkdownScan,
  getMarkdownImportStatus,
  getMarkdownScanStatus,
  hydrateMarkdownJobs,
  importMarkdownNotes,
  startMarkdownImport,
  startMarkdownScan
} from '../src/markdown-import.js';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'studianda-phase15-'));
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

function schemaVersion(store: Store): string {
  const db = (store as unknown as { db: DatabaseSync }).db;
  const row = db
    .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
    .get() as { value?: string } | undefined;
  return String(row?.value ?? '');
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

describe('schema 12：notes.tags + note_folders', () => {
  it('v11 库迁移增加 tags 列、回填 note_folders（含祖先），幂等', () => {
    const dir = path.join(root, 'migrate-v11');
    mkdirSync(dir, { recursive: true });
    const raw = new DatabaseSync(path.join(dir, 'reader.sqlite3'));
    raw.exec('CREATE TABLE schema_meta(key TEXT PRIMARY KEY, value TEXT)');
    raw.exec("INSERT INTO schema_meta(key, value) VALUES ('schema_version', '11')");
    raw.exec(
      `CREATE TABLE notes(
         id TEXT PRIMARY KEY,
         document_id TEXT,
         page INTEGER,
         quote TEXT,
         content TEXT,
         external_key TEXT DEFAULT '',
         folder_path TEXT DEFAULT '',
         created TEXT DEFAULT CURRENT_TIMESTAMP,
         deleted INTEGER DEFAULT 0
       )`
    );
    raw.exec(
      "INSERT INTO notes(id, document_id, page, quote, content, external_key, folder_path) VALUES ('n1', '', 0, '', '一', '', 'a/b')"
    );
    raw.exec(
      "INSERT INTO notes(id, document_id, page, quote, content, external_key, folder_path) VALUES ('n2', '', 0, '', '二', '', 'a/b/c')"
    );
    raw.exec(
      "INSERT INTO notes(id, document_id, page, quote, content, external_key, folder_path) VALUES ('n3', '', 0, '', '三', '', 'x')"
    );
    raw.close();

    const store = new Store(dir);
    try {
      expect(schemaVersion(store)).toBe('19');
      const db = (store as unknown as { db: DatabaseSync }).db;
      const columns = (db.prepare('PRAGMA table_info(notes)').all() as Array<{ name: string }>).map(
        (column) => column.name
      );
      expect(columns).toContain('tags');
      for (const note of store.listStandaloneNotes()) expect(note.tags).toEqual([]);
      const folders = store.listNoteFolders().map((folder) => folder.path);
      expect(folders).toEqual(['a', 'a/b', 'a/b/c', 'x']);
      expect(store.listNoteFolders().find((folder) => folder.path === 'a/b')?.noteCount).toBe(1);
    } finally {
      store.close();
    }

    // 幂等重开：版本仍是 13，tags 数据不会被重置。
    const reopened = new Store(dir);
    try {
      expect(schemaVersion(reopened)).toBe('19');
      expect(reopened.listNoteFolders()).toHaveLength(4);
    } finally {
      reopened.close();
    }
  });
});

describe('笔记标签', () => {
  it('createNote/updateNote 清洗 tags；listNoteTags/setNoteTags', () => {
    const store = storeAt('note-tags');
    try {
      const note = store.createNote({
        documentId: '',
        page: 0,
        content: '标签测试',
        tags: [' #阿尔法 ', '阿尔法', 'Beta', 'beta', '带\u0000控制', 'x'.repeat(80)]
      });
      // 去 #、trim、去重（忽略大小写）、控制字符剔除、单标签 50 字符上限。
      expect(note.tags).toEqual(['阿尔法', 'Beta', '带控制', 'x'.repeat(50)]);
      expect(store.getNote(note.id)?.tags).toEqual(note.tags);
      expect(store.listStandaloneNotes()[0]?.tags).toEqual(note.tags);

      const updated = store.updateNote(note.id, { tags: ['新标签', '新标签', ' #旧 '] });
      expect(updated.tags).toEqual(['新标签', '旧']);
      // 不传 tags 时保留原值。
      expect(store.updateNote(note.id, { content: '只改内容' }).tags).toEqual(['新标签', '旧']);

      // 数量上限 50。
      const many = Array.from({ length: 60 }, (_, index) => `tag${index}`);
      const capped = store.setNoteTags(note.id, many);
      expect(capped.tags).toHaveLength(50);

      const other = store.createNote({
        documentId: '',
        page: 0,
        content: '另一条',
        tags: ['Alpha', 'Gamma']
      });
      const allTags = store.listNoteTags();
      expect(allTags).toContain('Alpha');
      expect(allTags).toContain('tag0');
      expect([...allTags].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))).toEqual(allTags);
      void other;

      expect(() => store.setNoteTags('missing-note', ['x'])).toThrow('笔记不存在');
      // 非字符串数组 → 明确错误（store 类型层面由 server 校验）。
      expect(() => store.setNoteTags(note.id, 'x' as unknown as string[])).toThrow(
        '标签必须是字符串数组'
      );
    } finally {
      store.close();
    }
  });

  it('Markdown 导入提取 frontmatter tags 与正文 #tag 写入 notes.tags', async () => {
    const dir = path.join(root, 'tag-vault');
    mkdirSync(dir, { recursive: true });
    writeFile(
      dir,
      'tagged.md',
      '---\ntags: [front-a, front-b]\n---\n# 标题\n正文带 #正文标签 和 #another/tag\n'
    );
    writeFile(dir, 'list-tag.md', '---\ntags:\n  - 列表一\n  - 列表二\n---\n内容\n');
    const store = storeAt('tag-import');
    try {
      const report = await importMarkdownNotes(store, {
        vaultPath: dir,
        files: ['tagged.md', 'list-tag.md']
      });
      expect(report.imported).toBe(2);
      const notes = store.listStandaloneNotes();
      const tagged = notes.find((note) => note.content.includes('正文标签'))!;
      expect(tagged.tags).toEqual(
        expect.arrayContaining(['front-a', 'front-b', '正文标签', 'another/tag'])
      );
      const listTag = notes.find((note) => note.content.includes('内容'))!;
      expect(listTag.tags).toEqual(expect.arrayContaining(['列表一', '列表二']));
      // 正文标签文本仍保留。
      expect(tagged.content).toContain('#正文标签');

      // 重复导入时同步更新 tags。
      writeFile(dir, 'tagged.md', '正文带 #新标签\n');
      const second = await importMarkdownNotes(store, { vaultPath: dir, files: ['tagged.md'] });
      expect(second.updated).toBe(1);
      const updated = store.listStandaloneNotes().find((note) => note.content.includes('新标签'))!;
      expect(updated.tags).toContain('新标签');
      expect(updated.tags).not.toContain('front-a');
    } finally {
      store.close();
    }
  });
});

describe('笔记文件夹 CRUD', () => {
  it('操作返回规范 folders/notes 快照（rename/merge/move/delete）', () => {
    const store = storeAt('folder-snapshots');
    try {
      store.createNoteFolder('s/a');
      store.createNoteFolder('t/b');
      const note1 = store.createNote({ documentId: '', page: 0, content: '1', folderPath: 's' });
      const note2 = store.createNote({ documentId: '', page: 0, content: '2', folderPath: 's/a' });
      const trashed = store.createNote({ documentId: '', page: 0, content: 'x', folderPath: 's' });
      store.deleteNote(trashed.id);

      // rename（目标不存在）：notes 只含受影响笔记，folders 与数据库一致。
      const renamed = store.renameNoteFolder('s', 'r');
      expect(renamed.movedNotes).toBe(2);
      expect(renamed.movedDeletedNotes).toBe(1);
      expect(renamed.notes).toEqual(
        expect.arrayContaining([
          { id: note1.id, folderPath: 'r' },
          { id: note2.id, folderPath: 'r/a' },
          { id: trashed.id, folderPath: 'r' }
        ])
      );
      expect(renamed.notes).toHaveLength(3);
      expect(renamed.folders).toEqual(store.listNoteFolders());

      // merge：目标已存在时 notes/folders 仍为操作后的规范快照。
      const merged = store.renameNoteFolder('r', 't');
      expect(merged.ok).toBe(true);
      expect(merged.notes?.map((item) => item.id).sort()).toEqual(
        [note1.id, note2.id, trashed.id].sort()
      );
      expect(merged.folders).toEqual(store.listNoteFolders());
      expect(merged.folders?.some((folder) => folder.path === 't/a')).toBe(true);

      // move：单条笔记也返回 notes/folders。
      const moved = store.moveNoteToFolder(note2.id, 't/b');
      expect(moved.ok).toBe(true);
      expect(moved.notes).toEqual([{ id: note2.id, folderPath: 't/b' }]);
      expect(moved.folders).toEqual(store.listNoteFolders());
      expect(store.getNote(note2.id)?.folderPath).toBe('t/b');

      // delete 空文件夹：notes 为空，folders 为删除后的快照。
      store.createNoteFolder('empty-now');
      const deletedFolder = store.deleteNoteFolder('empty-now');
      expect(deletedFolder.ok).toBe(true);
      expect(deletedFolder.movedNotes).toBe(0);
      expect(deletedFolder.notes).toEqual([]);
      expect(deletedFolder.folders).toEqual(store.listNoteFolders());
      expect(deletedFolder.folders?.some((folder) => folder.path === 'empty-now')).toBe(false);
    } finally {
      store.close();
    }
  });

  it('创建祖先/空文件夹列出/重命名子树/移动/删除非空文件夹（笔记上移）', () => {
    const store = storeAt('note-folders');
    try {
      expect(store.listNoteFolders()).toEqual([]);
      const created = store.createNoteFolder('projects/阅读/2026');
      expect(created.path).toBe('projects/阅读/2026');
      expect(created.noteCount).toBe(0);
      expect(Number.isNaN(Date.parse(created.createdAt))).toBe(false);
      // 祖先与空文件夹都列出。
      expect(store.listNoteFolders().map((folder) => folder.path)).toEqual([
        'projects',
        'projects/阅读',
        'projects/阅读/2026'
      ]);
      // 幂等创建。
      expect(store.createNoteFolder('projects/阅读/2026').path).toBe('projects/阅读/2026');
      expect(() => store.createNoteFolder('')).toThrow('需要文件夹路径');
      expect(() => store.createNoteFolder('../escape')).toThrow('文件夹路径无效');

      const noteA = store.createNote({ documentId: '', page: 0, content: 'A', folderPath: 'projects/阅读' });
      const noteB = store.createNote({
        documentId: '',
        page: 0,
        content: 'B',
        folderPath: 'projects/阅读/2026'
      });
      // 回收站里的笔记也随文件夹移动，但计入 movedDeletedNotes。
      const trashedNote = store.createNote({
        documentId: '',
        page: 0,
        content: '回收站笔记',
        folderPath: 'projects/阅读'
      });
      store.deleteNote(trashedNote.id);
      expect(
        store.listNoteFolders().find((folder) => folder.path === 'projects/阅读')?.noteCount
      ).toBe(1);
      expect(
        store.listNoteFolders().find((folder) => folder.path === 'projects/阅读/2026')?.noteCount
      ).toBe(1);

      // 删除非空文件夹（新语义）：直接笔记移到父级，子文件夹整体上移一级；
      // 回收站里的笔记也移动（计入 movedDeletedNotes），不再报「文件夹非空」。
      store.createNoteFolder('del/sub');
      const delDirect = store.createNote({
        documentId: '',
        page: 0,
        content: '直接笔记',
        folderPath: 'del'
      });
      const delChild = store.createNote({
        documentId: '',
        page: 0,
        content: '子文件夹笔记',
        folderPath: 'del/sub'
      });
      const delTrashed = store.createNote({
        documentId: '',
        page: 0,
        content: '回收站笔记',
        folderPath: 'del'
      });
      store.deleteNote(delTrashed.id);
      expect(store.deleteNoteFolder('del')).toMatchObject({
        ok: true,
        movedNotes: 2,
        movedDeletedNotes: 1
      });
      expect(store.getNote(delDirect.id)?.folderPath).toBe('');
      expect(store.getNote(delChild.id)?.folderPath).toBe('sub');
      // 回收站笔记不在 getNote 的查询范围，用回收站列表断言。
      expect(store.listStandaloneNotes(true).find((item) => item.id === delTrashed.id)?.folderPath).toBe(
        ''
      );
      expect(store.listNoteFolders().some((folder) => folder.path === 'del')).toBe(false);
      expect(store.listNoteFolders().some((folder) => folder.path === 'sub')).toBe(true);
      // 已不存在的文件夹报错。
      expect(() => store.deleteNoteFolder('del')).toThrow('文件夹不存在');
      // 空文件夹可删。
      expect(store.createNoteFolder('empty/sub').path).toBe('empty/sub');
      expect(store.deleteNoteFolder('empty/sub')).toMatchObject({
        ok: true,
        movedNotes: 0,
        movedDeletedNotes: 0
      });
      expect(store.deleteNoteFolder('empty')).toMatchObject({
        ok: true,
        movedNotes: 0,
        movedDeletedNotes: 0
      });
      expect(store.listNoteFolders().some((folder) => folder.path.startsWith('empty'))).toBe(false);

      // 重命名子树：文件夹与笔记 folder_path 一起移动。
      const renamed: NoteFolderOperationResult = store.renameNoteFolder(
        'projects/阅读',
        '归档/旧阅读'
      );
      expect(renamed.ok).toBe(true);
      expect(renamed.movedNotes).toBe(2);
      expect(renamed.movedDeletedNotes).toBe(1);
      expect(store.getNote(noteA.id)?.folderPath).toBe('归档/旧阅读');
      expect(store.getNote(noteB.id)?.folderPath).toBe('归档/旧阅读/2026');
      const folderPaths = store.listNoteFolders().map((folder) => folder.path);
      expect(folderPaths).toContain('归档');
      expect(folderPaths).toContain('归档/旧阅读');
      expect(folderPaths).toContain('归档/旧阅读/2026');
      // 父目录 projects 保留为空文件夹，但原子树已移走。
      expect(folderPaths).toContain('projects');
      expect(folderPaths.some((folder) => folder.startsWith('projects/'))).toBe(false);

      // 重命名校验。
      expect(() => store.renameNoteFolder('归档/旧阅读', '归档/旧阅读/子目录')).toThrow(
        '不能重命名到自己的子文件夹'
      );
      // 目标已存在 → 合并（不再报错）。
      store.createNoteFolder('待合并');
      store.createNoteFolder('已存在目标');
      expect(store.renameNoteFolder('待合并', '已存在目标').ok).toBe(true);
      expect(store.listNoteFolders().some((folder) => folder.path === '待合并')).toBe(false);
      expect(store.listNoteFolders().some((folder) => folder.path === '已存在目标')).toBe(true);
      expect(() => store.renameNoteFolder('不存在', 'x')).toThrow('文件夹不存在');

      // 移动笔记到根/目标文件夹/不存在目标。
      store.moveNoteToFolder(noteA.id, '');
      expect(store.getNote(noteA.id)?.folderPath).toBe('');
      store.moveNoteToFolder(noteA.id, '归档');
      expect(store.getNote(noteA.id)?.folderPath).toBe('归档');
      expect(() => store.moveNoteToFolder(noteA.id, '不存在/文件夹')).toThrow('目标文件夹不存在');
      expect(() => store.moveNoteToFolder('missing-note', '')).toThrow('笔记不存在');
    } finally {
      store.close();
    }
  });
});

describe('HTTP：笔记文件夹与标签', () => {
  const dataDir = path.join(root, 'http');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(dataDir);
  const server = buildServer({ token, version: 'test-version', store, secrets: new SecretStore() });
  const headers = (): Record<string, string> => ({ 'x-studianda-token': token });

  afterAll(async () => {
    await server.close();
    store.close();
  });

  it('文件夹 CRUD/tags 路由；非法 400/404', async () => {
    const createFolder = await server.inject({
      method: 'POST',
      url: '/api/v1/notes/folders',
      headers: headers(),
      payload: { path: 'http/sub' }
    });
    expect(createFolder.statusCode).toBe(200);
    expect((createFolder.json() as NoteFolderRecord).path).toBe('http/sub');

    const listFolders = await server.inject({
      method: 'GET',
      url: '/api/v1/notes/folders',
      headers: headers()
    });
    expect(listFolders.statusCode).toBe(200);
    expect((listFolders.json() as NoteFolderRecord[]).map((folder) => folder.path)).toEqual([
      'http',
      'http/sub'
    ]);

    const missingPath = await server.inject({
      method: 'POST',
      url: '/api/v1/notes/folders',
      headers: headers(),
      payload: {}
    });
    expect(missingPath.statusCode).toBe(400);

    const note = store.createNote({ documentId: '', page: 0, content: 'HTTP 笔记' });
    const move = await server.inject({
      method: 'PATCH',
      url: `/api/v1/notes/${encodeURIComponent(note.id)}/folder`,
      headers: headers(),
      payload: { folderPath: 'http/sub' }
    });
    expect(move.statusCode).toBe(200);
    expect(store.getNote(note.id)?.folderPath).toBe('http/sub');

    const moveMissingNote = await server.inject({
      method: 'PATCH',
      url: '/api/v1/notes/missing-note/folder',
      headers: headers(),
      payload: { folderPath: '' }
    });
    expect(moveMissingNote.statusCode).toBe(404);

    // 非空文件夹删除（新语义）：笔记上移到父级，不再 400。
    const deleteNonEmpty = await server.inject({
      method: 'DELETE',
      url: '/api/v1/notes/folders?path=http%2Fsub',
      headers: headers()
    });
    expect(deleteNonEmpty.statusCode).toBe(200);
    expect((deleteNonEmpty.json() as NoteFolderOperationResult).movedNotes).toBe(1);
    expect(store.getNote(note.id)?.folderPath).toBe('http');

    // 不存在的文件夹删除 → 400。
    const deleteMissing = await server.inject({
      method: 'DELETE',
      url: '/api/v1/notes/folders?path=missing%2Ffolder',
      headers: headers()
    });
    expect(deleteMissing.statusCode).toBe(400);

    const rename = await server.inject({
      method: 'POST',
      url: '/api/v1/notes/folders/rename',
      headers: headers(),
      payload: { from: 'http', to: 'http2' }
    });
    expect(rename.statusCode).toBe(200);
    expect((rename.json() as NoteFolderOperationResult).movedNotes).toBe(1);

    const tags = await server.inject({
      method: 'PUT',
      url: `/api/v1/notes/${encodeURIComponent(note.id)}/tags`,
      headers: headers(),
      payload: { tags: ['接口标签', '接口标签', '#另一个'] }
    });
    expect(tags.statusCode).toBe(200);
    expect((tags.json() as { tags: string[] }).tags).toEqual(['接口标签', '另一个']);

    const badTags = await server.inject({
      method: 'PUT',
      url: `/api/v1/notes/${encodeURIComponent(note.id)}/tags`,
      headers: headers(),
      payload: { tags: 'not-array' }
    });
    expect(badTags.statusCode).toBe(400);

    const listTags = await server.inject({
      method: 'GET',
      url: '/api/v1/notes/tags',
      headers: headers()
    });
    expect(listTags.statusCode).toBe(200);
    expect(listTags.json()).toEqual(expect.arrayContaining(['接口标签', '另一个']));
  });
});

describe('后台 Markdown 扫描任务 + 任务持久化', () => {
  it('startMarkdownScan 完成：进度/total/scan 结果；单并发', async () => {
    const dir = path.join(root, 'scan-job-vault');
    mkdirSync(dir, { recursive: true });
    for (let index = 0; index < 25; index += 1) {
      writeFile(dir, `note-${index}.md`, `# N${index}`);
    }
    writeFile(dir, 'attach.png', Buffer.from('not-a-real-png'));
    const store = storeAt('scan-job-store');
    try {
      const started = startMarkdownScan(store, dir);
      expect(started.status).toBe('running');
      const second = startMarkdownScan(store, dir);
      expect(second.status).toBe('running');
      const job = await waitScan();
      expect(job.status).toBe('done');
      expect(job.phase).toBe('done');
      expect(job.total).toBe(26);
      expect(job.done).toBe(26);
      expect(job.scan?.notes).toHaveLength(25);
      expect(job.scan?.attachments).toHaveLength(1);
      // 持久化快照写入 settings。
      const persisted = JSON.parse(
        String(store.getSettings()['markdown.scan_job'] ?? '{}')
      ) as MarkdownScanJob;
      expect(persisted.status).toBe('done');
      expect(persisted.total).toBe(26);
    } finally {
      store.close();
    }
  });

  it('扫描 cancel 置 cancelled 并停止', async () => {
    const dir = path.join(root, 'scan-cancel-vault');
    mkdirSync(dir, { recursive: true });
    for (let index = 0; index < 500; index += 1) {
      writeFile(dir, `c-${index}.md`, `# C${index}`);
    }
    const store = storeAt('scan-cancel-store');
    try {
      startMarkdownScan(store, dir);
      const cancelled = cancelMarkdownScan();
      expect(cancelled.status).toBe('cancelled');
      const job = await waitScan();
      expect(job.status).toBe('cancelled');
      expect(job.scan).toBeNull();
    } finally {
      store.close();
    }
  });

  it('任务持久化：正常导入写 settings；running 快照 hydrate 后 interrupted，done 保留', async () => {
    const dir = path.join(root, 'persist-vault');
    mkdirSync(dir, { recursive: true });
    writeFile(dir, 'p.md', '# P\n');
    const store = storeAt('persist-store');
    try {
      startMarkdownImport(store, { vaultPath: dir, files: ['p.md'] });
      await waitImport();
      const saved = JSON.parse(String(store.getSettings()['markdown.import_job'] ?? '{}')) as {
        status: string;
        report?: { imported?: number };
      };
      expect(saved.status).toBe('done');
      expect(saved.report?.imported).toBe(1);

      // 模拟上次进程运行中崩溃：写入 running 快照后 hydrate → interrupted。
      store.updateSettings({
        'markdown.import_job': JSON.stringify({
          status: 'running',
          phase: 'importing',
          total: 10,
          done: 3,
          currentPath: 'x.md',
          report: null,
          error: ''
        })
      });
      hydrateMarkdownJobs(store);
      const interrupted = getMarkdownImportStatus();
      expect(interrupted.status).toBe('interrupted');
      expect(interrupted.error).toContain('进程重启中断');
      expect(interrupted.done).toBe(3);

      // done 快照（含 report）保留。
      store.updateSettings({
        'markdown.import_job': JSON.stringify({
          status: 'done',
          phase: 'finalizing',
          total: 1,
          done: 1,
          currentPath: '',
          report: { requested: 1, imported: 1 },
          error: ''
        })
      });
      hydrateMarkdownJobs(store);
      const done = getMarkdownImportStatus();
      expect(done.status).toBe('done');
      expect(done.report?.imported).toBe(1);

      // scan job 同样处理。
      store.updateSettings({
        'markdown.scan_job': JSON.stringify({
          status: 'running',
          phase: 'scanning',
          total: 0,
          done: 7,
          currentPath: 'y.md',
          scan: null,
          error: ''
        })
      });
      hydrateMarkdownJobs(store);
      expect(getMarkdownScanStatus().status).toBe('interrupted');
    } finally {
      store.close();
    }
  });
});

describe('HTTP：后台扫描', () => {
  const dataDir = path.join(root, 'http-scan');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(dataDir);
  const server = buildServer({ token, version: 'test-version', store, secrets: new SecretStore() });
  const headers = (): Record<string, string> => ({ 'x-studianda-token': token });

  afterAll(async () => {
    await server.close();
    store.close();
  });

  it('scan start/status/cancel 200；非法路径 400', async () => {
    const vault = path.join(root, 'http-scan-vault');
    mkdirSync(vault, { recursive: true });
    writeFile(vault, 'one.md', '# One');
    const missing = await server.inject({
      method: 'POST',
      url: '/api/v1/markdown/scan/start',
      headers: headers(),
      payload: { vaultPath: path.join(root, 'no-such-vault') }
    });
    expect(missing.statusCode).toBe(400);

    const started = await server.inject({
      method: 'POST',
      url: '/api/v1/markdown/scan/start',
      headers: headers(),
      payload: { vaultPath: vault }
    });
    expect(started.statusCode).toBe(200);
    expect((started.json() as MarkdownScanJob).status).toBe('running');

    let job: MarkdownScanJob = started.json() as MarkdownScanJob;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const status = await server.inject({
        method: 'GET',
        url: '/api/v1/markdown/scan/status',
        headers: headers()
      });
      expect(status.statusCode).toBe(200);
      job = status.json() as MarkdownScanJob;
      if (job.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(job.status).toBe('done');
    expect(job.scan?.notes).toHaveLength(1);

    const cancel = await server.inject({
      method: 'POST',
      url: '/api/v1/markdown/scan/cancel',
      headers: headers()
    });
    expect(cancel.statusCode).toBe(200);
    expect((cancel.json() as MarkdownScanJob).status).toBe('done');
  });
});
