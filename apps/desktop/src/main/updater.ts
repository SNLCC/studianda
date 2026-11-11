/**
 * 应用内更新（主进程）。
 *
 * 设计取舍：
 * - 不做"发现新版就自动下载/自动装"：234 MB 的安装包，用户没点下载就是在浪费流量；
 *   所以 autoDownload=false，由界面上用户点击后调用 `download()`，装之前再确认一次。
 * - 检查更新失败默认静默（自动检查时网络不通很常见，不能弹错打扰用户）；
 *   只有用户手动点「检查更新」或正在下载时，错误才推给界面。
 * - 安装前先备份资料、并等待 Core 子进程真正退出：Core 是用 process.execPath 启动的，
 *   和主程序是同一个 Studianda.exe，进程没退干净时 NSIS 覆盖安装会因文件占用失败。
 */
import { app, BrowserWindow, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { UpdateState } from '@studianda/shared';

/** 主进程提供的壳能力：更新模块不直接依赖 index.ts 的全局变量。 */
export interface UpdateManagerDeps {
  log(message: string): void;
  /** 当前主窗口（用于对话框归属；可能为 null）。 */
  getWindow(): BrowserWindow | null;
  /** 安装前停止 Core 子进程并等待其退出。 */
  stopCoreForUpdate(): Promise<void>;
  /** 安装前备份资料；失败时由更新流程询问用户是否继续。 */
  backupBeforeUpdate(): Promise<{ ok: boolean; message?: string }>;
}

const CHECK_DELAY_MS = 10_000;

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNREFUSED|ECONNRESET|socket hang up|net::/i.test(message)) {
    return '无法连接更新服务器，请检查网络后重试。';
  }
  // 仓库第一次发版前没有任何 Release，GitHub provider 会报 No published versions。
  if (/no published versions/i.test(message)) {
    return '发布页上还没有可用版本，暂时无法检查更新。';
  }
  if (/404|not found/i.test(message)) {
    return '更新信息不存在：该版本可能尚未发布。';
  }
  if (/app-update\.yml|ENOENT|YAMLException/i.test(message)) {
    return '更新配置无效，无法应用内更新（请重新安装最新版本，或到发布页手动下载）。';
  }
  return message.length > 180 ? `${message.slice(0, 180)}…` : message;
}

/** GitHub Release 正文可能是字符串，也可能是分段数组；统一成纯文本。 */
function normalizeReleaseNotes(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'note' in item) {
          const note = (item as { note?: unknown }).note;
          return typeof note === 'string' ? note : '';
        }
        return '';
      })
      .filter((part) => part.trim());
    return parts.length > 0 ? parts.join('\n\n') : undefined;
  }
  return undefined;
}

export class UpdateManager {
  private state: UpdateState;
  private checkInFlight = false;
  private downloadInFlight = false;
  private manualCheck = false;
  private bound = false;
  private startupTimer: NodeJS.Timeout | null = null;
  /** 是否自动检查更新（用户偏好，存 userData/update-pref.json；默认 false）。 */
  private autoCheck = false;

  constructor(private readonly deps: UpdateManagerDeps) {
    this.state = {
      currentVersion: app.getVersion(),
      phase: app.isPackaged ? 'idle' : 'unsupported',
      message: app.isPackaged ? undefined : '开发模式下不检查更新。'
    };
  }

  getState(): UpdateState {
    return this.state;
  }

  private preferenceFile(): string {
    return path.join(app.getPath('userData'), 'update-pref.json');
  }

  /** 读取“自动检查更新”偏好；文件不存在/损坏时默认关闭。 */
  getAutoCheck(): boolean {
    try {
      const parsed = JSON.parse(readFileSync(this.preferenceFile(), 'utf8')) as {
        autoCheck?: unknown;
      };
      return parsed.autoCheck === true;
    } catch {
      return false;
    }
  }

