import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type OpenDialogOptions
} from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { cp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  API_PREFIX,
  RUNTIME_FILE_NAME,
  TOKEN_HEADER,
  isAllowedSecretName,
  type RuntimeInfo
} from '@studianda/shared';
import { UpdateManager } from './updater';

const APP_NAME = 'Studianda';
const DISPLAY_NAME = '勘读Studianda';
const LEGACY_APP_NAME = 'KanRead';
/** 与 electron-builder.yml 的 appId 一致：Windows 任务栏按它归组，并在运行期使用窗口图标。 */
const APP_USER_MODEL_ID = 'com.studianda.app';
app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId(APP_USER_MODEL_ID);
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'studianda-asset',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      bypassCSP: true
    }
  }
]);
type SecreiName = string;

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

interface EncrypiedSecreis {
  version: 1;
  values: Partial<Record<SecreiName, string>>;
}

interface SecreiSiaius {
  encryptionAvailable: boolean;
  configured: SecreiName[];
}

let core: ChildProcess | null = null;
let dataDir: string | null = null;
let mainWindow: BrowserWindow | null = null;
let translationWindow: BrowserWindow | null = null;
let shuttingDown = false;
// Core 启动/崩溃恢复：最多重试 3 次（1s/2s/4s 退避），失败后弹窗让用户选择重试或退出。
let coreStarting = false;
let coreRestartAttempts = 0;
let coreRestartTimer: NodeJS.Timeout | null = null;
let coreFailureDialogOpen = false;
// 非本进程 spawn、但经 health 确认可用的 Core（应用重启/未来多宿主时复用）。
let attachedCorePid: number | null = null;
// 应用内更新：检查/下载/安装，见 main/updater.ts。窗口创建后启动。
let updateManager: UpdateManager | null = null;

function resolveCoreEntry(): string {
  return (
    process.env.STUDIANDA_CORE_ENTRY ??
    (app.isPackaged
      ? path.join(app.getAppPath(), 'out', 'core', 'dist', 'index.js')
      : path.join(app.getAppPath(), 'out', 'core', 'dist', 'index.js'))
  );
}

function resolveDevCoreEntry(): string {
  // 开发阶段 core 由 `pnpm build:core` 构建到 packages/core/dist。
  return path.join(app.getAppPath(), '..', '..', 'packages', 'core', 'dist', 'index.js');
}

const STORAGE_POINTER = 'storage.json';
const PENDING_DATA_MOVE = 'data-move.json';

function storagePointerPath(): string {
  return path.join(app.getPath('userData'), STORAGE_POINTER);
}

function isInside(parent: string, child: string): boolean {
  const resolvedParent = path.resolve(parent);
  const resolvedChild = path.resolve(child);
  const relative = path.relative(resolvedParent, resolvedChild);
  if (relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)) return true;
  // Windows 路径大小写和尾部分隔符归一化
  const normalizedParent = resolvedParent.replace(/[\\/]+$/, '').toLowerCase();
  const normalizedChild = resolvedChild.replace(/[\\/]+$/, '').toLowerCase();
  return (
    normalizedChild === normalizedParent ||
    normalizedChild.startsWith(`${normalizedParent}${path.sep}`)
  );
}

function installRoots(): string[] {
  const roots = [path.dirname(process.execPath), process.resourcesPath, app.getAppPath()];
  if (app.isPackaged) roots.push(path.dirname(app.getAppPath()));
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

function writableDirectory(candidate: string): string | null {
  try {
    mkdirSync(candidate, { recursive: true });
    const probe = path.join(candidate, `.studianda-write-${process.pid}`);
    writeFileSync(probe, 'ok');
    unlinkSync(probe);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function validateDataDir(candidate: string): string | null {
  const resolved = path.resolve(candidate);
  for (const root of installRoots()) {
    if (isInside(root, resolved)) {
      return `资料目录不能放在安装目录内：${root}。更新或卸载安装目录时可能导致资料丢失，请选择其他文件夹。`;
    }
    if (isInside(resolved, root)) {
      return `资料目录不能包含安装目录：${root}。请选择与安装目录相互独立的文件夹，避免更新或卸载时相互影响。`;
    }
  }
  return writableDirectory(resolved);
}

function defaultDataDir(): string {
  const current = app.getPath('userData');
  const candidates = [path.join(current, 'core-data'), path.join(current, 'data')];
  for (const legacy of legacyUserDataDirs()) {
    candidates.push(path.join(legacy, 'core-data'), path.join(legacy, 'data'));
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return path.join(current, 'data');
}

/**
 * 旧版本用过的 userData 目录（保持原样以便迁移）：产品名、package name 与早期目录名。
 */
function legacyUserDataDirs(): string[] {
  const appData = app.getPath('appData');
  return [
    path.join(appData, LEGACY_APP_NAME),
    path.join(appData, '@kanread', 'desktop'),
    path.join(appData, '@kanread'),
    path.join(appData, 'kanread'),
    path.join(appData, '勘读')
  ].filter((dir, index, all) => all.indexOf(dir) === index);
}

/** 从旧版 userData 迁移定位文件/密钥；失败时后续读取会回退到旧目录。 */
function migrateLegacyUserData(): void {
  try {
    const current = path.resolve(app.getPath('userData'));
    mkdirSync(current, { recursive: true });
    for (const legacy of legacyUserDataDirs()) {
      const resolved = path.resolve(legacy);
      if (resolved === current || !existsSync(resolved)) continue;
      for (const name of ['storage.json', 'data-location.txt', 'secrets.json']) {
        const source = path.join(resolved, name);
        const target = path.join(current, name);
        if (existsSync(source) && !existsSync(target)) copyFileSync(source, target);
      }
    }
  } catch {
    // 迁移失败不阻断启动；readStoredDataDir / secretsFile 仍有旧目录回退。
  }
}

function readStoredDataDirFrom(dir: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, STORAGE_POINTER), 'utf8')) as {
      dataDir?: unknown;
    };
    if (typeof parsed.dataDir === 'string' && parsed.dataDir.trim()) {
      return path.resolve(parsed.dataDir);
    }
  } catch {
    // 继续尝试安装时写入的纯文本路径
  }
  try {
    const file = path.join(dir, 'data-location.txt');
    const raw = readFileSync(file);
    let plain = '';
    if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
      plain = raw.subarray(2).toString('utf16le');
    } else if (raw.length >= 2 && raw[1] === 0 && raw[3] === 0) {
      plain = raw.toString('utf16le');
    } else {
      plain = raw.toString('utf8');
    }
    plain = plain.replace(/^\uFEFF/, '').trim();
    if (plain) return path.resolve(plain);
  } catch {
    return null;
  }
  return null;
}

