/**
 * 校验 server 路由注册顺序（只读门禁，不写任何文件）。
 *
 * 背景：chat 集群按状态所有权拆分时，路由要从 `server.ts` 内联搬进 `server/*.ts`
 * 模块，注册点改成 `registerXRoutes(app, deps)`。搬迁最容易出的问题是**路由序列变了**
 * （注册位置漂移/重复注册/被通配路由影子化），而 `check:contract` 用 Set 去重、
 * `route-wiring.test.ts` 按 manifest 遍历，两者都**抓不到顺序变化**。此前几轮靠手工
 * `git show HEAD:...` 逐条比对，本脚本把这件事固化：
 *
 *   1. 从 git 基线（默认 HEAD）取 `server.ts` + `server/*.ts`，**展开**每个
 *      `registerXRoutes(app, ...)` 调用（按模块函数体内源码顺序原地插入其路由）；
 *   2. 对工作区做同样的展开，得到两条 `METHOD /path` 序列；
 *   3. 逐条比对：路由集合差异（缺失/新增/重复）与顺序差异分别报告。
 *
 * 用法：
 *   node scripts/check-route-order.mjs                  # 基线 = HEAD
 *   node scripts/check-route-order.mjs --baseline <rev> # 指定任意 git rev / 分支 / tag
 *   node scripts/check-route-order.mjs --list           # 打印工作区展开后的完整序列
 *   node scripts/check-route-order.mjs --json           # 机器可读结果
 *
 * 退出码：0 = 序列逐条一致；1 = 路由集合一致但顺序不同；2 = 路由集合/重复注册有差异；
 *         3 = 脚本自身错误（rev 不存在、注册函数无法解析等）。本脚本**不**判断
 *         find-my-way 的静态/参数优先级，只做"和基线相比动了没有"的机械比对。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const SERVER_REL = 'packages/core/src/server.ts';
const SERVER_DIR_REL = 'packages/core/src/server';
const ROUTE_METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const API_PREFIX = '/api/v1';
/** 判断一个模块是否"自己会注册路由"（用于发现注册了却没人接线的模块）。 */
const ROUTE_CALL_PATTERN = /\bapp\.(?:get|post|put|patch|delete)\(/;

function usage(message) {
  if (message) console.error(`[route-order] ${message}`);
  console.error(
    '用法: node scripts/check-route-order.mjs [--baseline <rev>] [--list] [--json] [--quiet]'
  );
  process.exit(3);
}

function parseArgs(argv) {
  const options = { baseline: 'HEAD', list: false, json: false, quiet: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--baseline') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) usage('--baseline 需要一个 git rev');
      options.baseline = value;
      index += 1;
    } else if (arg.startsWith('--baseline=')) {
      const value = arg.slice('--baseline='.length);
      if (!value) usage('--baseline= 后面需要 git rev');
      options.baseline = value;
    } else if (arg === '--list') {
      options.list = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--quiet') {
      options.quiet = true;
    } else if (arg === '--help' || arg === '-h') {
      usage();
    } else {
      usage(`未知参数: ${arg}`);
    }
  }
  return options;
}

/** 模板/字符串字面量原文（保留 `${...}` 表达式，与 check-contract.mjs 同口径）。 */
function literalText(node, sourceFile) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.getText(sourceFile).slice(1, -1);
  }
  if (ts.isTemplateExpression(node)) {
    return node.getText(sourceFile).slice(1, -1);
  }
  return null;
}

/** 把模板表达式归约为 :p（支持嵌套花括号），丢弃 query 片段。 */
function reduceTemplateExpressions(value) {
  let output = '';
  let index = 0;
  while (index < value.length) {
    if (value[index] === '$' && value[index + 1] === '{') {
      const start = index;
      let depth = 1;
      index += 2;
      while (index < value.length && depth > 0) {
        if (value[index] === '{') depth += 1;
        else if (value[index] === '}') depth -= 1;
        index += 1;
      }
      const expression = value.slice(start + 2, index - 1);
      const isQueryBuilder = /^\s*(suffix|query|params|qs|search)\s*$/i.test(expression);
      if (!expression.includes('?') && !isQueryBuilder) output += ':p';
    } else {
      output += value[index];
      index += 1;
    }
  }
  return output;
}

