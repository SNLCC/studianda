export { getAppPortalRoot, setAppPortalRoot } from './portal-root.js';
export {
  ASSET_SOURCE_ATTRIBUTE,
  resolveAssetUrl,
  setAssetUrlResolver,
  type AssetUrlResolver
} from './asset-url.js';
export {
  getHostRoot,
  isEventInHostScope,
  onHostKeyDown,
  setHostRoot
} from './host-scope.js';
export { StructurePanel, type StructurePanelProps } from './StructurePanel.js';
export { HealthCard, type HealthCardProps, type HealthState } from './HealthCard.js';
export { BrandMark } from './BrandMark.js';
export {
  DocumentList,
  type DocumentListProps,
  type DocumentReorderTarget,
  type LibrarySort,
  type LibraryView
} from './DocumentList.js';
export {
  LibraryFilters,
  type LibraryCategoryFilter,
  type LibraryFiltersProps,
  type LibraryTypeFilterOption
} from './LibraryFilters.js';
export {
  ASSET_URL_PREFIX,
  MarkdownContent,
  isNoteAssetUrl,
  type MarkdownContentProps
} from './MarkdownContent.js';
export {
  MarkdownEditor,
  resolveImageSource,
  type MarkdownEditorProps,
  type MarkdownImageUpload
} from './MarkdownEditor.js';
export {
  htmlToMarkdown,
  escapeHtmlAttribute,
  escapeHtmlText,
  escapeMarkdownText,
  normalizeCssColor
} from './markdown-serializer.js';
export {
  ReferenceGraphView,
  ALL_KINDS_VISIBLE,
  INITIAL_GRAPH_VIEW,
  activeReferenceKinds,
  clampGraphScale,
  clampNodePosition,
  computeCrossEdgeStubs,
  computeGraphLayout,
  crossEdgeSummary,
  filterReferenceGraph,
  graphAllNodeLimit,
  graphFullNodeTotal,
  graphKindTotals,
  graphPageRange,
  moveGraphNode,
  needsServerSideFilter,
  placeVisibleLabels,
  selectVisibleLabelIds,
  zoomViewAt,
  type CrossEdgeStub,
  type GraphLayoutNode,
  type GraphViewTransform,
  type LabelDirection,
  type LabelPlacement,
  type ReferenceGraphViewProps,
  type ReferenceKindFilter
} from './ReferenceGraphView.js';
export {
  buildStandaloneFolderTree,
  collectFolderNotes,
  collectFolderPaths,
  filterStandaloneFolderTree,
  filterStandaloneNotesByTags,
  type StandaloneFolder
} from './standalone-folders.js';
export {
  MarkdownImportDialog,
  markdownImportPercent,
  markdownImportPhaseLabel,
  markdownImportStaleHint,
  type MarkdownImportDialogProps
} from './MarkdownImportDialog.js';
export { MarkdownScanTree, type MarkdownScanTreeProps } from './MarkdownScanTree.js';
export {
  computeVirtualWindow,
  emptySelection,
  fileChecked,
  filterMissingPathsForWarning,
  flattenMarkdownTree,
  folderCheckState,
  isReportMissingError,
  isScanTreeUnavailableError,
  selectAll,
  toSelectionInput,
  toggleFileSelection,
  toggleFolderSelection,
  type MarkdownLazyRow,
  type VirtualWindow
} from './markdown-virtual.js';
export {
  allMarkdownPaths,
  buildMarkdownTree,
  countSelectedFiles,
  filterMarkdownTree,
  folderSelectionState,
  setFolderSelected,
  type MarkdownSelectionState,
  type MarkdownTreeFile,
  type MarkdownTreeFolder,
  type MarkdownTreeNode
} from './markdown-tree.js';
export { Backlinks, type BacklinkTarget, type BacklinksProps } from './Backlinks.js';
export {
  PURGE_ANNOTATION_CONFIRM_TEXT,
  PURGE_NOTE_CONFIRM_TEXT,
  confirmPurgeAnnotation,
  confirmPurgeNote
} from './note-purge.js';
export {
  STANDALONE_SIDEBAR_COLLAPSED_KEY,
  STATUS_POLL_MAX_RETRIES,
  StandaloneNotesView,
  folderOptionToPath,
  isMarkdownJobTerminal,
  isMarkdownResultMissing,
  mergeLiteMarkdownJob,
  orderFolderTreeNotes,
  readStandaloneSidebarCollapsed,
  renameNoteFirstLine,
  reorderNoteIds,
  standaloneNoteTitle,
  standaloneNoteTitleRaw,
  filterStandaloneNotes,
  markdownJobStaleHint,
  statusPollRetryDelayMs,
  writeStandaloneSidebarCollapsed,
  type StandaloneNotesViewProps
} from './StandaloneNotesView.js';
export {
  planTableEdit,
  type TableEditAction,
  type TableEditPlan,
  type TableEditState
} from './table-editor.js';
export { AnnotationPanel, type AnnotationPanelProps } from './AnnotationPanel.js';
export { NotesPanel, type NotesPanelProps } from './NotesPanel.js';
export {
  ChatPanel,
  type ChatAskOptions,
  type ChatPanelProps,
  type ChatMessageView
} from './ChatPanel.js';
export { TranslationPanel, type TranslationPanelProps } from './TranslationPanel.js';
export {
  TranslationLayoutView,
  type TranslationLayoutViewProps
} from './TranslationLayoutView.js';
export { ReferencePanel, type ReferencePanelProps } from './ReferencePanel.js';
export {
  OutlinePanel,
  type OutlinePanelProps,
  type OutlineDraftEntry,
  type OutlineNodeView
} from './OutlinePanel.js';
