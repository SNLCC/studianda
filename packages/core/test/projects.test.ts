import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import type { DocumentDetail, ProjectDocumentRecord, ProjectSummary } from '@studianda/shared';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';

/**
 * 逻辑项目（schema_version 22）：数据层 + HTTP 接口。
 *
 * 验收点：
 * - 项目是逻辑对象（不绑目录），名称唯一且大小写不敏感，冲突给中文错误而不是裸 SQLite 错误；
 * - 项目只存文献链接：同一条文献可属于多个项目，删项目不删文献，删文献只删链接；
 * - 归档项目默认不出现在列表；清空用户数据后两张表都为空；
 * - `/api/v1/projects` 系列路由的校验、404 与返回结构。
 */

const root = mkdtempSync(path.join(tmpdir(), 'studianda-projects-'));
const dataDir = path.join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const token = 'projects-token';
const store = new Store(dataDir);
const server = buildServer({ token, version: 'test-version', store, secrets: new SecretStore() });

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
});

async function makePdfBytes(text: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]).drawText(text, { x: 40, y: 350, size: 20 });
  return pdf.save();
}

let pdfSeq = 0;
async function importPdf(label: string): Promise<DocumentDetail> {
  pdfSeq += 1;
  const file = path.join(root, 'pdfs', `${pdfSeq}-${label}.pdf`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, await makePdfBytes(`Project fixture ${label}`));
  return store.importDocument(file, `${label}.pdf`, true);
}

function headers(hasBody = false): Record<string, string> {
  return {
    'x-studianda-token': token,
    ...(hasBody ? { 'content-type': 'application/json' } : {})
  };
}

function readOnlyDb(): DatabaseSync {
  return new DatabaseSync(path.join(dataDir, 'reader.sqlite3'), { readOnly: true });
}

function countRows(table: string): number {
  const db = readOnlyDb();
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as
      | { n?: number }
      | undefined;
    return Number(row?.n ?? 0);
  } finally {
    db.close();
  }
}

function countProjectLinks(projectId: string): number {
  const db = readOnlyDb();
  try {
    const row = db
      .prepare('SELECT COUNT(*) AS n FROM project_documents WHERE project_id = ?')
      .get(projectId) as { n?: number } | undefined;
    return Number(row?.n ?? 0);
  } finally {
    db.close();
  }
}

