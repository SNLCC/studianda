import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

/**
 * 独立问答会话的存储层：多会话、自动标题、消息落库、压缩摘要、导入与删除。
 *
 * 全部用临时目录里真实 node:sqlite 数据库验证，不联网、不调用模型。
 */

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-qa-sessions-'));
let store: Store;

beforeAll(() => {
  store = new Store(dataDir);
});

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe('qa_sessions / qa_messages 存储', () => {
  it('新建会话：默认空标题、0 条消息，可按 id 读回', () => {
    const session = store.createQaSession();
    expect(session.id).toBeTruthy();
    expect(session.title).toBe('');
    expect(session.messageCount).toBe(0);
    expect(session.compacted).toBe(false);
    expect(session.contextSummary).toBe('');
    expect(session.summaryUpto).toBe(0);
    expect(store.getQaSession(session.id)?.id).toBe(session.id);
    expect(store.getQaSession('no-such-session')).toBeNull();
  });

  it('追加消息：计数、顺序、整轮 response 与 answered 标记都保留', () => {
    const session = store.createQaSession('测试会话');
    store.appendQaMessage({ sessionId: session.id, role: 'user', content: '问题一' });
    store.appendQaMessage({
      sessionId: session.id,
      role: 'assistant',
      content: '回答一',
      response: { answer: '回答一', sources: [] },
      answered: true
    });
    store.appendQaMessage({
      sessionId: session.id,
      role: 'assistant',
      content: '回答未完成：模型服务不可用',
      response: null,
      answered: false
    });

    const messages = store.listQaMessages(session.id);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'assistant']);
    expect(messages.map((message) => message.content)).toEqual([
      '问题一',
      '回答一',
      '回答未完成：模型服务不可用'
    ]);
    expect(messages[1]?.response?.answer).toBe('回答一');
    expect(messages[0]?.response).toBeNull();
    expect(messages[1]?.answered).toBe(true);
    expect(messages[2]?.answered).toBe(false);
    expect(store.getQaSession(session.id)?.messageCount).toBe(3);
  });

  it('会话列表按最近使用排序（追加消息会顶到最前）', async () => {
    const first = store.createQaSession('第一');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = store.createQaSession('第二');
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.appendQaMessage({ sessionId: first.id, role: 'user', content: '把第一顶上去' });
    const ids = store.listQaSessions().map((session) => session.id);
    expect(ids.indexOf(first.id)).toBeLessThan(ids.indexOf(second.id));
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
  });

  it('自动标题只补空标题，不覆盖用户改过的标题', () => {
    const session = store.createQaSession('');
    store.autoTitleQaSession(session.id, '  这是   第一个\n问题，应该生成一个标题  ');
    const titled = store.getQaSession(session.id);
    expect(titled?.title).toBe('这是 第一个 问题，应该生成一个标题');

    store.renameQaSession(session.id, '我自己改的');
    store.autoTitleQaSession(session.id, '第二个问题');
    expect(store.getQaSession(session.id)?.title).toBe('我自己改的');
  });

  it('压缩摘要只向前推进，不回退到更早的消息', () => {
    const session = store.createQaSession('压缩');
    const first = store.appendQaMessage({ sessionId: session.id, role: 'user', content: '第一轮' });
    const second = store.appendQaMessage({
      sessionId: session.id,
      role: 'assistant',
      content: '第一轮回答'
    });
    store.saveQaCompaction({ sessionId: session.id, summary: '早期摘要', upto: second.id });
    let stored = store.getQaSession(session.id);
    expect(stored?.contextSummary).toBe('早期摘要');
    expect(stored?.summaryUpto).toBe(second.id);
    expect(stored?.compacted).toBe(true);

    // 尝试写回更早位置：忽略，保持已覆盖的更大 id。
    store.saveQaCompaction({ sessionId: session.id, summary: '旧摘要', upto: first.id });
    stored = store.getQaSession(session.id);
    expect(stored?.summaryUpto).toBe(second.id);
    // 但摘要正文按最新一次写入更新（调用方只会在成功压缩后调用）。
    expect(stored?.contextSummary).toBe('旧摘要');
  });

  it('重命名与删除：删除会话会一并删除消息；未知会话返回 null', () => {
    const session = store.createQaSession('待删');
    store.appendQaMessage({ sessionId: session.id, role: 'user', content: '会被删掉' });
    const renamed = store.renameQaSession(session.id, '新名字');
    expect(renamed?.title).toBe('新名字');
    expect(store.renameQaSession('missing', 'x')).toBeNull();

    store.deleteQaSession(session.id);
    expect(store.getQaSession(session.id)).toBeNull();
    expect(store.listQaMessages(session.id)).toEqual([]);
    expect(store.listQaSessions().some((item) => item.id === session.id)).toBe(false);
  });

  it('导入旧历史：保留顺序与旧回答，占位回答标记为未回答', () => {
    const session = store.createQaSession('旧版问答记录');
    const imported = store.importQaMessages(session.id, [
      { role: 'user', content: '旧问题一' },
      { role: 'assistant', content: '旧回答一', answered: true },
      { role: 'user', content: '旧问题二' },
      { role: 'assistant', content: '这一轮没有产生文字回答。' },
      { role: 'user', content: '' }
    ]);
    expect(imported.messages).toHaveLength(4);
    expect(imported.messages.map((message) => message.content)).toEqual([
      '旧问题一',
      '旧回答一',
      '旧问题二',
      '这一轮没有产生文字回答。'
    ]);
    expect(imported.messages[1]?.answered).toBe(true);
    expect(imported.messages[3]?.answered).toBe(false);
    expect(imported.session.messageCount).toBe(4);
    expect(() => store.importQaMessages('missing', [])).toThrow('问答会话不存在');
  });

  it('会话搜索：按标题或消息内容过滤，通配符按字面处理', () => {
    const byTitle = store.createQaSession('独特标题：检索策略');
    const byMessage = store.createQaSession('普通会话');
    store.appendQaMessage({
      sessionId: byMessage.id,
      role: 'user',
      content: '消息里有 独特关键词 的提问'
    });
    expect(store.listQaSessions('独特标题').map((item) => item.id)).toEqual([byTitle.id]);
    expect(store.listQaSessions('独特关键词').map((item) => item.id)).toEqual([byMessage.id]);
    // % / _ 按字面匹配，不作为 LIKE 通配符（没有会话含这些字符，应为空）。
    expect(store.listQaSessions('%')).toHaveLength(0);
    expect(store.listQaSessions('_')).toHaveLength(0);
    expect(store.listQaSessions('  ').length).toBeGreaterThan(0);
  });

  it('重新生成：删除最后一轮助手消息、返回最后用户问题，不重复记用户消息', () => {
    const session = store.createQaSession('重新生成');
    store.appendQaMessage({ sessionId: session.id, role: 'user', content: '问题一' });
    store.appendQaMessage({ sessionId: session.id, role: 'assistant', content: '回答一' });
    store.appendQaMessage({ sessionId: session.id, role: 'user', content: '问题二' });
    store.appendQaMessage({ sessionId: session.id, role: 'assistant', content: '回答二' });

    expect(store.rewindQaSessionTail(session.id)).toBe('问题二');
    expect(store.listQaMessages(session.id).map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user'
    ]);
    // 再次重新生成：最后一条已经是用户问题（还没有新回答），返回同一个问题且不删任何东西。
    expect(store.rewindQaSessionTail(session.id)).toBe('问题二');
    expect(store.listQaMessages(session.id)).toHaveLength(3);
    // 没有用户消息的会话不可重新生成。
    const empty = store.createQaSession('空会话');
    store.appendQaMessage({ sessionId: empty.id, role: 'assistant', content: '没有提问的回答' });
    expect(store.rewindQaSessionTail(empty.id)).toBeNull();
    expect(store.rewindQaSessionTail('missing')).toBeNull();
  });

  it('会话消息分页：limit 取最新一页（升序），beforeId 取更早一页并判断 hasOlder', () => {
    const session = store.createQaSession('分页');
    for (let index = 1; index <= 10; index += 1) {
      store.appendQaMessage({ sessionId: session.id, role: 'user', content: `消息${index}` });
    }
    const latest = store.listQaMessages(session.id, { limit: 4 });
    expect(latest.map((message) => message.content)).toEqual([
      '消息7',
      '消息8',
      '消息9',
      '消息10'
    ]);
    expect(store.hasOlderQaMessages(session.id, latest[0]!.id)).toBe(true);

    const earlier = store.listQaMessages(session.id, {
      limit: 4,
      beforeId: latest[0]!.id
    });
    expect(earlier.map((message) => message.content)).toEqual([
      '消息3',
      '消息4',
      '消息5',
      '消息6'
    ]);
    const oldest = store.listQaMessages(session.id, {
      limit: 4,
      beforeId: earlier[0]!.id
    });
    expect(oldest.map((message) => message.content)).toEqual(['消息1', '消息2']);
    expect(store.hasOlderQaMessages(session.id, oldest[0]!.id)).toBe(false);
    // 不传 limit 时仍返回全部（backward compatible）。
    expect(store.listQaMessages(session.id)).toHaveLength(10);
  });

  it('编辑用户消息 / 从某轮分支删除', () => {
    const session = store.createQaSession('编辑分支');
    const user1 = store.appendQaMessage({ sessionId: session.id, role: 'user', content: '问题一' });
    const assistant1 = store.appendQaMessage({
      sessionId: session.id,
      role: 'assistant',
      content: '回答一'
    });
    const user2 = store.appendQaMessage({ sessionId: session.id, role: 'user', content: '问题二' });
    store.appendQaMessage({ sessionId: session.id, role: 'assistant', content: '回答二' });

    expect(store.editQaUserMessage(session.id, user2.id, '改后的问题二')).toEqual({
      ok: true,
      removed: 1
    });
    expect(store.listQaMessages(session.id).map((message) => message.content)).toEqual([
      '问题一',
      '回答一',
      '改后的问题二'
    ]);

    expect(store.deleteQaMessagesFrom(session.id, user1.id)).toEqual({ ok: true, removed: 3 });
    expect(store.listQaMessages(session.id)).toEqual([]);

    // 不允许编辑助手消息、不存在/不属于该会话的消息 → ok=false。
    expect(store.editQaUserMessage(session.id, assistant1.id, 'x')).toEqual({
      ok: false,
      removed: 0
    });
    expect(store.editQaUserMessage('missing', user2.id, 'x')).toEqual({
      ok: false,
      removed: 0
    });
    expect(store.deleteQaMessagesFrom(session.id, 999999)).toEqual({ ok: false, removed: 0 });
  });
});

describe('qa_sessions 置顶', () => {
  it('置顶会话排在列表最前，且状态可持久化', () => {
    const a = store.createQaSession('普通会话');
    const b = store.createQaSession('要置顶的会话');
    store.appendQaMessage({ sessionId: b.id, role: 'user', content: '置顶消息' });
    expect(store.listQaSessions()[0]!.id).toBe(b.id);

    expect(store.setQaSessionPinned(a.id, true)).toMatchObject({ id: a.id, pinned: true });
    const list = store.listQaSessions();
    expect(list[0]!.id).toBe(a.id);
    expect(list[0]!.pinned).toBe(true);
    expect(store.getQaSession(a.id)?.pinned).toBe(true);

    expect(store.setQaSessionPinned(a.id, false)).toMatchObject({ pinned: false });
    expect(store.listQaSessions().find((session) => session.id === a.id)?.pinned).toBe(false);
  });
});
