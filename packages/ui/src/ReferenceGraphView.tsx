import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
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
  /** 当前页的关系图数据（含 totalNodes/totalEdges/offset/limit/hasMore）。 */
  graph: ReferenceGraph | null;
  loading?: boolean;
  error?: string;
  onRetry?(): void;
  /** 点击节点：document 打开文献；独立笔记切到笔记视图；文献笔记/批注打开文献页。 */
  onOpenNode?(node: ReferenceGraphNode): void;
  /** 每页节点数（默认 120），与 app 请求参数保持一致。 */
  limit?: number;
  /** 切换分页：传入新的 offset（0-based）。 */
  onPageChange?(offset: number): void;
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
const DEFAULT_PAGE_SIZE = 120;
const MIN_SCALE = 0.4;
const MAX_SCALE = 3;
/** 节点拖动超过该屏幕像素距离就算拖动，不触发打开。 */
const DRAG_THRESHOLD_PX = 4;
/** 节点数不超过该值时默认显示全部标签。 */
const LABEL_ALL_THRESHOLD = 30;

const KIND_LABELS: Record<ReferenceNodeKind, string> = {
  document: '文献',
  note: '笔记',
  annotation: '批注'
};

const KIND_ORDER: ReferenceNodeKind[] = ['document', 'note', 'annotation'];

export const INITIAL_GRAPH_VIEW: GraphViewTransform = { scale: 1, tx: 0, ty: 0 };

/** 过滤节点/边（边两端都可见才保留）。纯函数，便于测试。 */
export function filterReferenceGraph(
  graph: ReferenceGraph,
  kinds: ReferenceKindFilter
): { nodes: ReferenceGraphNode[]; edges: ReferenceGraphEdge[] } {
  const nodes = graph.nodes.filter((node) => kinds[node.kind]);
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

/**
 * 简单力导向布局（斥力 + 弹簧 + 向心），纯函数、确定性（由 seed 决定初始扰动）。
 *
 * 不引入图形库；节点较多时限制迭代次数，避免阻塞主线程。
 */
export function computeGraphLayout(
  graph: ReferenceGraph,
  options?: { width?: number; height?: number; seed?: number }
): GraphLayoutNode[] {
  const width = options?.width ?? VIEW_WIDTH;
  const height = options?.height ?? VIEW_HEIGHT;
  const seed = options?.seed ?? 1;
  const nodes = graph.nodes;
  if (nodes.length === 0) return [];
  const random = mulberry32(seed);
  const indexById = new Map(nodes.map((node, index) => [node.id, index]));
  const edges = graph.edges.filter(
    (edge) => indexById.has(edge.from) && indexById.has(edge.to) && edge.from !== edge.to
  );
  const degree = new Map<string, number>(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }

  const centerX = width / 2;
  const centerY = height / 2;
  const spreadX = (width - VIEW_MARGIN * 2) / 2;
  const spreadY = (height - VIEW_MARGIN * 2) / 2;
  const rotation = random() * Math.PI * 2;
  const positions = nodes.map((node, index) => {
    const angle = rotation + (index / nodes.length) * Math.PI * 2;
    const radius = 0.5 + random() * 0.35;
    return {
      id: node.id,
      x: centerX + Math.cos(angle) * spreadX * radius,
      y: centerY + Math.sin(angle) * spreadY * radius,
      vx: 0,
      vy: 0
    };
  });
  const positionById = new Map(positions.map((position) => [position.id, position]));
  const iterations = nodes.length > 220 ? 70 : 150;
  const repulsion = 5200;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const forceX = new Map<string, number>(positions.map((item) => [item.id, 0]));
    const forceY = new Map<string, number>(positions.map((item) => [item.id, 0]));
    // 节点间斥力
    for (let i = 0; i < positions.length; i += 1) {
      const left = positions[i]!;
      for (let j = i + 1; j < positions.length; j += 1) {
        const right = positions[j]!;
        let dx = left.x - right.x;
        let dy = left.y - right.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.5) {
          dx = random() - 0.5;
          dy = random() - 0.5;
          distance = 0.5;
        }
        const force = Math.min(24, repulsion / (distance * distance));
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        forceX.set(left.id, (forceX.get(left.id) ?? 0) + fx);
        forceY.set(left.id, (forceY.get(left.id) ?? 0) + fy);
        forceX.set(right.id, (forceX.get(right.id) ?? 0) - fx);
        forceY.set(right.id, (forceY.get(right.id) ?? 0) - fy);
      }
    }
    // 边的弹簧力
    for (const edge of edges) {
      const from = positionById.get(edge.from);
      const to = positionById.get(edge.to);
      if (!from || !to) continue;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const distance = Math.max(1, Math.hypot(dx, dy));
      const spring = (distance - 120) * 0.012;
      const fx = (dx / distance) * spring;
      const fy = (dy / distance) * spring;
      forceX.set(from.id, (forceX.get(from.id) ?? 0) + fx);
      forceY.set(from.id, (forceY.get(from.id) ?? 0) + fy);
      forceX.set(to.id, (forceX.get(to.id) ?? 0) - fx);
      forceY.set(to.id, (forceY.get(to.id) ?? 0) - fy);
    }
    // 向心 + 位置更新
    for (const item of positions) {
      const centerPullX = (centerX - item.x) * 0.004;
      const centerPullY = (centerY - item.y) * 0.004;
      item.vx = (item.vx + (forceX.get(item.id) ?? 0) * 0.06 + centerPullX) * 0.82;
      item.vy = (item.vy + (forceY.get(item.id) ?? 0) * 0.06 + centerPullY) * 0.82;
      item.x = Math.min(width - VIEW_MARGIN, Math.max(VIEW_MARGIN, item.x + item.vx));
      item.y = Math.min(height - VIEW_MARGIN, Math.max(VIEW_MARGIN, item.y + item.vy));
    }
  }

  return positions.map((item) => ({
    id: item.id,
    x: Math.round(item.x),
    y: Math.round(item.y),
    degree: degree.get(item.id) ?? 0,
    radius: 7 + Math.min(9, (degree.get(item.id) ?? 0) * 1.1)
  }));
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
 */