  /** 保存偏好；关闭时立即取消已排队的启动检查，开启时补排一次。 */
  setAutoCheck(enabled: boolean): void {
    this.autoCheck = enabled;
    try {
      const file = this.preferenceFile();
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ autoCheck: enabled }, null, 2)}\n`, { mode: 0o600 });
    } catch {
      // 偏好写不进去也不影响本次运行（进程内 autoCheck 已更新）。
    }
    if (!enabled) {
      if (this.startupTimer) {
        clearTimeout(this.startupTimer);
        this.startupTimer = null;
      }
      return;
    }
    this.scheduleStartupCheck();
  }

  private scheduleStartupCheck(): void {
    if (!app.isPackaged) return;
    if (process.env.STUDIANDA_DISABLE_UPDATE_CHECK === '1') return;
    if (!this.autoCheck || this.startupTimer) return;
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void this.check(false);
    }, CHECK_DELAY_MS);
    // 更新检查不应阻止进程退出。
    this.startupTimer.unref?.();
  }

  /** 启动：绑定事件，并在窗口就绪后延迟做一次静默检查。 */
  start(): void {
    if (this.bound) return;
    this.bound = true;
    autoUpdater.autoDownload = false;
    // 用户没点“重启并安装”时，退出应用不要顺手装更新。
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.autoRunAppAfterInstall = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.logger = {
      info: (message?: unknown) => this.deps.log(`[update] ${String(message ?? '')}`),
      warn: (message?: unknown) => this.deps.log(`[update][warn] ${String(message ?? '')}`),
      error: (message?: unknown) => this.deps.log(`[update][error] ${String(message ?? '')}`),
      debug: (message?: unknown) => this.deps.log(`[update][debug] ${String(message ?? '')}`)
    };

    autoUpdater.on('checking-for-update', () => {
      this.patch({ phase: 'checking' }, this.manualCheck);
    });
    autoUpdater.on('update-available', (info) => {
      this.patch(
        {
          phase: 'available',
          version: info.version,
          releaseNotes: normalizeReleaseNotes(info.releaseNotes),
          releaseDate: typeof info.releaseDate === 'string' ? info.releaseDate : undefined,
          size: info.files?.[0]?.size,
          message: undefined
        },
        true
      );
    });
    autoUpdater.on('update-not-available', () => {
      this.patch(
        {
          phase: 'up-to-date',
          version: undefined,
          releaseNotes: undefined,
          progress: undefined,
          message: this.manualCheck ? '当前已经是最新版本。' : undefined
        },
        this.manualCheck
      );
    });
    autoUpdater.on('download-progress', (progress) => {
      this.patch(
        {
          phase: 'downloading',
          progress: {
            percent: Math.max(0, Math.min(100, progress.percent)),
            transferred: progress.transferred,
            total: progress.total,
            bytesPerSecond: progress.bytesPerSecond
          }
        },
        true
      );
    });
    autoUpdater.on('update-downloaded', (info) => {
      this.patch(
        {
          phase: 'downloaded',
          version: info.version,
          progress: { percent: 100, transferred: 0, total: info.files?.[0]?.size ?? 0, bytesPerSecond: 0 },
          message: '更新已下载，重启后完成安装。'
        },
        true
      );
    });
    autoUpdater.on('error', (error) => {
      this.fail(error, this.manualCheck || this.downloadInFlight);
    });

    this.autoCheck = this.getAutoCheck();
    this.scheduleStartupCheck();
  }

  /** 检查更新；manual=true 时把结果/错误直接反馈给界面。 */
  async check(manual: boolean): Promise<UpdateState> {
    if (!app.isPackaged) {
      return this.patch({
        phase: 'unsupported',
        message: '开发模式下不检查更新。'
      });
    }
    if (this.checkInFlight) return this.state;
    if (this.state.phase === 'downloading' || this.state.phase === 'downloaded' || this.state.phase === 'installing') {
      return this.state;
    }
    this.checkInFlight = true;
    this.manualCheck = manual;
    if (manual) {
      this.patch({ phase: 'checking', manual: true, message: '正在检查更新…' }, true);
    }
    try {
      this.deps.log('[update] checking for updates');
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.fail(error, manual);
    } finally {
      this.checkInFlight = false;
    }
    return this.state;
  }

  /** 用户点击「更新」后开始下载（不自动下载）。 */
  async download(): Promise<UpdateState> {
    if (!app.isPackaged || this.state.phase !== 'available') return this.state;
    if (this.downloadInFlight) return this.state;
    this.downloadInFlight = true;
    this.patch({ phase: 'downloading', message: '正在下载更新…', progress: undefined }, true);
    try {
      this.deps.log('[update] downloading update');
      await autoUpdater.downloadUpdate();
    } catch (error) {
      this.fail(error, true);
    } finally {
      this.downloadInFlight = false;
    }
    return this.state;
  }

  /**
   * 安装已下载的更新：先备份资料，再等 Core 退出，最后静默安装并重启。
   * 返回 ok=false 表示用户可以继续用当前版本（备份失败且用户选择取消等）。
   */
  async install(): Promise<{ ok: boolean; message?: string }> {
    if (!app.isPackaged) return { ok: false, message: '开发模式下不支持安装更新。' };
    if (this.state.phase !== 'downloaded') {
      return { ok: false, message: '当前没有已下载的更新。' };
    }
    this.patch({ phase: 'installing', message: '正在备份资料…' }, true);
    let backup: { ok: boolean; message?: string };
    try {
      backup = await this.deps.backupBeforeUpdate();
    } catch (error) {
      backup = { ok: false, message: describeError(error) };
    }
    if (!backup.ok) {
      this.deps.log(`[update] backup before update failed: ${backup.message ?? ''}`);
      const window = this.deps.getWindow();
      const detail = `更新前自动备份资料失败：${backup.message ?? '未知原因'}\n\n更新只会替换程序目录，不会改动资料目录；但备份失败时无法保证可回退。仍要继续安装吗？`;
      const choice = window
        ? await dialog.showMessageBox(window, {
            type: 'warning',
            title: '更新前备份失败',
            message: '资料备份失败',
            detail,
            buttons: ['仍然更新', '取消'],
            defaultId: 1,
            cancelId: 1,
            noLink: true
          })
        : await dialog.showMessageBox({
            type: 'warning',
            title: '更新前备份失败',
            message: '资料备份失败',
            detail,
            buttons: ['仍然更新', '取消'],
            defaultId: 1,
            cancelId: 1,
            noLink: true
          });
      if (choice.response !== 0) {
        this.patch({ phase: 'downloaded', message: '已取消更新。' }, true);
        return { ok: false, message: '已取消更新。' };
      }
    }
    this.patch({ phase: 'installing', message: '正在退出并安装更新…' }, true);
    try {
      // 必须先让 Core 退干净：它和主程序是同一个 exe，占用文件会让安装器失败。
      await this.deps.stopCoreForUpdate();
    } catch (error) {
      this.deps.log(`[update] stop core before install failed: ${describeError(error)}`);
    }
    this.deps.log('[update] quitting and installing');
    // 静默安装（不弹安装器界面），装完自动启动新版本。
    setImmediate(() => {
      autoUpdater.quitAndInstall(true, true);
    });
    return { ok: true };
  }

  private fail(error: unknown, notify: boolean): void {
    const message = describeError(error);
    this.deps.log(`[update] error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    this.patch({ phase: 'error', message, progress: undefined }, notify);
  }

  private patch(patch: Partial<UpdateState>, push = false): UpdateState {
    this.state = { ...this.state, ...patch };
    if (patch.phase !== 'checking') {
      // checking 阶段不覆盖 manual 标记，其余状态沿用本次检查的来源。
      this.state.manual = this.manualCheck;
    }
    if (push) this.push();
    return this.state;
  }

  private push(): void {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      window.webContents.send('studianda:update-status', this.state);
    }
  }
}