/** 路径归一（与 check-contract.mjs 保持一致，便于两处计数互相印证）。 */
function normalizePath(raw) {
  if (!raw) return null;
  let value = raw.trim();
  value = value.replace(/\$\{base\}/g, '');
  value = value.replace(/^https?:\/\/[^/]+/i, '');
  value = value.replace(/\$\{API_PREFIX\}/g, API_PREFIX);
  value = reduceTemplateExpressions(value);
  value = value.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':p');
  value = value.split('?')[0];
  if (!value.startsWith('/')) value = `/${value}`;
  if (!value.startsWith(API_PREFIX)) value = `${API_PREFIX}${value}`;
  value = value.replace(/\/+$/, '') || API_PREFIX;
  return value;
}

function parseSource(label, text) {
  return ts.createSourceFile(label, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

/** 把 `app.get(...)` / `app.post(...)` 识别为路由注册。 */
function routeOfCall(node) {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression) ||
    !ts.isIdentifier(node.expression.expression) ||
    node.expression.expression.text !== 'app' ||
    !ROUTE_METHODS.includes(node.expression.name.text)
  ) {
    return null;
  }
  return node;
}

/** 源码树加载器：工作区与任意 git rev 共用同一接口，展开逻辑只写一份。 */
function createTreeLoader(kind, rev) {
  const cache = new Map();
  const modulePaths = (() => {
    if (kind === 'worktree') {
      const absolute = path.join(root, SERVER_DIR_REL);
      if (!existsSync(absolute)) return [];
      return readdirSync(absolute)
        .filter((name) => name.endsWith('.ts'))
        .sort()
        .map((name) => `${SERVER_DIR_REL}/${name}`);
    }
    const output = execFileSync(
      'git',
      ['ls-tree', '-r', '--name-only', rev, '--', SERVER_REL, SERVER_DIR_REL],
      { cwd: root, encoding: 'utf8' }
    );
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(
        (file) =>
          file === SERVER_REL ||
          (file.startsWith(`${SERVER_DIR_REL}/`) &&
            file.endsWith('.ts') &&
            !file.slice(`${SERVER_DIR_REL}/`.length).includes('/'))
      )
      .filter((file) => file !== SERVER_REL)
      .sort();
  })();

  const getText = (relPath) => {
    if (cache.has(relPath)) return cache.get(relPath);
    let text = null;
    if (kind === 'worktree') {
      const absolute = path.join(root, relPath);
      if (existsSync(absolute)) text = readFileSync(absolute, 'utf8');
    } else {
      try {
        text = execFileSync('git', ['show', `${rev}:${relPath}`], {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore']
        });
      } catch {
        text = null;
      }
    }
    cache.set(relPath, text);
    return text;
  };

  return { kind, rev, getText, modulePaths };
}

/** 解析 import 映射：本地名 -> { path, importedName }；只收相对模块并把 .js 归到 .ts。 */
function importMapOf(relPath, sourceFile) {
  const map = new Map();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;
    const resolved = path.posix
      .normalize(path.posix.join(path.posix.dirname(relPath), specifier))
      .replace(/\.js$/, '.ts');
    if (!resolved.endsWith('.ts')) continue;
    const clause = statement.importClause;
    if (!clause) continue;
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if (!ts.isIdentifier(element.name)) continue;
        map.set(element.name.text, {
          path: resolved,
          importedName: element.propertyName ? element.propertyName.text : element.name.text
        });
      }
    }
  }
  return map;
}

/** 找到 export function <name>（兼容 `export const <name> = (...) => ...` 写法）。 */
function findExportedFunction(sourceFile, name) {
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name && statement.body) {
      return { node: statement, body: statement.body };
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || declaration.name.text !== name) continue;
        const init = declaration.initializer;
        if (!init) continue;
        const fn = ts.isArrowFunction(init) || ts.isFunctionExpression(init) ? init : null;
        if (fn?.body) return { node: declaration, body: fn.body };
      }
    }
  }
  return null;
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

