/**
 * 应用内《使用须知与隐私说明》（精简版）。
 *
 * 完整版见仓库 `docs/USAGE-NOTICE.md`：这里只保留用户在应用内需要立刻知道的事实
 * （本地工具定位、第三方 AI 服务责任边界、BYOK 边界、三方角色、逐功能数据流向、
 * 风险、未成年人、责任边界、版本）。改动内容时同步更新 `USAGE_NOTICE_VERSION`：已读记录按版本
 * 保存，旧版本会在设置页提示「有新版本」；欢迎引导页要求先读当前版本并勾选确认后才能开始使用。
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { USAGE_NOTICE_DOC_URL, openExternalLink } from './external-links.js';
import type { RuntimeAdapter } from './runtime.js';

/** 须知版本：与 docs/USAGE-NOTICE.md 的「文档版本」保持一致。 */
export const USAGE_NOTICE_VERSION = 'v1.10';
/** 生效日期：与 docs/USAGE-NOTICE.md 保持一致。 */
export const USAGE_NOTICE_EFFECTIVE_DATE = '2026-11-11';
/** 适用的应用版本。 */
export const USAGE_NOTICE_APPLICABLE_VERSION = '勘读 Studianda 0.1.x';

/** 已读版本（localStorage）：只记版本号，不阻塞使用，也不上传。 */
export const USAGE_NOTICE_STORAGE_KEY = 'studianda.usageNotice.readVersion';
/** 年龄确认（localStorage）：只记确认结果，不做身份核验。 */
export const AGE_CONFIRM_STORAGE_KEY = 'studianda.age.confirmed';
/** 已勾选「已查看使用须知」的版本（localStorage）：只记本机确认，不上传。 */
export const USAGE_NOTICE_ACK_STORAGE_KEY = 'studianda.usageNotice.ackVersion';

