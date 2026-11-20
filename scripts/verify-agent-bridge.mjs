#!/usr/bin/env node
/**
 * Agent bridge 端到端验证（需要先构建 core 与 bridge）：
 * 1. 在临时资料目录启动真实 Core；
 * 2. 用 MCP SDK 拉起 `packages/agent-bridge/dist/agent-bridge.mjs`；
 * 3. 验证 tools/list、scope=none 的标题列表、写入 scope=library 后的读取、撤销；
 * 4. 关闭 Core、清理临时目录。
 *
 * 用法：node scripts/verify-agent-bridge.mjs
 *       node scripts/verify-agent-bridge.mjs --bridge <打包后的 agent-bridge.mjs>
 *
 * 默认验证 `packages/agent-bridge/dist/agent-bridge.mjs`；传 `--bridge` 可验证安装包
 * `resources/agent-bridge.mjs` 这个真正随包分发的文件。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const coreEntry = path.join(root, 'packages', 'core', 'dist', 'index.js');
const bridgeFlag = process.argv.indexOf('--bridge');
const bridgeEntry =
  bridgeFlag >= 0
    ? path.resolve(process.argv[bridgeFlag + 1] ?? '')
    : path.join(root, 'packages', 'agent-bridge', 'dist', 'agent-bridge.mjs');
const sdkClient = path.join(
  root,
  'packages',
  'agent-bridge',
  'node_modules',
  '@modelcontextprotocol',
  'sdk',
  'dist',
  'esm',
  'client',
  'index.js'
);
const sdkStdio = path.join(
  root,
  'packages',
  'agent-bridge',
  'node_modules',
  '@modelcontextprotocol',
  'sdk',
  'dist',
  'esm',
  'client',
  'stdio.js'
);

for (const entry of [coreEntry, bridgeEntry]) {
  if (!existsSync(entry)) {
    console.error(`缺少构建产物：${entry}\n先跑 pnpm build:core 与 pnpm --filter @studianda/agent-bridge build`);
    process.exit(1);
  }
}

const { Client } = await import(pathToFileURL(sdkClient).href);
const { StdioClientTransport } = await import(pathToFileURL(sdkStdio).href);

const dir = mkdtempSync(path.join(tmpdir(), 'studianda-bridge-verify-'));
const core = spawn(process.execPath, [coreEntry, '--data-dir', dir, '--port', '0', '--print-runtime'], {
  stdio: ['ignore', 'pipe', 'pipe']
});
core.stdout.on('data', () => {});
core.stderr.on('data', (chunk) => process.stderr.write(`[core] ${chunk}`));

const deadline = Date.now() + 20_000;
while (!existsSync(path.join(dir, 'runtime.json'))) {
  if (Date.now() > deadline) throw new Error('Core 未在 20s 内写出 runtime.json');
  await new Promise((resolve) => setTimeout(resolve, 50));
}
const runtime = JSON.parse(
  await import('node:fs').then(({ readFileSync }) => readFileSync(path.join(dir, 'runtime.json'), 'utf8'))
);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [bridgeEntry],
  env: { STUDIANDA_DATA_DIR: dir },
  stderr: 'pipe'
});
const client = new Client({ name: 'verify-agent-bridge', version: '0' });
const failures = [];
const check = (condition, message) => {
  if (condition) console.log(`  ok  ${message}`);
  else {
    failures.push(message);
    console.error(`  FAIL ${message}`);
  }
};
const text = (result) =>
  (result.content ?? []).map((block) => block.text ?? '').join('\n');

try {
  await client.connect(transport);
  const tools = await client.listTools();
  check(
    tools.tools.map((tool) => tool.name).includes('library'),
    'tools/list 含 library'
  );

  const scopeNone = await client.callTool({ name: 'scope', arguments: { action: 'get' } });
  check(text(scopeNone).includes('"kind": "none"'), '默认 scope=none');

  const listNone = await client.callTool({ name: 'library', arguments: { action: 'list' } });
  check(listNone.isError !== true, 'scope=none 时 library.list 不报错（只回标题）');

  const put = await fetch(`http://127.0.0.1:${runtime.port}/api/v1/agent/scope`, {
    method: 'PUT',
    headers: { 'x-studianda-token': runtime.token, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'library' })
  });
  check(put.ok, 'PUT /agent/scope 写入 library');
  const saved = await put.json();
  check(saved.kind === 'library' && Array.isArray(saved.caps) && saved.caps.includes('read'), 'scope 返回 caps=read');

  const listLibrary = await client.callTool({ name: 'library', arguments: { action: 'list', limit: 5 } });
  check(listLibrary.isError !== true, 'scope=library 时 library.list 正常');

  const denied = await client.callTool({
    name: 'library',
    arguments: { action: 'pages', document_id: 'missing-doc', from: 1, to: 1 }
  });
  check(denied.isError === true, '不存在文献时工具返回错误（不崩溃）');

  const del = await fetch(`http://127.0.0.1:${runtime.port}/api/v1/agent/scope`, {
    method: 'DELETE',
    headers: { 'x-studianda-token': runtime.token }
  });
  check(del.ok, 'DELETE /agent/scope 撤销');
} finally {
  await client.close().catch(() => undefined);
  core.kill();
  await new Promise((resolve) => setTimeout(resolve, 200));
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows 偶发占用，忽略
  }
}

if (failures.length > 0) {
  console.error(`[verify-agent-bridge] FAIL（${failures.length}）`);
  process.exit(1);
}
console.log('[verify-agent-bridge] PASS');
