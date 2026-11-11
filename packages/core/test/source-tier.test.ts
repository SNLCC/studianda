import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SecretStore } from '../src/secrets.js';
import {
  SOURCE_TIERS,
  annotate,
  hostOf,
  labelOf,
  listing,
  rankOf,
  tierOf
} from '../src/source-tier.js';
import { Store } from '../src/store.js';
import { saveSearchConfig, searchWeb } from '../src/web-search.js';

describe('source tier', () => {
  it('reads the host as a domain fact (lowercase, without www.)', () => {
    expect(hostOf('https://www.arxiv.org/abs/2401.00001')).toBe('arxiv.org');
    expect(hostOf('https://WWW.Nature.COM/articles/x')).toBe('nature.com');
    expect(hostOf('https://plato.stanford.edu./entries/logic/')).toBe(
      'plato.stanford.edu'
    );
    expect(hostOf('https://sub.example.com/a')).toBe('sub.example.com');
  });

  it('does not assert anything when the URL is unusable', () => {
    expect(hostOf('not a url')).toBe('');
    expect(hostOf('')).toBe('');
    expect(hostOf(null)).toBe('');
    expect(hostOf('file:///etc/passwd')).toBe('');
    expect(tierOf('not a url')).toBe('GENERAL_WEB');
    expect(tierOf('file:///etc/passwd')).toBe('GENERAL_WEB');
  });

  it('classifies tiers from registrable domain ownership', () => {
    expect(tierOf('https://arxiv.org/abs/2401.00001')).toBe('PREPRINT');
    expect(tierOf('https://www.biorxiv.org/content/1')).toBe('PREPRINT');
    expect(tierOf('https://www.nature.com/articles/x')).toBe('JOURNAL_DOMAIN');
    expect(tierOf('https://doi.org/10.1000/xyz')).toBe('ACADEMIC_PUBLISHER');
    expect(tierOf('https://plato.stanford.edu/entries/logic/')).toBe('REFERENCE_WORK');
    expect(tierOf('https://en.wikipedia.org/wiki/Logic')).toBe('REFERENCE_WORK');
    // 机构域名 + /entries/ 路径：域名本身说明不了，路径可以。
    expect(tierOf('https://www.philosophy.stanford.edu/entries/logic')).toBe(
      'REFERENCE_WORK'
    );
    expect(tierOf('https://www.moe.gov.cn/a')).toBe('GOVERNMENT');
    expect(tierOf('https://www.tsinghua.edu.cn/a')).toBe('INSTITUTION');
    expect(tierOf('https://example.com/blog/post')).toBe('GENERAL_WEB');
    expect(tierOf('https://unknown.example.org/a')).toBe('GENERAL_WEB');
  });

  it('has a stable display order and labels that do not claim quality', () => {
    expect(SOURCE_TIERS).toEqual([
      'PREPRINT',
      'JOURNAL_DOMAIN',
      'ACADEMIC_PUBLISHER',
      'INSTITUTION',
      'GOVERNMENT',
      'REFERENCE_WORK',
      'GENERAL_WEB'
    ]);
    expect(rankOf('PREPRINT')).toBe(0);
    expect(rankOf('GENERAL_WEB')).toBe(6);
    expect(rankOf('UNKNOWN_TIER')).toBe(SOURCE_TIERS.length);
    expect(labelOf('PREPRINT')).toBe('预印本平台');
    expect(labelOf('nonsense')).toBe('一般网页');
  });

  it('annotates and stably sorts results by tier, keeping same-tier order', () => {
    const input = [
      { title: 'blog', url: 'https://blog.example.com/post' },
      { title: 'nature', url: 'https://www.nature.com/articles/x' },
      { title: 'arxiv', url: 'https://arxiv.org/abs/1' },
      { title: 'unknown', url: 'https://unknown.example.org/a' },
      { title: 'sep', url: 'https://plato.stanford.edu/entries/logic' }
    ];
    const snapshot = JSON.parse(JSON.stringify(input));
    const rows = annotate(input);
    expect(rows.map((row) => row.title)).toEqual([
      'arxiv',
      'nature',
      'sep',
      'blog',
      'unknown'
    ]);
    expect(rows.map((row) => row.tier)).toEqual([
      'PREPRINT',
      'JOURNAL_DOMAIN',
      'REFERENCE_WORK',
      'GENERAL_WEB',
      'GENERAL_WEB'
    ]);
    expect(rows[0]?.tierLabel).toBe('预印本平台');
    // 只加标注，不改调用方传进来的对象。
    expect(input).toEqual(snapshot);
  });

  it('lists only tiers that actually appeared, with unique hosts and a truthful note', () => {
    const rows = annotate([
      { url: 'https://arxiv.org/abs/1' },
      { url: 'https://www.nature.com/articles/x' },
      { url: 'https://plato.stanford.edu/entries/logic' },
      { url: 'https://blog.example.com/post' },
      { url: 'https://unknown.example.org/a' }
    ]);
    const result = listing(rows);
    expect(result.counts).toEqual({
      PREPRINT: 1,
      JOURNAL_DOMAIN: 1,
      REFERENCE_WORK: 1,
      GENERAL_WEB: 2
    });
    expect(result.groups.map((group) => group.tier)).toEqual([
      'PREPRINT',
      'JOURNAL_DOMAIN',
      'REFERENCE_WORK',
      'GENERAL_WEB'
    ]);
    expect(result.groups[3]).toMatchObject({
      label: '一般网页',
      count: 2,
      hosts: ['blog.example.com', 'unknown.example.org']
    });
    expect(result.note).toContain('只按域名归属分组');
    expect(result.note).toContain('不代表内容质量');
    expect(result.note).toContain('不等于已经查过学术资料库');
  });
});

describe('web search tiers', () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-source-tier-'));
  const store = new Store(dataDir);
  const secrets = new SecretStore();

  afterAll(() => {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns tiered results sorted by tier without changing the count', async () => {
    saveSearchConfig(store, secrets, { provider: 'deepseek', api_key: 'key' });
    vi.stubGlobal('fetch', async () =>
      new Response(
        JSON.stringify({
          results: [
            { title: 'blog', url: 'https://blog.example.com/post', snippet: 'b' },
            { title: 'nature', url: 'https://www.nature.com/articles/x', snippet: 'n' },
            { title: 'arxiv', url: 'https://arxiv.org/abs/1', snippet: 'a' }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    try {
      const results = await searchWeb(store, secrets, 'query');
      // 条数语义不变（仍然是最多 5 条），只是按层级稳定排序。
      expect(results).toHaveLength(3);
      expect(results.map((item) => item.url)).toEqual([
        'https://arxiv.org/abs/1',
        'https://www.nature.com/articles/x',
        'https://blog.example.com/post'
      ]);
      expect(results.map((item) => item.tier)).toEqual([
        'PREPRINT',
        'JOURNAL_DOMAIN',
        'GENERAL_WEB'
      ]);
      expect(results.map((item) => item.tierLabel)).toEqual([
        '预印本平台',
        '期刊网站',
        '一般网页'
      ]);
      expect(listing(results).counts).toEqual({
        PREPRINT: 1,
        JOURNAL_DOMAIN: 1,
        GENERAL_WEB: 1
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
