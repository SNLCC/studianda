import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const electron = path.join(root, 'apps/desktop/node_modules/electron/dist/electron.exe');
const port = 9333;
const child = spawn(electron, [`--remote-debugging-port=${port}`, 'apps/desktop'], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
child.stdout?.on('data', (chunk) => (output += chunk.toString()));
child.stderr?.on('data', (chunk) => (output += chunk.toString()));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pageTarget() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const rows = await fetch(`http://127.0.0.1:${port}/json`).then((res) => res.json());
      const page = rows.find(
        (row) => row.type === 'page' && !String(row.url).startsWith('devtools://')
      );
      if (page) return page;
    } catch {
      // 窗口/调试端口尚未就绪
    }
    await sleep(500);
  }
  throw new Error('未找到可调试页面');
}

function evaluate(ws, expression) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP 超时')), 15_000);
    const listener = (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== 1) return;
      clearTimeout(timer);
      ws.removeEventListener('message', listener);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result?.result?.value);
    };
    ws.addEventListener('message', listener);
    ws.send(
      JSON.stringify({
        id: 1,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true }
      })
    );
  });
}

let exitCode = 1;
try {
  const target = await pageTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  const before = await evaluate(ws, 'window.studianda.windowControls.isMaximized()');
  await evaluate(ws, 'window.studianda.windowControls.toggleMaximize(); true');
  await sleep(800);
  const maximized = await evaluate(ws, 'window.studianda.windowControls.isMaximized()');
  await evaluate(ws, 'window.studianda.windowControls.toggleMaximize(); true');
  await sleep(800);
  const restored = await evaluate(ws, 'window.studianda.windowControls.isMaximized()');
  console.log(JSON.stringify({ before, maximized, restored }));
  if (before !== false || maximized !== true || restored !== false) {
    throw new Error('窗口最大化/还原状态不符合预期');
  }
  exitCode = 0;
  await evaluate(ws, 'window.studianda.windowControls.close(); true').catch(() => undefined);
  ws.close();
  await sleep(1200);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(output.slice(-2000));
} finally {
  if (!child.killed) child.kill();
  await sleep(500);
  process.exitCode = exitCode;
}