/**
 * 把一棵源码树展开为有序路由序列。
 * - 路由调用：原地记录 `METHOD path`；
 * - `registerXRoutes(app, ...)`：按被调模块函数体内的源码顺序原地位插入其路由（可递归）；
 * - 其它节点按源码顺序继续下钻。
 */
function expandTree(loader) {
  const routes = [];
  const expandedModules = new Set();
  const stack = [];
  const contexts = new Map();

  const contextOf = (relPath) => {
    const cached = contexts.get(relPath);
    if (cached) return cached;
    const text = loader.getText(relPath);
    if (text === null) return null;
    const label = loader.kind === 'worktree' ? relPath : `${loader.rev}:${relPath}`;
    const sourceFile = parseSource(label, text);
    const context = { relPath, sourceFile, imports: importMapOf(relPath, sourceFile) };
    contexts.set(relPath, context);
    return context;
  };

  const recordRoute = (context, node) => {
    const raw = literalText(node.arguments[0], context.sourceFile);
    const routePath = raw ? normalizePath(raw) : null;
    if (!routePath) return false;
    routes.push({
      method: node.expression.name.text.toUpperCase(),
      path: routePath,
      source: `${context.relPath}:${lineOf(context.sourceFile, node)}`
    });
    return true;
  };

  const visit = (context, node) => {
    const routeCall = routeOfCall(node);
    if (routeCall) {
      recordRoute(context, routeCall);
      return; // 不再下钻 handler，避免把 handler 内代码误当注册
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const imported = context.imports.get(node.expression.text);
      if (imported && /^register[A-Z]/.test(imported.importedName)) {
        const key = `${imported.path}#${imported.importedName}`;
        if (stack.includes(key)) throw new Error(`注册函数循环引用: ${key}`);
        const moduleContext = contextOf(imported.path);
        if (!moduleContext) {
          throw new Error(
            `无法解析注册函数 ${imported.importedName}：模块 ${imported.path} 不存在`
          );
        }
        const fn = findExportedFunction(moduleContext.sourceFile, imported.importedName);
        if (!fn) {
          throw new Error(
            `无法解析注册函数 ${imported.importedName}（来自 ${imported.path}）`
          );
        }
        expandedModules.add(imported.path);
        stack.push(key);
        try {
          visit(moduleContext, fn.body);
        } finally {
          stack.pop();
        }
        return;
      }
    }
    ts.forEachChild(node, (child) => visit(context, child));
  };

  const serverContext = contextOf(SERVER_REL);
  if (!serverContext) throw new Error(`读不到 ${loader.kind} 的 ${SERVER_REL}`);
  visit(serverContext, serverContext.sourceFile);

  const modulesWithRoutes = loader.modulePaths.filter((relPath) => {
    const text = loader.getText(relPath);
    return text !== null && ROUTE_CALL_PATTERN.test(text);
  });
  const unregisteredModules = modulesWithRoutes.filter(
    (relPath) => !expandedModules.has(relPath)
  );
  return { routes, expandedModules, unregisteredModules };
}

function keyOf(route) {
  return `${route.method} ${route.path}`;
}

