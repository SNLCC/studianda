/**
 * 外部来源的结构分层（Web 分层）——**只说域名是什么，不评价它好不好**。
 *
 * 逐行* 1. 把可核验的**域名事实**标出来，让用户一眼看出"这是一篇预印本"还是"这是高校机构库"；
 * 2. 绝不让分层冒充质量判定——"这是大学网站"与"这个网站上的说法可靠"是两件事；
 *    本应用只有通用网页搜索，没有学术资料库检索，标了"预印本平台"不等于查过学术库。
 *
 * 因此这里的词表刻意只放**公开、可核对、归属唯一**的域名，并且宁可返回 GENERAL_WEB：
 * 认不出来就是"一般网页"，不猜。
 */

/** 层级顺序 = 显示顺序（不是质量顺序）。每一层都对应一个能核对的域名事实。 */
export const SOURCE_TIERS = [
  'PREPRINT',
  'JOURNAL_DOMAIN',
  'ACADEMIC_PUBLISHER',
  'INSTITUTION',
  'GOVERNMENT',
  'REFERENCE_WORK',
  'GENERAL_WEB'
] as const;

export type SourceTier = (typeof SOURCE_TIERS)[number];

export const TIER_LABELS: Record<SourceTier, string> = {
  PREPRINT: '预印本平台',
  JOURNAL_DOMAIN: '期刊网站',
  ACADEMIC_PUBLISHER: '学术出版社网站',
  INSTITUTION: '高校或研究机构网站',
  GOVERNMENT: '政府或公共机构网站',
  REFERENCE_WORK: '百科或参考资料站',
  GENERAL_WEB: '一般网页'
};

// 判断依据只有一条：这个域名属于谁。不涉及内容、不涉及该内容是否可信。
const PREPRINT = [
  'arxiv.org',
  'biorxiv.org',
  'medrxiv.org',
  'ssrn.com',
  'osf.io',
  'preprints.org',
  'chinaxiv.org',
  'techrxiv.org',
  'eartharxiv.org',
  'psyarxiv.com'
] as const;

const JOURNAL_DOMAIN = [
  'nature.com',
  'science.org',
  'sciencemag.org',
  'cell.com',
  'thelancet.com',
  'bmj.com',
  'jamanetwork.com',
  'nejm.org',
  'pnas.org',
  'plos.org',
  'frontiersin.org',
  'mdpi.com',
  'springeropen.com',
  'tandfonline.com',
  'sagepub.com',
  'acp.org',
  'iopscience.iop.org'
] as const;

const ACADEMIC_PUBLISHER = [
  'doi.org',
  'link.springer.com',
  'springer.com',
  'sciencedirect.com',
  'elsevier.com',
  'wiley.com',
  'onlinelibrary.wiley.com',
  'taylorandfrancis.com',
  'cambridge.org',
  'academic.oup.com',
  'oup.com',
  'jstor.org',
  'ieeexplore.ieee.org',
  'ieee.org',
  'acm.org',
  'dl.acm.org',
  'aps.org',
  'iopscience.org',
  'sagepub.co.uk',
  'emerald.com',
  'degruyter.com',
  'brill.com',
  'karger.com',
  'thieme-connect.com',
  'worldscientific.com'
] as const;

const REFERENCE_WORK = [
  'wikipedia.org',
  'britannica.com',
  'stanford.edu/entries',
  'plato.stanford.edu',
  'iep.utm.edu',
  'zbmath.org',
  'mathworld.wolfram.com'
] as const;

// 机构域名没有唯一列表（全世界的高校各自一个域名），只能按域名后缀规则判断。
// 这些后缀是各国教育与政府域名的公开注册规则，属于事实性规则，不是对某个机构的评价。
const INSTITUTION_SUFFIXES = [
  '.edu',
  '.ac.uk',
  '.ac.jp',
  '.ac.cn',
  '.edu.cn',
  '.edu.hk',
  '.edu.tw',
  '.edu.au',
  '.edu.sg',
  '.ac.kr',
  '.uni-',
  '.university'
] as const;

const GOVERNMENT_SUFFIXES = [
  '.gov',
  '.gov.cn',
  '.gov.uk',
  '.gov.au',
  '.gov.jp',
  '.mil',
  '.go.jp',
  '.gob.es',
  '.gouv.fr',
  '.europa.eu',
  '.gov.tw',
  '.gov.hk'
] as const;

/** 取主机名（小写、去掉 `www.`）。取不到时返回空串——不确定就什么都不断言。 */
export function hostOf(url: unknown): string {
  let host = '';
  try {
    host = new URL(String(url ?? '')).hostname.toLowerCase();
  } catch {
    return '';
  }
  host = host.replace(/\.+$/, '');
  if (!host) return '';
  return host.startsWith('www.') ? host.slice(4) : host;
}