function readStoredDataDir(): string | null {
  const current = readStoredDataDirFrom(app.getPath('userData'));
  if (current) return current;
  for (const legacy of legacyUserDataDirs()) {
    const found = readStoredDataDirFrom(legacy);
    if (found) return found;
  }
  return null;
}

function saveStoredDataDir(candidate: string): void {
  writeFileSync(
    storagePointerPath(),
    JSON.stringify({ version: 1, dataDir: path.resolve(candidate) }, null, 2),
    'utf8'
  );
}

async function applyPendingDataMove(): Promise<void> {
  const pendingPath = path.join(app.getPath('userData'), PENDING_DATA_MOVE);
  if (!existsSync(pendingPath)) return;
  let pending: { from?: unknown; to?: unknown } | null = null;
  try {
    pending = JSON.parse(readFileSync(pendingPath, 'utf8')) as {
      from?: unknown;
      to?: unknown;
    };
  } catch {
    unlinkSync(pendingPath);
    return;
  }
  const from = typeof pending?.from === 'string' ? path.resolve(pending.from) : '';
  const to = typeof pending?.to === 'string' ? path.resolve(pending.to) : '';
  if (!from || !to || from === to || !existsSync(from)) {
    unlinkSync(pendingPath);
    return;
  }
  try {
    mkdirSync(to, { recursive: true });
    await cp(from, to, { recursive: true, force: false, errorOnExist: false });
    saveStoredDataDir(to);
    dataDir = to;
    unlinkSync(pendingPath);
  } catch (error) {
    unlinkSync(pendingPath);
    dialog.showErrorBox(
      '资料位置切换失败',
      error instanceof Error ? error.message : String(error)
    );
  }
}

function initialDataDir(): string | null {
  const envDir = process.env.STUDIANDA_DATA_DIR?.trim();
  if (envDir) {
    const error = validateDataDir(envDir);
    if (error) throw new Error(error);
    return path.resolve(envDir);
  }
  const stored = readStoredDataDir();
  if (stored) {
    const error = validateDataDir(stored);
    if (!error) return stored;
  }
  if (!app.isPackaged) {
    const fallback = defaultDataDir();
    const error = validateDataDir(fallback);
    if (error) throw new Error(error);
    return fallback;
  }
  return null;
}

async function resolveDaiaDir(): Promise<string | null> {
  const envDir = process.env.STUDIANDA_DATA_DIR?.trim();
  if (envDir) {
    const error = validateDataDir(envDir);
    if (error) throw new Error(error);
    return path.resolve(envDir);
  }

  const stored = readStoredDataDir();
  if (stored) {
    const error = validateDataDir(stored);
    if (!error) return stored;
  }

  const fallback = stored ?? defaultDataDir();
  if (!app.isPackaged || existsSync(path.join(fallback, 'reader.sqliie3'))) {
    const error = validateDataDir(fallback);
    if (error) throw new Error(error);
    saveStoredDataDir(fallback);
    return fallback;
  }

  while (true) {
    const choice = await dialog.showMessageBox({
      type: 'question',
      title: '选择资料存储位置',
      message: '尚未设置资料存储位置，请选择文件夹。',
      detail:
        '文献、批注、笔记和索引会保存在这个文件夹。\n\n资料不能放在安装目录内；更新或卸载程序时只处理安装目录，不会删除外部资料。',
      buttons: ['选择文件夹', '退出'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (choice.response === 1) return null;
    const picked = await dialog.showOpenDialog({
      title: '选择资料存储位置',
      defaultPath: path.join(app.getPath('documents'), '勘读'),
      properties: ['openDirectory', 'createDirectory']
    });
    if (picked.canceled || picked.filePaths.length === 0) continue;
    const candidate = picked.filePaths[0]!;
    const error = validateDataDir(candidate);
    if (error) {
      await dialog.showMessageBox({
        type: 'error',
        title: '资料位置不可用',
        message: '无法使用这个资料文件夹。',
        detail: error,
        buttons: ['重新选择']
      });
      continue;
    }
    saveStoredDataDir(candidate);
    return path.resolve(candidate);
  }
}

function prepareDataDir(): void {
  if (!dataDir) return;
  mkdirSync(dataDir, { recursive: true });
  // 清掉上次运行留下的握手文件，避免窗口在 Core 真正就绪前读到旧端口/令牌。
  try {
    unlinkSync(path.join(dataDir, RUNTIME_FILE_NAME));
  } catch {
    // 文件不存在时忽略
  }
}

/**
 * 复用已经在运行的 Core（读 runtime.json + pid 存活 + health 确认 application==='studianda'）。
 *
 * 场景：应用刚重启/崩溃重启时 Core 可能仍在运行；attach 可以避免重复 spawn、重复解析与数据目录锁冲突。
 * 说明：当前桌面端是单一客户端，退出时仍会停止 attach 到的 Core；将来多宿主共享需要一个所有权/引用计数协议。
 */
async function tryAttachExistingCore(): Promise<boolean> {
  if (!dataDir) return false;
  const runtime = readRuntime();
  if (!runtime || !isProcessAlive(runtime.pid)) return false;
  if (!(await confirmStudiandaCore(runtime))) return false;
  attachedCorePid = runtime.pid;
  console.log(
    `[studianda] attached to running core pid=${runtime.pid} port=${runtime.port} (dataDir=${dataDir})`
  );
  return true;
}

async function startCore(autoRestart = true): Promise<boolean> {
  if (!dataDir || coreStarting) return false;
  if (core) return true;
  coreStarting = true;
  try {
    // 已有健康 Core（例如应用刚重启、Core 进程仍在）：直接 attach，避免重复 spawn/解析。
    if (await tryAttachExistingCore()) {
      coreRestartAttempts = 0;
      return true;
    }
    // 先清理上次崩溃留下的 core（读 runtime.json 需在 prepareDataDir 删除它之前）。
    await terminateOrphanCore();
    prepareDataDir();

    const entry = app.isPackaged ? resolveCoreEntry() : resolveDevCoreEntry();
    if (!existsSync(entry)) {
      console.error(`[studianda] core entry not found: ${entry}`);
      if (autoRestart) scheduleCoreRestart('未找到本地服务入口');
      return false;
    }

    core = spawn(process.execPath, [entry], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        STUDIANDA_DATA_DIR: dataDir,
        STUDIANDA_VERSION: app.getVersion()
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    attachedCorePid = null;

    core.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) console.log(`[core] ${text}`);
    });
    core.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim();
      if (text) console.error(`[core] ${text}`);
    });
    core.on('error', (error) => {
      console.error('[studianda] core spawn error:', error);
      core = null;
      coreStarting = false;
      if (!shuttingDown) scheduleCoreRestart(`本地服务启动错误：${error.message}`);
    });
    core.on('exit', (code, signal) => {
      console.log(`[studianda] core exited code=${code ?? 'null'} signal=${signal ?? 'null'}`);
      core = null;
      coreStarting = false;
      try {
        rmSync(path.join(app.getPath('temp'), 'Studianda-page-cache'), {
          recursive: true,
          force: true
        });
      } catch {
        // 页面缓存清理失败不影响应用退出
      }
      // 正常退出流程（shuttingDown）不重启；运行中崩溃则退避重试。
      if (!shuttingDown) {
        scheduleCoreRestart(`本地服务已退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`);
      }
    });

    // 等待握手文件 + health 校验；成功才认为启动完成，失败按退避重试。
    const ready = await waitForRuntime(10000);
    const runtime = ready ? readRuntime() : null;
    if (!runtime || !(await confirmStudiandaCore(runtime))) {
      // 进程可能在但没就绪：先结束它，避免重试时因 core 非空直接返回。
      const failedCore = core;
      core = null;
      try {
        failedCore?.kill('SIGTERM');
      } catch {
        // 忽略结束失败：后续重试会再检查
      }
      if (autoRestart) scheduleCoreRestart('本地服务启动超时');
      return false;
    }
    coreRestartAttempts = 0;
    return true;
  } finally {
    coreStarting = false;
  }
}

