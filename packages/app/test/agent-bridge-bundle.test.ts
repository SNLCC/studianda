import { describe, expect, it } from 'vitest';
import { agentBridgeBundleFiles } from '@studianda/shared';

describe('Agent MCP bundle 生成', () => {
  const files = agentBridgeBundleFiles({
    command: 'C:\\Program Files\\Studianda\\Studianda.exe',
    script: 'C:\\Program Files\\Studianda\\resources\\agent-bridge.mjs',
    dataDir: "C:\\Users\\O'Brien\\Documents\\勘读资料",
    version: '1.2.3'
  });
  const byPath = new Map(files.map((file) => [file.relativePath, file.content]));

  it('是 DSH 可识别的配置型 bundle', () => {
    const manifest = JSON.parse(byPath.get('package.json') ?? '{}') as {
      version?: string;
      dsh?: { bundle?: { patch?: string } };
      exports?: Record<string, string>;
    };
    expect(manifest.version).toBe('1.2.3');
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml');
    expect(manifest.exports?.['./icon']).toBe('./icon.svg');
    for (const path of ['cordis.patch.yml', 'locale/en.json', 'locale/zh.json', 'icon.svg', 'docs/DETAIL.md']) {
      expect(byPath.has(path), path).toBe(true);
    }
  });

  it('patch 用真实路径并且正确转义单引号', () => {
    const patch = byPath.get('cordis.patch.yml') ?? '';
    expect(patch).toContain("name: '@deepseek-ai/dsh-mcp-client'");
    expect(patch).toContain("serverName: studianda");
    expect(patch).toContain("transport: stdio");
    expect(patch).toContain("command: 'C:\\Program Files\\Studianda\\Studianda.exe'");
    expect(patch).toContain("'C:\\Program Files\\Studianda\\resources\\agent-bridge.mjs'");
    expect(patch).toContain("O''Brien");
    expect(patch).not.toContain('<安装目录>');
    expect(patch).toContain('ELECTRON_RUN_AS_NODE');
  });

  it('locale 有标题与说明，icon 是合法 SVG', () => {
    const zh = JSON.parse(byPath.get('locale/zh.json') ?? '{}') as {
      meta?: { title?: string; description?: string };
    };
    expect(zh.meta?.title).toBeTruthy();
    expect(zh.meta?.description).toContain('MCP');
    expect(byPath.get('icon.svg')).toContain('<svg');
  });
});