describe('逻辑项目数据层', () => {
  it('创建/读取/更新：名称与描述去空白、时间戳可用、documentCount 初始为 0', () => {
    const created = store.createProject({ name: '  文献综述  ', description: '  第一轮  ' });
    expect(created.name).toBe('文献综述');
    expect(created.description).toBe('第一轮');
    expect(created.archivedAt).toBe('');
    expect(created.documentCount).toBe(0);
    expect(Number.isNaN(Date.parse(created.createdAt))).toBe(false);
    expect(Number.isNaN(Date.parse(created.updatedAt))).toBe(false);

    const fetched = store.getProject(created.id);
    expect(fetched).toEqual(created);
    expect(store.getProject('not-a-project')).toBeNull();
    expect(store.listProjects().map((project) => project.id)).toContain(created.id);

    const renamed = store.updateProject(created.id, {
      name: '文献综述（改）',
      description: '第二版描述'
    });
    expect(renamed).toMatchObject({
      id: created.id,
      name: '文献综述（改）',
      description: '第二版描述',
      archivedAt: ''
    });
    expect(Date.parse(renamed.updatedAt)).toBeGreaterThanOrEqual(Date.parse(created.updatedAt));

    const archived = store.updateProject(created.id, { archived: true });
    expect(archived.archivedAt).not.toBe('');
    expect(store.listProjects().map((project) => project.id)).not.toContain(created.id);
    expect(store.listProjects(true).map((project) => project.id)).toContain(created.id);

    const unarchived = store.updateProject(created.id, { archived: false });
    expect(unarchived.archivedAt).toBe('');
    expect(store.listProjects().map((project) => project.id)).toContain(created.id);

    expect(() => store.updateProject('not-a-project', { name: 'x' })).toThrow('项目不存在');
    expect(() => store.createProject({ name: '   ' })).toThrow('请输入项目名称');
  });

  it('名称唯一且大小写不敏感：冲突返回中文错误，数据库唯一索引兜底', () => {
    store.createProject({ name: 'Alpha' });
    expect(() => store.createProject({ name: 'alpha' })).toThrow('已存在同名项目：alpha');
    expect(() => store.createProject({ name: 'ALPHA' })).toThrow('已存在同名项目：ALPHA');

    const beta = store.createProject({ name: 'Beta' });
    const gamma = store.createProject({ name: 'Gamma' });
    expect(() => store.updateProject(gamma.id, { name: 'beta' })).toThrow(
      '已存在同名项目：beta'
    );
    // 只改大小写不算冲突（除自身外无同名）。
    expect(store.updateProject(beta.id, { name: 'BETA' }).name).toBe('BETA');

    const db = readOnlyDb();
    try {
      const indexRow = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'projects_name_unique'"
        )
        .get() as { name?: string } | undefined;
      expect(indexRow?.name).toBe('projects_name_unique');
      const tableRow = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
        .get() as { name?: string } | undefined;
      expect(tableRow?.name).toBe('projects');
    } finally {
      db.close();
    }
  });

  it('一个文献可属于多个项目；重复加入幂等；移除只删链接', async () => {
    const document = await importPdf('multi-project');
    const first = store.createProject({ name: '项目一' });
    const second = store.createProject({ name: '项目二' });

    const link = store.addProjectDocument(first.id, document.id);
    expect(link).toMatchObject({
      projectId: first.id,
      id: document.id,
      name: document.name
    });
    expect(link.addedAt).not.toBe('');
    store.addProjectDocument(second.id, document.id);

    expect(store.listProjectDocuments(first.id)).toHaveLength(1);
    expect(store.listProjectDocuments(second.id)).toHaveLength(1);
    expect(store.getProject(first.id)?.documentCount).toBe(1);
    expect(store.getProject(second.id)?.documentCount).toBe(1);

    // 重复加入同一项目幂等：不新增链接、不改变加入时间。
    const again = store.addProjectDocument(first.id, document.id);
    expect(again.addedAt).toBe(link.addedAt);
    expect(store.listProjectDocuments(first.id)).toHaveLength(1);

    store.removeProjectDocument(first.id, document.id);
    expect(store.listProjectDocuments(first.id)).toHaveLength(0);
    expect(store.getProject(first.id)?.documentCount).toBe(0);
    // 另一个项目的链接不受影响。
    expect(store.listProjectDocuments(second.id)).toHaveLength(1);

    expect(() => store.removeProjectDocument(first.id, document.id)).toThrow('文献不在该项目中');
    expect(() => store.addProjectDocument(first.id, 'not-a-document')).toThrow('文档不存在');
    expect(() => store.addProjectDocument('not-a-project', document.id)).toThrow('项目不存在');
    expect(() => store.listProjectDocuments('not-a-project')).toThrow('项目不存在');
  });

  it('删项目只删链接、不删文献', async () => {
    const document = await importPdf('delete-project');
    const doomed = store.createProject({ name: '待删项目' });
    const kept = store.createProject({ name: '保留项目' });
    store.addProjectDocument(doomed.id, document.id);
    store.addProjectDocument(kept.id, document.id);

    const result = store.deleteProject(doomed.id);
    expect(result).toEqual({ id: doomed.id, deleted: true, detachedDocuments: 1 });
    expect(store.getProject(doomed.id)).toBeNull();

    // 文献本身仍在文献库，且另一个项目的链接保留。
    expect(store.getDocument(document.id)?.name).toBe(document.name);
    expect(store.listDocuments().map((row) => row.id)).toContain(document.id);
    expect(store.listProjectDocuments(kept.id)).toHaveLength(1);
    expect(store.listProjectDocuments(kept.id)[0]?.id).toBe(document.id);

    expect(() => store.deleteProject(doomed.id)).toThrow('项目不存在');
  });

  it('软删除文献保留链接（恢复后重新出现），彻底删除文献级联删链接', async () => {
    const document = await importPdf('purge-document');
    const project = store.createProject({ name: '级联项目' });
    store.addProjectDocument(project.id, document.id);

    // 应用回收站：链接仍在，但列表口径隐藏（与文献列表一致）。
    store.deleteDocument(document.id);
    expect(store.listProjectDocuments(project.id)).toHaveLength(0);
    expect(store.getProject(project.id)?.documentCount).toBe(0);
    store.restoreDocument(document.id);
    expect(store.listProjectDocuments(project.id)).toHaveLength(1);

    // 彻底删除：链接随文献一起删掉，项目本身保留。
    store.deleteDocument(document.id);
    store.purgeDocument(document.id, document.name);
    expect(store.getDocument(document.id)).toBeNull();
    expect(store.listProjectDocuments(project.id)).toHaveLength(0);
    expect(store.getProject(project.id)).not.toBeNull();
    expect(countProjectLinks(project.id)).toBe(0);
  });

  it('整库备份（VACUUM INTO）自然包含项目两表，无需按表补处理', () => {
    const project = store.createProject({ name: '备份项目' });
    const target = path.join(root, 'backup-projects.sqlite3');
    store.backupDatabase(target);

    const db = new DatabaseSync(target, { readOnly: true });
    try {
      const versionRow = db
        .prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'")
        .get() as { value?: string } | undefined;
      expect(versionRow?.value).toBe('24');
      const projectRow = db
        .prepare('SELECT id, name FROM projects WHERE id = ?')
        .get(project.id) as { id?: string; name?: string } | undefined;
      expect(projectRow?.name).toBe('备份项目');
      const linkTable = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project_documents'"
        )
        .get() as { name?: string } | undefined;
      expect(linkTable?.name).toBe('project_documents');
    } finally {
      db.close();
    }
    rmSync(target, { force: true });
  });

  it('清空用户数据会一并清掉 projects 与 project_documents', async () => {
    const document = await importPdf('clear-data');
    const project = store.createProject({ name: '清空用项目' });
    store.addProjectDocument(project.id, document.id);
    expect(countRows('projects')).toBeGreaterThan(0);
    expect(countRows('project_documents')).toBeGreaterThan(0);

    store.clearUserData();

    expect(countRows('projects')).toBe(0);
    expect(countRows('project_documents')).toBe(0);
    expect(store.listProjects(true)).toEqual([]);
  });
});

