/**
 * 用本项目自己的 NSIS 脚本实现替换 electron-builder 模板里的 WinShell 插件调用。
 *
 * 为什么：`WinShell.dll` 上游（nsis.sourceforge.io/WinShell_plug-in）只标注
 * "License: Freeware"，官方发行包 WinShell.zip 内只有两个 DLL，既没有许可文本
 * 也没有源码 —— 不构成再分发授权。安装器模板里的 10 处 `WinShell::` 调用会让
 * makensis 把该 DLL 嵌进安装包，等于随包分发了没有许可依据的组件。
 *
 * 怎么做：把每个调用改写成「把参数放进 $R8/$R9 → 调用
 * apps/desktop/build/nsis/aumid.nsh 里的宏」。aumid.nsh 用 NSIS 自带的 System
 * 插件 + 官方 Win\COM.nsh / Win\Propkey.nsh 定义，直接调用 Windows 公开 API
 * （CLSID_ShellLink → IPersistFile → IPropertyStore → PKEY_AppUserModel_ID），
 * 不引入任何第三方 DLL，也不需要自编译二进制：
 *
 *   WinShell::SetLnkAUMI "<lnk>" "${APP_ID}"
 *     → StrCpy $R8 "<lnk>" / StrCpy $R9 "${APP_ID}" / ${StudiandaSetLnkAUMI}
 *   WinShell::UninstShortcut "<lnk>"
 *     → StrCpy $R8 "<lnk>" / ${StudiandaClearLnkAUMI}
 *   WinShell::UninstAppUserModelId "${APP_ID}"
 *     → StrCpy $R9 "${APP_ID}" / ${StudiandaUnregisterAUMID}
 *
 * aumid.nsh 由 electron-builder.yml 的 `nsis.include` 注入，且必须由本脚本复核
 * 「模板里不再有任何 WinShell 调用」，否则直接让打包失败。
 *
 * 幂等：重复执行不会产生额外改动；由 scripts/package.mjs 在生成安装包前调用。
 * 用法（仓库根目录）：node scripts/patch-nsis-templates.mjs
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const requireFromDesktop = createRequire(path.join(root, 'apps', 'desktop', 'package.json'));

const includeFile = path.join(root, 'apps', 'desktop', 'build', 'nsis', 'aumid.nsh');

function templatesDirFromRequire(requireFn, name) {
  try {
    const pkgJson = requireFn.resolve(`${name}/package.json`);
    const candidate = path.join(path.dirname(pkgJson), 'templates', 'nsis');
    if (existsSync(candidate)) return candidate;
  } catch {
    // 该包不可解析，交由调用方尝试下一条路径
  }
  return null;
}

function resolveTemplatesDir() {
  const direct = templatesDirFromRequire(requireFromDesktop, 'app-builder-lib');
  if (direct) return direct;
  try {
    const builderPkg = requireFromDesktop.resolve('electron-builder/package.json');
    const viaBuilder = templatesDirFromRequire(createRequire(builderPkg), 'app-builder-lib');
    if (viaBuilder) return viaBuilder;
  } catch {
    // 继续
  }
  const pnpmDir = path.join(root, 'node_modules', '.pnpm');
  if (existsSync(pnpmDir)) {
    for (const entry of readdirSync(pnpmDir)) {
      if (!entry.startsWith('app-builder-lib@')) continue;
      const candidate = path.join(pnpmDir, entry, 'node_modules', 'app-builder-lib', 'templates', 'nsis');
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

if (!existsSync(includeFile)) {
  console.error(`[nsis] 缺少 ${path.relative(root, includeFile)}：无法替换 WinShell 调用。`);
  process.exit(1);
}

const templatesDir = resolveTemplatesDir();
if (!templatesDir) {
  console.error('[nsis] 找不到 electron-builder 的 NSIS 模板目录，无法替换 WinShell 调用。');
  process.exit(1);
}

const targets = [
  path.join(templatesDir, 'include', 'installer.nsh'),
  path.join(templatesDir, 'uninstaller.nsh')
];

function walkNsis(dir) {
  const files = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) files.push(...walkNsis(full));
    else if (/\.(nsh|nsi)$/i.test(name)) files.push(full);
  }
  return files;
}

let replaced = 0;
for (const file of targets) {
  if (!existsSync(file)) {
    console.error(`[nsis] 缺少模板文件：${path.relative(root, file)}`);
    process.exit(1);
  }
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const indent = line.match(/^\s*/)[0];
    let match;
    if ((match = line.match(/^\s*WinShell::SetLnkAUMI\s+"([^"]+)"\s+"(\$\{APP_ID\})"\s*$/))) {
      out.push(`${indent}StrCpy $R8 "${match[1]}"`);
      out.push(`${indent}StrCpy $R9 "${match[2]}"`);
      out.push(`${indent}\${StudiandaSetLnkAUMI}`);
      replaced += 1;
      continue;
    }
    if ((match = line.match(/^\s*WinShell::UninstShortcut\s+"([^"]+)"\s*$/))) {
      out.push(`${indent}StrCpy $R8 "${match[1]}"`);
      out.push(`${indent}\${StudiandaClearLnkAUMI}`);
      replaced += 1;
      continue;
    }
    if ((match = line.match(/^\s*WinShell::UninstAppUserModelId\s+"([^"]+)"\s*$/))) {
      out.push(`${indent}StrCpy $R9 "${match[1]}"`);
      out.push(`${indent}\${StudiandaUnregisterAUMID}`);
      replaced += 1;
      continue;
    }
    out.push(line);
  }
  const next = out.join('\n');
  if (next !== readFileSync(file, 'utf8')) {
    writeFileSync(file, next, 'utf8');
    console.log(`[nsis] 已改写 ${path.relative(templatesDir, file)} 中的 WinShell 调用`);
  }
}

// 复核：整个模板目录不允许再出现 WinShell 调用。
const leftovers = [];
for (const file of walkNsis(templatesDir)) {
  readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .forEach((line, index) => {
      if (/WinShell::/.test(line)) leftovers.push(`${path.relative(templatesDir, file)}:${index + 1}`);
    });
}
if (leftovers.length > 0) {
  console.error(`[nsis] 模板中仍有 WinShell 调用，拒绝打包：${leftovers.join('、')}`);
  console.error('[nsis] 请更新 scripts/patch-nsis-templates.mjs 的替换规则后再打包。');
  process.exit(1);
}

// 复核：替换后的宏必须由 aumid.nsh 提供。
const includeText = readFileSync(includeFile, 'utf8');
for (const macro of ['StudiandaSetLnkAUMI', 'StudiandaClearLnkAUMI', 'StudiandaUnregisterAUMID']) {
  if (!includeText.includes(`!define ${macro} "!insertmacro ${macro}"`)) {
    console.error(`[nsis] ${path.relative(root, includeFile)} 未定义 ${macro}`);
    process.exit(1);
  }
}

console.log(
  replaced > 0
    ? `[nsis] WinShell 调用已改为脚本实现（本次 ${replaced} 处），安装包不再内嵌 WinShell.dll`
    : '[nsis] WinShell 调用此前已完成替换，无需改动'
);
