import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';

/**
 * 笔记的 externalKey 去重：同一 documentId 内同一 externalKey 只保留一条（未删除）。
 *
 * 用于「回答存为笔记」等重复保存场景：重复点击/刷新后再保存应返回已有笔记，而不是新增一条。
 * 同时覆盖 HTTP 路由是否把 externalKey 透传到 store。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-note-ext-'));
const store = new Store(dataDir);
const server = buildServer({
  token: 'note-ext-token',
  version: 'test-version',
  store,
  secrets: new SecretStore()
});

beforeAll(() => {});

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('createNote externalKey 去重', () => {
  it('同一 externalKey 重复创建返回已有笔记，不新增', () => {
    const first = store.createNote({
      documentId: '',
      page: 0,
      content: '回答内容一',
      externalKey: 'chat-answer:session-1:42'
    });
    const second = store.createNote({
      documentId: '',
      page: 0,
      content: '回答内容一',
      externalKey: 'chat-answer:session-1:42'
    });
    expect(second.id).toBe(first.id);
    expect(
      store
        .listStandaloneNotes()
        .filter((note) => note.content === '回答内容一')
    ).toHaveLength(1);
  });

  it('不同 externalKey 正常创建两条', () => {
    store.createNote({
      documentId: '',
      page: 0,
      content: '回答内容二',
      externalKey: 'chat-answer:session-2:1'
    });
    store.createNote({
      documentId: '',
      page: 0,
      content: '回答内容二',
      externalKey: 'chat-answer:session-2:2'
    });
    expect(
      store.listStandaloneNotes().filter((note) => note.content === '回答内容二')
    ).toHaveLength(2);
  });

  it('已删除的旧笔记不参与去重，允许重新保存', () => {
    const first = store.createNote({
      documentId: '',
      page: 0,
      content: '回答内容三',
      externalKey: 'chat-answer:session-3:7'
    });
    store.deleteNote(first.id);
    const second = store.createNote({
      documentId: '',
      page: 0,
      content: '回答内容三',
      externalKey: 'chat-answer:session-3:7'
    });
    expect(second.id).not.toBe(first.id);
    expect(
      store
        .listStandaloneNotes()
        .filter((note) => note.content === '回答内容三')
    ).toHaveLength(1);
  });

  it('POST /notes 透传 externalKey：重复请求返回同一条笔记', async () => {
    const payload = {
      documentId: '',
      page: 0,
      content: 'HTTP 回答存为笔记',
      externalKey: 'chat-answer:session-http:99'
    };
    const headers = { 'x-studianda-token': 'note-ext-token' };
    const first = await server.inject({
      method: 'POST',
      url: '/api/v1/notes',
      headers,
      payload
    });
    const second = await server.inject({
      method: 'POST',
      url: '/api/v1/notes',
      headers,
      payload
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect((second.json() as { id: string }).id).toBe((first.json() as { id: string }).id);
    expect(
      store.listStandaloneNotes().filter((note) => note.content === 'HTTP 回答存为笔记')
    ).toHaveLength(1);
  });
});