/** `host` 是否就是这些域名之一或它们的子域（`x.nature.com` 与 `nature.com` 同属一家）。 */
function matches(host: string, domains: readonly string[]): boolean {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function pathOf(url: unknown): string {
  try {
    return new URL(String(url ?? '')).pathname.toLowerCase();
  } catch {
    return '';
  }
}

function isInstitution(host: string): boolean {
  return INSTITUTION_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/** 百科与参考资料站：域名命中，或"某高校域名下的专业百科"这一类路径。 */
function isReference(host: string, path: string): boolean {
  if (matches(host, REFERENCE_WORK)) return true;
  // `plato.stanford.edu` 这类"机构域名 + 专业词条站"：域名本身说明不了，路径可以。
  return path.includes('/entries/') && isInstitution(host);
}

/** 一个外部来源属于哪一层（域名事实，不是质量判断）；认不出来就是 GENERAL_WEB。 */
export function tierOf(url: unknown): SourceTier {
  const host = hostOf(url);
  if (!host) return 'GENERAL_WEB';
  const path = pathOf(url);
  if (matches(host, PREPRINT)) return 'PREPRINT';
  if (matches(host, JOURNAL_DOMAIN)) return 'JOURNAL_DOMAIN';
  if (matches(host, ACADEMIC_PUBLISHER)) return 'ACADEMIC_PUBLISHER';
  if (isReference(host, path)) return 'REFERENCE_WORK';
  if (GOVERNMENT_SUFFIXES.some((suffix) => host.endsWith(suffix))) return 'GOVERNMENT';
  if (isInstitution(host)) return 'INSTITUTION';
  return 'GENERAL_WEB';
}

export function labelOf(tier: string | null | undefined): string {
  return TIER_LABELS[(tier ?? '') as SourceTier] ?? TIER_LABELS.GENERAL_WEB;
}

/** 层级在显示顺序里的位置；没见过的层排最后（不抛错，也不插队）。 */
export function rankOf(tier: string | null | undefined): number {
  const index = SOURCE_TIERS.indexOf((tier ?? '') as SourceTier);
  return index >= 0 ? index : SOURCE_TIERS.length;
}

export type TieredResult<T> = T & { tier: SourceTier; tierLabel: string };

/**
 * 给每条结果标上层级，并按层级稳定排序（同层保持原有相对顺序）。
 *
 * 排序与显示是这一层全部的作用：它不参与引用编号的取舍、不参与"证据够不够"的判断，
 * 因此用稳定排序，保证同一批结果每次顺序一致。
 */
export function annotate<T>(
  results: ReadonlyArray<T> | null | undefined
): Array<TieredResult<T>> {
  const rows: Array<{ rank: number; index: number; row: TieredResult<T> }> = [];
  (results ?? []).forEach((item, index) => {
    const row = (
      item && typeof item === 'object' ? { ...(item as object) } : { url: String(item) }
    ) as TieredResult<T>;
    row.tier = tierOf((row as { url?: unknown }).url);
    row.tierLabel = labelOf(row.tier);
    rows.push({ rank: rankOf(row.tier), index, row });
  });
  rows.sort((left, right) => left.rank - right.rank || left.index - right.index);
  return rows.map((entry) => entry.row);
}

export interface TierListingGroup {
  tier: SourceTier;
  label: string;
  count: number;
  hosts: string[];
}

export interface TierListing {
  counts: Record<string, number>;
  groups: TierListingGroup[];
  note: string;
}

/**
 * 给报告用的分层清单：`{counts,groups,note}`。
 *
 * `groups` 只列确实出现过的层；`note` 如实说明这套分层的边界——尤其是
 * "只有通用网页搜索、没有学术库检索"，否则用户会以为标了"预印本平台"就等于查过学术资料库。
 */
export function listing(
  results: ReadonlyArray<{ url?: unknown; tier?: string } | null | undefined> | null | undefined
): TierListing {
  const items = results ?? [];
  const groups: TierListingGroup[] = [];
  for (const tier of SOURCE_TIERS) {
    const rows = items.filter((item) => (item ?? {}).tier === tier);
    if (rows.length === 0) continue;
    const hosts: string[] = [];
    for (const item of rows) {
      const host = hostOf((item ?? {}).url);
      if (host && !hosts.includes(host)) hosts.push(host);
    }
    groups.push({ tier, label: labelOf(tier), count: rows.length, hosts });
  }
  return {
    counts: Object.fromEntries(groups.map((group) => [group.tier, group.count])),
    groups,
    note:
      '这一层只按域名归属分组（例如域名属于预印本平台或期刊网站），用于排序与显示；' +
      '它不代表内容质量，也不等于已经查过学术资料库——本应用只有通用网页搜索。'
  };
}
