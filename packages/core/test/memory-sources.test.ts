import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import {
  MEMORY_RULES,
  memoryChatSources,
  memoryMaterial,
  searchMemory,
  wantsMemory,
  type MemoryHit
} from '../src/memory-sources.js';
import { Store } from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'studianda-memory-sources-'));

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function storeAt(name: string): Store {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  return new Store(dir);
}

/** 8 页 PDF：笔记/批注可以合法使用第 1..8 页。 */
async function importPdf(store: Store, label: string) {
  const file = path.join(root, 'pdfs', `${label}.pdf`);
  mkdirSync(path.dirname(file), { recursive: true });
  const pdf = await PDFDocument.create();
  for (let index = 1; index <= 8; index += 1) {
    pdf.addPage([300, 400]).drawText(`${label} page ${index}`, { x: 30, y: 360, size: 12 });
  }
  writeFileSync(file, await pdf.save());
  return store.importDocument(file, `${label}.pdf`, true);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 构造 MemoryHit 字面量：材料/来源转换是纯函数，不依赖 store。 */
function memoryHit(
  overrides: Partial<MemoryHit> & Pick<MemoryHit, 'kind' | 'id' | 'text'>
): MemoryHit {
  const note = overrides.kind === 'note';
  return {
    documentId: 'doc-1',
    documentName: '文献甲',
    page: note ? 3 : 5,
    title: note ? '笔记 · 第 3 页' : '批注 · 第 5 页',
    created: '2026-01-02 03:04:05',
    score: 0.5,
    ...overrides
  };
}

describe('wantsMemory', () => {
  it('中文泛化词（笔记/批注/注释/摘录/我的记录）都算提到', () => {
    for (const question of [
      '我的笔记里怎么说的',
      '这条批注是什么意思',
      '有哪些注释',
      '摘录里提到的内容',
      '看看我的记录',
      '个人记录里有相关材料吗'
    ]) {
      expect(wantsMemory(question)).toBe(true);
    }
  });

  it('单字「记录」不当作"在说我的记录"（避免学术句误触发最近记录兜底）', () => {
    expect(wantsMemory('把这篇文献记录的论点总结一下')).toBe(false);
    expect(wantsMemory('文章记录了三个实验')).toBe(false);
  });

  it('英文泛化词（note/annotation/highlight）按词边界识别', () => {
    expect(wantsMemory('What do my notes say?')).toBe(true);
    expect(wantsMemory('Show annotations for this page')).toBe(true);
    expect(wantsMemory('highlight this passage')).toBe(true);
    // notebook 不是 note，不能误触发"最近记录"兜底。
    expect(wantsMemory('My notebook is broken')).toBe(false);
  });

  it('普通问题与空问题不算提到', () => {
    expect(wantsMemory('这篇论文的主要论点是什么？')).toBe(false);
    expect(wantsMemory('What is the main argument?')).toBe(false);
    expect(wantsMemory('')).toBe(false);
    expect(wantsMemory('   ')).toBe(false);
  });
});

describe('searchMemory 词面召回', () => {
  it('按 query token coverage 召回笔记与批注，text 转纯文本', async () => {
    const store = storeAt('lexical');
    try {
      const document = await importPdf(store, 'lexical-doc');
      store.updateDocument(document.id, { name: '注意力研究' });
      const note = store.createNote({
        documentId: document.id,
        page: 2,
        quote: '原文摘引',
        content: '注意力机制是**核心**'
      });
      store.createNote({ documentId: document.id, page: 3, content: '完全无关的补充材料' });
      const annotation = store.createAnnotation({
        documentId: document.id,
        page: 5,
        quote: '自注意力机制',
        content: '值得回看'
      });

      const hits = searchMemory(store, {
        question: '注意力机制',
        includeNotes: true,
        includeAnnotations: true
      });
      // 无关笔记不能混进来。
      expect(hits).toHaveLength(2);
      const noteHit = hits.find((hit) => hit.id === note.id);
      expect(noteHit).toMatchObject({
        kind: 'note',
        documentId: document.id,
        documentName: '注意力研究',
        page: 2,
        title: '笔记 · 第 2 页',
        text: '注意力机制是核心',
        quote: '原文摘引'
      });
      const annotationHit = hits.find((hit) => hit.id === annotation.id);
      expect(annotationHit).toMatchObject({
        kind: 'annotation',
        documentId: document.id,
        documentName: '注意力研究',
        page: 5,
        title: '批注 · 第 5 页',
        quote: '自注意力机制',
        text: '自注意力机制\n批注：值得回看'
      });
      expect(hits.every((hit) => hit.score > 0)).toBe(true);
    } finally {
      store.close();
    }
  });

  it('selection 与 question 一起参与召回', async () => {
    const store = storeAt('lexical-selection');
    try {
      const document = await importPdf(store, 'selection-doc');
      const note = store.createNote({
        documentId: document.id,
        page: 1,
        content: '感知机模型的局限'
      });
      const hits = searchMemory(store, {
        question: '这一页讲了什么？',
        selection: '感知机',
        includeNotes: true,
        includeAnnotations: false
      });
      expect(hits.map((hit) => hit.id)).toEqual([note.id]);
    } finally {
      store.close();
    }
  });

  it('命中原句时额外加 0.5（coverage 1 + 0.5）', async () => {
    const store = storeAt('lexical-phrase');
    try {
      const document = await importPdf(store, 'phrase-doc');
      store.createNote({ documentId: document.id, page: 1, content: '网络分层' });
      const hits = searchMemory(store, {
        question: '网络分层',
        includeNotes: true,
        includeAnnotations: false
      });
      expect(hits).toHaveLength(1);
      expect(hits[0]!.score).toBe(1.5);
    } finally {
      store.close();
    }
  });

  it('没有词面命中且没提笔记/批注时返回空数组（不拿无关记录凑数）', async () => {
    const store = storeAt('lexical-empty');
    try {
      const document = await importPdf(store, 'empty-doc');
      store.createNote({ documentId: document.id, page: 1, content: '完全无关的材料' });
      store.createAnnotation({ documentId: document.id, page: 2, quote: '无关摘引', content: '无关批注' });
      expect(
        searchMemory(store, {
          question: '这篇论文的主要论点是什么？',
          includeNotes: true,
          includeAnnotations: true
        })
      ).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('limit 是每类上限', async () => {
    const store = storeAt('lexical-limit');
    try {
      const document = await importPdf(store, 'limit-doc');
      for (let index = 0; index < 3; index += 1) {
        store.createNote({ documentId: document.id, page: 1, content: `上限词 ${index}` });
      }
      const hits = searchMemory(store, {
        question: '上限词',
        includeNotes: true,
        includeAnnotations: false,
        limit: 2
      });
      expect(hits).toHaveLength(2);
    } finally {
      store.close();
    }
  });
});

describe('searchMemory 范围过滤与独立笔记', () => {
  it('documentIds 限定范围；独立笔记只在全库范围出现', async () => {
    const store = storeAt('scope');
    try {
      const documentA = await importPdf(store, 'scope-a');
      store.updateDocument(documentA.id, { name: '文献甲' });
      const documentB = await importPdf(store, 'scope-b');
      store.updateDocument(documentB.id, { name: '文献乙' });
      const noteA = store.createNote({
        documentId: documentA.id,
        page: 1,
        content: '共同主题甲'
      });
      const noteB = store.createNote({
        documentId: documentB.id,
        page: 1,
        content: '共同主题乙'
      });
      const standalone = store.createNote({ documentId: '', page: 0, content: '共同主题独立' });

      const scoped = searchMemory(store, {
        question: '共同主题',
        documentIds: [documentA.id],
        includeNotes: true,
        includeAnnotations: false
      });
      expect(scoped.map((hit) => hit.id)).toEqual([noteA.id]);

      const all = searchMemory(store, {
        question: '共同主题',
        includeNotes: true,
        includeAnnotations: false
      });
      expect(all.map((hit) => hit.id).sort()).toEqual([noteA.id, noteB.id, standalone.id].sort());
      const standaloneHit = all.find((hit) => hit.id === standalone.id);
      expect(standaloneHit).toMatchObject({
        kind: 'note',
        documentId: '',
        documentName: '独立笔记',
        page: 0,
        title: '独立笔记'
      });
    } finally {
      store.close();
    }
  });

  it('范围里已删除的文献不纳入', async () => {
    const store = storeAt('scope-deleted');
    try {
      const document = await importPdf(store, 'scope-deleted-doc');
      store.createNote({ documentId: document.id, page: 1, content: '删除前的内容' });
      store.deleteDocument(document.id);
      expect(
        searchMemory(store, {
          question: '删除前的内容',
          documentIds: [document.id],
          includeNotes: true,
          includeAnnotations: false
        })
      ).toEqual([]);
      // 全库范围同样看不到已删除文献的笔记。
      expect(
        searchMemory(store, {
          question: '删除前的内容',
          includeNotes: true,
          includeAnnotations: false
        })
      ).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe('searchMemory 回收站排除', () => {
  it('软删除的笔记、批注、独立笔记都不召回', async () => {
    const store = storeAt('trash');
    try {
      const document = await importPdf(store, 'trash-doc');
      const keptNote = store.createNote({
        documentId: document.id,
        page: 1,
        content: '保留的检索内容'
      });
      const deletedNote = store.createNote({
        documentId: document.id,
        page: 2,
        content: '删除的检索内容'
      });
      store.deleteNote(deletedNote.id);
      const deletedAnnotation = store.createAnnotation({
        documentId: document.id,
        page: 3,
        quote: '删除的检索内容',
        content: '批注'
      });
      store.deleteAnnotation(deletedAnnotation.id);
      const deletedStandalone = store.createNote({
        documentId: '',
        page: 0,
        content: '删除的检索内容独立'
      });
      store.deleteNote(deletedStandalone.id);

      const hits = searchMemory(store, {
        question: '检索内容',
        includeNotes: true,
        includeAnnotations: true
      });
      expect(hits.map((hit) => hit.id)).toEqual([keptNote.id]);
    } finally {
      store.close();
    }
  });
});

describe('searchMemory 两开关独立', () => {
  it('只召回选中的类型', async () => {
    const store = storeAt('switches');
    try {
      const document = await importPdf(store, 'switches-doc');
      const note = store.createNote({ documentId: document.id, page: 1, content: '开关测试笔记' });
      const annotation = store.createAnnotation({
        documentId: document.id,
        page: 2,
        quote: '开关测试批注',
        content: '批注正文'
      });

      const notesOnly = searchMemory(store, {
        question: '开关测试',
        includeNotes: true,
        includeAnnotations: false
      });
      expect(notesOnly.map((hit) => hit.id)).toEqual([note.id]);
      expect(notesOnly.every((hit) => hit.kind === 'note')).toBe(true);

      const annotationsOnly = searchMemory(store, {
        question: '开关测试',
        includeNotes: false,
        includeAnnotations: true
      });
      expect(annotationsOnly.map((hit) => hit.id)).toEqual([annotation.id]);

      expect(
        searchMemory(store, {
          question: '开关测试',
          includeNotes: false,
          includeAnnotations: false
        })
      ).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe('searchMemory 显式提笔记时的最近记录', () => {
  it('问题提到笔记但没有词面命中时，按 created 倒序给最近记录，score 记 0.05', async () => {
    const store = storeAt('recent');
    try {
      const document = await importPdf(store, 'recent-doc');
      const note = store.createNote({
        documentId: document.id,
        page: 1,
        content: 'Alpha beta gamma'
      });
      const older = store.createAnnotation({
        documentId: document.id,
        page: 2,
        quote: 'Delta',
        content: 'epsilon'
      });
      await sleep(20);
      const newer = store.createAnnotation({
        documentId: document.id,
        page: 3,
        quote: 'Zeta',
        content: 'eta'
      });

      const hits = searchMemory(store, {
        question: '我的笔记和批注里有没有提到这个问题？',
        includeNotes: true,
        includeAnnotations: true
      });
      expect(hits.map((hit) => hit.id)).toEqual([newer.id, older.id, note.id]);
      expect(hits.every((hit) => hit.score === 0.05)).toBe(true);
      const material = memoryMaterial(hits);
      expect(material).toContain('最近记录');
      expect(material).toContain('没有词面命中');
    } finally {
      store.close();
    }
  });

  it('问题没提笔记/批注时，即使库里有记录也不纳入', async () => {
    const store = storeAt('recent-guard');
    try {
      const document = await importPdf(store, 'recent-guard-doc');
      store.createNote({ documentId: document.id, page: 1, content: 'Alpha beta gamma' });
      expect(
        searchMemory(store, {
          question: 'What is the main argument?',
          includeNotes: true,
          includeAnnotations: true
        })
      ).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe('memoryMaterial 格式与字符预算', () => {
  const header = '用户笔记与批注（用户自己的记录，不是文献原文；不能作为逐字证据或引用编号）：';

  it('空数组返回空串', () => {
    expect(memoryMaterial([])).toBe('');
  });

  it('按固定字段生成笔记/批注/独立笔记行', () => {
    const material = memoryMaterial([
      memoryHit({
        kind: 'note',
        id: 'n1',
        documentName: '文献甲',
        page: 3,
        text: '这是笔记正文',
        quote: '原文摘引',
        created: '2026-01-02 03:04:05',
        score: 0.9
      }),
      memoryHit({
        kind: 'annotation',
        id: 'a1',
        documentName: '文献甲',
        page: 5,
        text: '原文摘引\n批注：这是批注正文',
        quote: '原文摘引',
        created: '2026-01-03T00:00:00.000Z',
        score: 0.8
      }),
      memoryHit({
        kind: 'note',
        id: 'n2',
        documentId: '',
        documentName: '独立笔记',
        page: 0,
        title: '独立笔记',
        text: '独立笔记正文',
        created: '2026-01-01 00:00:00',
        score: 0.7
      })
    ]);
    expect(material).toBe(
      [
        header,
        '[笔记] 《文献甲》第 3 页（2026-01-02）：这是笔记正文',
        '[批注] 《文献甲》第 5 页（2026-01-03）：摘引「原文摘引」；批注：这是批注正文',
        '[独立笔记]《独立笔记》（无页码）：独立笔记正文'
      ].join('\n')
    );
    expect(material).not.toContain('最近记录');
  });

  it('批注只有摘引或只有正文时如实只写已有的部分', () => {
    const material = memoryMaterial([
      memoryHit({
        kind: 'annotation',
        id: 'quote-only',
        text: '只有摘引原文',
        quote: '只有摘引原文',
        created: '2026-01-02 03:04:05'
      }),
      memoryHit({
        kind: 'annotation',
        id: 'comment-only',
        text: '只有批注正文',
        created: '2026-01-02 03:04:05'
      })
    ]);
    const lines = material.split('\n');
    expect(lines[1]).toBe('[批注] 《文献甲》第 5 页（2026-01-02）：摘引「只有摘引原文」');
    expect(lines[2]).toBe('[批注] 《文献甲》第 5 页（2026-01-02）：批注：只有批注正文');
  });

  it('超出字符预算时截断并说明', () => {
    const hits = Array.from({ length: 6 }, (_, index) =>
      memoryHit({
        kind: 'note',
        id: `long-${index}`,
        text: '内容'.repeat(100),
        created: '2026-01-02 03:04:05',
        score: 1
      })
    );
    const material = memoryMaterial(hits, 300);
    expect(material.split('\n')[0]).toBe(header);
    expect(material).toContain('字符预算');
    expect(material).toContain('截断');
    // 预算内只保留了一部分记录，没有把 6 条全塞进去。
    expect(material.split('\n').filter((line) => line.startsWith('[笔记]')).length).toBeLessThan(6);
  });
});

describe('memoryChatSources', () => {
  it('转换字段：kind/sourceType/memoryId/documentId/documentName/page/snippet', () => {
    const sources = memoryChatSources([
      memoryHit({ kind: 'note', id: 'n1', documentId: 'doc-1', documentName: '文献甲', page: 3, text: '笔记正文' }),
      memoryHit({
        kind: 'annotation',
        id: 'a1',
        documentId: 'doc-1',
        documentName: '文献甲',
        page: 5,
        text: '摘引\n批注：正文',
        quote: '摘引'
      }),
      memoryHit({
        kind: 'note',
        id: 'n2',
        documentId: '',
        documentName: '独立笔记',
        page: 0,
        title: '独立笔记',
        text: '独立正文'
      })
    ]);
    expect(sources).toEqual([
      {
        documentId: 'doc-1',
        documentName: '文献甲',
        page: 3,
        snippet: '笔记正文',
        kind: 'note',
        sourceType: 'note',
        memoryId: 'n1'
      },
      {
        documentId: 'doc-1',
        documentName: '文献甲',
        page: 5,
        snippet: '摘引\n批注：正文',
        kind: 'annotation',
        sourceType: 'annotation',
        memoryId: 'a1',
        // 摘引只作跳页高亮的定位锚点（不是证据、不进引用编号）。
        anchor: '摘引'
      },
      {
        documentId: '',
        documentName: '独立笔记',
        page: 0,
        snippet: '独立正文',
        kind: 'note',
        sourceType: 'note',
        memoryId: 'n2'
      }
    ]);
  });
});

describe('MEMORY_RULES', () => {
  it('明确笔记/批注不是文献原文、不能参与引用编号', () => {
    expect(MEMORY_RULES).toContain('用户自己的记录');
    expect(MEMORY_RULES).toContain('不是文献原文');
    expect(MEMORY_RULES).toContain('引用编号只能指向文献原文');
    expect(MEMORY_RULES).toContain('与原文冲突时以原文为准');
  });
});