/** 退避重启：1s / 2s / 4s；用尽后交给用户决定（重试/退出）。 */
function scheduleCoreRestart(reason: string): void {
  if (shuttingDown || !dataDir) return;
  if (coreRestartTimer) return;
  if (coreRestartAttempts >= 3) {
    void showCoreFailureDialog(reason);
    return;
  }
  const delay = 1000 * 2 ** coreRestartAttempts;
  coreRestartAttempts += 1;
  console.warn(`[studianda] ${reason}；${delay}ms 后尝试重启（第 ${coreRestartAttempts}/3 次）`);
  coreRestartTimer = setTimeout(() => {
    coreRestartTimer = null;
    void startCore();
  }, delay);
}

/** 启动失败的用户可见提示：可重试（重新拉起 Core）或退出应用。 */
async function showCoreFailureDialog(detail: string): Promise<void> {
  if (shuttingDown || coreFailureDialogOpen) return;
  coreFailureDialogOpen = true;
  try {
    const choice = await dialog.showMessageBox({
      type: 'error',
      title: '本地服务未运行',
      message: '本地服务（Core）启动失败',
      detail: `${detail}\n\n重试会重新启动本地服务；如果反复失败，请检查资料目录权限、磁盘空间，或查看日志。`,
      buttons: ['重试', '退出应用'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });
    if (choice.response === 0) {
      coreRestartAttempts = 0;
      void startCore();
    } else {
      app.quit();
    }
  } finally {
    coreFailureDialogOpen = false;
  }
}

function readRuntime(): RuntimeInfo | null {
  if (!dataDir) return null;
  const runtimePath = path.join(dataDir, RUNTIME_FILE_NAME);
  try {
    const parsed = JSON.parse(readFileSync(runtimePath, 'utf8')) as RuntimeInfo;
    if (!parsed.port || !parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 进程是否还存在（只探测，不发信号内容）。 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 确认 runtime.json 里记录的 pid 确实是本应用的 core：
 * 用同一份 runtime.json 的端口 + token 请求只读 health，返回 application==='studianda' 才算。
 * 跨平台无法安全读取命令行/父进程，因此用"带本机随机 token 的握手"作为身份确认；
 * 确认不了就绝不 kill（宁可留下一个空闲 core，也不误杀用户的其他进程）。
 */
async function confirmStudiandaCore(runtime: RuntimeInfo): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${API_PREFIX}/health`, {
      headers: { [TOKEN_HEADER]: runtime.token },
      signal: AbortSignal.timeout(1500)
    });
    if (!response.ok) return false;
    const payload = (await response.json()) as { application?: unknown };
    return payload.application === 'studianda';
  } catch {
    return false;
  }
}

/**
 * 终止上次异常退出留下的 core 子进程（孤儿）。
 *
 * 只在三件事都成立时处理：runtime.json 存在且带 pid → pid 仍存活 → 用该文件的端口/token
 * 握手确认是本应用 core。任一条件不满足都不动；启动后 runtime.json 会被重建。
 */
async function terminateOrphanCore(): Promise<void> {
  const runtime = readRuntime();
  if (!runtime || !isProcessAlive(runtime.pid)) return;
  const confirmed = await confirmStudiandaCore(runtime);
  if (!confirmed) {
    console.warn(
      `[studianda] runtime.json 记录的进程 ${runtime.pid} 仍在，但无法确认是本应用 core，未终止`
    );
    return;
  }
  try {
    process.kill(runtime.pid, 'SIGTERM');
    console.log(`[studianda] 已终止上次遗留的 core 进程 ${runtime.pid}`);
  } catch (error) {
    console.warn(`[studianda] 终止遗留 core 失败：${String(error)}`);
  }
}

/**
 * 密钥名称判定：白名单与 Core 共用 `@studianda/shared` 的 `isAllowedSecretName`，
 * 避免主进程/Core 两处各自维护导致“一处接受、另一处静默丢弃”。
 */
function isSecretName(name: string): name is SecreiName {
  return isAllowedSecretName(name);
}
function secretsFile(): string {
  const current = path.join(app.getPath('userData'), 'secrets.json');
  if (!existsSync(current)) {
    for (const legacy of legacyUserDataDirs()) {
      const candidate = path.join(legacy, 'secrets.json');
      if (existsSync(candidate)) return candidate;
    }
  }
  return current;
}

function readEncryptedSecrets(): EncrypiedSecreis {
  try {
    const parsed = JSON.parse(readFileSync(secretsFile(), 'utf8')) as EncrypiedSecreis;
    if (parsed.version !== 1 || typeof parsed.values !== 'object' || parsed.values == null) {
      return { version: 1, values: {} };
    }
    const values: EncrypiedSecreis['values'] = {};
    for (const [name, value] of Object.entries(parsed.values)) {
      if (isSecretName(name) && typeof value === 'string' && value) values[name] = value;
    }
    return { version: 1, values };
  } catch {
    return { version: 1, values: {} };
  }
}

function secretStatus(): SecreiSiaius {
  const encrypted = readEncryptedSecrets();
  return {
    encryptionAvailable: safeStorage.isEncryptionAvailable(),
    configured: Object.keys(encrypted.values) as SecreiName[]
  };
}

function decryptSecrets(): Partial<Record<SecreiName, string>> {
  const encrypted = readEncryptedSecrets();
  const result: Partial<Record<SecreiName, string>> = {};
  if (!safeStorage.isEncryptionAvailable()) return result;
  for (const name of Object.keys(encrypted.values) as SecreiName[]) {
    const value = encrypted.values[name];
    if (!value) continue;
    try {
      result[name] = safeStorage.decryptString(Buffer.from(value, 'base64'));
    } catch {
      // 旧机器/换用户后解不开时，丢弃该条而不是让应用启动失败
    }
  }
  return result;
}

function writeSecretFile(encrypted: EncrypiedSecreis): void {
  const file = secretsFile();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(encrypted, null, 2)}\n`, { mode: 0o600 });
}

async function pushSecretsToCore(): Promise<void> {
  const runtime = readRuntime();
  if (!runtime) return;
  const secrets = decryptSecrets();
  for (const name of Object.keys(secrets) as SecreiName[]) {
    try {
      await fetch(`http://127.0.0.1:${runtime.port}${API_PREFIX}/secrets`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [TOKEN_HEADER]: runtime.token
        },
        body: JSON.stringify({ name, value: secrets[name] ?? '' })
      });
    } catch (error) {
      console.error('[studianda] failed to push secret to core:', error);
    }
  }
}

