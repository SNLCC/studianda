/**
 * 文档级在途请求登记表（每个 server 实例一份，由 `buildServer` 创建后注入各路由模块）。
 *
 * 语义：彻底删除某文献（purge）或清空全部用户数据之前，必须先中止这些还活着的
 * 请求/任务，避免后台任务在删除后继续写回已删除的数据。同一个 controller 可以登记到
 * 多个文献（跨文献 chat 会把 `documentId` 与 `scope_documents` 一起登记）。
 *
 * 归属：登记者横跨四个模块（chat / 翻译单页 / 全书摘要 / 区域 OCR 后台任务），消费者是
 * 另外两个模块
 * （purge / clear-user-data），因此必须共享一张表，且**不能**做成模块级单例——否则
 * `app.close()` 后的实例间互相污染。Store 不持有它（Store 不该知道 AbortController）。
 *
 * 约束（后人不要改坏）：
 * 1. `abort` 必须**同步、不 await**：purge 的顺序是 abort → stopDocumentTranslation →
 *    purgeDocument，改成一异步就会退化成"边删边写"。
 * 2. `abort` / `abortAll` **先摘表再 abort**：保证重复 abort 与后到的 untrack 都是安全
 *    no-op，也避免 abort 回调里重新登记时把新 controller 一起中止。
 * 3. `track` 返回的 untrack 必须**幂等**。
 */
export class DocumentRequestRegistry {
  private readonly requests = new Map<string, Set<AbortController>>();
  private closed = false;

  /**
   * 把 controller 登记到多个文献（忽略空 id、去重）；返回幂等 untrack。
   * 关闭后调用会立即 abort 该 controller 并返回 no-op。
   */
  track(
    documentIds: readonly (string | undefined)[],
    controller: AbortController
  ): () => void {
    if (this.closed) {
      controller.abort();
      return () => {};
    }
    const ids = [...new Set(documentIds.filter((id): id is string => Boolean(id)))];
    for (const id of ids) {
      const set = this.requests.get(id) ?? new Set<AbortController>();
      set.add(controller);
      this.requests.set(id, set);
    }
    return () => {
      for (const id of ids) {
        const set = this.requests.get(id);
        if (!set) continue;
        set.delete(controller);
        if (set.size === 0) this.requests.delete(id);
      }
    };
  }

  /** 同步：先摘表再逐个 abort；重复调用幂等。**不等待任务结束。** */
  abort(documentId: string): void {
    const set = this.requests.get(documentId);
    if (!set) return;
    this.requests.delete(documentId);
    for (const controller of set) controller.abort();
  }

  /**
   * 关闭/清空数据用：中止全部文献。按快照遍历，abort 回调里新登记的请求不会被本次
   * 中止（与 clear-user-data 原先"遍历 keys 快照"的行为一致）。
   */
  abortAll(): void {
    for (const documentId of [...this.requests.keys()]) this.abort(documentId);
  }

  /** 只读诊断（测试用）：按文献返回在途 controller 数；不传文献返回全部在途数。 */
  pending(documentId?: string): number {
    if (documentId !== undefined) return this.requests.get(documentId)?.size ?? 0;
    let total = 0;
    for (const set of this.requests.values()) total += set.size;
    return total;
  }

  /** 关闭：abortAll + 标记 closed；之后 `track()` 立即 abort 并返回 no-op。 */
  close(): void {
    this.closed = true;
    this.abortAll();
  }
}
