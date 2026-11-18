import type { DatabaseSync } from 'node:sqlite';
import type { NoteAssetReindexJob } from '@studianda/shared';
import {
  countAssetFiles,
  ensureAssetRecord,
  scanAssetFileBatches,
  type NoteAssetDeps,
  type NoteSourceKind
} from './store/note-assets.js';

/**
 * 后台分块资源索引重建器（从 Store 拆出）。
 *
 * 为什么独立成类：重建是**异步、分块、长任务**，而笔记/批注写入是**同步、单事务**的。
 * 把任务状态（job / running）与分块调度搬到这里后，Store 不再同时持有「同步 refs 同步
 * 逻辑」和「后台任务状态」两套东西，只保留 3 个薄委托方法。
 *
 * 行为与拆分前完全一致（不要顺手改）：
 * - phase 顺序：scanning → notes → annotations → finalizing；
 * - total = 目录文件数 + notes 行数 + annotations 行数，done 按实际处理项累加；
 * - 每批一个短事务并在批间让出事件循环；
 * - 失败时由 `start()` 捕获，status=error 且 error 带「资源索引重建失败：…」（截断 200 字）；
 * - 单并发：运行中重复 `start()` 直接返回当前任务快照。
 */

/** 重建器真正需要的依赖：note-assets 域依赖 + 一条来源的重同步回调。 */
export interface NoteAssetReindexerDeps extends NoteAssetDeps {
  /**
   * 单条来源的 refs 重同步。由 Store 注入为对 `Store.syncNoteAssetRefs` 的调用：
   * 同步写路径与后台重建共用同一份实现，也保留原来可替换（测试失败注入）的挂点。
   */
  syncSource: (kind: NoteSourceKind, sourceId: string, content: string) => void;
}

/** 无任务时的初始快照（status/phase 均为 idle）；每次返回副本，调用方改不到内部状态。 */
const IDLE_JOB: NoteAssetReindexJob = {
  status: 'idle',
  phase: 'idle',
  total: 0,
  done: 0,
  indexedFiles: 0,
  indexedRefs: 0,
  indexedAt: '',
  error: ''
};

export class NoteAssetReindexer {
  /** 后台重建任务状态（仅内存态，重启丢失 running 状态——与原实现一致）。 */
  private job: NoteAssetReindexJob = { ...IDLE_JOB };
  private running = false;

  constructor(
    private readonly db: DatabaseSync,
    private readonly deps: NoteAssetReindexerDeps
  ) {}

  /** 后台重建任务状态快照（无任务时 status/phase 为 idle）。 */
  status(): NoteAssetReindexJob {
    return { ...this.job };
  }

  /**
   * 触发后台分块重建资源索引（单并发）：目录文件、notes、annotations 分批处理，
   * 每批一个短事务并在批间让出事件循环，避免长时间阻塞请求。已运行则返回当前任务。
   */
  start(): NoteAssetReindexJob {
    if (this.running) return this.status();
    this.running = true;
    this.job = {
      status: 'running',
      phase: 'scanning',
      total: 0,
      done: 0,
      indexedFiles: 0,
      indexedRefs: 0,
      indexedAt: '',
      error: ''
    };
    void this.runOnce().catch((error) => {
      this.running = false;
      const message = error instanceof Error ? error.message : String(error);
      this.job = {
        ...this.job,
        status: 'error',
        error: `资源索引重建失败：${message.slice(0, 200)}`
      };
    });
    return this.status();
  }

  /** 后台分块重建的实现：目录 → notes → annotations → finalizing，每批 100 条。 */
  async runOnce(): Promise<void> {
    const batchSize = 100;
    // 单批内容总字节上限：防止 100 条旧笔记里塞满内联大图时整批进内存。
    // 单条内容超过上限时仍单独处理（无法拆开一条 Markdown）。
    const maxBatchContentBytes = 2 * 1024 * 1024;
    const db = this.db;
    const yieldToEventLoop = (): Promise<void> =>
      new Promise((resolve) => setImmediate(resolve));
    const count = (table: 'notes' | 'annotations'): number =>
      Number(
        (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: number } | undefined)?.n ??
          0
      );

    // 目录只做流式遍历：先数数量（用于进度分母），再分批登记，避免一次性把
    // 几十万/上百万个文件名和 Dirent 全部留在内存里。
    const assetFileCount = countAssetFiles(this.deps.assetDir);
    this.job = {
      ...this.job,
      phase: 'scanning',
      total: assetFileCount + count('notes') + count('annotations')
    };

    await scanAssetFileBatches(this.deps.assetDir, batchSize, (batch) => {
      if (batch.length === 0) return;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const name of batch) ensureAssetRecord(db, this.deps, name);
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
      this.job.done += batch.length;
    });

    // 先清空引用，再按批重建（后台任务允许最终一致，完成时全量 refs 已重建）。
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec('DELETE FROM note_asset_refs');
      db.exec("UPDATE note_assets SET ref_count = 0, last_referenced = ''");
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }

    const runSource = async (
      table: 'notes' | 'annotations',
      kind: NoteSourceKind,
      phase: 'notes' | 'annotations'
    ): Promise<void> => {
      this.job = { ...this.job, phase };
      let cursor = 0;
      while (true) {
        // 先取一批元数据（只含内容字节数），再按累计字节数挑出真正要处理的行；
        // 避免一次把 100 条超大笔记内容同时读进内存。
        const metaRows = db
          .prepare(
            `SELECT rowid AS rowid, id, LENGTH(CAST(content AS BLOB)) AS content_bytes
             FROM ${table}
             WHERE rowid > ? ORDER BY rowid LIMIT ?`
          )
          .all(cursor, batchSize) as unknown as Array<{
          rowid: number;
          id: string;
          content_bytes: number;
        }>;
        if (metaRows.length === 0) break;
        const selected: typeof metaRows = [];
        let selectedBytes = 0;
        for (const row of metaRows) {
          const bytes = Number(row.content_bytes ?? 0);
          if (selected.length > 0 && selectedBytes + bytes > maxBatchContentBytes) break;
          selected.push(row);
          selectedBytes += bytes;
          if (selectedBytes >= maxBatchContentBytes) break;
        }
        const ids = selected.map((row) => row.rowid);
        const rows = db
          .prepare(
            `SELECT rowid AS rowid, id, content FROM ${table}
             WHERE rowid IN (${ids.map(() => '?').join(', ')}) ORDER BY rowid`
          )
          .all(...ids) as unknown as Array<{
          rowid: number;
          id: string;
          content: string | null;
        }>;
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const row of rows) this.deps.syncSource(kind, row.id, row.content ?? '');
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        cursor = Number(selected[selected.length - 1]!.rowid);
        this.job.done += rows.length;
        await yieldToEventLoop();
      }
    };
    await runSource('notes', 'note', 'notes');
    await runSource('annotations', 'annotation', 'annotations');

    this.job = { ...this.job, phase: 'finalizing' };
    const refCount = Number(
      (db.prepare('SELECT COUNT(*) AS n FROM note_asset_refs').get() as { n?: number })?.n ?? 0
    );
    const indexedAt = this.deps.now();
    try {
      this.deps.updateSettings({
        'note_assets.indexed_at': indexedAt,
        'note_assets.indexed_files': String(assetFileCount),
        'note_assets.indexed_refs': String(refCount)
      });
    } catch {
      // 统计写入失败不影响重建结果。
    }
    this.job = {
      ...this.job,
      status: 'done',
      phase: 'finalizing',
      indexedFiles: assetFileCount,
      indexedRefs: refCount,
      indexedAt,
      error: ''
    };
    this.running = false;
  }
}