/**
 * 运行期窗口 / 任务栏图标使用「开卷」版；未启动时的 exe / 快捷方式 / 安装包使用「叠书」版
 * （electron-builder.yml 的 win.icon 与 nsis 图标）。
 *
 * Windows 任务栏对 ICO（多尺寸 16–256）显示更稳，所以 win32 优先取 icon-open.ico，
 * PNG 只作为其它平台/缺文件时的兜底。打包后这两个文件都在 resources/ 根目录
 * （electron-builder exiraResources）；开发时从 apps/desktop/build/ 读取。
 */
function windowIconPath(): string | undefined {
  const packaged = [
    path.join(process.resourcesPath, 'icon-open.ico'),
    path.join(process.resourcesPath, 'icon-open.png')
  ];
  const development = [
    path.join(app.getAppPath(), 'build', 'icon-open.ico'),
    path.join(app.getAppPath(), 'build', 'icon-open.png')
  ];
  const candidates = process.platform === 'win32' ? [...packaged, ...development] : [
    packaged[1]!,
    development[1]!
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

/** 把渲染进程错误写到 userData/renderer.log，白屏时可直接查看。 */
function logRenderer(message: string): void {
  try {
    const target = path.join(app.getPath('userData'), 'renderer.log');
    mkdirSync(path.dirname(target), { recursive: true });
    appendFileSync(target, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // 日志写失败不影响界面。
  }
}

let rendererRecoveryAttempts = 0;

/** 开发模式的 renderer 地址（electron-vite 注入）；生产为空。 */
function rendererDevUrl(): string | null {
  return process.env.ELECTRON_RENDERER_URL?.trim() || null;
}

/**
 * 是否是本应用自己的页面。
 *
 * 只允许 `file://<appPath>/out/renderer/**`（生产）或 dev server 同源地址（开发）；
 * 其它 URL 一律视为外部内容——不附加 preload 信任、不接管导航。
 */
function isAppPageUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const dev = rendererDevUrl();
    if (dev) return url.origin === new URL(dev).origin;
    if (url.protocol !== 'file:') return false;
    const target = path.resolve(fileURLToPath(url));
    const rendererRoot = path.resolve(app.getAppPath(), 'out', 'renderer');
    return target === path.join(rendererRoot, 'index.html') || target.startsWith(`${rendererRoot}${path.sep}`);
  } catch {
    return false;
  }
}

/** 允许交给系统浏览器/邮件客户端的链接（不允许 file://、javascript: 等）。 */
function isExternalLink(rawUrl: string): boolean {
  try {
    return ['http:', 'https:', 'mailto:'].includes(new URL(rawUrl).protocol);
  } catch {
    return false;
  }
}

/** 外部链接统一交给系统处理：应用内不创建新窗口、不导航离开应用页。 */
function openExternalUrl(rawUrl: string): { ok: boolean; message?: string } {
  if (!isExternalLink(rawUrl)) {
    return { ok: false, message: '只允许打开 http/https/mailto 链接' };
  }
  try {
    void shell.openExternal(rawUrl).catch((error) => {
      console.error('[studianda] failed to open external url:', error);
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 窗口导航守卫：渲染进程只能停留在应用页面；外链交给系统浏览器，新窗口一律拒绝。
 * 这样即使页面里出现恶意/误写的链接，也不会让 preload 桥暴露给非应用内容。
 */
function installWebContentsGuards(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalLink(url)) openExternalUrl(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppPageUrl(url)) return;
    event.preventDefault();
    if (isExternalLink(url)) openExternalUrl(url);
  });
}

/** 会话级权限：只放行录音与剪贴板，其余（摄像头/通知/地理位置等）默认拒绝。 */
const ALLOWED_PERMISSIONS = new Set(['media', 'clipboard-read', 'clipboard-sanitized-write']);
function installSessionGuards(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) =>
    ALLOWED_PERMISSIONS.has(permission)
  );
}