/** 使用须知的一节：标题 + 正文段落 + 要点列表。 */
export interface UsageNoticeSection {
  title: string;
  paragraphs: string[];
  bullets: string[];
}
/** 精简版正文：按与 docs 一致的口径压缩，避免在应用内塞入整份文档。 */
export const USAGE_NOTICE_SECTIONS: UsageNoticeSection[] = [
  {
    title: '1. 当前定位：本地工具，不是生成式 AI 服务提供者',
    paragraphs: [
      '勘读（Studianda）是在你本机运行的本地优先学术阅读工具，负责导入文献、组织阅读。'
    ],
    bullets: [
      '本工具不提供 AI 模型或生成能力：AI 功能由你自行配置的第三方模型服务或本机模型提供；项目方不持有模型、不代收模型费用、不运营云端服务。',
      '生成内容的合规性与标识义务由对应 AI 服务提供者承担；本工具不替代其备案、审核、内容处置与投诉等义务。',
      '你使用本工具生成、传播内容，需自行遵守相关法律法规及科研诚信要求；不得删除、篡改、伪造或隐匿 AI 标识。',
      '应用没有账号体系、没有云同步、没有遥测或崩溃上报；文献、笔记、会话记录与检索缓存只写在你选定的资料目录。但你使用会话/翻译/搜索等功能时，相应内容会发给你配置的第三方服务（见第 5 节），由该服务按其条款处理。',
      '请勿将本工具用于对外提供咨询、内容生成或其他生成式 AI 服务；如违反，使用者自行承担相应责任。'
    ]
  },
  {
    title: '2. 密钥与 BYOK 边界',
    paragraphs: [
      '应用采用自带密钥（BYOK，Bring Your Own Key）：不内置任何生成式 AI 模型，也不内置任何模型/搜索服务密钥，不提供免费额度。安装后没有预置的模型连接；需要你自行向服务商申请并合法持有密钥，并在设置中配置并指定用途。本机 OCR 使用开源 tesseract.js 识别引擎（OCR，不是生成式 AI），语言训练数据不随包分发、按需下载。'
    ],
    bullets: [
      '通常由你与模型/搜索/翻译等服务商签约；如果你使用机构提供的 Key，签约方可能是机构、他人或账号持有人。费用、服务条款与数据处理由你与对应服务商之间的协议决定；使用共享密钥、机构密钥或他人账号时，你仍受对应服务商的协议约束，密钥持有人对使用负最终责任。',
      '机构用户：当前暂不接受机构用户。',
      '密钥经系统安全存储加密后写入独立文件（userData/secrets.json），不写入资料目录、不随资料备份；请勿在 issue、日志或截图中粘贴密钥。'
    ]
  },
  {
    title: '3. 三方角色',
    paragraphs: [],
    bullets: [
      '工具提供方：勘读项目，只提供软件本身，不提供 AI 模型或生成能力；软件只在本机读取和处理。',
      '模型服务提供者：你选择的模型/搜索/翻译/语音等服务商（或你在本机运行的模型），按其条款处理你发送的内容。',
      '使用者：你，自行持有密钥、遵守第三方服务条款，并对导入内容的合法性负责。'
    ]
  },
  {
    title: '4. 数据放在哪、保留多久',
    paragraphs: [],
    bullets: [
      '资料目录：文献 PDF 副本、数据库、批注、笔记、译文、会话记录、检索缓存与备份都在这里；卸载程序不会删除资料目录。',
      '资料目录、备份与诊断包均为明文，未内置加密，请自行使用磁盘加密或系统账户隔离。',
      '删除文献会级联清理它的批注、笔记、会话记录、译文与索引，但备份与回滚目录可能保留旧副本，不保证物理擦除；需要彻底删除时请退出应用后删除整个资料目录。',
      '也可以在「设置 → 数据与维护 → 清空全部本地数据」删除本机全部用户数据（不删除服务配置与密钥）；会同时清理资料目录与 userData 下的本地运行日志（可删除时），并对数据库做 WAL 截断与 VACUUM 以减少残留。'
    ]
  },
  {
    title: '5. 逐功能数据流向（精简）',
    paragraphs: ['以下功能会把内容发离本机；除这些之外，应用不向第三方发送数据。'],
    bullets: [
      '会话/精读/翻译/摘要：问题、检索命中片段或所选页面/章节原文、勾选的笔记与批注正文等 → 你配置的模型服务；不含 PDF 原件。',
      '视觉读页/在线解析：该页渲染图片或相应 PDF → 你配置或选择的视觉/解析服务。',
      'Embedding/重排：需要向量化或重排的检索文本与候选片段 → 配置的远程模型；默认使用本机 TF-IDF 与本地重排规则。',
      '联网搜索：搜索词 → 你配置的相应服务，默认「每次询问」；把「搜索规划隐私策略」改为交给模型规划时，按所选范围把问题/选文等发给你配置的会话模型。',
      '语音：录音音频或待朗读文字 → 配置的语音服务；默认使用本机系统语音组件。',
      'Zotero/WebDAV：连接信息、文献条目与附件请求 → 本机 Zotero、api.zotero.org 或你填写的地址；默认本机模式。',
      '更新检查：默认关闭，可在「设置 → 关于与更新」开启；开启后安装版启动约 10 秒向 GitHub Releases 发送版本号等元数据，不含文献、笔记或会话内容；可设置环境变量 STUDIANDA_DISABLE_UPDATE_CHECK=1 强制关闭。'
    ]
  },
  {
    title: '6. 风险提示',
    paragraphs: [],
    bullets: [
      'AI 生成内容（回答、译文、摘要、OCR/视觉解读）可能不准确、编造或遗漏；「有引用」不等于「已核实/真实可靠」，重要判断请回原文核对，机器翻译仅供参考。',
      '标识：回答区、译文区与识别结果旁有显式 AI 提示；「复制回答」「复制译文」与识别文本复制会自动附带标识文字；导出 Markdown 在文件头强制写入 AI 生成声明与学术披露提示，没有“一键去除”标识的开关（导出文件可手动编辑，但应用不协助去标识）。',
      '学术使用：使用 AI 辅助生成内容时，请按相应机构、期刊或学校的科研诚信要求披露使用范围；你（作者）对最终内容负责。',
      '请仅接入依法合规运营的生成式 AI 服务；请勿接入未备案/未合规服务、来源不明的共享 Key 或中转端点，相关数据传输风险与合规责任由你自行承担。应用不验证服务商是否已备案。',
      '证据审计默认按证据确定性改写：替换缺证段落、给推断加前缀、移除未核验引用/页码（规则固定、可复现，不是开放式二次创作）；可在「设置 → 快捷键与阅读 → 证据审计输出」切换为“只标注、不改写正文”。',
      '未加密、备份残留、数据传输风险、第三方服务中断或变更等风险，需要你自行评估并采取保护措施。',
      '不得删除、篡改、伪造或隐匿第三方或本工具产生的 AI 生成标识与元数据；本工具不提供去标识功能。'
    ]
  },
  {
    title: '7. 适用人群与未成年人',
    paragraphs: [],
    bullets: [
      '面向具备独立判断能力的研究者、教师、学生与写作者；不面向未成年人提供服务与推广，不设面向未成年人的功能或监护人模式。',
      '首次启动需要先打开并阅读当前版本《使用须知与隐私说明》，勾选「已查看使用须知与隐私说明」，并确认「已年满 18 周岁，并知悉本工具不面向未成年人」，之后才能开始使用。未满 18 周岁请勿使用。'
    ]
  },
  {
    title: '8. 违法内容与责任边界',
    paragraphs: [],
    bullets: [
      '不生成、不传播违法有害内容；不利用本工具规避监管、伪造证据或侵犯他人合法权利。',
      '发现模型返回违法或明显不当内容时：停止该轮生成、删除相关会话或笔记。',
      '你对自己导入、生成、保存、导出和传播的内容负责；使用本工具生成、传播内容需遵守相关法律法规及科研诚信要求，不得删除、篡改、伪造或隐匿 AI 标识。你应自行判断第三方模型服务的合规状态；软件按「现状」提供，法律强制规定不得排除或限制的责任不受影响，除此之外责任限制以 LICENSE 为准。',
      '本工具是本地客户端，没有服务端内容审核链路，不能替代在线服务提供者的审核、处置与报告义务。'
    ]
  },
  {
    title: '9. 版本与变更',
    paragraphs: [],
    bullets: [
      `当前文档版本 ${USAGE_NOTICE_VERSION}，生效日期 ${USAGE_NOTICE_EFFECTIVE_DATE}，适用应用版本 ${USAGE_NOTICE_APPLICABLE_VERSION}。`,
      '新增联网功能、默认行为或数据流向变化时，会同步更新本说明并在发版说明中提示；完整版与变更记录见仓库 docs/USAGE-NOTICE.md。'
    ]
  }
];