/** 路由多重集（保留重复注册：重复本身就是影子化风险）。 */
function multiset(routes) {
  const counts = new Map();
  for (const route of routes) {
    const key = keyOf(route);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function compare(baselineRoutes, currentRoutes) {
  const baseSet = multiset(baselineRoutes);
  const currentSet = multiset(currentRoutes);
  const missing = [];
  const added = [];
  for (const [key, count] of baseSet) {
    const have = currentSet.get(key) ?? 0;
    if (have < count) missing.push({ key, count: count - have });
  }
  for (const [key, count] of currentSet) {
    const had = baseSet.get(key) ?? 0;
    if (count > had) added.push({ key, count: count - had });
  }
  const duplicates = [...currentSet].filter(([, count]) => count > 1);
  const reorder = [];
  const length = Math.max(baselineRoutes.length, currentRoutes.length);
  for (let index = 0; index < length; index += 1) {
    const before = baselineRoutes[index];
    const after = currentRoutes[index];
    if (!before || !after || keyOf(before) !== keyOf(after)) {
      reorder.push({
        index,
        baseline: before ? `${keyOf(before)} (${before.source})` : '(缺失)',
        current: after ? `${keyOf(after)} (${after.source})` : '(缺失)'
      });
    }
  }
  return { missing, added, duplicates, reorder };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  try {
    execFileSync('git', ['rev-parse', '--verify', `${options.baseline}^{commit}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch {
    usage(`基线 rev 不存在: ${options.baseline}`);
  }

  const baselineTree = expandTree(createTreeLoader('git', options.baseline));
  const currentTree = expandTree(createTreeLoader('worktree'));
  const diff = compare(baselineTree.routes, currentTree.routes);

  if (options.list) {
    for (const [index, route] of currentTree.routes.entries()) {
      console.log(`${String(index + 1).padStart(3)}. ${keyOf(route)}  ${route.source}`);
    }
  }

  const identical =
    diff.missing.length === 0 &&
    diff.added.length === 0 &&
    diff.duplicates.length === 0 &&
    diff.reorder.length === 0;
  const result = {
    baseline: options.baseline,
    baselineRoutes: baselineTree.routes.length,
    currentRoutes: currentTree.routes.length,
    identical,
    missing: diff.missing,
    added: diff.added,
    duplicates: diff.duplicates,
    reorder: diff.reorder,
    unregisteredModules: currentTree.unregisteredModules
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (options.quiet) {
    console.log(
      `[route-order] baseline=${options.baseline} ` +
        `baselineRoutes=${baselineTree.routes.length} currentRoutes=${currentTree.routes.length} => ` +
        (identical
          ? '逐条一致'
          : `不一致（missing=${diff.missing.length} added=${diff.added.length} ` +
            `duplicates=${diff.duplicates.length} reorder=${diff.reorder.length}）`)
    );
  } else {
    const head =
      `[route-order] baseline=${options.baseline} ` +
      `baselineRoutes=${baselineTree.routes.length} currentRoutes=${currentTree.routes.length}`;
    if (identical) {
      console.log(`${head} => 逐条一致`);
    } else {
      console.log(head);
      if (diff.missing.length > 0) {
        console.error('[route-order] 工作区缺失（基线有、工作区无）：');
        for (const item of diff.missing) {
          console.error(`  - ${item.key}${item.count > 1 ? ` x${item.count}` : ''}`);
        }
      }
      if (diff.added.length > 0) {
        console.error('[route-order] 工作区新增（基线无、工作区有）：');
        for (const item of diff.added) {
          console.error(`  - ${item.key}${item.count > 1 ? ` x${item.count}` : ''}`);
        }
      }
      if (diff.duplicates.length > 0) {
        console.error('[route-order] 工作区重复注册（method+path 相同，后者被影子化）：');
        for (const [key, count] of diff.duplicates) console.error(`  - ${key} x${count}`);
      }
      if (diff.reorder.length > 0) {
        const preview = diff.reorder.slice(0, 12);
        console.error(
          `[route-order] 顺序不同：共 ${diff.reorder.length} 个位置与基线不一致` +
            (diff.reorder.length > preview.length ? `（只列前 ${preview.length} 个）` : '')
        );
        for (const item of preview) {
          console.error(`  #${item.index + 1}`);
          console.error(`    基线: ${item.baseline}`);
          console.error(`    工作区: ${item.current}`);
        }
      }
    }
    if (currentTree.unregisteredModules.length > 0) {
      console.error('[route-order] 有路由注册但未被 server.ts 接线的模块（可疑）：');
      for (const module of currentTree.unregisteredModules) console.error(`  - ${module}`);
    }
  }

  const exitCode =
    diff.missing.length > 0 || diff.added.length > 0 || diff.duplicates.length > 0
      ? 2
      : diff.reorder.length > 0
        ? 1
        : 0;
  process.exitCode = exitCode;
}

try {
  main();
} catch (error) {
  console.error(`[route-order] 失败: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 3;
}