export function placeVisibleLabels(
  nodes: ReferenceGraphNode[],
  positions: GraphLayoutNode[],
  showAll: boolean,
  hoveredId: string | null
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
  for (const node of ordered) {
    if (node.id === hoveredId) continue;
    const position = positionById.get(node.id);
    if (!position) continue;
    const placement = choosePlacement(node.label, position, placed, circleNodes);
    if (!placement) continue;
    placements.set(node.id, placement);
    placed.push({ id: node.id, ...placement });
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

/** 全库引用关系图视图：分页、缩放/平移、节点拖拽、标签防重叠、节点点击导航。 */
export function ReferenceGraphView({
  graph,
  loading = false,
  error = '',
  onRetry,
  onOpenNode,
  limit,
  onPageChange
}: ReferenceGraphViewProps): React.JSX.Element {
  const [visibleKinds, setVisibleKinds] = useState<ReferenceKindFilter>({
    document: true,
    note: true,
    annotation: true
  });
  const [seed, setSeed] = useState(1);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [showAllLabels, setShowAllLabels] = useState(false);
  const [view, setView] = useState<GraphViewTransform>(INITIAL_GRAPH_VIEW);
  // 初值直接用当前页算一次布局，保证首帧/SSR 就有节点；后续布局变化由 effect 同步。
  const [positions, setPositions] = useState<GraphLayoutNode[]>(() =>
    graph ? computeGraphLayout({ ...graph, edges: graph.edges }, { seed: 1 }) : []
  );
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

  const filtered = useMemo(
    () => (graph ? filterReferenceGraph(graph, visibleKinds) : { nodes: [], edges: [] }),
    [graph, visibleKinds]
  );

  const layout = useMemo(() => {
    if (!graph) return [];
    return computeGraphLayout(
      { ...graph, nodes: filtered.nodes, edges: filtered.edges },
      { seed }
    );
    // 只依赖当前页数据/过滤/seed；hover、缩放、平移都不会重算布局。
  }, [graph, filtered, seed]);

  // 布局变化（切页/切 seed/过滤）时重置节点位置，并清掉拖拽上下文。
  useEffect(() => {
    setPositions(layout);
    dragRef.current = null;
    setDraggingId(null);
  }, [layout]);

  // 切页时重置视图（缩放/平移），并重新布局（layout 已随之变化）。
  useEffect(() => {
    setView(INITIAL_GRAPH_VIEW);
    setHoveredId(null);
  }, [graph?.offset, graph?.limit]);

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
  const adjacent = useMemo(() => {
    if (!hoveredId) return new Set<string>();
    const ids = new Set<string>([hoveredId]);
    for (const edge of filtered.edges) {
      if (edge.from === hoveredId) ids.add(edge.to);
      if (edge.to === hoveredId) ids.add(edge.from);
    }
    return ids;
  }, [filtered.edges, hoveredId]);

  const labelsVisible = useMemo(
    () =>
      placeVisibleLabels(
        filtered.nodes,
        positions,
        showAllLabels || filtered.nodes.length <= LABEL_ALL_THRESHOLD,
        hoveredId
      ),
    [filtered.nodes, positions, showAllLabels, hoveredId]
  );

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
    setHoveredId(null);
  };

  const toggleKind = (kind: ReferenceNodeKind): void => {
    setVisibleKinds((current) => ({ ...current, [kind]: !current[kind] }));
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

  const handleNodePointerDown = (
    event: React.PointerEvent<SVGGElement>,
    node: ReferenceGraphNode
  ): void => {
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
  };

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
              title={`显示/隐藏${KIND_LABELS[kind]}节点`}
            >
              {KIND_LABELS[kind]}
            </button>
          ))}
        </div>
        <div className="kr-graph__meta">
          <span>
            第 {pageRange && pageRange.total > 0 ? `${pageRange.start}–${pageRange.end}` : '0'} / 共{' '}
            {totalNodes} 个节点
            {graph ? ` · 本页 ${shownNodes} 个节点 / ${filtered.edges.length} 条引用` : ''}
            {crossSummary.total > 0 ? ` · 跨页引用 ${crossSummary.total} 条` : ''}
            {crossSummary.hidden > 0
              ? ` · 仅显示前 ${crossSummary.returned} 条，另有 ${crossSummary.hidden} 条未显示`
              : ''}
          </span>
          <button
            type="button"
            className="kr-graph__relayout"
            aria-pressed={showAllLabels}
            title={showAllLabels ? '只显示悬停节点的标签' : '显示所有节点的标签（自动避让重叠）'}
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

      {graph && totalNodes > 0 ? (
        <div className="kr-graph__pagination" role="group" aria-label="关系图分页">
          <button
            type="button"
            onClick={() => onPageChange?.(Math.max(0, (graph.offset ?? 0) - pageSize))}
            disabled={!pageRange?.hasPrev || !onPageChange}
            title="上一页"
          >
            上一页
          </button>
          <span className="kr-muted">
            {pageRange && pageRange.total > 0
              ? `第 ${pageRange.start}–${pageRange.end} / 共 ${pageRange.total} 个节点`
              : '共 0 个节点'}
          </span>
          <button
            type="button"
            onClick={() => onPageChange?.((graph.offset ?? 0) + pageSize)}
            disabled={!pageRange?.hasNext || !onPageChange}
            title="下一页"
          >
            下一页
          </button>
        </div>
      ) : null}

      {graph && graph.unresolved > 0 ? (
        <p className="kr-graph__warning" role="status">
          去重后 {graph.unresolved} 条悬空引用（指向已不存在的目标，已忽略这些边）。
        </p>
      ) : null}

      {loading ? (
        <p className="kr-muted kr-graph__status">正在读取引用关系…</p>
      ) : error ? (
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
            在笔记或批注里用 [[内部引用]] 关联文献、笔记或批注后，这里会画出引用网络。
          </p>
        </div>
      ) : (
        <div className="kr-graph__canvas">
          <svg
            ref={svgRef}
            className={`kr-graph__svg${panning ? ' is-panning' : ''}${
              draggingId ? ' is-dragging-node' : ''
            }`}
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            role="img"
            aria-label={`引用关系图：当前页 ${shownNodes} 个节点，${filtered.edges.length} 条引用`}
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
                      onMouseEnter={() => setHoveredId(stub.internalId)}
                      onMouseLeave={() => setHoveredId(null)}
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
              <g className="kr-graph__edges">
                {filtered.edges.map((edge, index) => {
                  const from = positionById.get(edge.from);
                  const to = positionById.get(edge.to);
                  if (!from || !to) return null;
                  const active =
                    Boolean(hoveredId) && adjacent.has(edge.from) && adjacent.has(edge.to);
                  const dimmed = Boolean(hoveredId) && !active;
                  return (
                    <line
                      key={`${edge.from}->${edge.to}-${index}`}
                      className={`kr-graph__edge${active ? ' is-active' : ''}${
                        dimmed ? ' is-dimmed' : ''
                      }`}
                      x1={from.x}
                      y1={from.y}
                      x2={to.x}
                      y2={to.y}
                    />
                  );
                })}
              </g>
              <g className="kr-graph__nodes">
                {filtered.nodes.map((node) => {
                  const position = positionById.get(node.id);
                  if (!position) return null;
                  const isHovered = hoveredId === node.id;
                  const isDimmed = Boolean(hoveredId) && !adjacent.has(node.id);
                  const canOpen = Boolean(onOpenNode);
                  const titleText = `${KIND_LABELS[node.kind]} · ${node.label}${
                    node.page ? ` · 第 ${node.page} 页` : ''
                  }${node.kind === 'note' && !node.documentId ? ' · 独立笔记' : ''}`;
                  return (
                    <g
                      key={node.id}
                      className={`kr-graph__node kr-graph__node--${node.kind}${
                        isHovered ? ' is-hovered' : ''
                      }${isDimmed ? ' is-dimmed' : ''}${
                        draggingId === node.id ? ' is-dragging' : ''
                      }`}
                      role={canOpen ? 'button' : undefined}
                      tabIndex={canOpen ? 0 : undefined}
                      aria-label={titleText}
                      transform={`translate(${position.x}, ${position.y})`}
                      onPointerDown={(event) => handleNodePointerDown(event, node)}
                      onMouseEnter={() => setHoveredId(node.id)}
                      onMouseLeave={() => setHoveredId(null)}
                      onFocus={() => setHoveredId(node.id)}
                      onBlur={() => setHoveredId(null)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          onOpenNode?.(node);
                        }
                      }}
                    >
                      <circle className="kr-graph__circle" r={position.radius} />
                      <title>{titleText}</title>
                    </g>
                  );
                })}
              </g>
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
