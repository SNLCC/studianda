import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { REFERENCE_GRAPH_ALL_NODE_LIMIT } from '@studianda/shared';
import type {
  ReferenceGraph,
  ReferenceGraphCrossEdge,
  ReferenceGraphEdge,
  ReferenceGraphNode,
  ReferenceNodeKind
} from '@studianda/shared';

/** 关系图过滤：按节点类型显示/隐藏。 */
export type ReferenceKindFilter = Record<ReferenceNodeKind, boolean>;

export interface GraphLayoutNode {
  id: string;
  x: number;
  y: number;
  radius: number;
  degree: number;
}

export interface ReferenceGraphViewProps {
  /** 关系图数据（默认 all 全量模式：含全部节点/边；超硬上限时退回分页并带 hasMore/truncated）。 */
  graph: ReferenceGraph | null;
  loading?: boolean;
  error?: string;
  onRetry?(): void;
  /** 点击节点：document 打开文献；独立笔记切到笔记视图；文献笔记/批注打开文献页。 */
  onOpenNode?(node: ReferenceGraphNode): void;
  /** 分批兜底时每批节点数（默认 500）；全量模式不使用。 */
  limit?: number;
  /** 分批兜底切换批次：传入新的 offset（0-based）。全量模式不渲染分页按钮。 */
  onPageChange?(offset: number): void;
  /**
   * 仅当全库超过全量加载上限、服务端退回分批时，类型筛选才改走服务端（先过滤再分批）；
   * 默认数据已是全量，纯客户端过滤即可。回调传当前选中类型（全选传空数组表示不过滤）。
   */
  onKindFilterChange?(kinds: ReferenceNodeKind[]): void;
  /** 仅当全库超过全量加载上限、退回分批时，关键字搜索才改走服务端。 */
  onSearchChange?(search: string): void;
}

/** 视图变换：平移 + 缩放。 */
export interface GraphViewTransform {
  scale: number;
  tx: number;
  ty: number;
}

const VIEW_WIDTH = 900;
const VIEW_HEIGHT = 560;
const VIEW_MARGIN = 46;
/** 默认分页兜底节点数（all 全量模式下不用）。 */
const DEFAULT_PAGE_SIZE = 500;
/** 斥力截断距离上限/下限：实际值按节点密度在区间内收缩，保证大图交互量近似线性。 */
const REPULSION_CUTOFF_MAX = 130;
const REPULSION_CUTOFF_MIN = 26;
/** 节点数超过该值时把布局计算推迟到下一帧，并显示「正在计算布局…」提示。 */
const DEFER_LAYOUT_THRESHOLD = 260;
const MIN_SCALE = 0.4;
const MAX_SCALE = 3;
/** 节点拖动超过该屏幕像素距离就算拖动，不触发打开。 */
const DRAG_THRESHOLD_PX = 4;
/** 节点数不超过该值时默认显示全部标签。 */
const LABEL_ALL_THRESHOLD = 30;
/** 大图「显示全部标签」时最多摆放的标签数（超出按度数取前 N，避免主线程被撑满）。 */
const LABEL_ALL_MAX = 260;

const KIND_LABELS: Record<ReferenceNodeKind, string> = {
  document: '文献',
  note: '笔记',
  annotation: '批注'
};

const KIND_ORDER: ReferenceNodeKind[] = ['document', 'note', 'annotation'];

export const INITIAL_GRAPH_VIEW: GraphViewTransform = { scale: 1, tx: 0, ty: 0 };

/**
 * 过滤节点/边（边两端都可见才保留）。纯函数，便于测试。
 * 可选 search 按节点显示名做不区分大小写子串过滤；两者都是「先过滤再布局」。
 */
export function filterReferenceGraph(
  graph: ReferenceGraph,
  kinds: ReferenceKindFilter,
  search = ''
): { nodes: ReferenceGraphNode[]; edges: ReferenceGraphEdge[] } {
  const term = search.trim().toLowerCase();
  const nodes = graph.nodes.filter(
    (node) => kinds[node.kind] && (!term || node.label.toLowerCase().includes(term))
  );
  const ids = new Set(nodes.map((node) => node.id));
  const edges = graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to));
  return { nodes, edges };
}

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let result = value;
    result = Math.imul(result ^ (result >>> 15), result | 1);
    result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
    return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把缩放夹到 0.4–3x。 */
export function clampGraphScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/**
 * 以 SVG 坐标系中的指针位置为中心缩放。
 * `pointer` 是未变换前的 SVG 坐标（不是屏幕坐标）。
 */
export function zoomViewAt(
  view: GraphViewTransform,
  pointer: { x: number; y: number },
  factor: number
): GraphViewTransform {
  const nextScale = clampGraphScale(view.scale * factor);
  if (nextScale === view.scale) return view;
  const ratio = nextScale / view.scale;
  return {
    scale: nextScale,
    tx: pointer.x - (pointer.x - view.tx) * ratio,
    ty: pointer.y - (pointer.y - view.ty) * ratio
  };
}

/** 节点拖动：返回更新后的位置数组（不修改原数组）。 */
export function moveGraphNode(
  positions: GraphLayoutNode[],
  id: string,
  x: number,
  y: number
): GraphLayoutNode[] {
  return positions.map((node) => (node.id === id ? { ...node, x, y } : node));
}

/** 跨页引用截断信息：total 为服务端总数，returned 为实际返回条数。 */
export function crossEdgeSummary(graph: ReferenceGraph | null): {
  returned: number;
  total: number;
  hidden: number;
} {
  const returned = graph?.crossEdges?.length ?? 0;
  const total = Math.max(returned, graph?.crossEdgeTotal ?? returned);
  return { returned, total, hidden: Math.max(0, total - returned) };
}

/** 分页信息：第 X–Y / 共 N 个节点。 */
export function graphPageRange(graph: ReferenceGraph): {
  start: number;
  end: number;
  total: number;
  hasPrev: boolean;
  hasNext: boolean;
} {
  const total = graph.totalNodes;
  const offset = Math.max(0, graph.offset);
  const loaded = graph.nodes.length;
  return {
    start: loaded > 0 ? offset + 1 : 0,
    end: offset + loaded,
    total,
    hasPrev: offset > 0,
    hasNext: graph.hasMore
  };
}

/** 默认全选（三类节点都显示）。 */
export const ALL_KINDS_VISIBLE: ReferenceKindFilter = {
  document: true,
  note: true,
  annotation: true
};

/** 当前类型过滤里处于选中状态的类型。 */
export function activeReferenceKinds(filter: ReferenceKindFilter): ReferenceNodeKind[] {
  return KIND_ORDER.filter((kind) => filter[kind]);
}

/** 全库各类型节点总数；旧服务端没有 kindCounts 时退化为当前页统计（不报错）。 */
export function graphKindTotals(graph: ReferenceGraph | null): Record<ReferenceNodeKind, number> {
  const totals: Record<ReferenceNodeKind, number> = { document: 0, note: 0, annotation: 0 };
  if (!graph) return totals;
  if (graph.kindCounts) {
    for (const kind of KIND_ORDER) totals[kind] = graph.kindCounts[kind] ?? 0;
    return totals;
  }
  for (const node of graph.nodes) totals[node.kind] += 1;
  return totals;
}