/** IPC 调用是否来自应用自己的页面（token/密钥等敏感通道必须校验）。 */
function isTrustedIpcSender(event: IpcMainInvokeEvent | IpcMainEvent): boolean {
  try {
    return isAppPageUrl(event.senderFrame?.url ?? '');
  } catch {
    return false;
  }
}


function createWindow(): void {
  const workArea = screen.getPrimaryDisplay().workAreaSize;
  const windowWidth = Math.min(1440, workArea.width);
  const windowHeight = Math.min(900, workArea.height);
  mainWindow = new BrowserWindow({
    width: windowWidth,
    height: windowHeight,
    minWidth: Math.min(1040, windowWidth),
    minHeight: Math.min(680, windowHeight),
    backgroundColor: '#f4eedf',
    title: DISPLAY_NAME,
    frame: false,
    icon: windowIconPath(),
    webPreferences: {
      preload: path.join(app.getAppPath(), 'out', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 朗读音频是在异步请求完成后才播放的，没有直接的用户手势；允许自动播放，
      // 否则 Chromium 会静默拦截 audio.play()，表现为「朗读没有声音」。
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false
    }
  });

  mainWindow.on('maximize', () => mainWindow?.webContents.send('studianda:window-maximized', true));
  mainWindow.on('unmaximize', () =>
    mainWindow?.webContents.send('studianda:window-maximized', false)
  );
  installWebContentsGuards(mainWindow);

  // 渲染进程出错/崩溃时不要静默白屏：记录日志，并自动尝试恢复一次窗口。
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    // Electron 44 的这个事件仍是旧签名：level 0 verbose / 1 info / 2 warning / 3 error。
    if (level === 3) logRenderer(`[console] ${message} (${sourceId}:${line})`);
  });
  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    logRenderer(`[did-fail-load] ${code} ${description} ${url}`);
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logRenderer(`[render-process-gone] ${details.reason} exitCode=${details.exitCode}`);
    if (details.reason !== 'clean-exit' && rendererRecoveryAttempts < 2) {
      rendererRecoveryAttempts += 1;
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
      }, 500);
    }
  });
  mainWindow.webContents.on('did-finish-load', () => {
    rendererRecoveryAttempts = 0;
  });

  if (workArea.width >= 1200) {
    mainWindow.maximize();
  }

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(app.getAppPath(), 'out', 'renderer', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function loadTranslationWindow(
  win: BrowserWindow,
  documentId: string,
  page: number
): void {
  const query: Record<string, string> = {
    translationWindow: '1',
    doc: documentId,
    page: String(page)
  };
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    const url = new URL(devUrl);
    url.search = new URLSearchParams(query).toString();
    void win.loadURL(url.toString());
  } else {
    void win.loadFile(path.join(app.getAppPath(), 'out', 'renderer', 'index.html'), { query });
  }
}

/**
 * 独立译文窗口（多显示器只显示译文）：
 * - 与主窗口共用同一份 renderer，只带 `?translationWindow=1&doc=&page=`；
 * - 单实例复用：已打开时聚焦并重新按新页码/文献加载，不重复开窗；
 * - 只读，不提供编辑/删除。
 */
function openTranslationWindow(input: {
  documentId?: unknown;
  page?: unknown;
}): { ok: boolean; message?: string } {
  const documentId = typeof input?.documentId === 'string' ? input.documentId.trim() : '';
  if (!documentId) return { ok: false, message: '缺少文献 ID' };
  const requested = Number(input?.page ?? 1);
  const page = Number.isInteger(requested) && requested >= 1 ? requested : 1;
  if (translationWindow && !translationWindow.isDestroyed()) {
    loadTranslationWindow(translationWindow, documentId, page);
    if (translationWindow.isMinimized()) translationWindow.restore();
    translationWindow.show();
    translationWindow.focus();
    return { ok: true };
  }
  translationWindow = new BrowserWindow({
    width: 900,
    height: 1000,
    minWidth: 520,
    minHeight: 480,
    title: '译文 · 勘读Studianda',
    backgroundColor: '#f4eedf',
    autoHideMenuBar: true,
    icon: windowIconPath(),
    webPreferences: {
      preload: path.join(app.getAppPath(), 'out', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false
    }
  });
  translationWindow.setMenuBarVisibility(false);
  installWebContentsGuards(translationWindow);
  loadTranslationWindow(translationWindow, documentId, page);
  translationWindow.on('closed', () => {
    translationWindow = null;
  });
  return { ok: true };
}

function stopCore(): void {
  shuttingDown = true;
  if (coreRestartTimer) {
    clearTimeout(coreRestartTimer);
    coreRestartTimer = null;
  }
  if (core) {
    try {
      core.kill('SIGTERM');
    } catch {
      // 忽略退出阶段的错误
    }
    core = null;
  }
  // attach 到外部启动的 Core：当前桌面端退出时仍停止它（单客户端语义）；
  // 将来多宿主共享时需要改成引用计数/所有权协议，不能在这里直接杀。
  if (attachedCorePid != null) {
    try {
      process.kill(attachedCorePid, 'SIGTERM');
    } catch {
      // 进程已退出时忽略
    }
    attachedCorePid = null;
  }
}

/**
 * 更新安装前停止 Core 并等待其退出。
 *
 * Core 是用 `process.execPath` 启动的，进程映像和主程序是同一个 Studianda.exe；
 * 只要还有一个实例在跑，NSIS 覆盖安装就会因文件占用失败。所以这里不能像普通退出那样
 * 发完 SIGTERM 就走，必须等到进程真的退出（超时后强杀兜底）。
 */
async function stopCoreForUpdate(timeoutMs = 6000): Promise<void> {
  if (coreRestartTimer) {
    clearTimeout(coreRestartTimer);
    coreRestartTimer = null;
  }
  shuttingDown = true;
  const child = core;
  core = null;
  const attached = attachedCorePid;
  attachedCorePid = null;

  if (child && child.exitCode == null && child.signalCode == null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // 进程可能刚好自己退出
        }
        resolve();
      }, timeoutMs);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        child.kill('SIGTERM');
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  if (attached != null) {
    try {
      process.kill(attached, 'SIGTERM');
    } catch {
      // 已退出
    }
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && isProcessAlive(attached)) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (isProcessAlive(attached)) {
      try {
        process.kill(attached, 'SIGKILL');
      } catch {
        // 已被系统回收
      }
    }
  }
}

