import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { RUNTIME_FILE_NAME } from '@studianda/shared';
import { buildServer } from './server.js';
import { applyPendingRestore } from './backup.js';
import { hydrateMarkdownJobs } from './markdown-import.js';
import { SecretStore } from './secrets.js';
import { Store } from './store.js';

const VERSION = process.env.STUDIANDA_VERSION ?? '0.1.0';
const DEFAULT_DATA_DIR = path.join(homedir(), '.studianda');

interface CliOptions {
  dataDir?: string;
  port: number;
  printRuntime: boolean;
  check: boolean;
  help: boolean;
  version: boolean;
}

const USAGE = `Studianda Core（本地服务）

用法：node dist/index.js [选项]

选项：
  --data-dir <dir>   数据目录（默认 $STUDIANDA_DATA_DIR，其次 ~/.studianda）
  --port <n>         监听端口（默认 0 = 随机端口；只绑定 127.0.0.1）
  --print-runtime    就绪后把 {port,token,pid,version,startedAt} 作为 JSON 打到 stdout
  --check            只做数据目录/SQLite 自检，不监听端口（退出码 0/1）
  --version          打印版本号
  -h, --help         显示本帮助

环境变量：STUDIANDA_DATA_DIR、STUDIANDA_VERSION
`;

function parseCli(argv: string[]): CliOptions {
  const options: CliOptions = {
    port: 0,
    printRuntime: false,
    check: false,
    help: false,
    version: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--data-dir') {
      const value = argv[index + 1];
      if (!value) throw new Error('--data-dir 缺少参数');
      options.dataDir = path.resolve(value);
      index += 1;
    } else if (arg === '--port') {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 0 || value > 65535) {
        throw new Error('--port 需要 0–65535 的整数');
      }
      options.port = value;
      index += 1;
    } else if (arg === '--print-runtime') {
      options.printRuntime = true;
    } else if (arg === '--check') {
      options.check = true;
    } else if (arg === '--version') {
      options.version = true;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

function fail(message: string): never {
  console.error(`STUDIANDA_CORE_ERROR ${message}`);
  console.error(USAGE);
  process.exit(2);
}

const cli = (() => {
  try {
    return parseCli(process.argv.slice(2));
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
})();

if (cli.help) {
  console.log(USAGE);
  process.exit(0);
}
if (cli.version) {
  console.log(VERSION);
  process.exit(0);
}

const dataDir = cli.dataDir ?? process.env.STUDIANDA_DATA_DIR ?? DEFAULT_DATA_DIR;

// --check：只读自检（会打开 SQLite 并应用迁移，与正常启动一致），不监听端口、不写 runtime.json。
if (cli.check) {
  try {
    mkdirSync(dataDir, { recursive: true });
    const store = new Store(dataDir);
    try {
      const result = store.quickCheck();
      console.log(
        JSON.stringify({
          ok: true,
          application: 'studianda',
          version: VERSION,
          dataDir,
          quickCheck: result
        })
      );
    } finally {
      store.close();
    }
    process.exit(0);
  } catch (error) {
    console.error(
      JSON.stringify({
        ok: false,
        application: 'studianda',
        version: VERSION,
        dataDir,
        message: error instanceof Error ? error.message : String(error)
      })
    );
    process.exit(1);
  }
}

const token = randomBytes(24).toString('hex');

mkdirSync(dataDir, { recursive: true });
try {
  const restored = applyPendingRestore(dataDir);
  if (restored) {
    console.error(
      `STUDIANDA_RESTORE_APPLIED ${JSON.stringify({ backup: restored.restored, rollback: restored.rollbackDir })}`
    );
  }
} catch (error) {
  console.error('STUDIANDA_RESTORE_FAILED', error instanceof Error ? error.message : error);
  process.exit(1);
}
const store = new Store(dataDir);
// 读回上次 Markdown 导入/扫描任务快照：running → interrupted（不续跑）。
hydrateMarkdownJobs(store);
const secrets = new SecretStore();

let closing = false;
const app = buildServer({ token, version: VERSION, store, secrets, isClosing: () => closing });

const address = await app.listen({ host: '127.0.0.1', port: cli.port });
const port = new URL(address).port;

const runtime = {
  port: Number(port),
  token,
  pid: process.pid,
  version: VERSION,
  startedAt: new Date().toISOString()
};
const runtimePath = path.join(dataDir, RUNTIME_FILE_NAME);
writeFileSync(runtimePath, `${JSON.stringify(runtime, null, 2)}\n`, { mode: 0o600 });

// 只输出握手信息，方便 Electron/DSH 的父进程读取；--print-runtime 才输出含 token 的完整 JSON。
if (cli.printRuntime) {
  console.log(JSON.stringify(runtime));
} else {
  console.log(`STUDIANDA_CORE_READY ${JSON.stringify({ port: runtime.port, pid: runtime.pid })}`);
}

// 启动完成后跑一次笔记图片自动清理：restore-safe（保留已删除笔记的引用）+ 24h 宽限期，
// 内部失败吞掉，不阻断启动（详细规则见 Store.autoGcNoteAssets / gcNoteAssets）。
store.autoGcNoteAssets();

void store
  .reindexLegacyChunks()
  .catch((error) => console.error('STUDIANDA_REINDEX_FAILED', error instanceof Error ? error.message : error));

async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  try {
    await app.close();
    store.close();
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.on('disconnect', () => void shutdown());