/** 全库节点总数（不受 kinds/search 服务端过滤影响）。 */
export function graphFullNodeTotal(graph: ReferenceGraph | null): number {
  if (!graph) return 0;
  const totals = graphKindTotals(graph);
  return Math.max(graph.totalNodes, totals.document + totals.note + totals.annotation);
}

/** 当前响应适用的全量模式硬上限（服务端返回优先，否则用共享常量）。 */
export function graphAllNodeLimit(graph: ReferenceGraph | null): number {
  const limit = graph?.allNodeLimit;
  return typeof limit === 'number' && Number.isFinite(limit) && limit > 0
    ? limit
    : REFERENCE_GRAPH_ALL_NODE_LIMIT;
}

/**
 * 是否需要服务端筛选：只有全库节点数超过「全量加载上限」时（服务端已退回分批），
 * 类型/关键字筛选才必须先由服务端过滤再分页；默认（≤5000）数据已全量，纯客户端过滤即可。
 */
export function needsServerSideFilter(
  graph: ReferenceGraph | null,
  allNodeLimit: number
): boolean {
  return graphFullNodeTotal(graph) > allNodeLimit;
}

/**
 * 简单力导向布局（斥力 + 弹簧 + 向心），纯函数、确定性（由 seed 决定初始扰动）。
 *
 * 性能：小图（≤140 节点）用全对斥力保证质量；大图（全量模式最多 5000 节点）改用均匀网格
 * 分桶，斥力截断距离按节点密度收缩（保证每个节点只与邻近节点交互、总计算量近似线性），
 * 迭代次数按规模递减（150→22 轮），避免 O(n²) 阻塞主线程。
 * 返回结构不变（id/x/y/radius/degree），拖动、缩放、标签逻辑无需感知实现差异。
 */
export function computeGraphLayout(
  graph: ReferenceGraph,
  options?: { width?: number; height?: number; seed?: number }
): GraphLayoutNode[] {
  const width = options?.width ?? VIEW_WIDTH;
  const height = options?.height ?? VIEW_HEIGHT;
  const seed = options?.seed ?? 1;
  const nodes = graph.nodes;
  const count = nodes.length;
  if (count === 0) return [];
  const random = mulberry32(seed);
  const indexById = new Map<string, number>();
  nodes.forEach((node, index) => indexById.set(node.id, index));
  // 边预先转成索引对，避免每轮迭代反复查 Map。
  const edgeFrom: number[] = [];
  const edgeTo: number[] = [];
  for (const edge of graph.edges) {
    const from = indexById.get(edge.from);
    const to = indexById.get(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    edgeFrom.push(from);
    edgeTo.push(to);
  }
  // 度数 = 与该节点相连的边数（出边+入边）。
  const degree: number[] = new Array(count).fill(0);
  for (let index = 0; index < edgeFrom.length; index += 1) {
    const from = edgeFrom[index] ?? 0;
    const to = edgeTo[index] ?? 0;
    degree[from] = (degree[from] ?? 0) + 1;
    degree[to] = (degree[to] ?? 0) + 1;
  }

  const centerX = width / 2;
  const centerY = height / 2;
  const spreadX = (width - VIEW_MARGIN * 2) / 2;
  const spreadY = (height - VIEW_MARGIN * 2) / 2;
  const rotation = random() * Math.PI * 2;
  const xs: number[] = new Array(count);
  const ys: number[] = new Array(count);
  const vxs: number[] = new Array(count).fill(0);
  const vys: number[] = new Array(count).fill(0);
  // 预先取随机扰动，避免布局迭代中再次调用随机数（保证同 seed 输出稳定）。
  const jitterX: number[] = new Array(count);
  const jitterY: number[] = new Array(count);
  for (let index = 0; index < count; index += 1) {
    const angle = rotation + (index / count) * Math.PI * 2;
    const radius = 0.5 + random() * 0.35;
    xs[index] = centerX + Math.cos(angle) * spreadX * radius;
    ys[index] = centerY + Math.sin(angle) * spreadY * radius;
    jitterX[index] = random() - 0.5;
    jitterY[index] = random() - 0.5;
  }
  // 迭代次数按规模递减：5000 节点约 22 轮，保证主线程不被长时间占用。
  const iterations =
    count <= 140 ? 150 : count <= 600 ? 80 : count <= 1500 ? 50 : count <= 3000 ? 35 : 22;
  const repulsion = 5200;
  const forceX: number[] = new Array(count).fill(0);
  const forceY: number[] = new Array(count).fill(0);
  // 大图用网格分桶：桶边长 = 斥力截断距离，只检查邻近桶；裁掉远处斥力对整体形态影响很小。
  const useGrid = count > 140;
  const buckets = new Map<number, number[]>();
  // 截断距离随节点密度收缩：节点越多，单节点邻域半径越小，总交互量保持近似线性。
  const densitySpacing = Math.sqrt((width * height) / Math.max(1, count));
  const repulsionCutoff = useGrid
    ? Math.min(
        REPULSION_CUTOFF_MAX,
        Math.max(REPULSION_CUTOFF_MIN, densitySpacing * 2.2)
      )
    : REPULSION_CUTOFF_MAX;
  const bucketCols = Math.max(1, Math.ceil(width / repulsionCutoff) + 1);
  const bucketKeys: number[] = [];
  const bucketIndex = (x: number, y: number): number => {
    const column = Math.min(bucketCols - 1, Math.max(0, Math.floor(x / repulsionCutoff)));
    const row = Math.max(0, Math.floor(y / repulsionCutoff));
    return row * bucketCols + column;
  };
  const addRepulsion = (left: number, right: number): void => {
    let dx = (xs[left] ?? centerX) - (xs[right] ?? centerX);
    let dy = (ys[left] ?? centerY) - (ys[right] ?? centerY);
    // 热点循环里不用 Math.hypot（V8 下明显更慢），手写平方和开方。
    let distance = Math.sqrt(dx * dx + dy * dy);
    if (distance < 0.5) {
      dx = jitterX[left] ?? 0.25;
      dy = jitterY[left] ?? 0.25;
      distance = 0.5;
    }
    if (useGrid && distance > repulsionCutoff) return;
    const force = Math.min(24, repulsion / (distance * distance));
    const fx = (dx / distance) * force;
    const fy = (dy / distance) * force;
    forceX[left] = (forceX[left] ?? 0) + fx;
    forceY[left] = (forceY[left] ?? 0) + fy;
    forceX[right] = (forceX[right] ?? 0) - fx;
    forceY[right] = (forceY[right] ?? 0) - fy;
  };
  // 只向右/向下相邻桶配对（配合同桶 start=a+1），每条节点对恰好计算一次。
  const neighborOffsets: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1]
  ];

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    forceX.fill(0);
    forceY.fill(0);
    if (useGrid) {
      buckets.clear();
      bucketKeys.length = 0;
      for (let index = 0; index < count; index += 1) {
        const key = bucketIndex(xs[index] ?? centerX, ys[index] ?? centerY);
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = [];
          buckets.set(key, bucket);
          bucketKeys.push(key);
        }
        bucket.push(index);
      }
      for (const key of bucketKeys) {
        const bucket = buckets.get(key);
        if (!bucket) continue;
        const row = Math.floor(key / bucketCols);
        const column = key % bucketCols;
        for (const [rowOffset, columnOffset] of neighborOffsets) {
          const neighborRow = row + rowOffset;
          const neighborColumn = column + columnOffset;
          if (neighborRow < 0 || neighborColumn < 0 || neighborColumn >= bucketCols) continue;
          const neighbor = buckets.get(neighborRow * bucketCols + neighborColumn);
          if (!neighbor) continue;
          const sameBucket = rowOffset === 0 && columnOffset === 0;
          for (let a = 0; a < bucket.length; a += 1) {
            const left = bucket[a] ?? 0;
            for (let b = sameBucket ? a + 1 : 0; b < neighbor.length; b += 1) {
              addRepulsion(left, neighbor[b] ?? 0);
            }
          }
        }
      }
    } else {
      for (let left = 0; left < count; left += 1) {
        for (let right = left + 1; right < count; right += 1) {
          addRepulsion(left, right);
        }
      }
    }
    // 边的弹簧力
    for (let index = 0; index < edgeFrom.length; index += 1) {
      const from = edgeFrom[index] ?? 0;
      const to = edgeTo[index] ?? 0;
      const dx = (xs[to] ?? centerX) - (xs[from] ?? centerX);
      const dy = (ys[to] ?? centerY) - (ys[from] ?? centerY);
      const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const spring = (distance - 120) * 0.012;
      const fx = (dx / distance) * spring;
      const fy = (dy / distance) * spring;
      forceX[from] = (forceX[from] ?? 0) + fx;
      forceY[from] = (forceY[from] ?? 0) + fy;
      forceX[to] = (forceX[to] ?? 0) - fx;
      forceY[to] = (forceY[to] ?? 0) - fy;
    }
    // 向心 + 位置更新
    for (let index = 0; index < count; index += 1) {
      const x = xs[index] ?? centerX;
      const y = ys[index] ?? centerY;
      const centerPullX = (centerX - x) * 0.004;
      const centerPullY = (centerY - y) * 0.004;
      const nextVx = ((vxs[index] ?? 0) + (forceX[index] ?? 0) * 0.06 + centerPullX) * 0.82;
      const nextVy = ((vys[index] ?? 0) + (forceY[index] ?? 0) * 0.06 + centerPullY) * 0.82;
      vxs[index] = nextVx;
      vys[index] = nextVy;
      xs[index] = Math.min(width - VIEW_MARGIN, Math.max(VIEW_MARGIN, x + nextVx));
      ys[index] = Math.min(height - VIEW_MARGIN, Math.max(VIEW_MARGIN, y + nextVy));
    }
  }

  return nodes.map((node, index) => {
    const nodeDegree = degree[index] ?? 0;
    return {
      id: node.id,
      x: Math.round(xs[index] ?? centerX),
      y: Math.round(ys[index] ?? centerY),
      degree: nodeDegree,
      radius: 7 + Math.min(9, nodeDegree * 1.1)
    };
  });
}