describe('逻辑项目 HTTP 接口', () => {
  it('POST/GET/PATCH/DELETE /projects：CRUD、校验与 404', async () => {
    const createResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: headers(true),
      payload: { name: '接口项目', description: '接口描述' }
    });
    expect(createResponse.statusCode).toBe(200);
    const created = createResponse.json() as ProjectSummary;
    expect(created).toMatchObject({
      name: '接口项目',
      description: '接口描述',
      archivedAt: '',
      documentCount: 0
    });
    expect(created.id).toBeTruthy();

    const listResponse = await server.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: headers()
    });
    expect(listResponse.statusCode).toBe(200);
    expect((listResponse.json() as ProjectSummary[]).map((project) => project.id)).toContain(
      created.id
    );

    // 重名（大小写不同）→ 400 + 中文错误；字段类型错误 → 400。
    const duplicate = await server.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: headers(true),
      payload: { name: '接口项目' }
    });
    expect(duplicate.statusCode).toBe(400);
    expect((duplicate.json() as { message?: string }).message).toContain('已存在同名项目');

    const badName = await server.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: headers(true),
      payload: { name: 123 }
    });
    expect(badName.statusCode).toBe(400);
    expect((badName.json() as { message?: string }).message).toBe('name 必须是字符串');

    const badDescription = await server.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: headers(true),
      payload: { name: '另一个项目', description: 1 }
    });
    expect(badDescription.statusCode).toBe(400);

    const patchResponse = await server.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${created.id}`,
      headers: headers(true),
      payload: { name: '接口项目（改）', description: '改后描述' }
    });
    expect(patchResponse.statusCode).toBe(200);
    expect(patchResponse.json() as ProjectSummary).toMatchObject({
      name: '接口项目（改）',
      description: '改后描述'
    });

    const emptyPatch = await server.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${created.id}`,
      headers: headers(true),
      payload: {}
    });
    expect(emptyPatch.statusCode).toBe(400);

    const badArchived = await server.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${created.id}`,
      headers: headers(true),
      payload: { archived: 'yes' }
    });
    expect(badArchived.statusCode).toBe(400);

    const archiveResponse = await server.inject({
      method: 'PATCH',
      url: `/api/v1/projects/${created.id}`,
      headers: headers(true),
      payload: { archived: true }
    });
    expect(archiveResponse.statusCode).toBe(200);
    const afterArchive = await server.inject({
      method: 'GET',
      url: '/api/v1/projects',
      headers: headers()
    });
    expect((afterArchive.json() as ProjectSummary[]).map((project) => project.id)).not.toContain(
      created.id
    );
    const withArchived = await server.inject({
      method: 'GET',
      url: '/api/v1/projects?archived=true',
      headers: headers()
    });
    expect((withArchived.json() as ProjectSummary[]).map((project) => project.id)).toContain(
      created.id
    );

    const missingPatch = await server.inject({
      method: 'PATCH',
      url: '/api/v1/projects/not-a-project',
      headers: headers(true),
      payload: { name: 'x' }
    });
    expect(missingPatch.statusCode).toBe(404);

    const deleteResponse = await server.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${created.id}`,
      headers: headers()
    });
    expect(deleteResponse.statusCode).toBe(200);
    expect(deleteResponse.json()).toMatchObject({ id: created.id, deleted: true });

    const deleteAgain = await server.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${created.id}`,
      headers: headers()
    });
    expect(deleteAgain.statusCode).toBe(404);
  });

  it('GET/POST/DELETE /projects/:id/documents：链接增删、404 与校验', async () => {
    const document = await importPdf('route-link');
    const projectResponse = await server.inject({
      method: 'POST',
      url: '/api/v1/projects',
      headers: headers(true),
      payload: { name: '链接接口项目' }
    });
    const project = projectResponse.json() as ProjectSummary;

    const addResponse = await server.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/documents`,
      headers: headers(true),
      payload: { documentId: document.id }
    });
    expect(addResponse.statusCode).toBe(200);
    expect(addResponse.json()).toMatchObject({
      projectId: project.id,
      id: document.id,
      name: document.name
    });

    const listResponse = await server.inject({
      method: 'GET',
      url: `/api/v1/projects/${project.id}/documents`,
      headers: headers()
    });
    expect(listResponse.statusCode).toBe(200);
    const records = listResponse.json() as ProjectDocumentRecord[];
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe(document.id);
    expect(records[0]?.projectId).toBe(project.id);

    const missingDocumentId = await server.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/documents`,
      headers: headers(true),
      payload: {}
    });
    expect(missingDocumentId.statusCode).toBe(400);
    expect((missingDocumentId.json() as { message?: string }).message).toBe(
      'documentId 必须是字符串'
    );

    const unknownProject = await server.inject({
      method: 'POST',
      url: '/api/v1/projects/not-a-project/documents',
      headers: headers(true),
      payload: { documentId: document.id }
    });
    expect(unknownProject.statusCode).toBe(404);

    const unknownDocument = await server.inject({
      method: 'POST',
      url: `/api/v1/projects/${project.id}/documents`,
      headers: headers(true),
      payload: { documentId: 'not-a-document' }
    });
    expect(unknownDocument.statusCode).toBe(404);

    const listUnknownProject = await server.inject({
      method: 'GET',
      url: '/api/v1/projects/not-a-project/documents',
      headers: headers()
    });
    expect(listUnknownProject.statusCode).toBe(404);

    const removeResponse = await server.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${project.id}/documents/${document.id}`,
      headers: headers()
    });
    expect(removeResponse.statusCode).toBe(200);
    expect(removeResponse.json()).toEqual({ ok: true });

    const removeAgain = await server.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${project.id}/documents/${document.id}`,
      headers: headers()
    });
    expect(removeAgain.statusCode).toBe(404);

    // 清理：删项目，文献仍在。
    await server.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${project.id}`,
      headers: headers()
    });
    expect(store.getDocument(document.id)).not.toBeNull();
  });
});
