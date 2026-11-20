import type { DatabaseSync } from 'node:sqlite';

/**
 * 统一事务入口：外层用 `BEGIN IMMEDIATE`，已在事务里则降级为 `SAVEPOINT`。
 *
 * 背景：领域函数（createNote / createAnnotation 等）各自管理事务，调用方以前不能再包一层；
 * P1 的变更集需要「一次 apply 包多条领域写」，所以引入可嵌套事务。所有新事务必须走这里，
 * 不要在领域函数里直接 `BEGIN`。
 */
export interface TransactionScope {
  commit(): void;
  rollback(): void;
}

let savepointSequence = 0;

function inTransaction(db: DatabaseSync): boolean {
  return Boolean((db as unknown as { isTransaction?: boolean }).isTransaction);
}

export function beginTransaction(db: DatabaseSync): TransactionScope {
  const nested = inTransaction(db);
  const name = `sp_${++savepointSequence}`;
  if (nested) db.exec(`SAVEPOINT ${name}`);
  else db.exec('BEGIN IMMEDIATE');
  let finished = false;
  return {
    commit() {
      if (finished) return;
      finished = true;
      if (nested) db.exec(`RELEASE SAVEPOINT ${name}`);
      else db.exec('COMMIT');
    },
    rollback() {
      if (finished) return;
      finished = true;
      if (nested) {
        try {
          db.exec(`ROLLBACK TO SAVEPOINT ${name}; RELEASE SAVEPOINT ${name}`);
        } catch {
          // 上层可能已经整体回滚；忽略重复回滚。
        }
      } else {
        try {
          db.exec('ROLLBACK');
        } catch {
          // SQLite 可能已自动回滚（如磁盘满）；忽略二次回滚错误。
        }
      }
    }
  };
}

export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  const scope = beginTransaction(db);
  try {
    const value = fn();
    scope.commit();
    return value;
  } catch (error) {
    scope.rollback();
    throw error;
  }
}