/** 读取已读的须知版本；本地存储不可用时当作未读（不抛出、不阻塞）。 */
export function readUsageNoticeVersion(): string {
  try {
    return window.localStorage.getItem(USAGE_NOTICE_STORAGE_KEY)?.trim() ?? '';
  } catch {
    return '';
  }
}

/** 当前版本是否已读：设置页据此显示「已阅读」/「有更新」。 */
export function hasReadCurrentUsageNotice(): boolean {
  return readUsageNoticeVersion() === USAGE_NOTICE_VERSION;
}

/** 记录当前版本已读；只写本机 localStorage，不联网。 */
export function markUsageNoticeRead(): void {
  try {
    window.localStorage.setItem(USAGE_NOTICE_STORAGE_KEY, USAGE_NOTICE_VERSION);
  } catch {
    // 存储不可用时只在本次会话生效，不影响使用。
  }
}

/** 读取「已勾选已查看须知」的版本；本地存储不可用时当作未确认。 */
export function readUsageNoticeAckVersion(): string {
  try {
    return window.localStorage.getItem(USAGE_NOTICE_ACK_STORAGE_KEY)?.trim() ?? '';
  } catch {
    return '';
  }
}

/** 欢迎页据此要求「先阅读当前版本 + 勾选确认」后才能开始使用。 */
export function hasAcknowledgedCurrentUsageNotice(): boolean {
  return readUsageNoticeAckVersion() === USAGE_NOTICE_VERSION;
}

/** 记录/撤销「已查看使用须知」确认；只写本机 localStorage，不联网。 */
export function setUsageNoticeAcknowledged(acknowledged: boolean): void {
  try {
    if (acknowledged) {
      window.localStorage.setItem(USAGE_NOTICE_ACK_STORAGE_KEY, USAGE_NOTICE_VERSION);
    } else {
      window.localStorage.removeItem(USAGE_NOTICE_ACK_STORAGE_KEY);
    }
  } catch {
    // 存储不可用时只在本次会话生效。
  }
}

