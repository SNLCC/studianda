import type { DatabaseSync } from 'node:sqlite';
import type {
  CreateProjectInput,
  DocumentDetail,
  ProjectDeleteResult,
  ProjectDocumentRecord,
  ProjectSummary,
  UpdateProjectInput
} from '@studianda/shared';

/**
 * 逻辑项目域（从 store.ts 拆出的第一个试点，schema_version 22）。
 *
 * 拆分约定（后续域可复用）：
 * - 每个导出函数都是**纯函数 + 显式依赖注入**：第一个参数是 SQLite 句柄 `db`，
 *   第二个参数是 `deps`（只含本域真正需要的 `now()` / `uuid()` / 文献读取），
 *   绝不接收 `Store` 实例——否则只是把代码搬家。
 * - 私有辅助（行映射、SQL 常量、校验）一起搬到这里，不反向引用 store.ts 的私有成员。
 * - Store 上的同名方法只剩一层薄委托，调用方与返回结构不变。
 * - 跨表写操作（deleteProject）在同一个事务里完成，拆文件不拆事务。
 */

/** 项目域真正需要的非 DB 依赖；由 Store（或直接调用本模块的测试）显式传入。 */
export interface ProjectDeps {
  /** 当前时间（ISO 文本）。默认实现与 Store 原来的 `new Date().toISOString()` 一致。 */
  now: () => string;
  /** 新建项目 id。默认实现与 Store 原来的 `randomUUID()` 一致。 */
  uuid: () => string;
  /**
   * 读取未删除文献的详情。项目只存链接，加入/列出文献时需要文献域的映射结果；
   * 这里注入一个函数而不是复制 documents 的 SQL，避免两处映射漂移。
   */
  getDocument: (id: string) => DocumentDetail | null;
}

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  archivedAt: string;
  createdAt: string;
  updatedAt: string;
}

/** 项目表列清单：读取/列表共用，避免两处手写列名漂移。 */
const PROJECT_COLUMNS = 'id, name, description, archived_at, created_at, updated_at';

/** 项目名唯一索引冲突（node:sqlite message 形如 `UNIQUE constraint failed: projects.name`）。 */
function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

function projectRawRow(db: DatabaseSync, id: string): ProjectRow | null {
  const row = db
    .prepare(`SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`)
    .get(id) as
    | {
        id?: string;
        name?: string;
        description?: string;
        archived_at?: string;
        created_at?: string;
        updated_at?: string;
      }
    | undefined;
  if (!row?.id) return null;
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    description: String(row.description ?? ''),
    archivedAt: String(row.archived_at ?? ''),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? '')
  };
}

