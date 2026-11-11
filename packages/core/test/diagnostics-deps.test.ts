import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateDiagnostics } from '../src/diagnostics.js';
import { Store } from '../src/store.js';

/**
 * 诊断依赖版本：
 * 报告里必须有 dependencies，版本非空；读不到的包列进 missing 而不是抛错。
 */
let dataDir = '';
let store: Store;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-diagnostics-deps-'));
  store = new Store(dataDir);
});

afterEach(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('diagnostics dependencies', () => {
  it('报告包含运行时与关键依赖版本', () => {
    const report = generateDiagnostics(store, { name: '勘读', version: '0.0.0-test' });
    expect(report.dependencies).toBeTruthy();
    expect(report.dependencies.node).toBe(process.versions.node);
    expect(typeof report.dependencies.electron).toBe('string');
    // 关键包都应在开发环境装好；版本是 semver 字符串。
    for (const name of ['pdf-lib', 'pdfjs-dist', 'fflate']) {
      expect(report.dependencies.packages[name]).toMatch(/^\d+\.\d+/);
    }
    expect(Array.isArray(report.dependencies.missing)).toBe(true);
  });

  it('依赖版本进入 JSON（诊断包内容）且缺包不阻断', () => {
    const report = generateDiagnostics(store, { name: '勘读', version: '0.0.0-test' });
    const cloned = JSON.parse(JSON.stringify(report)) as {
      dependencies: { packages: Record<string, string>; missing: string[] };
    };
    expect(cloned.dependencies.packages['pdf-lib']).toBeTruthy();
    // missing 里列出的包不能同时出现在 packages 里；两者都如实。
    for (const name of cloned.dependencies.missing) {
      expect(cloned.dependencies.packages[name]).toBeUndefined();
    }
    expect(report.integrity).toBe('ok');
  });
});
