/** 富文本表格编辑：把「在光标处插行/插列/删行/删列」规划成纯数据，便于测试与实际 DOM 操作。 */

export type TableEditAction =
  | 'row-above'
  | 'row-below'
  | 'column-left'
  | 'column-right'
  | 'delete-row'
  | 'delete-column';

export interface TableEditState {
  rowCount: number;
  columnCount: number;
  /** 当前单元格的行/列下标（0-based）。 */
  rowIndex: number;
  columnIndex: number;
}

export type TableEditPlan =
  | {
      kind: 'insert-row';
      /** 新行插入到该下标（0..rowCount）。 */
      rowIndex: number;
    }
  | {
      kind: 'insert-column';
      /** 新列插入到该下标（0..columnCount）。 */
      columnIndex: number;
    }
  | {
      kind: 'delete-row';
      /** 要删除的行下标。 */
      rowIndex: number;
      /** 删除后把光标放到该行的第一个单元格（已夹到有效范围）。 */
      focusRowIndex: number;
    }
  | {
      kind: 'delete-column';
      columnIndex: number;
      focusColumnIndex: number;
    }
  | { kind: 'remove-table' };

/**
 * 计算表格编辑计划；所有下标都夹到合法范围，空/只有一行一列时删除等于移除整张表。
 */
export function planTableEdit(edit: TableEditAction, state: TableEditState): TableEditPlan {
  const rowCount = Math.max(1, state.rowCount);
  const columnCount = Math.max(1, state.columnCount);
  const rowIndex = Math.max(0, Math.min(state.rowIndex, rowCount - 1));
  const columnIndex = Math.max(0, Math.min(state.columnIndex, columnCount - 1));
  switch (edit) {
    case 'row-above':
      return { kind: 'insert-row', rowIndex };
    case 'row-below':
      return { kind: 'insert-row', rowIndex: rowIndex + 1 };
    case 'column-left':
      return { kind: 'insert-column', columnIndex };
    case 'column-right':
      return { kind: 'insert-column', columnIndex: columnIndex + 1 };
    case 'delete-row':
      if (rowCount <= 1) return { kind: 'remove-table' };
      return {
        kind: 'delete-row',
        rowIndex,
        focusRowIndex: Math.min(rowIndex, rowCount - 2)
      };
    case 'delete-column':
      if (columnCount <= 1) return { kind: 'remove-table' };
      return {
        kind: 'delete-column',
        columnIndex,
        focusColumnIndex: Math.min(columnIndex, columnCount - 2)
      };
    default:
      return { kind: 'remove-table' };
  }
}
