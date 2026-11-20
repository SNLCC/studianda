import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentJobRecord } from '@studianda/shared';
import { SecretStore } from '../src/secrets.js';
import { buildServer } from '../src/server.js';
import { Store } from '../src/store.js';

const TEST_PDF =
  process.env.STUDIANDA_TEST_PDF ?? path.resolve(import.meta.dirname, 'fixtures/sample-paper.pdf');
const token = 'agent-jobs-token';
const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-agent-jobs-'));
const store = new Store(dataDir);
const server = buildServer({ token, version: 'test', store, secrets: new SecretStore() });
let documentId = '';

beforeAll(async () => {
  documentId = (await store.importDocument(TEST_PDF)).id;
});

afterAll(async () => {
  await server.close();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const headers = (): Record<string, string> => ({
  'x-studianda-token': token,
  'content-type': 'application/json'
});

describe('Agent 长任务持久化', () => {
  it('创建/归属/完成/列表；needs_confirmation 是独立状态', async () => {
    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/agent/jobs',
      headers: headers(),
      payload: {
        kind: 'ask',
        agentName: 'dsh',
        documentId,
        question: '这篇文章说什么？'
      }
    });
    expect(created.statusCode).toBe(200);
    const job = created.json() as AgentJobRecord;
    expect(job.status).toBe('running');

    const other = await server.inject({
      method: 'GET',
      url: `/api/v1/agent/jobs/${job.id}?agent=claude`,
      headers: headers()
    });
    expect(other.statusCode).toBe(404);

    const finished = await server.inject({
      method: 'POST',
      url: `/api/v1/agent/jobs/${job.id}/finish`,
      headers: headers(),
      payload: {
        agentName: 'dsh',
        status: 'needs_confirmation',
        result: { needs_confirmation: true }
      }
    });
    expect((finished.json() as AgentJobRecord).status).toBe('needs_confirmation');

    const read = await server.inject({
      method: 'GET',
      url: `/api/v1/agent/jobs/${job.id}?agent=dsh`,
      headers: headers()
    });
    expect(read.json()).toMatchObject({
      status: 'needs_confirmation',
      result: { needs_confirmation: true }
    });

    const list = await server.inject({
      method: 'GET',
      url: '/api/v1/agent/jobs?agent=dsh',
      headers: headers()
    });
    expect((list.json() as AgentJobRecord[]).some((row) => row.id === job.id)).toBe(true);
  });

  it('cancel 只能由 owner 执行；启动时 running 会标 interrupted', async () => {
    const ocr = await server.inject({
      method: 'POST',
      url: '/api/v1/agent/jobs',
      headers: headers(),
      payload: { kind: 'ocr', agentName: 'dsh', documentId, pages: [1, 2] }
    });
    expect(ocr.statusCode).toBe(200);
    expect((ocr.json() as AgentJobRecord).status).toBe('running');

    const corpus = await server.inject({
      method: 'POST',
      url: '/api/v1/agent/jobs',
      headers: headers(),
      payload: {
        kind: 'corpus_ask',
        agentName: 'dsh',
        documentId,
        question: '共同点？',
        document_ids: [documentId]
      }
    });
    expect(corpus.statusCode).toBe(200);
    expect((corpus.json() as AgentJobRecord).status).toBe('running');

    const embed = await server.inject({
      method: 'POST',
      url: '/api/v1/agent/jobs',
      headers: headers(),
      payload: { kind: 'embed', agentName: 'dsh' }
    });
    expect(embed.statusCode).toBe(200);
    expect((embed.json() as AgentJobRecord).status).toBe('running');

    const created = await server.inject({
      method: 'POST',
      url: '/api/v1/agent/jobs',
      headers: headers(),
      payload: { kind: 'ask', agentName: 'dsh', documentId, question: 'q' }
    });
    const job = created.json() as AgentJobRecord;
    const denied = await server.inject({
      method: 'POST',
      url: `/api/v1/agent/jobs/${job.id}/cancel`,
      headers: headers(),
      payload: { agentName: 'claude' }
    });
    expect(denied.statusCode).toBe(404);
    const cancelled = await server.inject({
      method: 'POST',
      url: `/api/v1/agent/jobs/${job.id}/cancel`,
      headers: headers(),
      payload: { agentName: 'dsh' }
    });
    expect((cancelled.json() as AgentJobRecord).status).toBe('cancelled');

    const running = await server.inject({
      method: 'POST',
      url: '/api/v1/agent/jobs',
      headers: headers(),
      payload: { kind: 'ask', agentName: 'dsh', documentId, question: 'interrupt me' }
    });
    const runningJob = running.json() as AgentJobRecord;
    store.markAgentJobsInterrupted();
    expect(store.getAgentJob(runningJob.id)?.status).toBe('interrupted');
  });
});