/** 项目关联文献数：只数未进应用回收站的文献（与文献列表口径一致）。 */
function projectDocumentCount(db: DatabaseSync, id: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM project_documents pd
         JOIN documents d ON d.id = pd.document_id
         WHERE pd.project_id = ? AND d.deleted = 0`
    )
    .get(id) as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

function projectSummaryOf(db: DatabaseSync, row: ProjectRow): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    documentCount: projectDocumentCount(db, row.id)
  };
}

function projectNameOf(input: string): string {
  const name = input.trim();
  if (!name) throw new Error('请输入项目名称');
  if (name.length > 60) throw new Error('项目名称过长（最多 60 个字符）');
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('项目名称包含控制字符');
  return name;
}

function projectDescriptionOf(input: string): string {
  const value = input.trim();
  if (value.length > 2000) throw new Error('项目描述过长（最多 2000 个字符）');
  return value;
}

/** 同名判断大小写不敏感（与 DB 唯一索引一致）。 */
function projectNameTaken(db: DatabaseSync, name: string, exceptId?: string): boolean {
  const row = db
    .prepare('SELECT id FROM projects WHERE name = ? COLLATE NOCASE AND id <> ? LIMIT 1')
    .get(name, exceptId ?? '') as { id?: string } | undefined;
  return Boolean(row?.id);
}

/** 链接变化（加入/移除文献）同样算项目更新：列表「最近更新时间」随之刷新。 */
function touchProject(db: DatabaseSync, id: string, at: string): void {
  db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(at, id);
}

/** 列出项目（默认不含归档）；documentCount 只数未进回收站的文献。 */
export function listProjects(
  db: DatabaseSync,
  _deps: ProjectDeps,
  includeArchived = false
): ProjectSummary[] {
  const rows = db
    .prepare(
      `SELECT ${PROJECT_COLUMNS}
         FROM projects
         WHERE ? = 1 OR archived_at = ''
         ORDER BY created_at ASC, name ASC`
    )
    .all(includeArchived ? 1 : 0) as unknown as Array<{
    id?: string;
    name?: string;
    description?: string;
    archived_at?: string;
    created_at?: string;
    updated_at?: string;
  }>;
  return rows.flatMap((row) => {
    if (!row.id) return [];
    return [
      projectSummaryOf(db, {
        id: String(row.id),
        name: String(row.name ?? ''),
        description: String(row.description ?? ''),
        archivedAt: String(row.archived_at ?? ''),
        createdAt: String(row.created_at ?? ''),
        updatedAt: String(row.updated_at ?? '')
      })
    ];
  });
}

export function getProject(
  db: DatabaseSync,
  _deps: ProjectDeps,
  id: string
): ProjectSummary | null {
  const row = projectRawRow(db, id);
  return row ? projectSummaryOf(db, row) : null;
}

export function createProject(
  db: DatabaseSync,
  deps: ProjectDeps,
  input: CreateProjectInput
): ProjectSummary {
  const name = projectNameOf(input.name ?? '');
  const description = projectDescriptionOf(input.description ?? '');
  if (projectNameTaken(db, name)) throw new Error(`已存在同名项目：${name}`);
  const id = deps.uuid();
  const now = deps.now();
  try {
    db.prepare(
      `INSERT INTO projects(id, name, description, archived_at, created_at, updated_at)
           VALUES (?, ?, ?, '', ?, ?)`
    ).run(id, name, description, now, now);
  } catch (error) {
    // 并发下应用层检查可能穿透：把唯一索引冲突翻译成同一个中文错误，不抛裸 SQLite 错误。
    if (isUniqueConstraintError(error)) throw new Error(`已存在同名项目：${name}`);
    throw error;
  }
  const created = projectRawRow(db, id);
  if (!created) throw new Error('创建项目后无法读取');
  return projectSummaryOf(db, created);
}

/** 改名/改描述/归档都在这里：只更新传了的字段，名称冲突给出中文错误。 */
export function updateProject(
  db: DatabaseSync,
  deps: ProjectDeps,
  id: string,
  patch: UpdateProjectInput
): ProjectSummary {
  const current = projectRawRow(db, id);
  if (!current) throw new Error('项目不存在');
  const name = patch.name === undefined ? current.name : projectNameOf(patch.name);
  const description =
    patch.description === undefined
      ? current.description
      : projectDescriptionOf(patch.description);
  let archivedAt = current.archivedAt;
  if (patch.archived === true && !archivedAt) archivedAt = deps.now();
  else if (patch.archived === false) archivedAt = '';
  const changed =
    name !== current.name ||
    description !== current.description ||
    archivedAt !== current.archivedAt;
  if (changed) {
    if (name !== current.name && projectNameTaken(db, name, id)) {
      throw new Error(`已存在同名项目：${name}`);
    }
    try {
      db.prepare(
        'UPDATE projects SET name = ?, description = ?, archived_at = ?, updated_at = ? WHERE id = ?'
      ).run(name, description, archivedAt, deps.now(), id);
    } catch (error) {
      if (isUniqueConstraintError(error)) throw new Error(`已存在同名项目：${name}`);
      throw error;
    }
  }
  const updated = projectRawRow(db, id);
  if (!updated) throw new Error('项目不存在');
  return projectSummaryOf(db, updated);
}

export function archiveProject(
  db: DatabaseSync,
  deps: ProjectDeps,
  id: string
): ProjectSummary {
  if (!projectRawRow(db, id)) throw new Error('项目不存在');
  const now = deps.now();
  db.prepare("UPDATE projects SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at = ''").run(
    now,
    now,
    id
  );
  const updated = projectRawRow(db, id);
  if (!updated) throw new Error('项目不存在');
  return projectSummaryOf(db, updated);
}

/** 删项目只删链接、不删文献；返回解除关联的文献数（含回收站里的文献链接）。 */
export function deleteProject(
  db: DatabaseSync,
  _deps: ProjectDeps,
  id: string
): ProjectDeleteResult {
  if (!projectRawRow(db, id)) throw new Error('项目不存在');
  const countRow = db
    .prepare('SELECT COUNT(*) AS n FROM project_documents WHERE project_id = ?')
    .get(id) as { n?: number } | undefined;
  const detachedDocuments = Number(countRow?.n ?? 0);
  // 两个 DELETEs 必须在同一个事务里：删链接成功、删项目失败会留下孤儿链接。
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM project_documents WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { id, deleted: true, detachedDocuments };
}

/** 把文献加入项目（重复加入幂等）；只建链接，不改文献归属。 */
export function addProjectDocument(
  db: DatabaseSync,
  deps: ProjectDeps,
  projectId: string,
  documentId: string
): ProjectDocumentRecord {
  if (!projectRawRow(db, projectId)) throw new Error('项目不存在');
  const document = deps.getDocument(documentId);
  if (!document) throw new Error('文档不存在');
  const now = deps.now();
  const result = db
    .prepare(
      'INSERT OR IGNORE INTO project_documents(project_id, document_id, added_at) VALUES (?, ?, ?)'
    )
    .run(projectId, documentId, now);
  if (result.changes > 0) touchProject(db, projectId, now);
  const link = db
    .prepare('SELECT added_at FROM project_documents WHERE project_id = ? AND document_id = ?')
    .get(projectId, documentId) as { added_at?: string } | undefined;
  return { ...document, projectId, addedAt: String(link?.added_at ?? now) };
}

export function removeProjectDocument(
  db: DatabaseSync,
  deps: ProjectDeps,
  projectId: string,
  documentId: string
): void {
  if (!projectRawRow(db, projectId)) throw new Error('项目不存在');
  const result = db
    .prepare('DELETE FROM project_documents WHERE project_id = ? AND document_id = ?')
    .run(projectId, documentId);
  if (result.changes === 0) throw new Error('文献不在该项目中');
  touchProject(db, projectId, deps.now());
}

/** 项目下的文献（只读链接；隐藏进应用回收站的文献，恢复后自动重新出现）。 */
export function listProjectDocuments(
  db: DatabaseSync,
  deps: ProjectDeps,
  projectId: string
): ProjectDocumentRecord[] {
  if (!projectRawRow(db, projectId)) throw new Error('项目不存在');
  const rows = db
    .prepare(
      `SELECT pd.document_id, pd.added_at
         FROM project_documents pd
         JOIN documents d ON d.id = pd.document_id
         WHERE pd.project_id = ? AND d.deleted = 0
         ORDER BY pd.added_at DESC, d.name ASC`
    )
    .all(projectId) as unknown as Array<{ document_id?: string; added_at?: string }>;
  const records: ProjectDocumentRecord[] = [];
  for (const row of rows) {
    const documentId = String(row.document_id ?? '');
    if (!documentId) continue;
    const document = deps.getDocument(documentId);
    if (!document) continue;
    records.push({ ...document, projectId, addedAt: String(row.added_at ?? '') });
  }
  return records;
}
