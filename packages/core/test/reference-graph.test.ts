import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { afterAll, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const root = mkdtempSync(path.join(tmpdir(), 'studianda-reference-graph-'));
const token = 'test-token';

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function storeAt(name: string): Store {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  return new Store(dir);
}

async function importPdf(store: Store, label: string) {
  const file = path.join(root, 'pdfs', `${label}.pdf`);
  mkdirSync(path.dirname(file), { recursive: true });
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]).drawText(`Reference graph fixture ${label}`, { x: 40, y: 350, size: 16 });
  writeFileSync(file, await pdf.save());
  return store.importDocument(file, `${label}.pdf`, true);
}

function nodeIds(graph: { nodes: Array<{ id: string }> }): Set<string> {
  return new Set(graph.nodes.map((node) => node.id));
}

function edgeKeys(graph: { edges: Array<{ from: string; to: string }> }): Set<string> {
  return new Set(graph.edges.map((edge) => `${edge.from}->${edge.to}`));
}

describe('Store.getReferenceGraph', () => {
  it('节点完整（文献/文献笔记/独立笔记/批注），标签按要求生成', async () => {
    const store = storeAt('graph-nodes');
    try {
      const document = await importPdf(store, 'nodes-doc');
      const note = store.createNote({
        documentId: document.id,
        page: 0,
        content: '# 首行标题\n\n**正文**'
      });
      const standalone = store.createNote({
        documentId: '',
        page: 0,
        content: '### 独立笔记标题\n正文内容'
      });
      const annotated = store.createAnnotation({
        documentId: document.id,
        page: 1,
        quote: '批注摘引原文',
        content: '**批注内容**',
        style: 'page'
      });
      const contentOnly = store.createAnnotation({
        documentId: document.id,
        page: 2,
        quote: '',
        content: '只有内容的批注摘要',
        style: 'page'
      });
      // 无连边节点也必须返回。
      store.createNote({ documentId: '', page: 0, content: '孤立笔记没有引用' });

      const graph = store.getReferenceGraph();
      const ids = nodeIds(graph);
      expect([...ids]).toEqual(
        expect.arrayContaining([
          `document:${document.id}`,
          `note:${note.id}`,
          `note:${standalone.id}`,
          `annotation:${annotated.id}`,
          `annotation:${contentOnly.id}`
        ])
      );

      const byId = new Map(graph.nodes.map((node) => [node.id, node]));
      expect(byId.get(`document:${document.id}`)).toMatchObject({
        kind: 'document',
        label: 'nodes-doc.pdf',
        documentId: document.id
      });
      // 笔记标题取首行并去掉 Markdown 标记。
      expect(byId.get(`note:${note.id}`)).toMatchObject({
        kind: 'note',
        label: '首行标题',
        documentId: document.id
      });
      // 独立笔记 documentId 为空串。
      expect(byId.get(`note:${standalone.id}`)).toMatchObject({
        kind: 'note',
        label: '独立笔记标题',
        documentId: ''
      });
      // 批注优先用 quote；没有 quote 用内容纯文本前 40 字。
      expect(byId.get(`annotation:${annotated.id}`)?.label).toBe('批注摘引原文');
      expect(byId.get(`annotation:${contentOnly.id}`)?.label).toBe('只有内容的批注摘要');
      expect(byId.get(`annotation:${annotated.id}`)?.documentId).toBe(document.id);
    } finally {
      store.close();
    }
  });

  it('按 [[…]] 建边：目标存在才建、去重、独立笔记与批注都参与、缺失目标计入 unresolved', async () => {
    const store = storeAt('graph-edges');
    try {
      const documentA = await importPdf(store, 'edges-a');
      const documentB = await importPdf(store, 'edges-b');
      const deletedDocument = await importPdf(store, 'edges-deleted');
      const noteA = store.createNote({ documentId: documentA.id, page: 0, content: '笔记A' });
      const standalone = store.createNote({
        documentId: '',
        page: 0,
        content: '# 独立笔记\n内容'
      });
      const annotationB = store.createAnnotation({
        documentId: documentB.id,
        page: 1,
        quote: '批注B',
        content: '',
        style: 'page'
      });
      store.deleteDocument(deletedDocument.id);

      const source = store.createNote({
        documentId: documentB.id,
        page: 0,
        content: [
          `[[doc:${documentA.id}|文献A]]`,
          // 重复引用同一目标：只留一条边。
          `[[doc:${documentA.id}]]`,
          `[[note:${documentA.id}/${noteA.id}|笔记A]]`,
          `[[note:${standalone.id}|独立笔记]]`,
          `[[ann:${documentB.id}/${annotationB.id}|批注B]]`,
          // 以下目标都不存在/已删除 → unresolved。
          `[[note:${documentA.id}/missing-note]]`,
          `[[ann:${documentB.id}/missing-annotation]]`,
          `[[doc:${deletedDocument.id}]]`,
          // 不是合法内部引用：忽略，不计入 unresolved。
          '[[随便写写]]'
        ].join('\n')
      });
      const standaloneSource = store.createNote({
        documentId: '',
        page: 0,
        content: `独立笔记引用 [[doc:${documentA.id}]]`
      });
      const annotationSource = store.createAnnotation({
        documentId: documentA.id,
        page: 1,
        quote: '引用批注',
        content: `[[note:${documentB.id}/${source.id}]]`,
        style: 'page'
      });
      // 已删除的笔记不参与建图（连它的引用也不计 unresolved）。
      const deletedNote = store.createNote({
        documentId: documentA.id,
        page: 0,
        content: `[[doc:${documentB.id}]]`
      });
      store.deleteNote(deletedNote.id);

      const graph = store.getReferenceGraph();
      const ids = nodeIds(graph);
      expect(ids).not.toContain(`document:${deletedDocument.id}`);
      expect(ids).not.toContain(`note:${deletedNote.id}`);

      const edges = edgeKeys(graph);
      expect([...edges]).toEqual(
        expect.arrayContaining([
          `note:${source.id}->document:${documentA.id}`,
          `note:${source.id}->note:${noteA.id}`,
          `note:${source.id}->note:${standalone.id}`,
          `note:${source.id}->annotation:${annotationB.id}`,
          `note:${standaloneSource.id}->document:${documentA.id}`,
          `annotation:${annotationSource.id}->note:${source.id}`
        ])
      );
      // 重复引用去重：只有一条 note:source -> document:A 边。
      expect(
        graph.edges.filter(
          (edge) => edge.from === `note:${source.id}` && edge.to === `document:${documentA.id}`
        )
      ).toHaveLength(1);
      // 缺失目标 3 条；非法 [[随便写写]] 不计。
      expect(graph.unresolved).toBe(3);
    } finally {
      store.close();
    }
  });
  it('悬空引用按「来源 + 目标原文」去重；非法参数抛错', async () => {
    const store = storeAt('graph-unresolved');
    try {
      const noteA = store.createNote({
        documentId: '',
        page: 0,
        content: '[[doc:missing-document]] [[doc:missing-document]]'
      });
      const noteB = store.createNote({
        documentId: '',
        page: 0,
        content: '[[doc:missing-document]]'
      });
      const graph = store.getReferenceGraph();
      // noteA 重复引用同一缺失目标只算 1；noteB 是另一个来源，再算 1。
      expect(graph.unresolved).toBe(2);
      expect(graph.totalNodes).toBe(2);
      expect(graph.edges).toEqual([]);
      void noteA;
      void noteB;
      expect(() => store.getReferenceGraph({ limit: 0 })).toThrow('limit');
      expect(() => store.getReferenceGraph({ limit: 501 })).toThrow('limit');
      expect(() => store.getReferenceGraph({ offset: -1 })).toThrow('offset');
      expect(() => store.getReferenceGraph({ offset: 1.5 })).toThrow('offset');
    } finally {
      store.close();
    }
  });

  it('按度数分页：节点降序、只返回页内边、totals/offset/limit/hasMore 正确', async () => {
    const store = storeAt('graph-pager');
    try {
      const hub = await importPdf(store, 'pager-hub');
      const other = await importPdf(store, 'pager-other');
      const noteA = store.createNote({
        documentId: hub.id,
        page: 0,
        content: `[[doc:${hub.id}]]`
      });
      const noteB = store.createNote({
        documentId: hub.id,
        page: 0,
        content: `[[doc:${hub.id}]]`
      });
      const noteC = store.createNote({
        documentId: hub.id,
        page: 0,
        content: `[[doc:${hub.id}]]`
      });
      store.createNote({ documentId: other.id, page: 0, content: `[[doc:${other.id}]]` });

      const first = store.getReferenceGraph({ limit: 2, offset: 0 });
      expect(first.totalNodes).toBe(6);
      expect(first.totalEdges).toBe(4);
      expect(first.limit).toBe(2);
      expect(first.offset).toBe(0);
      expect(first.hasMore).toBe(true);
      expect(first.nodes).toHaveLength(2);
      // 度数最高的 hub 文献排第一（被 3 条笔记引用）。
      expect(first.nodes[0]?.id).toBe(`document:${hub.id}`);
      // 当前页内没有一条边的两端都在本页（笔记页外、文献页内）。
      expect(first.edges).toEqual([]);

      const second = store.getReferenceGraph({ limit: 2, offset: 2 });
      expect(second.offset).toBe(2);
      expect(second.hasMore).toBe(true);
      expect(second.nodes).toHaveLength(2);
      const firstIds = new Set(first.nodes.map((node) => node.id));
      expect(second.nodes.every((node) => !firstIds.has(node.id))).toBe(true);

      const tail = store.getReferenceGraph({ limit: 2, offset: 4 });
      expect(tail.hasMore).toBe(false);
      expect(tail.nodes).toHaveLength(2);

      // 一页装下全部节点时，页内边就是全图边。
      const all = store.getReferenceGraph({ limit: 10, offset: 0 });
      expect(all.nodes).toHaveLength(6);
      expect(all.edges).toHaveLength(4);
      expect(all.hasMore).toBe(false);
      const allIds = new Set(all.nodes.map((node) => node.id));
      expect(
        all.edges.every((edge) => allIds.has(edge.from) && allIds.has(edge.to))
      ).toBe(true);
      // 度数相同按 kind/id 升序：hub 之后同度数的 document 排在 note 前。
      expect(all.nodes[1]?.kind).toBe('document');
      // 引用存在则边存在：三条 note→hub 边都在。
      expect(all.edges.filter((edge) => edge.to === `document:${hub.id}`)).toHaveLength(3);
      void noteA;
      void noteB;
      void noteC;
    } finally {
      store.close();
    }
  });

  it('kinds 过滤：先过滤再分页，总数/边数按过滤后统计，kindCounts 始终是全库', async () => {
    const store = storeAt('graph-kinds');
    try {
      const documentA = await importPdf(store, 'kinds-a');
      const documentB = await importPdf(store, 'kinds-b');
      const note = store.createNote({
        documentId: documentA.id,
        page: 0,
        content: `[[doc:${documentB.id}]]`
      });
      store.createAnnotation({
        documentId: documentA.id,
        page: 1,
        quote: '批注引用',
        content: `[[doc:${documentB.id}]] [[note:${documentA.id}/${note.id}]]`,
        style: 'page'
      });

      const full = store.getReferenceGraph({ limit: 500 });
      expect(full.kindCounts).toEqual({ document: 2, note: 1, annotation: 1 });
      expect(full.totalNodes).toBe(4);
      expect(full.totalEdges).toBe(3);
      // 空 kinds 数组等价于不过滤（旧客户端不传 kinds 时行为不变）。
      const noFilter = store.getReferenceGraph({ kinds: [], limit: 500 });
      expect(noFilter.totalNodes).toBe(full.totalNodes);
      expect(noFilter.totalEdges).toBe(full.totalEdges);

      // 只看文献：结果为两篇文献，totalEdges 只统计两端都在结果内的边（0）；
      // 页外笔记/批注的引用变成方向为 in 的跨页边（仍能看出上下文）。
      const docs = store.getReferenceGraph({ kinds: ['document'], limit: 500 });
      expect(docs.nodes.map((node) => node.kind)).toEqual(['document', 'document']);
      expect(docs.totalNodes).toBe(2);
      expect(docs.totalEdges).toBe(0);
      expect(docs.hasMore).toBe(false);
      expect(docs.kindCounts).toEqual({ document: 2, note: 1, annotation: 1 });
      expect(docs.crossEdges.map((edge) => edge.direction)).toEqual(['in', 'in']);
      expect(docs.crossEdges.every((edge) => edge.externalId.length > 0)).toBe(true);

      // 只看笔记+批注：annotation→note 是页内边（totalEdges=1），两条指向文献的边成为跨页出边。
      const inner = store.getReferenceGraph({ kinds: ['note', 'annotation'], limit: 500 });
      expect(inner.totalNodes).toBe(2);
      expect(inner.totalEdges).toBe(1);
      expect(inner.edges).toHaveLength(1);
      expect(inner.crossEdgeTotal).toBe(2);

      // 分页字段按过滤后的总数计算。
      const first = store.getReferenceGraph({ kinds: ['note', 'annotation'], limit: 1, offset: 0 });
      expect(first.nodes).toHaveLength(1);
      expect(first.hasMore).toBe(true);
      expect(first.totalNodes).toBe(2);

      expect(() => store.getReferenceGraph({ kinds: ['unknown' as never] })).toThrow('kinds');
    } finally {
      store.close();
    }
  });

  it('search 过滤：按节点显示名不区分大小写子串匹配，先过滤再分页', async () => {
    const store = storeAt('graph-search');
    try {
      const alpha = await importPdf(store, 'Search-Alpha');
      const beta = await importPdf(store, 'beta');
      store.createNote({ documentId: alpha.id, page: 0, content: 'Alpha 笔记引用' });
      store.createNote({ documentId: beta.id, page: 0, content: 'beta 笔记' });

      const matched = store.getReferenceGraph({ search: 'alpha', limit: 500 });
      expect(matched.totalNodes).toBe(2);
      expect(matched.nodes.every((node) => node.label.toLowerCase().includes('alpha'))).toBe(true);
      expect(matched.totalEdges).toBe(0);
      expect(matched.hasMore).toBe(false);
      // 过滤只影响分页结果，kindCounts 仍是全库统计。
      expect(matched.kindCounts).toEqual({ document: 2, note: 2, annotation: 0 });

      const combined = store.getReferenceGraph({ kinds: ['document'], search: 'beta', limit: 500 });
      expect(combined.nodes.map((node) => node.label)).toEqual(['beta.pdf']);
      expect(combined.totalNodes).toBe(1);

      const none = store.getReferenceGraph({ search: '不存在的关键字', limit: 500 });
      expect(none.totalNodes).toBe(0);
      expect(none.nodes).toEqual([]);
      expect(none.hasMore).toBe(false);
      expect(none.kindCounts).toEqual({ document: 2, note: 2, annotation: 0 });
    } finally {
      store.close();
    }
  });

  it('all 全量模式：一次返回全部节点/边、无跨页边、total 为全图口径；旧分页行为不变', async () => {
    const store = storeAt('graph-all');
    try {
      const documentA = await importPdf(store, 'all-a');
      const documentB = await importPdf(store, 'all-b');
      // A（all-b）与 B/C/D 三篇笔记都有引用关系：全量模式三条边一次返回；
      // 旧分页模式下同一条边会被拆到不同页，只剩部分页内边 + 跨页 stub。
      store.createNote({ documentId: documentA.id, page: 0, content: `[[doc:${documentB.id}]]` });
      store.createNote({ documentId: documentA.id, page: 0, content: `[[doc:${documentB.id}]]` });
      store.createNote({ documentId: documentA.id, page: 0, content: `[[doc:${documentB.id}]]` });

      const all = store.getReferenceGraph({ all: true, limit: 1 });
      expect(all.nodes).toHaveLength(5);
      expect(all.edges).toHaveLength(3);
      expect(all.totalNodes).toBe(5);
      expect(all.totalEdges).toBe(3);
      expect(all.hasMore).toBe(false);
      // A 与 B/C/D 的三条关系边都在同一份数据里，没有任何 A→D 缺失。
      expect(all.edges.filter((edge) => edge.to === `document:${documentB.id}`)).toHaveLength(3);
      // 全量模式所有端点都在同一份数据里：没有跨页 stub。
      expect(all.crossEdges).toEqual([]);
      expect(all.crossEdgeTotal).toBe(0);
      expect(all.truncated).toBe(false);
      expect(all.allNodeLimit).toBe(Store.MAX_ALL_NODES);
      expect(all.kindCounts).toEqual({ document: 2, note: 3, annotation: 0 });

      // 旧分页请求不受影响：limit=1 仍只返回一个节点且 hasMore=true，没有 all 模式字段；
      // 同一份数据分页时页内边只剩 0 条、其余都成了跨页 stub。
      const paged = store.getReferenceGraph({ limit: 1 });
      expect(paged.nodes).toHaveLength(1);
      expect(paged.hasMore).toBe(true);
      expect(paged.truncated).toBeUndefined();
      expect(paged.allNodeLimit).toBeUndefined();
      expect(paged.edges).toEqual([]);
      expect(paged.crossEdgeTotal).toBe(3);

      // all + kinds：过滤后的完整子图，一次返回、无跨页边。
      const docsOnly = store.getReferenceGraph({ all: true, kinds: ['document'] });
      expect(docsOnly.totalNodes).toBe(2);
      expect(docsOnly.nodes).toHaveLength(2);
      expect(docsOnly.totalEdges).toBe(0);
      expect(docsOnly.edges).toEqual([]);
      expect(docsOnly.crossEdges).toEqual([]);
      expect(docsOnly.hasMore).toBe(false);
      expect(docsOnly.kindCounts).toEqual({ document: 2, note: 3, annotation: 0 });

      // all + search：同样一次返回全部匹配节点。
      const searched = store.getReferenceGraph({ all: true, search: 'all-a' });
      expect(searched.nodes.map((node) => node.label)).toEqual(['all-a.pdf']);
      expect(searched.totalNodes).toBe(1);
      expect(searched.hasMore).toBe(false);
      expect(searched.crossEdges).toEqual([]);
    } finally {
      store.close();
    }
  });

  it('all 超硬上限：退回分页、标注 truncated/allNodeLimit，过滤到上限内恢复全量', async () => {
    const store = storeAt('graph-all-limit');
    const originalLimit = Store.MAX_ALL_NODES;
    try {
      Store.MAX_ALL_NODES = 2;
      const document = await importPdf(store, 'limit-doc');
      store.createNote({ documentId: document.id, page: 0, content: `[[doc:${document.id}]]` });
      store.createNote({ documentId: document.id, page: 0, content: `[[doc:${document.id}]]` });

      const truncated = store.getReferenceGraph({ all: true, limit: 2 });
      expect(truncated.truncated).toBe(true);
      expect(truncated.allNodeLimit).toBe(2);
      expect(truncated.totalNodes).toBe(3);
      expect(truncated.nodes).toHaveLength(2);
      expect(truncated.hasMore).toBe(true);
      // 兜底分页保留跨页边上下文（页外端点的 stub）。
      expect(truncated.crossEdgeTotal).toBeGreaterThan(0);

      // 用 kinds 过滤到硬上限以内 → 服务端恢复全量返回，跨页边消失。
      const filtered = store.getReferenceGraph({ all: true, limit: 2, kinds: ['note'] });
      expect(filtered.truncated).toBe(false);
      expect(filtered.hasMore).toBe(false);
      expect(filtered.totalNodes).toBe(2);
      expect(filtered.nodes).toHaveLength(2);
      expect(filtered.crossEdges).toEqual([]);
    } finally {
      Store.MAX_ALL_NODES = originalLimit;
      store.close();
    }
  });

  it('crossEdges：恰好一端在当前页的边带页外端点与方向；同页边不进 crossEdges', async () => {
    const store = storeAt('graph-cross');
    try {
      const hub = await importPdf(store, 'cross-hub');
      const other = await importPdf(store, 'cross-other');
      const noteA = store.createNote({
        documentId: hub.id,
        page: 0,
        content: `[[doc:${hub.id}]]`
      });
      const noteB = store.createNote({
        documentId: hub.id,
        page: 0,
        content: `[[doc:${hub.id}]]`
      });
      const noteC = store.createNote({
        documentId: other.id,
        page: 0,
        content: `[[doc:${hub.id}]]`
      });

      const full = store.getReferenceGraph({ limit: 500 });
      expect(full.crossEdges).toEqual([]);
      expect(full.crossEdgeTotal).toBe(0);
      expect(full.edges).toHaveLength(3);

      // 第一页只有度数最高的 hub 文献：三条入边都是跨页 in，页外端点是三篇笔记。
      const hubPage = store.getReferenceGraph({ limit: 1, offset: 0 });
      expect(hubPage.nodes).toHaveLength(1);
      expect(hubPage.nodes[0]?.id).toBe(`document:${hub.id}`);
      expect(hubPage.crossEdges).toHaveLength(3);
      expect(hubPage.crossEdgeTotal).toBe(3);
      for (const edge of hubPage.crossEdges) {
        expect(edge.direction).toBe('in');
        expect(edge.to).toBe(`document:${hub.id}`);
        expect([noteA.id, noteB.id, noteC.id].map((id) => `note:${id}`)).toContain(edge.externalId);
        // 页外端点 label 来自笔记首行（内部引用渲染后的纯文本）。
        expect(edge.externalLabel.length).toBeGreaterThan(0);
      }

      // 选一页只有某篇引用笔记：它的出边是跨页 out，页外端点是 hub 文献。
      const noteIndex = full.nodes.findIndex(
        (node) => node.kind === 'note' && full.edges.some((edge) => edge.from === node.id)
      );
      expect(noteIndex).toBeGreaterThanOrEqual(0);
      const notePage = store.getReferenceGraph({ limit: 1, offset: noteIndex });
      expect(notePage.nodes).toHaveLength(1);
      const outEdge = notePage.crossEdges.find((edge) => edge.direction === 'out');
      expect(outEdge).toBeDefined();
      expect(outEdge?.from).toBe(notePage.nodes[0]?.id);
      expect(outEdge?.externalId).toBe(`document:${hub.id}`);
      expect(outEdge?.externalLabel).toBe('cross-hub.pdf');
      // 每一条边只出现一次，且当前页外端点不在 nodes 里。
      const seen = new Set<string>();
      for (const edge of notePage.crossEdges) {
        const key = `${edge.from}->${edge.to}`;
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
      expect(notePage.edges).toEqual([]);

      // 同一页内边不会重复进 crossEdges：两页大小装下 note→hub 两端时是页内边。
      const hubIndex = full.nodes.findIndex((node) => node.id === `document:${hub.id}`);
      const pairIndex = Math.min(hubIndex, noteIndex);
      const pairPage = store.getReferenceGraph({ limit: 2, offset: pairIndex });
      if (pairPage.edges.length > 0) {
        expect(pairPage.crossEdges.map((edge) => `${edge.from}->${edge.to}`)).not.toEqual(
          expect.arrayContaining(pairPage.edges.map((edge) => `${edge.from}->${edge.to}`))
        );
      }
    } finally {
      store.close();
    }
  });

  it('crossEdges 最多返回 200 条，crossEdgeTotal 记录全部数量并稳定排序', async () => {
    const store = storeAt('graph-cross-limit');
    try {
      const hub = await importPdf(store, 'cross-limit-hub');
      // 250 篇笔记都引用同一文献 → 以 hub 为唯一页节点时产生 250 条跨页 in 边。
      for (let index = 0; index < 250; index += 1) {
        store.createNote({
          documentId: hub.id,
          page: 0,
          content: `批量引用 ${index} [[doc:${hub.id}]]`
        });
      }
      const page = store.getReferenceGraph({ limit: 1, offset: 0 });
      expect(page.nodes[0]?.id).toBe(`document:${hub.id}`);
      expect(page.crossEdgeTotal).toBe(250);
      expect(page.crossEdges).toHaveLength(200);
      // 稳定排序：from、to 字典序升序。
      const sorted = page.crossEdges
        .slice()
        .sort((left, right) =>
          left.from === right.from
            ? left.to.localeCompare(right.to)
            : left.from.localeCompare(right.from)
        );
      expect(page.crossEdges).toEqual(sorted);
      // 每条跨页边的页外端点都在完整节点集合中。
      const full = store.getReferenceGraph({ limit: 500 });
      const fullIds = new Set(full.nodes.map((node) => node.id));
      expect(page.crossEdges.every((edge) => fullIds.has(edge.externalId))).toBe(true);
    } finally {
      store.close();
    }
  });

  it('缓存 TTL 2s：连续请求复用，写操作立即失效，过期后重建', async () => {
    const store = storeAt('graph-cache');
    try {
      const document = await importPdf(store, 'cache-doc');
      const first = store.getReferenceGraph();
      const second = store.getReferenceGraph();
      // 命中缓存：返回同一批节点对象。
      expect(second.nodes[0]).toBe(first.nodes[0]);

      // 笔记变更立即失效：新笔记出现在图里，且是重建后的新对象。
      const note = store.createNote({ documentId: document.id, page: 0, content: '缓存笔记' });
      const afterCreate = store.getReferenceGraph();
      expect(afterCreate.nodes.some((node) => node.id === `note:${note.id}`)).toBe(true);
      expect(afterCreate.nodes[0]).not.toBe(first.nodes[0]);

      // 修改笔记内容 → label 立即更新。
      store.updateNote(note.id, { content: '# 新标题' });
      expect(
        store.getReferenceGraph().nodes.find((node) => node.id === `note:${note.id}`)?.label
      ).toBe('新标题');

      // 文献改名 → document 节点 label 立即更新。
      store.updateDocument(document.id, { name: '改名后的文献.pdf' });
      expect(
        store.getReferenceGraph().nodes.find((node) => node.id === `document:${document.id}`)?.label
      ).toBe('改名后的文献.pdf');

      // 批注 create/delete 失效。
      const annotation = store.createAnnotation({
        documentId: document.id,
        page: 1,
        quote: '缓存批注',
        content: '',
        style: 'page'
      });
      expect(
        store.getReferenceGraph().nodes.some((node) => node.id === `annotation:${annotation.id}`)
      ).toBe(true);
      store.deleteAnnotation(annotation.id);
      expect(
        store.getReferenceGraph().nodes.some((node) => node.id === `annotation:${annotation.id}`)
      ).toBe(false);

      // 删除/恢复笔记。
      store.deleteNote(note.id);
      expect(store.getReferenceGraph().nodes.some((node) => node.id === `note:${note.id}`)).toBe(
        false
      );
      store.restoreNote(note.id);
      expect(store.getReferenceGraph().nodes.some((node) => node.id === `note:${note.id}`)).toBe(
        true
      );

      // TTL：把缓存时间拨回到 3 秒前模拟过期，下一次请求必须重建（节点对象换新）。
      const cacheRef = (
        store as unknown as {
          referenceGraphCache: { builtAt: number } | null;
        }
      ).referenceGraphCache;
      expect(cacheRef).not.toBeNull();
      const cachedNode = store.getReferenceGraph().nodes[0];
      cacheRef!.builtAt = Date.now() - 3000;
      expect(store.getReferenceGraph().nodes[0]).not.toBe(cachedNode);
    } finally {
      store.close();
    }
  });
});

describe('GET /api/v1/reference-graph', () => {
  const dataDir = path.join(root, 'graph-http');
  mkdirSync(dataDir, { recursive: true });
  const store = new Store(dataDir);
  const server = buildServer({ token, version: 'test-version', store, secrets: new SecretStore() });

  afterAll(async () => {
    await server.close();
    store.close();
  });

  const headers = (): Record<string, string> => ({ 'x-studianda-token': token });

  it('200 返回 nodes/edges/unresolved 与分页字段', async () => {
    const document = await importPdf(store, 'http-graph-doc');
    const note = store.createNote({ documentId: document.id, page: 0, content: '文献笔记' });
    store.createNote({
      documentId: document.id,
      page: 0,
      content: `[[note:${document.id}/${note.id}|笔记]]`
    });

    const response = await server.inject({
      method: 'GET',
      url: '/api/v1/reference-graph',
      headers: headers()
    });
    expect(response.statusCode).toBe(200);
    const graph = response.json() as {
      nodes: Array<{ id: string; kind: string }>;
      edges: Array<{ from: string; to: string }>;
      crossEdges: Array<{ from: string; to: string; direction: string }>;
      crossEdgeTotal: number;
      unresolved: number;
      totalNodes: number;
      totalEdges: number;
      offset: number;
      limit: number;
      hasMore: boolean;
    };
    expect(graph.nodes).toContainEqual(
      expect.objectContaining({ id: `document:${document.id}`, kind: 'document' })
    );
    expect(graph.nodes).toContainEqual(expect.objectContaining({ id: `note:${note.id}` }));
    expect(graph.edges.length).toBeGreaterThanOrEqual(1);
    expect(typeof graph.unresolved).toBe('number');
    // 默认一页装下全部节点：没有跨页边，total 为 0。
    expect(graph.crossEdges).toEqual([]);
    expect(graph.crossEdgeTotal).toBe(0);
    expect(graph.limit).toBe(200);
    expect(graph.offset).toBe(0);
    expect(graph.totalNodes).toBe(graph.nodes.length);
    expect(graph.totalEdges).toBeGreaterThanOrEqual(graph.edges.length);
    expect(typeof graph.hasMore).toBe('boolean');
  });

  it('limit/offset 非法 400，合法分页生效', async () => {
    for (const url of [
      '/api/v1/reference-graph?limit=0',
      '/api/v1/reference-graph?limit=501',
      '/api/v1/reference-graph?limit=abc',
      '/api/v1/reference-graph?limit=1.5',
      '/api/v1/reference-graph?offset=-1',
      '/api/v1/reference-graph?offset=abc'
    ]) {
      const response = await server.inject({ method: 'GET', url, headers: headers() });
      expect(response.statusCode, url).toBe(400);
    }

    const paged = await server.inject({
      method: 'GET',
      url: '/api/v1/reference-graph?limit=1&offset=0',
      headers: headers()
    });
    expect(paged.statusCode).toBe(200);
    const graph = paged.json() as {
      nodes: unknown[];
      offset: number;
      limit: number;
      hasMore: boolean;
    };
    expect(graph.nodes).toHaveLength(1);
    expect(graph.limit).toBe(1);
    expect(graph.offset).toBe(0);
    expect(graph.hasMore).toBe(true);
  });

  it('kinds/search 可选过滤：先过滤再分页，旧客户端不传时行为不变；非法值 400', async () => {
    const docsOnly = await server.inject({
      method: 'GET',
      url: '/api/v1/reference-graph?kinds=document&limit=500',
      headers: headers()
    });
    expect(docsOnly.statusCode).toBe(200);
    const docsGraph = docsOnly.json() as {
      nodes: Array<{ kind: string }>;
      totalNodes: number;
      hasMore: boolean;
      kindCounts: Record<string, number>;
    };
    expect(docsGraph.nodes.every((node) => node.kind === 'document')).toBe(true);
    expect(docsGraph.totalNodes).toBe(1);
    expect(docsGraph.hasMore).toBe(false);
    expect(docsGraph.kindCounts).toEqual({ document: 1, note: 2, annotation: 0 });

    const filteredPage = await server.inject({
      method: 'GET',
      url: '/api/v1/reference-graph?kinds=note&limit=1&offset=0',
      headers: headers()
    });
    expect(filteredPage.statusCode).toBe(200);
    const notesGraph = filteredPage.json() as {
      nodes: Array<{ kind: string }>;
      totalNodes: number;
      hasMore: boolean;
    };
    expect(notesGraph.nodes).toHaveLength(1);
    expect(notesGraph.nodes[0]?.kind).toBe('note');
    expect(notesGraph.totalNodes).toBe(2);
    expect(notesGraph.hasMore).toBe(true);

    const searched = await server.inject({
      method: 'GET',
      url: `/api/v1/reference-graph?search=${encodeURIComponent('GRAPH-DOC')}`,
      headers: headers()
    });
    expect(searched.statusCode).toBe(200);
    const searchGraph = searched.json() as {
      nodes: Array<{ label: string }>;
      totalNodes: number;
      kindCounts: Record<string, number>;
    };
    expect(searchGraph.totalNodes).toBe(1);
    expect(searchGraph.nodes[0]?.label).toBe('http-graph-doc.pdf');
    expect(searchGraph.kindCounts).toEqual({ document: 1, note: 2, annotation: 0 });

    for (const url of [
      '/api/v1/reference-graph?kinds=',
      '/api/v1/reference-graph?kinds=foo',
      '/api/v1/reference-graph?kinds=document,foo',
      `/api/v1/reference-graph?search=${'x'.repeat(101)}`
    ]) {
      const response = await server.inject({ method: 'GET', url, headers: headers() });
      expect(response.statusCode, url).toBe(400);
    }
  });

  it('all=1 全量模式：一次返回全部节点+边、无跨页边，并按 Accept-Encoding 返回 gzip', async () => {
    // 不带 accept-encoding：普通 JSON。
    const plain = await server.inject({
      method: 'GET',
      url: '/api/v1/reference-graph?all=1',
      headers: headers()
    });
    expect(plain.statusCode).toBe(200);
    const graph = plain.json() as {
      nodes: unknown[];
      edges: unknown[];
      crossEdges: unknown[];
      totalNodes: number;
      totalEdges: number;
      hasMore: boolean;
      truncated: boolean;
      allNodeLimit: number;
    };
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toHaveLength(1);
    expect(graph.totalNodes).toBe(3);
    expect(graph.totalEdges).toBe(1);
    expect(graph.hasMore).toBe(false);
    expect(graph.crossEdges).toEqual([]);
    expect(graph.truncated).toBe(false);
    expect(graph.allNodeLimit).toBe(5000);
    // 传 limit=1 也不影响全量模式（不按 offset/limit 截断）。
    const withLimit = await server.inject({
      method: 'GET',
      url: '/api/v1/reference-graph?all=1&limit=1',
      headers: headers()
    });
    expect((withLimit.json() as { nodes: unknown[] }).nodes).toHaveLength(3);

    // 带 accept-encoding: gzip：响应被压缩，解压后是同一个 JSON。
    const gzipped = await server.inject({
      method: 'GET',
      url: '/api/v1/reference-graph?all=1',
      headers: { ...headers(), 'accept-encoding': 'gzip' }
    });
    expect(gzipped.statusCode).toBe(200);
    expect(gzipped.headers['content-encoding']).toBe('gzip');
    const unzipped = JSON.parse(gunzipSync(gzipped.rawPayload).toString('utf8')) as {
      nodes: unknown[];
      hasMore: boolean;
    };
    expect(unzipped.nodes).toHaveLength(3);
    expect(unzipped.hasMore).toBe(false);

    // all 非法值 400。
    const invalid = await server.inject({
      method: 'GET',
      url: '/api/v1/reference-graph?all=maybe',
      headers: headers()
    });
    expect(invalid.statusCode).toBe(400);
  });
});