/** 更新前备份资料：走 Core 的同步备份接口（POST /backups，返回备份记录）。 */
async function backupBeforeUpdate(): Promise<{ ok: boolean; message?: string }> {
  const runtime = readRuntime();
  if (!runtime) return { ok: false, message: '本地服务未运行，无法创建备份' };
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${API_PREFIX}/backups`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [TOKEN_HEADER]: runtime.token
      },
      body: '{}',
      // 大资料库压缩可能较慢：给足 10 分钟，避免备份被误判失败。
      signal: AbortSignal.timeout(10 * 60 * 1000)
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return {
        ok: false,
        message: `备份接口返回 ${response.status}${detail ? `：${detail.slice(0, 120)}` : ''}`
      };
    }
    const record = (await response.json().catch(() => ({}))) as { name?: unknown };
    return { ok: true, message: typeof record.name === 'string' ? record.name : undefined };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** 更新模块日志写到 userData/update.log：用户反馈更新失败时可直接取这个文件。 */
function logUpdate(message: string): void {
  try {
    const target = path.join(app.getPath('userData'), 'update.log');
    mkdirSync(path.dirname(target), { recursive: true });
    appendFileSync(target, `[${new Date().toISOString()}] ${message}\n`);
  } catch {
    // 日志写失败不影响更新流程
  }
  console.log(message);
}

function ensureUpdateManager(): UpdateManager {
  if (!updateManager) {
    updateManager = new UpdateManager({
      log: logUpdate,
      getWindow: () => mainWindow,
      stopCoreForUpdate,
      backupBeforeUpdate
    });
  }
  return updateManager;
}

async function waitForRuntime(timeoutMs = 8000): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (readRuntime()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function saveSecret(name: string, value: string): SecreiSiaius {
  if (!isSecretName(name)) throw new Error('不支持的密钥');
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('当前系统没有可用的凭据加密（safeStorage），请不要在此环境保存密钥。');
  }
  const encrypted = readEncryptedSecrets();
  if (value.trim() === '') {
    delete encrypted.values[name];
  } else {
    encrypted.values[name] = safeStorage.encryptString(value).toString('base64');
  }
  writeSecretFile(encrypted);
  return secretStatus();
}


app.whenReady().then(async () => {
  migrateLegacyUserData();
  protocol.handle('studianda-asset', async (request) => {
    const url = new URL(request.url);
    // 渲染进程静态资源（pdf.js 的 cmaps/wasm/standard_fonts/iccs 等）用无主机名的
    // `studianda-asset:///cmaps/...`；note-assets 用 `studianda-asset://note-assets/<文件>`。
    // 这里把 hostname + pathname 拼回相对路径统一处理。
    const relative = decodeURIComponent(`${url.hostname ?? ''}${url.pathname}`)
      .replace(/^\/+/, '')
      // 兼容旧版渲染进程/缓存里可能出现的 `studianda-asset://app/...` 写法：
      // 避免再解析成 out/renderer/app/... 导致 cmaps/wasm 404。
      .replace(/^app\//, '');
    if (relative.includes('..')) return new Response('Not found', { status: 404 });
    // 笔记/批注图片：存于当前数据目录的 note-assets/，只允许该子目录，避免任意文件读取。
    if (relative.startsWith('note-assets/')) {
      const base = dataDir ? path.join(dataDir, 'note-assets') : '';
      const name = relative.slice('note-assets/'.length);
      if (!base || !name || name.includes('/') || name.includes('\\')) {
        return new Response('Not found', { status: 404 });
      }
      const target = path.join(base, name);
      if (!target.startsWith(`${base}${path.sep}`)) {
        return new Response('Not found', { status: 404 });
      }
      const ext = path.extname(target).toLowerCase();
      const type =
        ext === '.png'
          ? 'image/png'
          : ext === '.jpg' || ext === '.jpeg'
            ? 'image/jpeg'
            : ext === '.gif'
              ? 'image/gif'
              : ext === '.webp'
                ? 'image/webp'
                : 'application/octet-stream';
      try {
        const data = await readFile(target);
        return new Response(data, {
          headers: {
            'content-type': type,
            'access-control-allow-origin': '*',
            'cache-control': 'public, max-age=86400'
          }
        });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    }
    const target = path.join(app.getAppPath(), 'out', 'renderer', relative);
    try {
      const data = await readFile(target);
      const ext = path.extname(target).toLowerCase();
      const type =
        ext === '.bcmap'
          ? 'application/octet-stream'
          : ext === '.wasm'
            ? 'application/wasm'
            : ext === '.pfb' || ext === '.ttf'
              ? 'application/octet-stream'
              : ext === '.icc'
                ? 'application/octet-stream'
                : ext === '.js'
                  ? 'text/javascript'
                  : 'application/octet-stream';
      return new Response(data, {
        headers: {
          'content-type': type,
          'access-control-allow-origin': '*',
          'cache-control': 'public, max-age=3600'
        }
      });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
  ipcMain.on('studianda:window-minimize', () => mainWindow?.minimize());
  ipcMain.on('studianda:window-toggle-maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.on('studianda:window-close', () => mainWindow?.close());
  ipcMain.handle('studianda:window-is-maximized', () => mainWindow?.isMaximized() ?? false);
  // 独立译文窗口：主窗口把当前文献/页码交给桌面壳，壳负责开窗与复用。
  ipcMain.handle('studianda:open-translation-window', (_event, input: unknown) =>
    openTranslationWindow((input ?? {}) as { documentId?: unknown; page?: unknown })
  );

  ipcMain.handle('studianda:get-data-location', () => dataDir ?? '');
  // 打开数据目录：只调用本机文件管理器；失败时把路径回传，由界面提示手动打开。
  ipcMain.handle('studianda:open-data-dir', async () => {
    const target = dataDir ?? app.getPath('userData');
    const error = await shell.openPath(target);
    return error
      ? { ok: false, message: `未能自动打开文件管理器，请手动打开：${target}` }
      : { ok: true, message: '已在本机文件管理器打开数据目录。' };
  });
  ipcMain.handle('studianda:open-legal-notice', async (_event) => {
    if (!isTrustedIpcSender(_event)) return { ok: false };
    const candidates = app.isPackaged
      ? [path.join(process.resourcesPath, 'legal', 'NOTICE.html')]
      : [
          path.join(app.getAppPath(), 'legal', 'NOTICE.html'),
          path.join(app.getAppPath(), '..', '..', 'legal', 'NOTICE.html')
        ];
    const legalFile = candidates.find((candidate) => existsSync(candidate));
    if (!legalFile) {
      dialog.showErrorBox('第三方声明未找到', '安装包中缺少 legal/NOTICE.html。');
      return { ok: false };
    }
    const error = await shell.openPath(legalFile);
    if (error) dialog.showErrorBox('无法打开第三方声明', error);
    return { ok: !error };
  });
  // 完整版《使用须知与隐私说明》：优先打开安装包内 legal/USAGE-NOTICE.md；
  // .md 没有默认关联程序时退回浏览器打开本地文件（只读，不联网）。
  ipcMain.handle('studianda:open-usage-notice', async (event) => {
    if (!isTrustedIpcSender(event)) return { ok: false, message: '不可信的调用来源' };
    const candidates = app.isPackaged
      ? [path.join(process.resourcesPath, 'legal', 'USAGE-NOTICE.md')]
      : [
          path.join(app.getAppPath(), '..', '..', 'docs', 'USAGE-NOTICE.md'),
          path.join(app.getAppPath(), 'docs', 'USAGE-NOTICE.md')
        ];
    const noticeFile = candidates.find((candidate) => existsSync(candidate));
    if (!noticeFile) {
      dialog.showErrorBox('使用须知完整版未找到', '安装包中缺少 legal/USAGE-NOTICE.md。');
      return { ok: false, message: '使用须知完整版未找到' };
    }
    const error = await shell.openPath(noticeFile);
    if (!error) return { ok: true };
    try {
      await shell.openExternal(pathToFileURL(noticeFile).href);
      return { ok: true };
    } catch (openError) {
      const message = openError instanceof Error ? openError.message : String(openError);
      dialog.showErrorBox('无法打开使用须知完整版', message || error);
      return { ok: false, message: message || error };
    }
  });
  // 清空用户数据后，best-effort 删除 userData 下的渲染/更新日志（不在资料目录，但可能含路径/错误上下文）。
  ipcMain.handle('studianda:clear-user-logs', (event) => {
    if (!isTrustedIpcSender(event)) return { ok: false, removed: [] as string[] };
    const removed: string[] = [];
    for (const name of ['renderer.log', 'update.log']) {
      try {
        unlinkSync(path.join(app.getPath('userData'), name));
        removed.push(name);
      } catch {
        // 不存在/被占用时跳过。
      }
    }
    return { ok: true, removed };
  });
  ipcMain.handle('studianda:get-data-setup', (event) => {
    if (!isTrustedIpcSender(event)) return { configured: false, current: '' };
    return {
      // 仅用于界面自动化验证首次启动页：STUDIANDA_FORCE_SETUP=1 时强制显示资料位置页。
      configured: process.env.STUDIANDA_FORCE_SETUP === '1' ? false : Boolean(dataDir),
      current: dataDir ?? ''
    };
  });
  ipcMain.handle('studianda:setup-data-location', async (_event) => {
    if (!isTrustedIpcSender(_event)) return { ok: false, message: '不可信的调用来源' };
    const picked = await dialog.showOpenDialog({
      title: '选择资料存储位置',
      defaultPath: path.join(app.getPath('documents'), '勘读'),
      properties: ['openDirectory', 'createDirectory']
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, message: '已取消选择。' };
    }
    const target = path.resolve(picked.filePaths[0]!);
    const error = validateDataDir(target);
    if (error) return { ok: false, message: error };
    saveStoredDataDir(target);
    dataDir = target;
    // 手动选择资料位置：启动失败直接回给界面，不在此时弹自动重试对话框。
    const started = await startCore(false);
    if (!started) {
      return { ok: false, message: '本地服务启动失败，请检查资料目录权限/磁盘空间后重试。' };
    }
    try {
      await pushSecretsToCore();
    } catch (err) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : '本地服务启动失败'
      };
    }
    return { ok: true, message: '资料位置已设置。' };
  });
  ipcMain.handle('studianda:change-data-location', async (_event) => {
    if (!isTrustedIpcSender(_event)) return { ok: false, message: '不可信的调用来源' };
    if (!dataDir) return { ok: false, message: '尚未设置资料位置。' };
    const picked = await dialog.showOpenDialog({
      title: '更改资料存储位置',
      defaultPath: dataDir,
      properties: ['openDirectory', 'createDirectory']
    });
    if (picked.canceled || picked.filePaths.length === 0) {
      return { ok: false, message: '已取消' };
    }
    const target = path.resolve(picked.filePaths[0]!);
    if (target === path.resolve(dataDir)) {
      return { ok: false, message: '新位置与当前资料位置相同。' };
    }
    const error = validateDataDir(target);
    if (error) return { ok: false, message: error };
    try {
      if (existsSync(target) && readdirSync(target).length > 0) {
        return { ok: false, message: '请选择空文件夹，避免与已有资料混在一起。' };
      }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : '无法读取目标文件夹' };
    }
    writeFileSync(
      path.join(app.getPath('userData'), PENDING_DATA_MOVE),
      JSON.stringify({ version: 1, from: dataDir, to: target }, null, 2),
      'utf8'
    );
    setTimeout(() => {
      app.relaunch();
      app.quit();
    }, 350);
    return { ok: true, message: '正在复制资料并重启应用…' };
  });

  ipcMain.handle('studianda:get-runtime', (event) =>
    isTrustedIpcSender(event) ? readRuntime() : null
  );
  ipcMain.handle('studianda:pick-pdf', async () => {
    const options: OpenDialogOptions = {
      title: '导入 PDF',
      properties: ['openFile'],
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });
  // 打开笔记附件（导入的 PDF/音频等）：只允许 note-assets 目录内的纯文件名。
  ipcMain.handle('studianda:open-note-asset', async (_event, rawUrl: unknown) => {
    if (typeof rawUrl !== 'string' || !dataDir) return { ok: false, message: '附件路径无效' };
    try {
      const url = new URL(rawUrl);
      const name = decodeURIComponent(
        url.hostname === 'note-assets'
          ? url.pathname.replace(/^\/+/, '')
          : url.pathname.replace(/^\/+/, '').replace(/^note-assets\//, '')
      );
      if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
        return { ok: false, message: '附件路径无效' };
      }
      const target = path.join(dataDir, 'note-assets', name);
      if (!target.startsWith(path.join(dataDir, 'note-assets') + path.sep)) {
        return { ok: false, message: '附件路径无效' };
      }
      const error = await shell.openPath(target);
      return error ? { ok: false, message: error } : { ok: true, message: '' };
    } catch {
      return { ok: false, message: '附件路径无效' };
    }
  });
  ipcMain.handle('studianda:pick-markdown-vault', async () => {
    const options: OpenDialogOptions = {
      title: '选择 Markdown 笔记文件夹',
      properties: ['openDirectory']
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });
  ipcMain.handle('studianda:pick-directory', async () => {
    const options: OpenDialogOptions = {
      title: '选择旧版 data 目录',
      properties: ['openDirectory']
    };
    const result = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });
  ipcMain.handle('studianda:secret-status', (event) =>
    isTrustedIpcSender(event) ? secretStatus() : { encryptionAvailable: false, configured: [] }
  );
  ipcMain.handle('studianda:secret-set', async (_event, name: unknown, value: unknown) => {
    if (!isTrustedIpcSender(_event)) throw new Error('不可信的调用来源');
    if (typeof name !== 'string' || typeof value !== 'string') {
      throw new Error('参数错误');
    }
    const status = saveSecret(name, value);
    await pushSecretsToCore();
    return status;
  });
  ipcMain.handle('studianda:secret-clear', async (_event, name: unknown) => {
    if (!isTrustedIpcSender(_event)) throw new Error('不可信的调用来源');
    if (typeof name !== 'string') throw new Error('参数错误');
    const status = saveSecret(name, '');
    await pushSecretsToCore();
    return status;
  });

  // 外部链接：只放行 http/https/mailto，交给系统浏览器；应用内不导航。
  ipcMain.handle('studianda:open-external', (_event, rawUrl: unknown) => {
    if (!isTrustedIpcSender(_event)) return { ok: false, message: '不可信的调用来源' };
    if (typeof rawUrl !== 'string') return { ok: false, message: '链接无效' };
    return openExternalUrl(rawUrl);
  });
  // 导出保存：主进程弹保存对话框并写盘，renderer 不获得任意路径写权限。
  ipcMain.handle('studianda:save-blob', async (_event, data: unknown, filename: unknown) => {
    if (!isTrustedIpcSender(_event)) return { ok: false, message: '不可信的调用来源' };
    if (!(data instanceof Uint8Array) || typeof filename !== 'string') {
      return { ok: false, message: '参数错误' };
    }
    const safeName =
      path.basename(filename).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'export';
    const result = mainWindow
      ? await dialog.showSaveDialog(mainWindow, {
          title: '保存导出文件',
          defaultPath: path.join(app.getPath('downloads'), safeName)
        })
      : await dialog.showSaveDialog({
          title: '保存导出文件',
          defaultPath: path.join(app.getPath('downloads'), safeName)
        });
    if (result.canceled || !result.filePath) return { ok: false, message: '已取消保存' };
    try {
      await writeFile(result.filePath, Buffer.from(data));
      return { ok: true, message: result.filePath };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : '保存失败' };
    }
  });

  // 应用内更新：状态查询与三个动作（检查/下载/安装）。安装是不可逆动作，
  // 只接受应用自己页面的调用（与密钥等敏感通道同一套来源校验）。
  ipcMain.handle('studianda:update-state', (event) =>
    isTrustedIpcSender(event) ? ensureUpdateManager().getState() : null
  );
  // 自动检查更新偏好：只存 userData/update-pref.json；不涉及用户内容。
  ipcMain.handle('studianda:update-auto-check-get', (event) =>
    isTrustedIpcSender(event) ? ensureUpdateManager().getAutoCheck() : null
  );
  ipcMain.handle('studianda:update-auto-check-set', (event, enabled: unknown) => {
    if (!isTrustedIpcSender(event)) return null;
    const manager = ensureUpdateManager();
    manager.setAutoCheck(enabled === true);
    return manager.getAutoCheck();
  });
  ipcMain.handle('studianda:update-check', async (event, manual: unknown) => {
    if (!isTrustedIpcSender(event)) return null;
    return ensureUpdateManager().check(manual === true);
  });
  ipcMain.handle('studianda:update-download', async (event) => {
    if (!isTrustedIpcSender(event)) return null;
    return ensureUpdateManager().download();
  });
  ipcMain.handle('studianda:update-install', async (event) => {
    if (!isTrustedIpcSender(event)) return { ok: false, message: '不可信的调用来源' };
    return ensureUpdateManager().install();
  });

  dataDir = initialDataDir();
  if (dataDir) {
    await applyPendingDataMove();
    // 首次启动/正常启动：失败时 startCore 会自动退避重试，用尽后弹窗让用户选择。
    const started = await startCore();
    if (started) {
      try {
        await pushSecretsToCore();
      } catch (error) {
        console.error('[studianda] failed to push secrets to core', error);
      }
    }
  }
  installSessionGuards();
  createWindow();
  // 窗口就绪后再启动更新检查：延迟 10s，静默失败，不拖慢首屏。
  ensureUpdateManager().start();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (!shuttingDown) stopCore();
});
