/**
 * 单文档轮次互斥表（每个 server 实例一份，由 `buildServer` 创建）。
 *
 * 语义：同一文献同一时刻只处理一轮问答 / 一次危险写操作（重新生成、编辑并重问、
 * 分支删除）。两个窗口同时提问会让 user/assistant 交错落库，所以回答与危险写操作
 * 共用同一把锁；锁粒度是**文献**（key = `doc:<documentId>`），不是会话（sessionId 不参与 key）。
 *
 * 归属：写入者横跨「回答」与「消息写」两类路由，因此必须是每实例一个、跨模块注入的
 * 对象；**不能**做成模块级单例——`app.close()` 后 key 残留会让该文献永久 409，并污染
 * 同进程里下一个 server 实例。
 *
 * 与 `DocumentRequestRegistry` 的分工（**不要合并、不要互相引用**）：
 * - 本表管「同文档同时只能有一个回答」：同步 CAS，handler 的 finally 立即释放；
 * - 请求表管「在途请求可被 purge abort」：登记 AbortController，活到请求结束。
 * 两者 key 语义、参与者、生命周期都不同，合并会同时改变 409 语义与 abort 范围。
 *
 * 约束（后人不要改坏）：
 * 1. `begin` 是**同步 CAS**：`has` 与 `add` 之间不能插 `await`，否则两个请求可能同时进入。
 * 2. `end` 必须**幂等**：未占用 / 传 null 都是 no-op（重复结束不会抛错）。
 * 3. registry 只回答 boolean，**不负责发 409**：两种 409 文案（薄封装与 ask 路由各一种）
 *    归调用方所有；统一文案是行为回归，把 reply 塞进 registry 还会绑死 transport。
 */
export class ChatTurnRegistry {
  private readonly active = new Set<string>();
  private closed = false;

  /**
   * 同步 CAS 占用：返回 false = 已被占用（或 registry 已关闭），调用方负责回 409。
   * key 为 null/空表示该请求不参与互斥（与拆分前的 `beginChatTurn` 一致），恒返回 true。
   */
  begin(key: string | null): boolean {
    if (this.closed) return false;
    if (!key) return true;
    if (this.active.has(key)) return false;
    this.active.add(key);
    return true;
  }

  /** 幂等释放；未占用 / 传 null 都是 no-op（与拆分前的 `endChatTurn` 一致）。 */
  end(key: string | null): void {
    if (key) this.active.delete(key);
  }

  /** 只读快照（测试/诊断用，不新增 HTTP 端点）。 */
  activeKeys(): readonly string[] {
    return [...this.active];
  }

  /** 关闭：清空并拒绝后续 begin（之后 `begin()` 一律 false）。 */
  close(): void {
    this.closed = true;
    this.active.clear();
  }
}

/**
 * 并发锁的键：按文献 id；没有文献 id 的请求不锁。
 * 只按文献，不看会话——同一文献的多个会话也串行（这是既有行为，不要改成按会话加锁）。
 */
export function chatTurnKeyOf(documentId: string | undefined | null): string | null {
  return documentId ? `doc:${documentId}` : null;
}
