import { mkdtempSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const token = 'agent-attribution-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-agent-attribution-'));
const store = new Store(dataDir);
const server = buildServer({ token, version: 'test', store, secrets: new SecretStore() });

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const headers = (): Record<string, string> => ({
  'x-studianda-token': token,
  'content-type': 'application/json'
});

describe('Agent 写入归属', () => {
  it('笔记与批注可写入 agent_name，读回带 agentName；用户写入为空', () => {
    const aiNote = store.createNote({
      documentId: '',
      page: 0,
      content: 'agent 写的笔记',
      origin: 'ai',
      agentName: 'DSH'
    });
    expect(aiNote.origin).toBe('ai');
    expect(aiNote.agentName).toBe('DSH');

    const userNote = store.createNote({ documentId: '', page: 0, content: '用户写的笔记' });
    expect(userNote.origin).toBe('user');
    expect(userNote.agentName).toBeUndefined();

    const aiAnnotation = store.createAnnotation({
      documentId: 'doc-any',
      page: 1,
      content: 'agent 写的批注',
      origin: 'ai',
      agentName: 'Claude Code'
    });
    expect(aiAnnotation.origin).toBe('ai');
    expect(aiAnnotation.agentName).toBe('Claude Code');

    const annotations = store.listAnnotations('doc-any');
    expect(annotations[0]?.agentName).toBe('Claude Code');
  });

  it('POST /notes 接受 agentName 并落库', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/api/v1/notes',
      headers: headers(),
      payload: { documentId: '', page: 0, content: '经 HTTP 写入', origin: 'ai', agentName: 'Codex' }
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { agentName?: string }).agentName).toBe('Codex');
  });

  it('schema 28：版本号、两列与两张 agent 表存在', () => {
    const db = new DatabaseSync(path.join(dataDir, 'reader.sqlite3'));
    const version = (
      db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as {
        value: string;
      }
    ).value;
    expect(version).toBe('28');
    const noteColumns = (db.prepare('PRAGMA table_info(notes)').all() as unknown as Array<{
      name: string;
    }>).map((row) => row.name);
    const annotationColumns = (
      db.prepare('PRAGMA table_info(annotations)').all() as unknown as Array<{ name: string }>
    ).map((row) => row.name);
    expect(noteColumns).toContain('agent_name');
    expect(annotationColumns).toContain('agent_name');
    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as Array<{
        name: string;
      }>
    ).map((row) => row.name);
    expect(tables).toContain('agent_grants');
    expect(tables).toContain('agent_operations');
    db.close();
  });
});
