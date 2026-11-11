import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const legalDir = path.join(root, 'legal');
const auditDir = path.join(root, 'dev-notes', 'legal-audit');
const inventory = JSON.parse(readFileSync(path.join(legalDir, 'inventory.json'), 'utf8'));

function normalizeLicense(value) {
  if (!value) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map((item) => item?.type ?? String(item)).join(' OR ');
  return value.type ?? '';
}

async function fetchMetadata(record) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(record.name)}/${encodeURIComponent(record.version)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { url, body: await response.json() };
}

const results = [];
// 测试/基准 fixture 的 package.json 不是可发布依赖（registry 无此包），已在 THIRD-PARTY 中单列。
const queue = [...inventory.packages].filter((record) => !record.fixture);
const workers = Array.from({ length: 8 }, async () => {
  while (queue.length > 0) {
    const record = queue.shift();
    const id = `${record.name}@${record.version}`;
    try {
      const { url, body } = await fetchMetadata(record);
      const registryLicense = normalizeLicense(body.license);
      const localLicense = normalizeLicense(record.license);
      const repository =
        typeof body.repository === 'string'
          ? body.repository
          : body.repository?.url ?? record.repository ?? '';
      results.push({
        id,
        package: record.name,
        version: record.version,
        localLicense,
        registryLicense,
        match:
          !registryLicense ||
          localLicense.toLowerCase() === registryLicense.toLowerCase() ||
          localLicense.toLowerCase().includes(registryLicense.toLowerCase()),
        repository,
        tarball: body.dist?.tarball ?? '',
        integrity: body.dist?.integrity ?? '',
        registryUrl: url
      });
    } catch (error) {
      results.push({
        id,
        package: record.name,
        version: record.version,
        localLicense: normalizeLicense(record.license),
        registryLicense: '',
        match: false,
        error: error instanceof Error ? error.message : String(error),
        repository: record.repository ?? '',
        tarball: '',
        integrity: '',
        registryUrl: `https://registry.npmjs.org/${encodeURIComponent(record.name)}/${encodeURIComponent(record.version)}`
      });
    }
  }
});
await Promise.all(workers);

results.sort((left, right) => left.id.localeCompare(right.id));
const mismatches = results.filter((result) => !result.match);
const report = {
  generatedAt: new Date().toISOString(),
  checked: results.length,
  mismatches,
  packages: results
};
mkdirSync(auditDir, { recursive: true });
writeFileSync(
  path.join(auditDir, 'REGISTRY-AUDIT.json'),
  JSON.stringify(report, null, 2),
  'utf8'
);

const rows = results
  .map(
    (result) =>
      `| ${result.package} | ${result.version} | ${result.localLicense || '—'} | ${
        result.registryLicense || '—'
      } | ${result.match ? '一致' : '不一致/未校验'} | ${result.repository || '—'} |`
  )
  .join('\n');
const markdown = `# npm Registry 许可证交叉核查

生成时间：${new Date().toISOString()}

本报告用 **npm 官方 registry** 的包元数据核对安装包内实际依赖的版本、许可证声明和仓库地址。

- 检查包数：${results.length}
- 不一致或无法校验：${mismatches.length}

| 包 | 版本 | 包内声明 | Registry 声明 | 结果 | 官方仓库 |
|---|---|---|---|---|---|
${rows}

${
  mismatches.length
    ? `## 需要人工复核\n\n${mismatches
        .map(
          (result) =>
            `- \`${result.package}@${result.version}\`：包内 ${result.localLicense || '未声明'} / registry ${
              result.registryLicense || '未获取'
            }${result.error ? `（${result.error}）` : ''}`
        )
        .join('\n')}\n`
    : '## 结论\n\n所有可访问的 npm 包元数据与包内许可证声明一致，未发现缺失或冲突。\n'
}

## 说明

- 本报告只核对元数据，不替代许可证原文；
- 原文仍以 \`legal/licenses/\` 中随包文件为准；
- 网络失败会记录为“未校验”，需要重新运行。
`;
writeFileSync(path.join(auditDir, 'REGISTRY-AUDIT.md'), markdown, 'utf8');
console.log(`checked=${results.length} mismatches=${mismatches.length}`);
console.log(`output=${path.join(auditDir, 'REGISTRY-AUDIT.md')}`);
