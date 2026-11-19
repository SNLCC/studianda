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

describe('listReadingTasks 与翻译任务共用 reading_tasks 表', () => {
  it('默认会带出同文档的翻译任务行（特征化：没有问答字段，界面按 unreadPages 过滤）', () => {
    store.saveReadingTask(
      'qa-task-doc-mix',
      { question: '这本书讲了什么？', pagesRead: [1], unread_pages: [2, 3] },
      ['doc-mix']
    );
    store.saveReadingTask(
      'qa-task-other-doc',
      { question: '别的文献', pagesRead: [], unread_pages: [1] },
      ['doc-other']
    );
    store.saveTranslationJob({
      documentId: 'doc-mix',
      status: 'running',
      total: 10,
      done: 3,
      currentPage: 4,
      error: ''
    });

    const listed = store.listReadingTasks('doc-mix');
    const ids = listed.map((task) => task.taskId);
    // 现状：只按 documents 过滤、不看 key 前缀，所以翻译任务行也在列表里。
    expect(ids).toEqual(expect.arrayContaining(['qa-task-doc-mix', 'translation-job:doc-mix']));
    expect(ids).not.toContain('qa-task-other-doc');
    expect(listed.find((task) => task.taskId === 'translation-job:doc-mix')).toMatchObject({
      question: '',
      pagesRead: [],
      unreadPages: [],
      answer: ''
    });
    // 界面传给 ChatPanel 前按 unreadPages 非空过滤：翻译任务行恒为空，用户看不到。
    expect(listed.filter((task) => task.unreadPages.length > 0).map((task) => task.taskId)).toEqual(
      ['qa-task-doc-mix']
    );
  });

  it("kind:'reading' 可显式收窄到问答任务（opt-in，默认行为不变）", () => {
    store.saveReadingTask(
      'qa-task-doc-narrow',
      { question: '收窄测试', pagesRead: [1], unread_pages: [2] },
      ['doc-narrow']
    );
    store.saveTranslationJob({
      documentId: 'doc-narrow',
      status: 'done',
      total: 5,
      done: 5,
      currentPage: null,
      error: ''
    });

    expect(store.listReadingTasks('doc-narrow').map((task) => task.taskId)).toEqual(
      expect.arrayContaining(['qa-task-doc-narrow', 'translation-job:doc-narrow'])
    );
    expect(
      store.listReadingTasks('doc-narrow', { kind: 'reading' }).map((task) => task.taskId)
    ).toEqual(['qa-task-doc-narrow']);
    // 显式传 'all' 与默认行为一致。
    expect(store.listReadingTasks('doc-narrow', { kind: 'all' }).length).toBe(2);
  });
});
