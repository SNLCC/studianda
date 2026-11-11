import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'legal/upstream/official/napi-canvas');
const auditDir = path.join(root, 'dev-notes', 'legal-audit');
const sbom = JSON.parse(readFileSync(path.join(dir, 'sbom.cdx.json'), 'utf8'));

const manual = {
  'skia.win32-x64-msvc.node': 'BSD-3-Clause',
  anstyle: 'MIT OR Apache-2.0',
  canvas: 'MIT',
  clap: 'MIT OR Apache-2.0',
  clap_builder: 'MIT OR Apache-2.0',
  clap_lex: 'MIT OR Apache-2.0',
  'cxxbridge-cmd': 'MIT OR Apache-2.0',
  'skia-fontations': 'Apache-2.0',
  strsim: 'MIT'
};

const textMap = {
  MIT: 'clap-LICENSE-MIT.txt',
  'Apache-2.0': 'clap-LICENSE-APACHE.txt',
  'BSD-2-Clause': 'BSD-2-Clause.txt',
  'BSD-3-Clause': 'Skia-LICENSE.txt',
  'MPL-2.0': 'MPL-2.0.txt',
  Unlicense: 'Unlicense.txt',
  Zlib: 'zlib-LICENSE.txt',
  ISC: 'ISC.txt',
  ICU: 'ICU-LICENSE.txt',
  IJG: 'IJG.txt',
  'libpng-2.0': 'libpng-2.0.txt',
  'Unicode-3.0': 'Unicode-3.0.txt',
  FTL: 'FTL.txt'
};

function licenseOf(component) {
  const values = (component.licenses ?? [])
    .map((item) => item.license?.id ?? item.expression ?? item.name ?? '')
    .filter(Boolean);
  if (values.length > 0) return values.join(' OR ');
  return manual[component.name] ?? '未标注';
}

function tokens(expression) {
  return [
    ...new Set(
      expression
        .replace(/[()]/g, ' ')
        .split(/\s+(?:OR|AND)\s+|\s*\/\s*/i)
        .map((token) => token.trim())
        .filter(Boolean)
    )
  ];
}

const components = (sbom.components ?? []).map((component) => {
  const license = licenseOf(component);
  const componentTokens = tokens(license);
  const unresolved = componentTokens.filter((token) => !textMap[token]);
  return {
    name: component.name,
    version: component.version ?? '',
    license,
    textFiles: componentTokens
      .filter((token) => textMap[token])
      .map((token) => textMap[token]),
    unresolved
  };
});
const unresolved = components.filter((component) => component.unresolved.length > 0);
const licenseCounts = {};
for (const component of components) {
  licenseCounts[component.license] = (licenseCounts[component.license] ?? 0) + 1;
}

const rows = components
  .map(
    (component) =>
      `| ${component.name} | ${component.version} | ${component.license} | ${
        component.textFiles.join('<br>') || '—'
      } | ${component.unresolved.join(', ') || '—'} |`
  )
  .join('\n');
const counts = Object.entries(licenseCounts)
  .sort((a, b) => b[1] - a[1])
  .map(([license, count]) => `- ${license}：${count}`)
  .join('\n');

const report = `# @napi-rs/canvas SBOM 逐组件覆盖报告

生成时间：${new Date().toISOString()}

SBOM 是“组件清单”，不是逐组件许可证原文。本报告把 SBOM 中每个组件映射到许可证族和本地许可证文本，便于审计。

- 组件总数：${components.length}
- 已覆盖许可证文本：${components.length - unresolved.length}
- 仍有未覆盖：${unresolved.length}

## 许可证分布

${counts}

## 逐组件

| 组件 | 版本 | 许可证 | 本地许可证文本 | 未覆盖 |
|---|---|---|---|---|
${rows}

## 结论

${unresolved.length === 0 ? '所有 SBOM 组件的许可证族均已映射到本地许可证文本，未发现未覆盖项。' : '仍有未覆盖项，需要补充。'}
`;

mkdirSync(auditDir, { recursive: true });
writeFileSync(path.join(auditDir, 'SBOM-AUDIT.md'), report, 'utf8');
writeFileSync(
  path.join(auditDir, 'SBOM-AUDIT.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), components, unresolved }, null, 2),
  'utf8'
);
console.log(`components=${components.length} unresolved=${unresolved.length}`);
if (unresolved.length) {
  console.error(unresolved.map((item) => `${item.name}: ${item.unresolved.join(',')}`).join('\n'));
  process.exitCode = 1;
}
