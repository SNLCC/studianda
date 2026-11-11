import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-reading-task-'));
const store = new Store(dataDir);

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('reading task persistence', () => {
  it('saves, overwrites, loads and deletes a task payload', () => {
    store.saveReadingTask('task-1', { question: 'q', pagesRead: [1, 2] }, ['doc-1']);
    expect(store.loadReadingTask('task-1')).toMatchObject({
      payload: { question: 'q', pagesRead: [1, 2] },
      documents: ['doc-1']
    });

    store.saveReadingTask('task-1', { question: 'q', pagesRead: [1, 2, 3] }, ['doc-1']);
    expect(store.loadReadingTask('task-1')?.payload).toEqual({
      question: 'q',
      pagesRead: [1, 2, 3]
    });

    store.deleteReadingTask('task-1');
    expect(store.loadReadingTask('task-1')).toBeNull();
  });

  it('returns null for an unknown or invalid task', () => {
    expect(store.loadReadingTask('missing')).toBeNull();
  });
});
