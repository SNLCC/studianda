import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { answerQuestion } from '../src/chat.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

/**
 * 真实模型自动化回归（默认跳过，避免 CI/本机无密钥时误跑、产生费用）。
 *
 * 运行方式（PowerShell 示例）：
 *   $env:STUDIANDA_REAL_MODEL_TEST='1'
 *   $env:STUDIANDA_MODEL_BASE_URL='https://api.example.com/v1'
 *   $env:STUDIANDA_MODEL_NAME='your-chat-model'
 *   $env:STUDIANDA_MODEL_API_KEY='sk-...'
 *   pnpm.cmd --filter @studianda/core exec vitest run test/real-model-regression.test.ts
 *
 * 覆盖两条主链路：单篇阅读（answer_mode=reading）与库内检索（answer_mode=library）。
 * 断言只做「有非空回答、没有抛错」，不比对具体措辞；模型输出天然不确定，不能断言固定文本。
 */
const enabled =
  process.env.STUDIANDA_REAL_MODEL_TEST === '1' &&
  Boolean(process.env.STUDIANDA_MODEL_BASE_URL?.trim()) &&
  Boolean(process.env.STUDIANDA_MODEL_NAME?.trim());

describe.skipIf(!enabled)('真实模型回归（需显式开启）', () => {
  let dataDir = '';
  let store: Store;
  const secrets = new SecretStore();
  let documentId = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-real-model-'));
    store = new Store(dataDir);
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage([400, 500]);
    page.drawText('Value belief is defined in contrast to mere opinion.', {
      x: 30,
      y: 440,
      size: 10,
      font
    });
    page.drawText('The second half discusses how value belief is measured.', {
      x: 30,
      y: 420,
      size: 10,
      font
    });
    const file = path.join(dataDir, 'real-model.pdf');
    writeFileSync(file, await pdf.save());
    documentId = (await store.importDocument(file, undefined, true)).id;
    await store.savePageTextEdit(
      documentId,
      1,
      '第一页：价值信念在文中与单纯意见区分开，测量口径见调查题项。Value belief is measured in surveys.'
    );
  });

  afterAll(() => {
    store?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it('单篇阅读：真实模型返回非空回答', async () => {
    const response = await answerQuestion(store, secrets, {
      question: '这篇文献如何定义价值信念？',
      documentId,
      page: 1,
      reading_scope: 'local',
      reading_rigor: 'fast',
      source_policy: 'document_only'
    });
    expect(response.answer?.trim().length ?? 0).toBeGreaterThan(0);
    expect(response.answer_mode).toBe('reading');
    console.log('[real-model] reading answer chars=', response.answer?.length ?? 0);
  }, 300_000);

  it('库内检索：真实模型返回非空回答', async () => {
    const response = await answerQuestion(store, secrets, {
      question: '价值信念的测量口径是什么？',
      source_policy: 'document_only'
    });
    expect(response.answer?.trim().length ?? 0).toBeGreaterThan(0);
    expect(response.answer_mode).toBe('library');
    console.log('[real-model] library answer chars=', response.answer?.length ?? 0);
  }, 300_000);
});