function truncateLabel(label: string, max = 14): string {
  const value = (label || '').trim() || '（未命名）';
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function labelWidth(label: string): number {
  return Math.min(220, truncateLabel(label).length * 7.5 + 12);
}

export type LabelDirection = 'right' | 'left' | 'top' | 'bottom';

export interface LabelPlacement {
  x: number;
  y: number;
  width: number;
  height: number;
  direction: LabelDirection;
}

interface LabelBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const LABEL_HEIGHT = 18;
/** 候选方向顺序：右/左/上/下。 */
const LABEL_DIRECTIONS: LabelDirection[] = ['right', 'left', 'top', 'bottom'];

function boxesOverlap(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

/** 矩形与节点圆是否相交（最近点距离 < 半径）。 */
function boxIntersectsCircle(
  box: { x: number; y: number; width: number; height: number },
  circle: { x: number; y: number; radius: number }
): boolean {
  const nearestX = Math.max(box.x, Math.min(circle.x, box.x + box.width));
  const nearestY = Math.max(box.y, Math.min(circle.y, box.y + box.height));
  const dx = nearestX - circle.x;
  const dy = nearestY - circle.y;
  return dx * dx + dy * dy < circle.radius * circle.radius;
}

function candidatePlacement(
  label: string,
  position: GraphLayoutNode,
  direction: LabelDirection
): LabelPlacement {
  const width = labelWidth(label);
  const height = LABEL_HEIGHT;
  const gap = 7;
  switch (direction) {
    case 'left':
      return {
        x: position.x - position.radius - gap - width,
        y: position.y - height / 2,
        width,
        height,
        direction
      };
    case 'top':
      return {
        x: position.x - width / 2,
        y: position.y - position.radius - gap - height,
        width,
        height,
        direction
      };
    case 'bottom':
      return {
        x: position.x - width / 2,
        y: position.y + position.radius + gap,
        width,
        height,
        direction
      };
    default:
      return {
        x: position.x + position.radius + gap,
        y: position.y - height / 2,
        width,
        height,
        direction: 'right'
      };
  }
}

/** 选中第一个不与已放置标签、任何节点圆相交的方向；全部冲突返回 null。 */
function choosePlacement(
  label: string,
  position: GraphLayoutNode,
  placed: LabelBox[],
  circleNodes: GraphLayoutNode[]
): LabelPlacement | null {
  for (const direction of LABEL_DIRECTIONS) {
    const candidate = candidatePlacement(label, position, direction);
    if (placed.some((box) => boxesOverlap(box, candidate))) continue;
    if (
      circleNodes.some((circle) =>
        boxIntersectsCircle(candidate, {
          x: circle.x,
          y: circle.y,
          radius: circle.radius + 2
        })
      )
    ) {
      continue;
    }
    return candidate;
  }
  return null;
}

/**
 * 标签放置（Phase 7）：按度数从高到低，为每个节点依次尝试右/左/上/下 4 个候选框，
 * 选第一个不与已放置标签、任何节点圆相交的位置；全部冲突才隐藏。
 * hover 节点标签优先放置且保证显示。返回 nodeId → 放置结果（含方向）。
 * 可选 maxPlacements：大图「显示全部标签」时只摆放度数最高的前 N 个，避免 O(n²) 卡顿。
 */
export function placeVisibleLabels(
  nodes: ReferenceGraphNode[],
  positions: GraphLayoutNode[],
  showAll: boolean,
  hoveredId: string | null,
  maxPlacements = Number.POSITIVE_INFINITY
): Map<string, LabelPlacement> {
  const positionById = new Map(positions.map((node) => [node.id, node]));
  const placements = new Map<string, LabelPlacement>();
  if (nodes.length === 0) return placements;
  const placed: LabelBox[] = [];
  const circleNodes = positions;

  if (hoveredId) {
    const position = positionById.get(hoveredId);
    const hoveredNode = nodes.find((node) => node.id === hoveredId);
    if (position && hoveredNode) {
      // hover 标签保证显示：优先右侧，冲突时按方向尝试，仍不行也强制放右侧。
      const placement =
        choosePlacement(hoveredNode.label, position, [], circleNodes) ??
        candidatePlacement(hoveredNode.label, position, 'right');
      placements.set(hoveredId, placement);
      placed.push({ id: hoveredId, ...placement });
    }
  }

  if (!showAll) return placements;

  const ordered = [...nodes].sort((left, right) => {
    const leftPosition = positionById.get(left.id);
    const rightPosition = positionById.get(right.id);
    return (rightPosition?.degree ?? 0) - (leftPosition?.degree ?? 0);
  });
  const limit = Number.isFinite(maxPlacements)
    ? Math.max(0, Math.floor(maxPlacements))
    : ordered.length;
  let placedCount = 0;
  for (const node of ordered) {
    if (placedCount >= limit) break;
    if (node.id === hoveredId) continue;
    const position = positionById.get(node.id);
    if (!position) continue;
    const placement = choosePlacement(node.label, position, placed, circleNodes);
    if (!placement) continue;
    placements.set(node.id, placement);
    placed.push({ id: node.id, ...placement });
    placedCount += 1;
  }
  return placements;
}

/** 兼容旧接口：只返回应显示标签的节点 id 集合。 */
export function selectVisibleLabelIds(
  nodes: ReferenceGraphNode[],
  positions: GraphLayoutNode[],
  showAll: boolean,
  hoveredId: string | null
): Set<string> {
  return new Set(placeVisibleLabels(nodes, positions, showAll, hoveredId).keys());
}

/** 节点拖拽夹取：位置限制在画布内并考虑节点半径。 */
export function clampNodePosition(
  position: GraphLayoutNode,
  x: number,
  y: number,
  width = VIEW_WIDTH,
  height = VIEW_HEIGHT,
  margin = VIEW_MARGIN
): { x: number; y: number } {
  const minX = margin + position.radius;
  const maxX = width - margin - position.radius;
  const minY = margin + position.radius;
  const maxY = height - margin - position.radius;
  const clampValue = (value: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, value));
  return {
    x: clampValue(x, Math.min(minX, maxX), Math.max(minX, maxX)),
    y: clampValue(y, Math.min(minY, maxY), Math.max(minY, maxY))
  };
}

/** 跨页 stub：从当前页节点指向画布边缘。 */
export interface CrossEdgeStub {
  key: string;
  internalId: string;
  direction: 'out' | 'in';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  labelX: number;
  labelY: number;
  label: string;
}

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

/**
 * 把 crossEdges 变成可绘制的虚线 stub：按 externalId 哈希选择上/下/左/右边界，
 * 终点落在画布边缘（留出标签空间），返回标签位置。
 */
export function computeCrossEdgeStubs(
  crossEdges: ReferenceGraphCrossEdge[],
  positions: GraphLayoutNode[],
  width = VIEW_WIDTH,
  height = VIEW_HEIGHT,
  margin = VIEW_MARGIN
): CrossEdgeStub[] {
  const positionById = new Map(positions.map((node) => [node.id, node]));
  const stubs: CrossEdgeStub[] = [];
  crossEdges.forEach((edge, index) => {
    if (edge.direction === 'out') {
      if (!positionById.has(edge.from)) return;
    } else if (!positionById.has(edge.to)) {
      return;
    }
    const internalId = edge.direction === 'out' ? edge.from : edge.to;
    const position = positionById.get(internalId);
    if (!position) return;
    const hash = stableHash(edge.externalId || `${edge.from}->${edge.to}`);
    const side = Math.floor(hash * 4) % 4;
    const spread = hash * 2 - 1;
    const label = edge.externalLabel || edge.externalId || '页外节点';
    const edgeInset = 10;
    const labelHeight = LABEL_HEIGHT;
    let x2 = position.x;
    let y2 = position.y;
    let labelX = position.x;
    let labelY = position.y;
    if (side === 0) {
      // 右边界
      x2 = width - edgeInset;
      y2 = Math.min(
        height - margin - labelHeight,
        Math.max(margin + labelHeight, position.y + spread * 90)
      );
      labelX = x2 - labelWidth(label) - 6;
      labelY = y2 - labelHeight - 4;
    } else if (side === 1) {
      // 左边界
      x2 = edgeInset;
      y2 = Math.min(
        height - margin - labelHeight,
        Math.max(margin + labelHeight, position.y + spread * 90)
      );
      labelX = x2 + 6;
      labelY = y2 - labelHeight - 4;
    } else if (side === 2) {
      // 上边界
      y2 = edgeInset;
      x2 = Math.min(
        width - margin - labelWidth(label),
        Math.max(margin + labelWidth(label), position.x + spread * 120)
      );
      labelX = Math.min(width - labelWidth(label) - 6, Math.max(6, x2 - labelWidth(label) / 2));
      labelY = y2 + 6;
    } else {
      // 下边界
      y2 = height - edgeInset;
      x2 = Math.min(
        width - margin - labelWidth(label),
        Math.max(margin + labelWidth(label), position.x + spread * 120)
      );
      labelX = Math.min(width - labelWidth(label) - 6, Math.max(6, x2 - labelWidth(label) / 2));
      labelY = y2 - labelHeight - 6;
    }
    stubs.push({
      key: `${edge.from}->${edge.to}-${edge.externalId}-${index}`,
      internalId,
      direction: edge.direction,
      x1: position.x,
      y1: position.y,
      x2,
      y2,
      labelX,
      labelY,
      label
    });
  });
  return stubs;
}

/**
 * 边层：只在边集合或坐标变化时重渲染。hover 高亮由父组件直接切换 DOM class，
 * 避免大图（数千节点/边）每次 hover 都走一遍 React diff。
 */
const GraphEdgesLayer = memo(function GraphEdgesLayer({
  edges,
  positionById
}: {
  edges: ReferenceGraphEdge[];
  positionById: Map<string, GraphLayoutNode>;
}): React.JSX.Element {
  return (
    <g className="kr-graph__edges">
      {edges.map((edge, index) => {
        const from = positionById.get(edge.from);
        const to = positionById.get(edge.to);
        if (!from || !to) return null;
        return (
          <line
            key={`${edge.from}->${edge.to}-${index}`}
            className="kr-graph__edge"
            data-from={edge.from}
            data-to={edge.to}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
          />
        );
      })}
    </g>
  );
});

/**
 * 节点层：只在节点集合、坐标或拖拽态变化时重渲染；hover 类名由父组件直接改 DOM。
 */
const GraphNodesLayer = memo(function GraphNodesLayer({
  nodes,
  positionById,
  draggingId,
  canOpen,
  onNodePointerDown,
  onNodeHover,
  onNodeKeyDown
}: {
  nodes: ReferenceGraphNode[];
  positionById: Map<string, GraphLayoutNode>;
  draggingId: string | null;
  canOpen: boolean;
  onNodePointerDown(event: React.PointerEvent<SVGGElement>, node: ReferenceGraphNode): void;
  onNodeHover(id: string | null): void;
  onNodeKeyDown(event: React.KeyboardEvent<SVGGElement>, node: ReferenceGraphNode): void;
}): React.JSX.Element {
  return (
    <g className="kr-graph__nodes">
      {nodes.map((node) => {
        const position = positionById.get(node.id);
        if (!position) return null;
        const titleText = `${KIND_LABELS[node.kind]} · ${node.label}${
          node.page ? ` · 第 ${node.page} 页` : ''
        }${node.kind === 'note' && !node.documentId ? ' · 独立笔记' : ''}`;
        return (
          <g
            key={node.id}
            data-node-id={node.id}
            className={`kr-graph__node kr-graph__node--${node.kind}${
              draggingId === node.id ? ' is-dragging' : ''
            }`}
            role={canOpen ? 'button' : undefined}
            tabIndex={canOpen ? 0 : undefined}
            aria-label={titleText}
            transform={`translate(${position.x}, ${position.y})`}
            onPointerDown={(event) => onNodePointerDown(event, node)}
            onMouseEnter={() => onNodeHover(node.id)}
            onMouseLeave={() => onNodeHover(null)}
            onFocus={() => onNodeHover(node.id)}
            onBlur={() => onNodeHover(null)}
            onKeyDown={(event) => onNodeKeyDown(event, node)}
          >
            <circle className="kr-graph__circle" r={position.radius} />
            <title>{titleText}</title>
          </g>
        );
      })}
    </g>
  );
});

/**
 * 全库引用关系图视图：默认 all 全量模式（一次拿到全部节点+边，关系图完整）；
 * 只有全库超过服务端硬上限被退回分批时，才提供类型/关键字服务端筛选与分批查看。
 * 缩放/平移、节点拖拽、标签防重叠、节点点击导航保持不变。
 */
export function ReferenceGraphView({
  graph,
  loading = false,
  error = '',
  onRetry,
  onOpenNode,
  limit,
  onPageChange,
  onKindFilterChange,
  onSearchChange
}: ReferenceGraphViewProps): React.JSX.Element {
  const [visibleKinds, setVisibleKinds] = useState<ReferenceKindFilter>(ALL_KINDS_VISIBLE);
  // 搜索框输入值；防抖后的 appliedSearch 才真正参与过滤/请求。
  const [searchText, setSearchText] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [seed, setSeed] = useState(1);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [showAllLabels, setShowAllLabels] = useState(false);
  const [view, setView] = useState<GraphViewTransform>(INITIAL_GRAPH_VIEW);
  // 布局坐标在 useLayoutEffect 里算（小图同步、大图推迟），首帧不会闪空画布。
  const [positions, setPositions] = useState<GraphLayoutNode[]>([]);
  const [layoutBusy, setLayoutBusy] = useState(false);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [panning, setPanning] = useState(false);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const dragRef = useRef<{
    id: string;
    startClientX: number;
    startClientY: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const panRef = useRef<{
    startClientX: number;
    startClientY: number;
    startTx: number;
    startTy: number;
  } | null>(null);

  const pageSize = limit ?? graph?.limit ?? DEFAULT_PAGE_SIZE;
  // 全量模式（服务端 all=1）：正常一次拿到全部节点/边；只有全库超过硬上限退回分批时，
  // 类型/关键字筛选才需要走服务端（否则只能筛当前批、统计口径失真）。默认纯客户端全量过滤。
  const allNodeLimit = graphAllNodeLimit(graph);
  const serverSideFilter = needsServerSideFilter(graph, allNodeLimit);
  const kindTotals = graphKindTotals(graph);
  const fullNodeTotal = graphFullNodeTotal(graph);
  const showKindCounts = Boolean(graph?.kindCounts);
  const activeKinds = activeReferenceKinds(visibleKinds);
  const kindsFiltered = activeKinds.length < KIND_ORDER.length;
  // 服务端是否因超硬上限截断（all 模式响应字段）；无该字段的旧服务端按全库总数判断。
  const truncated = Boolean(graph?.truncated) || (serverSideFilter && Boolean(graph?.hasMore));

  // 搜索防抖：输入停顿 250ms 后才应用，避免每个按键都触发重排/请求。
  useEffect(() => {
    const trimmed = searchText.trim();
    if (trimmed === appliedSearch) return;
    const timer = window.setTimeout(() => setAppliedSearch(trimmed), 250);
    return () => window.clearTimeout(timer);
  }, [searchText, appliedSearch]);

  // 服务端筛选模式：把生效的搜索词交给 app 重新请求（值未变化时不重复发送）。
  const lastSentSearch = useRef(appliedSearch);
  useEffect(() => {
    if (!serverSideFilter) return;
    if (lastSentSearch.current === appliedSearch) return;
    lastSentSearch.current = appliedSearch;
    onSearchChange?.(appliedSearch);
  }, [appliedSearch, serverSideFilter, onSearchChange]);

  const filtered = useMemo(
    () => (graph ? filterReferenceGraph(graph, visibleKinds, appliedSearch) : { nodes: [], edges: [] }),
    [graph, visibleKinds, appliedSearch]
  );

  // hover 邻接表：用于高亮相邻节点/边。高亮直接切 DOM class，不触发节点/边层重渲染。
  const adjacencyMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const edge of filtered.edges) {
      let fromSet = map.get(edge.from);
      if (!fromSet) {
        fromSet = new Set<string>();
        map.set(edge.from, fromSet);
      }
      fromSet.add(edge.to);
      let toSet = map.get(edge.to);
      if (!toSet) {
        toSet = new Set<string>();
        map.set(edge.to, toSet);
      }
      toSet.add(edge.from);
    }
    return map;
  }, [filtered.edges]);

  const hoveredRef = useRef<string | null>(null);
  const resetGraphHover = useCallback((): void => {
    hoveredRef.current = null;
    setHoveredId(null);
  }, []);
  const setGraphHover = useCallback(
    (id: string | null): void => {
      if (hoveredRef.current === id) return;
      hoveredRef.current = id;
      // 只让标签层随 hover 重渲染；节点/边层保持 memo，高亮直接切换 DOM class。
      setHoveredId(id);
      const svg = svgRef.current;
      if (!svg) return;
      const focusSet = new Set<string>();
      if (id) {
        focusSet.add(id);
        for (const neighbor of adjacencyMap.get(id) ?? []) focusSet.add(neighbor);
      }
      svg.querySelectorAll<SVGGElement>('.kr-graph__node').forEach((element) => {
        const nodeId = element.getAttribute('data-node-id') ?? '';
        const isHovered = nodeId === id;
        const isAdjacent = focusSet.has(nodeId);
        element.classList.toggle('is-hovered', isHovered);
        element.classList.toggle('is-dimmed', Boolean(id) && !isAdjacent);
      });
      svg.querySelectorAll<SVGLineElement>('.kr-graph__edge').forEach((element) => {
        const from = element.getAttribute('data-from') ?? '';
        const to = element.getAttribute('data-to') ?? '';
        // 与旧逻辑一致：两端都在 hover 邻近集合内才算 active。
        const active = Boolean(id) && focusSet.has(from) && focusSet.has(to);
        element.classList.toggle('is-active', active);
        element.classList.toggle('is-dimmed', Boolean(id) && !active);
      });
    },
    [adjacencyMap]
  );

  // 切页时重置视图（缩放/平移）与 hover，并重新布局（layout 已随之变化）。
  useEffect(() => {
    setView(INITIAL_GRAPH_VIEW);
    resetGraphHover();
  }, [graph?.offset, graph?.limit, resetGraphHover]);

  // 过滤/搜索导致节点集合变化时清掉 hover：节点层会重渲染并丢掉 DOM class，避免 hover 状态错位。
  useEffect(() => {
    resetGraphHover();
  }, [filtered.nodes, resetGraphHover]);

  // 布局计算：小图在 layout effect 里同步算（首帧即绘制，不闪空画布）；大图推迟到下一帧
  // 并显示「正在计算布局…」，避免全量模式（最多 5000 节点）布局阻塞 React 渲染/首帧。
  // 切页、改 seed、改过滤都会重新布局并清掉拖拽上下文。
  useLayoutEffect(() => {
    dragRef.current = null;
    setDraggingId(null);
    if (!graph) {
      setPositions([]);
      setLayoutBusy(false);
      return;
    }
    const input = { ...graph, nodes: filtered.nodes, edges: filtered.edges };
    if (filtered.nodes.length <= DEFER_LAYOUT_THRESHOLD) {
      setPositions(computeGraphLayout(input, { seed }));
      setLayoutBusy(false);
      return;
    }
    let cancelled = false;
    let timer: number | undefined;
    setLayoutBusy(true);
    const frame = window.requestAnimationFrame(() => {
      timer = window.setTimeout(() => {
        if (cancelled) return;
        setPositions(computeGraphLayout(input, { seed }));
        setLayoutBusy(false);
      }, 0);
    });
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [graph, filtered, seed]);

  // 滚轮以指针为中心缩放：需要非 passive 监听才能 preventDefault。
  useEffect(() => {
    const element = svgRef.current;
    if (!element) return;
    const handleWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const pointer = {
        x: ((event.clientX - rect.left) * VIEW_WIDTH) / rect.width,
        y: ((event.clientY - rect.top) * VIEW_HEIGHT) / rect.height
      };
      const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
      setView((current) => zoomViewAt(current, pointer, factor));
    };
    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => element.removeEventListener('wheel', handleWheel);
  }, [graph, positions.length]);

  const positionById = useMemo(
    () => new Map(positions.map((node) => [node.id, node])),
    [positions]
  );
  const nodeById = useMemo(
    () => new Map(filtered.nodes.map((node) => [node.id, node])),
    [filtered.nodes]
  );

  const labelShowAll = showAllLabels || filtered.nodes.length <= LABEL_ALL_THRESHOLD;
  const maxLabelPlacements = filtered.nodes.length > LABEL_ALL_MAX ? LABEL_ALL_MAX : undefined;
  // 基础标签只随节点/坐标/开关变化重算；hover 只额外算一个标签并合并，避免大图 hover 反复摆全部标签。
  const baseLabels = useMemo(
    () =>
      placeVisibleLabels(filtered.nodes, positions, labelShowAll, null, maxLabelPlacements),
    [filtered.nodes, positions, labelShowAll, maxLabelPlacements]
  );
  const labelsVisible = useMemo(() => {
    if (!hoveredId) return baseLabels;
    const hovered = placeVisibleLabels(filtered.nodes, positions, false, hoveredId);
    if (hovered.size === 0) return baseLabels;
    const merged = new Map(baseLabels);
    for (const [nodeId, placement] of hovered) merged.set(nodeId, placement);
    return merged;
  }, [baseLabels, filtered.nodes, positions, hoveredId]);

  // 跨页边：只保留页内端点可见（被类型过滤隐藏的节点不画 stub）。
  const visibleCrossEdges = useMemo(() => {
    const ids = new Set(filtered.nodes.map((node) => node.id));
    return (graph?.crossEdges ?? []).filter((edge) =>
      ids.has(edge.direction === 'out' ? edge.from : edge.to)
    );
  }, [graph, filtered.nodes]);

  const crossStubs = useMemo(
    () => computeCrossEdgeStubs(visibleCrossEdges, positions),
    [visibleCrossEdges, positions]
  );

  const resetView = (): void => setView(INITIAL_GRAPH_VIEW);

  const relayout = (): void => {
    setSeed((value) => value + 1);
    resetView();
    resetGraphHover();
  };

  const toggleKind = (kind: ReferenceNodeKind): void => {
    const next = { ...visibleKinds, [kind]: !visibleKinds[kind] };
    setVisibleKinds(next);
    // 只有全库超过硬上限、服务端退回分批时，类型筛选才交给服务端（先过滤再分批），统计口径才准确。
    if (serverSideFilter) {
      const nextKinds = activeReferenceKinds(next);
      onKindFilterChange?.(nextKinds.length === KIND_ORDER.length ? [] : nextKinds);
    }
  };

  const clearSearch = (): void => {
    setSearchText('');
    setAppliedSearch('');
  };

  const svgPoint = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const element = svgRef.current;
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: ((clientX - rect.left) * VIEW_WIDTH) / rect.width,
      y: ((clientY - rect.top) * VIEW_HEIGHT) / rect.height
    };
  };

  const handleNodePointerDown = useCallback(
    (event: React.PointerEvent<SVGGElement>, node: ReferenceGraphNode): void => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      const position = positionById.get(node.id);
      if (!position) return;
      const element = svgRef.current;
      element?.setPointerCapture?.(event.pointerId);
      dragRef.current = {
        id: node.id,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startX: position.x,
        startY: position.y,
        moved: false
      };
      setDraggingId(node.id);
    },
    [positionById]
  );

  // onOpenNode 每次父组件渲染都可能是新函数；用 ref 保持 layer 的 memo 稳定（否则 5000 节点会整层重渲染）。
  const onOpenNodeRef = useRef(onOpenNode);
  onOpenNodeRef.current = onOpenNode;
  const handleNodeKeyDown = useCallback(
    (event: React.KeyboardEvent<SVGGElement>, node: ReferenceGraphNode): void => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onOpenNodeRef.current?.(node);
      }
    },
    []
  );

  const handleSvgPointerDown = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return;
    const target = event.target as Element | null;
    if (target?.closest('.kr-graph__node')) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    panRef.current = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      startTx: viewRef.current.tx,
      startTy: viewRef.current.ty
    };
    setPanning(true);
  };

  const handleSvgPointerMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current;
    if (drag) {
      const dxScreen = event.clientX - drag.startClientX;
      const dyScreen = event.clientY - drag.startClientY;
      if (!drag.moved && Math.hypot(dxScreen, dyScreen) >= DRAG_THRESHOLD_PX) {
        drag.moved = true;
      }
      const pointer = svgPoint(drag.startClientX, drag.startClientY);
      const current = svgPoint(event.clientX, event.clientY);
      if (pointer && current) {
        const scale = viewRef.current.scale || 1;
        const nextX = drag.startX + (current.x - pointer.x) / scale;
        const nextY = drag.startY + (current.y - pointer.y) / scale;
        setPositions((currentPositions) => {
          const currentPosition = currentPositions.find((item) => item.id === drag.id);
          if (!currentPosition) return currentPositions;
          const clamped = clampNodePosition(currentPosition, nextX, nextY);
          return moveGraphNode(currentPositions, drag.id, clamped.x, clamped.y);
        });
      }
      return;
    }
    const pan = panRef.current;
    if (!pan) return;
    const pointer = svgPoint(pan.startClientX, pan.startClientY);
    const current = svgPoint(event.clientX, event.clientY);
    if (!pointer || !current) return;
    setView((previous) => ({
      ...previous,
      tx: pan.startTx + (current.x - pointer.x),
      ty: pan.startTy + (current.y - pointer.y)
    }));
  };

  const finishPointerInteraction = (event: React.PointerEvent<SVGSVGElement>): void => {
    const drag = dragRef.current;
    if (drag) {
      dragRef.current = null;
      setDraggingId(null);
      if (!drag.moved) {
        const node = nodeById.get(drag.id);
        if (node) onOpenNode?.(node);
      }
    }
    if (panRef.current) {
      panRef.current = null;
      setPanning(false);
    }
    const element = svgRef.current;
    if (element && element.hasPointerCapture?.(event.pointerId)) {
      element.releasePointerCapture(event.pointerId);
    }
  };

  const pageRange = graph ? graphPageRange(graph) : null;
  const crossSummary = crossEdgeSummary(graph);
  const totalNodes = graph?.totalNodes ?? 0;
  const shownNodes = filtered.nodes.length;
  // 只有全库超硬上限、服务端退回分批（hasMore/后续批次）时才显示分页；全量模式一屏装下时完全隐藏。
  const paged = Boolean(graph) && (Boolean(graph?.hasMore) || (graph?.offset ?? 0) > 0);
  const serverFilterActive = serverSideFilter && (kindsFiltered || appliedSearch.length > 0);
  const searchPlaceholder = '全库搜索节点名称';
  const kindTotalsText = `${KIND_LABELS.document} ${kindTotals.document} · ${KIND_LABELS.note} ${kindTotals.note} · ${KIND_LABELS.annotation} ${kindTotals.annotation}`;

  return (
    <section className="kr-graph" aria-label="引用关系图">
      <header className="kr-graph__head">
        <div className="kr-graph__filters" role="group" aria-label="关系图类型过滤">
          {KIND_ORDER.map((kind) => (
            <button
              key={kind}
              type="button"
              className={`kr-graph__filter kr-graph__filter--${kind}${
                visibleKinds[kind] ? ' is-active' : ''
              }`}
              aria-pressed={visibleKinds[kind]}
              onClick={() => toggleKind(kind)}
              title={`显示/隐藏${KIND_LABELS[kind]}节点${
                showKindCounts ? `（全库 ${kindTotals[kind]} 个）` : ''
              }`}
            >
              {KIND_LABELS[kind]}
              {showKindCounts ? (
                <span className="kr-graph__filter-count">{kindTotals[kind]}</span>
              ) : null}
            </button>
          ))}
        </div>
        <form
          className="kr-graph__search"
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            setAppliedSearch(searchText.trim());
          }}
        >
          <input
            type="search"
            value={searchText}
            placeholder={searchPlaceholder}
            aria-label="按节点名称搜索"
            onChange={(event) => setSearchText(event.target.value)}
          />
          {searchText ? (
            <button
              type="button"
              className="kr-graph__search-clear"
              title="清除关键字，恢复显示全部节点"
              onClick={clearSearch}
            >
              清除
            </button>
          ) : null}
        </form>
        <div className="kr-graph__meta">
          <span>
            {graph
              ? paged
                ? `第 ${pageRange?.start ?? 0}–${pageRange?.end ?? 0} 个 / 共 ${totalNodes} 个节点 · 本页 ${
                    filtered.edges.length
                  } 条引用`
                : `共 ${totalNodes} 个节点 / ${graph.totalEdges} 条引用`
              : ''}
            {graph && !paged && (kindsFiltered || appliedSearch.length > 0)
              ? ` · 当前显示 ${shownNodes} 个节点 / ${filtered.edges.length} 条引用`
              : ''}
            {crossSummary.total > 0 ? ` · 跨页引用 ${crossSummary.total} 条` : ''}
            {crossSummary.hidden > 0
              ? ` · 仅显示前 ${crossSummary.returned} 条，另有 ${crossSummary.hidden} 条未显示`
              : ''}
          </span>
          <button
            type="button"
            className="kr-graph__relayout"
            aria-pressed={showAllLabels}
            title={
              showAllLabels
                ? '只显示悬停节点的标签'
                : filtered.nodes.length > LABEL_ALL_MAX
                  ? `显示度数最高的前 ${LABEL_ALL_MAX} 个节点标签（自动避让重叠）`
                  : '显示所有节点的标签（自动避让重叠）'
            }
            onClick={() => setShowAllLabels((value) => !value)}
            disabled={shownNodes === 0}
          >
            {showAllLabels ? '隐藏全部标签' : '显示全部标签'}
          </button>
          <button
            type="button"
            className="kr-graph__relayout"
            title="恢复默认缩放并居中"
            onClick={resetView}
            disabled={shownNodes === 0}
          >
            重置视图
          </button>
          <button
            type="button"
            className="kr-graph__relayout"
            title="重新计算节点布局"
            onClick={relayout}
            disabled={shownNodes === 0}
          >
            重新布局
          </button>
        </div>
      </header>

      {graph && (fullNodeTotal > allNodeLimit || truncated) ? (
        <p className="kr-graph__notice" role="status">
          {serverFilterActive
            ? `已筛选出 ${totalNodes} / 全库 ${fullNodeTotal} 个节点${
                showKindCounts ? `（${kindTotalsText}）` : ''
              }。${
                totalNodes > allNodeLimit
                  ? `结果仍超过单次全量加载上限 ${allNodeLimit}，已退回分批查看；继续缩小筛选范围即可一次显示完整关系。`
                  : '当前筛选结果已回到全量显示，A 与 B/C/D 的引用关系一次画全。'
              }`
            : `关系过于庞大：全库 ${fullNodeTotal} 个节点${
                showKindCounts ? `（${kindTotalsText}）` : ''
              }，超过单次全量加载上限 ${allNodeLimit}，已自动退回分批查看。可用类型筛选或关键字搜索把范围缩小到 ${allNodeLimit} 个以内，缩小后会一次显示完整关系（不再有跨批缺失）。`}
        </p>
      ) : null}

      {paged ? (
        <div className="kr-graph__pagination" role="group" aria-label="超过全量上限，分批查看">
          <button
            type="button"
            onClick={() => onPageChange?.(Math.max(0, (graph?.offset ?? 0) - pageSize))}
            disabled={!pageRange?.hasPrev || !onPageChange}
            title="上一批节点"
          >
            上一批
          </button>
          <span className="kr-muted">
            超过全量加载上限，分批查看：第 {pageRange?.start ?? 0}–{pageRange?.end ?? 0} 个 / 共{' '}
            {totalNodes} 个节点
          </span>
          <button
            type="button"
            onClick={() => onPageChange?.((graph?.offset ?? 0) + pageSize)}
            disabled={!pageRange?.hasNext || !onPageChange}
            title="下一批节点"
          >
            下一批
          </button>
        </div>
      ) : null}

      {graph && graph.unresolved > 0 ? (
        <p className="kr-graph__warning" role="status">
          去重后 {graph.unresolved} 条悬空引用（指向已不存在的目标，已忽略这些边）。
        </p>
      ) : null}

      {error && graph ? (
        <p className="kr-page-error kr-graph__status" role="alert">
          更新关系图失败：{error}（下面是上一次结果）
        </p>
      ) : null}

      {loading && !graph ? (
        <p className="kr-muted kr-graph__status">正在读取引用关系…</p>
      ) : error && !graph ? (
        <p className="kr-page-error kr-graph__status" role="alert">
          读取关系图失败：{error}
          {onRetry ? (
            <button type="button" className="kr-link-button" onClick={onRetry}>
              重试
            </button>
          ) : null}
        </p>
      ) : shownNodes === 0 ? (
        <div className="kr-graph__empty">
          <p>
            {totalNodes === 0
              ? '还没有任何内部引用关系。'
              : '当前过滤条件下没有节点。'}
          </p>
          <p className="kr-muted">
            {kindsFiltered || appliedSearch.length > 0
              ? '试试重新勾选节点类型或清空搜索关键字。'
              : '在笔记或批注里用 [[内部引用]] 关联文献、笔记或批注后，这里会画出引用网络。'}
          </p>
        </div>
      ) : (
        <div className="kr-graph__canvas">
          {loading || layoutBusy ? (
            <p className="kr-graph__busy" role="status">
              {loading ? '正在更新关系图…' : '正在计算布局…'}
            </p>
          ) : null}
          <svg
            ref={svgRef}
            className={`kr-graph__svg${panning ? ' is-panning' : ''}${
              draggingId ? ' is-dragging-node' : ''
            }`}
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            role="img"
            aria-label={`引用关系图：当前显示 ${shownNodes} 个节点，${filtered.edges.length} 条引用`}
            aria-busy={loading || layoutBusy}
            onPointerDown={handleSvgPointerDown}
            onPointerMove={handleSvgPointerMove}
            onPointerUp={finishPointerInteraction}
            onPointerCancel={finishPointerInteraction}
            onPointerLeave={(event) => {
              if (panRef.current) finishPointerInteraction(event);
            }}
          >
            <defs>
              <marker
                id="kr-graph-arrow-out"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto"
              >
                <path className="kr-graph__arrow kr-graph__arrow--out" d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
              <marker
                id="kr-graph-arrow-in"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="7"
                markerHeight="7"
                orient="auto"
              >
                <path className="kr-graph__arrow kr-graph__arrow--in" d="M 0 0 L 10 5 L 0 10 z" />
              </marker>
            </defs>
            <g transform={`translate(${view.tx}, ${view.ty}) scale(${view.scale})`}>
              {crossStubs.length > 0 ? (
                <g className="kr-graph__cross-edges">
                  {crossStubs.map((stub) => {
                  const outward = stub.direction === 'out';
                  const startX = outward ? stub.x1 : stub.x2;
                  const startY = outward ? stub.y1 : stub.y2;
                  const endX = outward ? stub.x2 : stub.x1;
                  const endY = outward ? stub.y2 : stub.y1;
                  return (
                    <g
                      key={stub.key}
                      className={`kr-graph__cross-edge kr-graph__cross-edge--${stub.direction}`}
                      onMouseEnter={() => setGraphHover(stub.internalId)}
                      onMouseLeave={() => setGraphHover(null)}
                    >
                      <line
                        className="kr-graph__cross-line"
                        x1={startX}
                        y1={startY}
                        x2={endX}
                        y2={endY}
                        markerEnd={
                          outward ? 'url(#kr-graph-arrow-out)' : 'url(#kr-graph-arrow-in)'
                        }
                      />
                      <g
                        className="kr-graph__cross-label"
                        transform={`translate(${stub.labelX}, ${stub.labelY})`}
                      >
                        <rect
                          className="kr-graph__cross-label-bg"
                          width={labelWidth(stub.label)}
                          height={18}
                          rx={4}
                        />
                        <text className="kr-graph__cross-label-text" x={6} y={13}>
                          {truncateLabel(stub.label)}
                        </text>
                      </g>
                      <title>
                        {`跨页引用（${outward ? '出页' : '入页'}）：${
                          stub.label
                        } ↔ 当前页节点`}
                      </title>
                    </g>
                  );
                  })}
                </g>
              ) : null}
              <GraphEdgesLayer edges={filtered.edges} positionById={positionById} />
              <GraphNodesLayer
                nodes={filtered.nodes}
                positionById={positionById}
                draggingId={draggingId}
                canOpen={Boolean(onOpenNode)}
                onNodePointerDown={handleNodePointerDown}
                onNodeHover={setGraphHover}
                onNodeKeyDown={handleNodeKeyDown}
              />
              <g className="kr-graph__labels" aria-hidden="true">
                {[...labelsVisible.entries()].map(([nodeId, placement]) => {
                  const node = nodeById.get(nodeId);
                  if (!node) return null;
                  return (
                    <g
                      key={`label-${nodeId}`}
                      className="kr-graph__label-group"
                      transform={`translate(${placement.x}, ${placement.y})`}
                    >
                      <rect
                        className="kr-graph__label-bg"
                        width={placement.width}
                        height={placement.height}
                        rx={4}
                      />
                      <text
                        className="kr-graph__label"
                        x={7}
                        y={placement.height / 2 + 1}
                        dominantBaseline="middle"
                      >
                        {truncateLabel(node.label)}
                      </text>
                    </g>
                  );
                })}
              </g>
            </g>
          </svg>
          <p className="kr-graph__legend">
            <span className="kr-graph__legend-item kr-graph__legend-item--document">文献</span>
            <span className="kr-graph__legend-item kr-graph__legend-item--note">笔记</span>
            <span className="kr-graph__legend-item kr-graph__legend-item--annotation">批注</span>
            {crossStubs.length > 0 ? (
              <span className="kr-graph__legend-item kr-graph__legend-item--cross">
                虚线 = 跨页引用（实线箭头出页 / 虚线箭头入页）
              </span>
            ) : null}
            <span className="kr-muted">
              滚轮缩放（0.4–3x）· 拖拽空白平移 · 拖动节点调整位置 · 节点大小表示引用次数
            </span>
          </p>
        </div>
      )}
    </section>
  );
}