/** 是否已确认年龄条款。 */
export function readAgeConfirmed(): boolean {
  try {
    return window.localStorage.getItem(AGE_CONFIRM_STORAGE_KEY) === 'yes';
  } catch {
    return false;
  }
}

/** 记录年龄确认（只在本机保存确认结果，不做身份核验）。 */
export function markAgeConfirmed(): void {
  try {
    window.localStorage.setItem(AGE_CONFIRM_STORAGE_KEY, 'yes');
  } catch {
    // 存储不可用时只在本次会话生效。
  }
}

/**
 * 使用须知弹窗：设置页与欢迎引导页共用。
 *
 * - 关闭时记录已读版本（不强制阻断，未读也能继续使用）；
 * - Esc / 点击遮罩关闭；焦点管理交给全局 `useDialogFocusTrap`（aria-modal）；
 * - 反馈/完整版链接复用壳的 openExternal，不新增 IPC。
 */
export function UsageNoticeDialog({
  adapter,
  onClose
}: {
  adapter: Pick<RuntimeAdapter, 'openExternal' | 'openUsageNotice'>;
  onClose(): void;
}): JSX.Element {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [linkError, setLinkError] = useState('');

  useEffect(() => {
    closeButtonRef.current?.focus();
  }, []);

  const close = (): void => {
    markUsageNoticeRead();
    onClose();
  };

  const openLink = async (url: string): Promise<void> => {
    setLinkError('');
    const result = await openExternalLink(adapter, url);
    if (!result.ok) {
      setLinkError(result.message ?? '无法打开链接，请手动复制地址在浏览器中打开。');
    }
  };

  /** 优先打开安装包内完整版；宿主未实现或失败时回退到仓库在线文档。 */
  const openFullNotice = async (): Promise<void> => {
    if (adapter.openUsageNotice) {
      try {
        const local = await adapter.openUsageNotice();
        if (local.ok) return;
      } catch {
        // 回退到仓库文档
      }
    }
    await openLink(USAGE_NOTICE_DOC_URL);
  };

  return (
    <div
      className="kr-usage-notice-backdrop"
      role="presentation"
      data-usage-notice=""
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
      onKeyDown={(event) => {
        // 使用须知叠在设置/引导之上：Esc 只关这一层，不连带关闭下面的设置。
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        close();
      }}
    >
      <div
        className="kr-usage-notice"
        role="dialog"
        aria-modal="true"
        aria-label="使用须知与隐私说明"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="kr-usage-notice__head">
          <h2>使用须知与隐私说明</h2>
          <p className="kr-usage-notice__meta">
            应用内精简版 · 版本 {USAGE_NOTICE_VERSION} · 生效日期 {USAGE_NOTICE_EFFECTIVE_DATE} ·
            适用 {USAGE_NOTICE_APPLICABLE_VERSION}
          </p>
        </header>
        <div className="kr-usage-notice__body">
          {USAGE_NOTICE_SECTIONS.map((section) => (
            <section className="kr-usage-notice__section" key={section.title}>
              <h3>{section.title}</h3>
              {section.paragraphs.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
              {section.bullets.length > 0 ? (
                <ul>
                  {section.bullets.map((bullet) => (
                    <li key={bullet}>{bullet}</li>
                  ))}
                </ul>
              ) : null}
            </section>
          ))}
          <p className="kr-usage-notice__more">
            完整版（含逐功能数据流向表与变更记录）见仓库文档 docs/USAGE-NOTICE.md。
          </p>
          {linkError ? (
            <p className="kr-page-error" role="alert">
              {linkError}
            </p>
          ) : null}
        </div>
        <footer className="kr-usage-notice__footer">
          <button
            type="button"
            className="kr-secondary"
            title="优先打开安装包内的完整版；不可用时打开仓库文档"
            onClick={() => void openFullNotice()}
          >
            打开完整版
          </button>
          <button
            ref={closeButtonRef}
            type="button"
            className="kr-primary"
            onClick={close}
          >
            我已阅读，关闭
          </button>
        </footer>
      </div>
    </div>
  );
}
