/** 校验 server 路由与 api-client 方法是否一致。 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(import.meta.dirname, '..');
const serverFile = path.join(root, 'packages', 'core', 'src', 'server.ts');
const serverDir = path.join(root, 'packages', 'core', 'src', 'server');
// 路由按域拆分后，契约门禁必须扫描 server.ts + server/*.ts，否则会误报 "客户端有、服务端无"。
const serverFiles = [
  serverFile,
  ...readdirSync(serverDir)
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => path.join(serverDir, name))
];
const clientFile = path.join(root, 'packages', 'api-client', 'src', 'index.ts');
const manifestFile = path.join(root, 'docs', 'api', 'route-manifest.json');
const allowlistFile = path.join(root, 'scripts', 'contract-allowlist.json');

const ROUTE_METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const PREFIX = '/api/v1';
const CLIENT_CALLS = new Set(['request', 'requestRetry', 'requestBlob', 'fetch', 'EventSource']);

/** 读源码并返回 AST + 便于取原文的 sourceFile。 */
function parse(file) {
  const text = readFileSync(file, 'utf8');
  return {
    text,
    source: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  };
}

/** 模板/字符串字面量的原文（去掉外层引号，保留 `${...}` 表达式）。 */
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
      // `${... ? '?a=b' : ''}` 之类的 query 片段与 URLSearchParams 变量都不是路径段。
      if (!expression.includes('?') && !isQueryBuilder) output += ':p';
    } else {
      output += value[index];
      index += 1;
    }
  }
  return output;
}

/** 把路径归一到可比较形式。 */
function normalizePath(raw) {
  if (!raw) return null;
  let value = raw.trim();
  value = value.replace(/\$\{base\}/g, '');
  value = value.replace(/^https?:\/\/[^/]+/i, '');
  value = value.replace(/\$\{API_PREFIX\}/g, PREFIX);
  value = reduceTemplateExpressions(value);
  value = value.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':p');
  value = value.split('?')[0];
  if (!value.startsWith('/')) value = `/${value}`;
  if (!value.startsWith(PREFIX)) value = `${PREFIX}${value}`;
  value = value.replace(/\/+$/, '') || PREFIX;
  return value;
}

function extractServerRoutes(sourceFile) {
  const routes = new Set();
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'app' &&
      ROUTE_METHODS.includes(node.expression.name.text)
    ) {
      const raw = literalText(node.arguments[0], sourceFile);
      const pathName = raw ? normalizePath(raw) : null;
      if (pathName) routes.add(`${node.expression.name.text.toUpperCase()} ${pathName}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return routes;
}

function readClientMethod(node, sourceFile) {
  if (node.arguments.length < 2) return null;
  const init = node.arguments[1];
  if (!ts.isObjectLiteralExpression(init)) return null;
  for (const property of init.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === 'method' &&
      ts.isStringLiteralLike(property.initializer)
    ) {
      return property.initializer.text.toUpperCase();
    }
  }
  return null;
}

function extractClientRoutes(sourceFile) {
  const routes = new Set();
  const visit = (node) => {
    if (
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      ts.isIdentifier(node.expression)
    ) {
      const callee = node.expression.text;
      if (CLIENT_CALLS.has(callee)) {
        const raw = literalText(node.arguments?.[0], sourceFile);
        // request(`${base}${path}`) 是传输实现，不是接口路径。
        if (raw && !/^\$\{base\}\$\{path\}$/.test(raw) && raw !== '${path}') {
          const pathName = normalizePath(raw);
          if (pathName) {
            const method =
              callee === 'EventSource' ? 'GET' : (readClientMethod(node, sourceFile) ?? 'GET');
            routes.add(`${method} ${pathName}`);
          }
        }
      }
    }
    // getDocumentFileSource 返回 { url, httpHeaders }，url 也是契约的一部分。
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'url'
    ) {
      const raw = literalText(node.initializer, sourceFile);
      const pathName = raw ? normalizePath(raw) : null;
      if (pathName) routes.add(`GET ${pathName}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return routes;
}

function readAllowlist() {
  if (!existsSync(allowlistFile)) return { missing: [], reason: {} };
  const parsed = JSON.parse(readFileSync(allowlistFile, 'utf8'));
  return {
    missing: Array.isArray(parsed.missing) ? parsed.missing : [],
    reason: parsed.reason && typeof parsed.reason === 'object' ? parsed.reason : {}
  };
}

const serverSources = serverFiles.map(parse);
const client = parse(clientFile);
const serverRoutes = new Set();
for (const source of serverSources) {
  for (const route of extractServerRoutes(source.source)) serverRoutes.add(route);
}
const clientRoutes = extractClientRoutes(client.source);
const allowlist = readAllowlist();

const missing = [...serverRoutes].filter((entry) => !clientRoutes.has(entry)).sort();
const clientOnly = [...clientRoutes].filter((entry) => !serverRoutes.has(entry)).sort();
const allowlisted = missing.filter((entry) => allowlist.missing.includes(entry));
const unallowlistedMissing = missing.filter((entry) => !allowlist.missing.includes(entry));

const manifest = {
  apiPrefix: PREFIX,
  apiVersion: 1,
  note: '由 scripts/check-contract.mjs 生成；不要手工编辑。',
  counts: {
    serverRoutes: serverRoutes.size,
    clientRoutes: clientRoutes.size,
    missingFromClient: missing.length,
    clientOnly: clientOnly.length,
    allowlistedMissing: allowlisted.length
  },
  serverRoutes: [...serverRoutes].sort(),
  missingFromClient: missing,
  allowlistedMissing: allowlisted.map((entry) => ({ entry, reason: allowlist.reason[entry] ?? '' })),
  clientOnly,
  nextSteps:
    unallowlistedMissing.length === 0 && clientOnly.length === 0
      ? []
      : '新增/修改路由后同步更新 packages/api-client；确属壳专用路由请在 scripts/contract-allowlist.json 写明 reason。'
};

mkdirSync(path.dirname(manifestFile), { recursive: true });
writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(
  `[contract] server=${manifest.counts.serverRoutes} client=${manifest.counts.clientRoutes} ` +
    `missing=${manifest.counts.missingFromClient} clientOnly=${manifest.counts.clientOnly}`
);
if (unallowlistedMissing.length > 0) {
  console.error('[contract] 服务端有、客户端无（且未白名单）：');
  for (const entry of unallowlistedMissing) console.error(`  - ${entry}`);
}
if (clientOnly.length > 0) {
  console.error('[contract] 客户端有、服务端无：');
  for (const entry of clientOnly) console.error(`  - ${entry}`);
}
if (unallowlistedMissing.length > 0 || clientOnly.length > 0) {
  process.exitCode = 1;
} else {
  console.log(`[contract] ok；清单已写入 ${path.relative(root, manifestFile)}`);
}
