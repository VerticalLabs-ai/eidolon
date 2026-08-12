// ---------------------------------------------------------------------------
// Revision diff service (M2 — Artifact Intelligence & Discovery)
// ---------------------------------------------------------------------------
//
// Computes a structured `DiffResult` between two artifact revision snapshots.
// The diff logic is pure (in-memory comparison of two decrypted JSONB
// payloads) and dispatches by artifact type:
//
//   • document  — line-level text diff via the `diff` npm package (diffLines)
//   • sheet     — column + row changes with cell-level value deltas
//   • board     — card changes (added/removed/moved/modified)
//   • slide_deck— slide-level (added/removed/reordered) + block-level deltas
//   • timeline  — task changes with field-level deltas (start/end/dependsOn/progress)
//   • gallery   — item changes with url/caption deltas
//   • dashboard — data source + widget changes
//   • app/code  — file-level changes + line diff within modified files
//
// All diff results share a common `summary: { additions, deletions, modifications }`.
// The summary counts are consistent with the type-specific payload.
//
// The service is a pure function: it accepts the artifact type + the two
// decrypted content snapshots and returns a `DiffResult`. Loading the
// revisions (with company scoping + 404 handling) is the route's job.
// ---------------------------------------------------------------------------

import { diffLines } from 'diff';
import type { ChangeObject } from 'diff';
import { ArtifactTypeSchema } from '@eidolon/shared';
import type { z } from 'zod';
import type {
  DiffResult,
  DiffSummary,
  LineDiff,
  LineDiffResult,
  SheetDiffResult,
  SheetColumnChange,
  SheetRowChange,
  SheetCellDelta,
  BoardDiffResult,
  BoardCardChange,
  SlidesDiffResult,
  SlideChange,
  SlideBlockDelta,
  TimelineDiffResult,
  TimelineTaskChange,
  GalleryDiffResult,
  GalleryItemChange,
  DashboardDiffResult,
  DashboardDataSourceChange,
  DashboardWidgetChange,
  FileDiffResult,
  FileChange,
} from '@eidolon/shared';

type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split a multi-line `value` (which may contain several lines joined by
 * `diffLines` into a single change object) into individual line content
 * strings, stripping trailing newlines.
 */
function splitLineValues(value: string): string[] {
  // diffLines groups consecutive same-type lines into one change object
  // whose `value` is the concatenation (with trailing newlines). Split on
  // newlines, dropping the empty trailing element from the final newline.
  const lines = value.split('\n');
  // If the value ends with \n, the split produces a trailing '' — drop it.
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines;
}

/** Deep-equal for JSON-serializable values (content snapshots are JSONB). */
function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Compute field-level deltas between two records. Returns one entry per
 * field that changed (present in both but different, or added/removed).
 * Fields are compared by key set union.
 */
function fieldDeltas(
  from: Record<string, unknown>,
  to: Record<string, unknown>,
  fields?: string[],
): Array<{ field: string; from: unknown; to: unknown }> {
  const keys = fields ?? Array.from(new Set([...Object.keys(from), ...Object.keys(to)]));
  const deltas: Array<{ field: string; from: unknown; to: unknown }> = [];
  for (const key of keys) {
    const fromVal = from[key];
    const toVal = to[key];
    if (!jsonEqual(fromVal, toVal)) {
      deltas.push({ field: key, from: fromVal, to: toVal });
    }
  }
  return deltas;
}

/** Index an array of records by their `id` field. */
function indexById<T extends { id: string }>(arr: T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of arr) map.set(item.id, item);
  return map;
}

// ---------------------------------------------------------------------------
// Document diff (line-level via `diff` npm package)
// ---------------------------------------------------------------------------

/**
 * Extract the body text from a document content snapshot. Documents use
 * either markdown (string body) or delta (array of blocks) format. For
 * delta format, we join block text fields into a single string so line
 * diffing still works.
 */
function documentBodyText(content: Record<string, unknown>): string {
  if (typeof content.body === 'string') return content.body;
  if (Array.isArray(content.body)) {
    // Delta format: extract text from each block's content.text field.
    return content.body
      .map((block: unknown) => {
        if (typeof block === 'object' && block !== null) {
          const b = block as Record<string, unknown>;
          if (typeof b.content === 'object' && b.content !== null) {
            const c = b.content as Record<string, unknown>;
            if (typeof c.text === 'string') return c.text;
          }
          if (typeof b.text === 'string') return b.text;
        }
        return '';
      })
      .join('\n');
  }
  return '';
}

/**
 * Convert the raw `diffLines` change objects into our `LineDiff[]` format,
 * assigning 1-based line numbers. Added lines are numbered in the `to`
 * revision; removed lines in the `from` revision; unchanged lines share
 * the same number in both.
 */
function changesToLineDiffs(changes: ChangeObject<string>[]): LineDiff[] {
  const lines: LineDiff[] = [];
  let fromLine = 1;
  let toLine = 1;
  for (const change of changes) {
    const lineValues = splitLineValues(change.value);
    for (const content of lineValues) {
      if (change.added) {
        lines.push({ type: 'added', content, lineNumber: toLine });
        toLine += 1;
      } else if (change.removed) {
        lines.push({ type: 'removed', content, lineNumber: fromLine });
        fromLine += 1;
      } else {
        lines.push({ type: 'unchanged', content, lineNumber: fromLine });
        fromLine += 1;
        toLine += 1;
      }
    }
  }
  return lines;
}

function diffDocument(
  fromContent: Record<string, unknown>,
  toContent: Record<string, unknown>,
): { result: LineDiffResult; summary: DiffSummary } {
  const fromText = documentBodyText(fromContent);
  const toText = documentBodyText(toContent);
  const changes = diffLines(fromText, toText);
  const lines = changesToLineDiffs(changes);
  const additions = lines.filter((l) => l.type === 'added').length;
  const deletions = lines.filter((l) => l.type === 'removed').length;
  return {
    result: { lines },
    summary: { additions, deletions, modifications: 0 },
  };
}

// ---------------------------------------------------------------------------
// Sheet diff (cell-level)
// ---------------------------------------------------------------------------

function diffSheet(
  fromContent: Record<string, unknown>,
  toContent: Record<string, unknown>,
): { result: SheetDiffResult; summary: DiffSummary } {
  const fromColumns = (fromContent.columns as Array<{ id: string; key: string; width?: number }> | undefined) ?? [];
  const toColumns = (toContent.columns as Array<{ id: string; key: string; width?: number }> | undefined) ?? [];
  const fromRows = (fromContent.rows as Array<{ id: string; cells: Record<string, { value: unknown }> }> | undefined) ?? [];
  const toRows = (toContent.rows as Array<{ id: string; cells: Record<string, { value: unknown }> }> | undefined) ?? [];

  // Column changes
  const fromColMap = indexById(fromColumns);
  const toColMap = indexById(toColumns);
  const columnChanges: SheetColumnChange[] = [];

  // Removed columns (in from not in to) — preserve from-order
  for (const col of fromColumns) {
    if (!toColMap.has(col.id)) {
      columnChanges.push({ type: 'removed', column: col });
    }
  }
  // Added columns (in to not in from) — preserve to-order
  for (const col of toColumns) {
    if (!fromColMap.has(col.id)) {
      columnChanges.push({ type: 'added', column: col });
    }
  }
  // Modified columns (in both but changed)
  for (const col of toColumns) {
    const fromCol = fromColMap.get(col.id);
    if (fromCol) {
      const changes = fieldDeltas(fromCol as Record<string, unknown>, col as Record<string, unknown>);
      if (changes.length > 0) {
        columnChanges.push({ type: 'modified', columnId: col.id, changes });
      }
    }
  }

  // Row changes
  const fromRowMap = indexById(fromRows);
  const toRowMap = indexById(toRows);
  const rowChanges: SheetRowChange[] = [];

  // Removed rows (in from not in to) — preserve from-order + index
  fromRows.forEach((row, index) => {
    if (!toRowMap.has(row.id)) {
      rowChanges.push({ type: 'removed', row, index });
    }
  });
  // Added rows (in to not in from) — preserve to-order + index
  toRows.forEach((row, index) => {
    if (!fromRowMap.has(row.id)) {
      rowChanges.push({ type: 'added', row, index });
    }
  });
  // Modified rows (in both but cells changed)
  for (const row of toRows) {
    const fromRow = fromRowMap.get(row.id);
    if (fromRow) {
      const fromCells = fromRow.cells ?? {};
      const toCells = row.cells ?? {};
      const allKeys = Array.from(new Set([...Object.keys(fromCells), ...Object.keys(toCells)]));
      const cellDeltas: SheetCellDelta[] = [];
      for (const key of allKeys) {
        const fromVal = fromCells[key]?.value;
        const toVal = toCells[key]?.value;
        if (!jsonEqual(fromVal, toVal)) {
          cellDeltas.push({ columnKey: key, from: fromVal, to: toVal });
        }
      }
      if (cellDeltas.length > 0) {
        rowChanges.push({ type: 'modified', rowId: row.id, cellDeltas });
      }
    }
  }

  const additions = columnChanges.filter((c) => c.type === 'added').length + rowChanges.filter((r) => r.type === 'added').length;
  const deletions = columnChanges.filter((c) => c.type === 'removed').length + rowChanges.filter((r) => r.type === 'removed').length;
  const modifications = columnChanges.filter((c) => c.type === 'modified').length + rowChanges.filter((r) => r.type === 'modified').length;

  return {
    result: { columnChanges, rowChanges },
    summary: { additions, deletions, modifications },
  };
}

// ---------------------------------------------------------------------------
// Board diff (card-level)
// ---------------------------------------------------------------------------

function diffBoard(
  fromContent: Record<string, unknown>,
  toContent: Record<string, unknown>,
): { result: BoardDiffResult; summary: DiffSummary } {
  const fromCards = (fromContent.cards as Array<{ id: string; columnId: string; title: string; order: number; payload?: Record<string, unknown> }> | undefined) ?? [];
  const toCards = (toContent.cards as Array<{ id: string; columnId: string; title: string; order: number; payload?: Record<string, unknown> }> | undefined) ?? [];

  const fromMap = indexById(fromCards);
  const toMap = indexById(toCards);
  const cardChanges: BoardCardChange[] = [];

  // Removed cards (in from not in to)
  for (const card of fromCards) {
    if (!toMap.has(card.id)) {
      cardChanges.push({ type: 'removed', card });
    }
  }
  // Added cards (in to not in from)
  for (const card of toCards) {
    if (!fromMap.has(card.id)) {
      cardChanges.push({ type: 'added', card });
    }
  }
  // Cards in both: classify as moved or modified
  for (const card of toCards) {
    const fromCard = fromMap.get(card.id);
    if (fromCard) {
      const positionChanged = fromCard.columnId !== card.columnId || fromCard.order !== card.order;
      // Compare all fields except position to detect content modification
      const fromContentFields: Record<string, unknown> = { ...fromCard };
      delete fromContentFields.columnId;
      delete fromContentFields.order;
      const toContentFields: Record<string, unknown> = { ...card };
      delete toContentFields.columnId;
      delete toContentFields.order;
      const contentChanged = !jsonEqual(fromContentFields, toContentFields);

      if (positionChanged && !contentChanged) {
        // Pure move
        cardChanges.push({ type: 'moved', cardId: card.id, from: fromCard, to: card });
      } else if (contentChanged) {
        // Modified (may also include position change)
        const changes = fieldDeltas(fromCard as Record<string, unknown>, card as Record<string, unknown>);
        cardChanges.push({ type: 'modified', cardId: card.id, changes });
      }
      // If neither position nor content changed, no change entry
    }
  }

  const additions = cardChanges.filter((c) => c.type === 'added').length;
  const deletions = cardChanges.filter((c) => c.type === 'removed').length;
  const modifications = cardChanges.filter((c) => c.type === 'moved' || c.type === 'modified').length;

  return {
    result: { cardChanges },
    summary: { additions, deletions, modifications },
  };
}

// ---------------------------------------------------------------------------
// Slides diff (slide + block level)
// ---------------------------------------------------------------------------

function diffSlides(
  fromContent: Record<string, unknown>,
  toContent: Record<string, unknown>,
): { result: SlidesDiffResult; summary: DiffSummary } {
  const fromSlides = (fromContent.slides as Array<{ id: string; layout: string; blocks: Array<Record<string, unknown>> }> | undefined) ?? [];
  const toSlides = (toContent.slides as Array<{ id: string; layout: string; blocks: Array<Record<string, unknown>> }> | undefined) ?? [];

  const fromMap = indexById(fromSlides);
  const toMap = indexById(toSlides);
  const slideChanges: SlideChange[] = [];

  // Removed slides (in from not in to) — preserve from-order + index
  fromSlides.forEach((slide, index) => {
    if (!toMap.has(slide.id)) {
      slideChanges.push({ type: 'removed', slide, index });
    }
  });
  // Added slides (in to not in from) — preserve to-order + index
  toSlides.forEach((slide, index) => {
    if (!fromMap.has(slide.id)) {
      slideChanges.push({ type: 'added', slide, index });
    }
  });
  // Slides in both: check reorder + block-level deltas
  toSlides.forEach((toSlide, toIndex) => {
    const fromSlide = fromMap.get(toSlide.id);
    if (fromSlide) {
      const fromIndex = fromSlides.findIndex((s) => s.id === toSlide.id);
      const fromBlocks = fromSlide.blocks ?? [];
      const toBlocks = toSlide.blocks ?? [];

      // Check if blocks changed
      const fromBlockMap = new Map<string, number>();
      fromBlocks.forEach((b, i) => {
        // Blocks don't have ids; use index as key
        fromBlockMap.set(String(i), i);
      });

      const blockDeltas: SlideBlockDelta[] = [];
      // Simple block comparison by index (blocks are ordered)
      const maxBlocks = Math.max(fromBlocks.length, toBlocks.length);
      for (let i = 0; i < maxBlocks; i++) {
        const fromBlock = fromBlocks[i];
        const toBlock = toBlocks[i];
        if (fromBlock === undefined && toBlock !== undefined) {
          blockDeltas.push({ type: 'added', block: toBlock, index: i });
        } else if (fromBlock !== undefined && toBlock === undefined) {
          blockDeltas.push({ type: 'removed', block: fromBlock, index: i });
        } else if (fromBlock !== undefined && toBlock !== undefined && !jsonEqual(fromBlock, toBlock)) {
          const changes = fieldDeltas(fromBlock, toBlock);
          blockDeltas.push({ type: 'modified', blockIndex: i, changes });
        }
      }

      const reordered = fromIndex !== toIndex;
      const blocksChanged = blockDeltas.length > 0;

      if (reordered && !blocksChanged) {
        slideChanges.push({ type: 'reordered', slideId: toSlide.id, fromIndex, toIndex });
      } else if (blocksChanged) {
        slideChanges.push({ type: 'modified', slideId: toSlide.id, blockDeltas });
      }
    }
  });

  const additions = slideChanges.filter((s) => s.type === 'added').length;
  const deletions = slideChanges.filter((s) => s.type === 'removed').length;
  const modifications = slideChanges.filter((s) => s.type === 'modified' || s.type === 'reordered').length;

  return {
    result: { slideChanges },
    summary: { additions, deletions, modifications },
  };
}

// ---------------------------------------------------------------------------
// Timeline diff (task-level)
// ---------------------------------------------------------------------------

function diffTimeline(
  fromContent: Record<string, unknown>,
  toContent: Record<string, unknown>,
): { result: TimelineDiffResult; summary: DiffSummary } {
  const fromTasks = (fromContent.tasks as Array<{ id: string; title: string; start: string; end: string; dependsOn?: string[]; progress?: number }> | undefined) ?? [];
  const toTasks = (toContent.tasks as Array<{ id: string; title: string; start: string; end: string; dependsOn?: string[]; progress?: number }> | undefined) ?? [];

  const fromMap = indexById(fromTasks);
  const toMap = indexById(toTasks);
  const taskChanges: TimelineTaskChange[] = [];

  // Removed tasks (in from not in to)
  for (const task of fromTasks) {
    if (!toMap.has(task.id)) {
      taskChanges.push({ type: 'removed', task });
    }
  }
  // Added tasks (in to not in from)
  for (const task of toTasks) {
    if (!fromMap.has(task.id)) {
      taskChanges.push({ type: 'added', task });
    }
  }
  // Modified tasks (in both but changed)
  for (const task of toTasks) {
    const fromTask = fromMap.get(task.id);
    if (fromTask) {
      const deltas = fieldDeltas(
        fromTask as Record<string, unknown>,
        task as Record<string, unknown>,
        ['title', 'start', 'end', 'dependsOn', 'progress'],
      );
      if (deltas.length > 0) {
        taskChanges.push({ type: 'modified', taskId: task.id, fieldDeltas: deltas });
      }
    }
  }

  const additions = taskChanges.filter((t) => t.type === 'added').length;
  const deletions = taskChanges.filter((t) => t.type === 'removed').length;
  const modifications = taskChanges.filter((t) => t.type === 'modified').length;

  return {
    result: { taskChanges },
    summary: { additions, deletions, modifications },
  };
}

// ---------------------------------------------------------------------------
// Gallery diff (item-level)
// ---------------------------------------------------------------------------

function diffGallery(
  fromContent: Record<string, unknown>,
  toContent: Record<string, unknown>,
): { result: GalleryDiffResult; summary: DiffSummary } {
  const fromItems = (fromContent.items as Array<{ id: string; type: string; url: string; caption?: string }> | undefined) ?? [];
  const toItems = (toContent.items as Array<{ id: string; type: string; url: string; caption?: string }> | undefined) ?? [];

  const fromMap = indexById(fromItems);
  const toMap = indexById(toItems);
  const itemChanges: GalleryItemChange[] = [];

  // Removed items (in from not in to)
  for (const item of fromItems) {
    if (!toMap.has(item.id)) {
      itemChanges.push({ type: 'removed', item });
    }
  }
  // Added items (in to not in from)
  for (const item of toItems) {
    if (!fromMap.has(item.id)) {
      itemChanges.push({ type: 'added', item });
    }
  }
  // Modified items (in both but changed)
  for (const item of toItems) {
    const fromItem = fromMap.get(item.id);
    if (fromItem) {
      const deltas = fieldDeltas(
        fromItem as Record<string, unknown>,
        item as Record<string, unknown>,
        ['url', 'caption', 'type'],
      );
      if (deltas.length > 0) {
        itemChanges.push({ type: 'modified', itemId: item.id, fieldDeltas: deltas });
      }
    }
  }

  const additions = itemChanges.filter((i) => i.type === 'added').length;
  const deletions = itemChanges.filter((i) => i.type === 'removed').length;
  const modifications = itemChanges.filter((i) => i.type === 'modified').length;

  return {
    result: { itemChanges },
    summary: { additions, deletions, modifications },
  };
}

// ---------------------------------------------------------------------------
// Dashboard diff (data source + widget)
// ---------------------------------------------------------------------------

function diffDashboard(
  fromContent: Record<string, unknown>,
  toContent: Record<string, unknown>,
): { result: DashboardDiffResult; summary: DiffSummary } {
  const fromDataSources = (fromContent.dataSources as Array<{ id: string; type: string; config: Record<string, unknown> }> | undefined) ?? [];
  const toDataSources = (toContent.dataSources as Array<{ id: string; type: string; config: Record<string, unknown> }> | undefined) ?? [];
  const fromWidgets = (fromContent.widgets as Array<{ id: string; type: string; dataSourceId: string; config: Record<string, unknown> }> | undefined) ?? [];
  const toWidgets = (toContent.widgets as Array<{ id: string; type: string; dataSourceId: string; config: Record<string, unknown> }> | undefined) ?? [];

  // Data source changes
  const fromDsMap = indexById(fromDataSources);
  const toDsMap = indexById(toDataSources);
  const dataSourceChanges: DashboardDataSourceChange[] = [];

  for (const ds of fromDataSources) {
    if (!toDsMap.has(ds.id)) {
      dataSourceChanges.push({ type: 'removed', dataSource: ds });
    }
  }
  for (const ds of toDataSources) {
    if (!fromDsMap.has(ds.id)) {
      dataSourceChanges.push({ type: 'added', dataSource: ds });
    }
  }
  for (const ds of toDataSources) {
    const fromDs = fromDsMap.get(ds.id);
    if (fromDs) {
      const deltas = fieldDeltas(fromDs as Record<string, unknown>, ds as Record<string, unknown>);
      if (deltas.length > 0) {
        dataSourceChanges.push({ type: 'modified', dataSourceId: ds.id, fieldDeltas: deltas });
      }
    }
  }

  // Widget changes
  const fromWidgetMap = indexById(fromWidgets);
  const toWidgetMap = indexById(toWidgets);
  const widgetChanges: DashboardWidgetChange[] = [];

  for (const widget of fromWidgets) {
    if (!toWidgetMap.has(widget.id)) {
      widgetChanges.push({ type: 'removed', widget });
    }
  }
  for (const widget of toWidgets) {
    if (!fromWidgetMap.has(widget.id)) {
      widgetChanges.push({ type: 'added', widget });
    }
  }
  for (const widget of toWidgets) {
    const fromWidget = fromWidgetMap.get(widget.id);
    if (fromWidget) {
      const deltas = fieldDeltas(fromWidget as Record<string, unknown>, widget as Record<string, unknown>);
      if (deltas.length > 0) {
        widgetChanges.push({ type: 'modified', widgetId: widget.id, fieldDeltas: deltas });
      }
    }
  }

  const additions = dataSourceChanges.filter((d) => d.type === 'added').length + widgetChanges.filter((w) => w.type === 'added').length;
  const deletions = dataSourceChanges.filter((d) => d.type === 'removed').length + widgetChanges.filter((w) => w.type === 'removed').length;
  const modifications = dataSourceChanges.filter((d) => d.type === 'modified').length + widgetChanges.filter((w) => w.type === 'modified').length;

  return {
    result: { dataSourceChanges, widgetChanges },
    summary: { additions, deletions, modifications },
  };
}

// ---------------------------------------------------------------------------
// App / Code diff (file-level + line diff)
// ---------------------------------------------------------------------------

function diffFiles(
  fromContent: Record<string, unknown>,
  toContent: Record<string, unknown>,
): { result: FileDiffResult; summary: DiffSummary } {
  const fromFiles = (fromContent.files as Array<{ path: string; content: string }> | undefined) ?? [];
  const toFiles = (toContent.files as Array<{ path: string; content: string }> | undefined) ?? [];

  const fromMap = new Map<string, { path: string; content: string }>();
  for (const f of fromFiles) fromMap.set(f.path, f);
  const toMap = new Map<string, { path: string; content: string }>();
  for (const f of toFiles) toMap.set(f.path, f);

  const fileChanges: FileChange[] = [];

  // Removed files (in from not in to)
  for (const file of fromFiles) {
    if (!toMap.has(file.path)) {
      fileChanges.push({ type: 'removed', path: file.path });
    }
  }
  // Added files (in to not in from)
  for (const file of toFiles) {
    if (!fromMap.has(file.path)) {
      fileChanges.push({ type: 'added', path: file.path });
    }
  }
  // Modified files (in both but content changed)
  let addedLines = 0;
  let removedLines = 0;
  let modifiedFileCount = 0;
  for (const file of toFiles) {
    const fromFile = fromMap.get(file.path);
    if (fromFile && fromFile.content !== file.content) {
      const changes = diffLines(fromFile.content, file.content);
      const lines = changesToLineDiffs(changes);
      addedLines += lines.filter((l) => l.type === 'added').length;
      removedLines += lines.filter((l) => l.type === 'removed').length;
      modifiedFileCount += 1;
      fileChanges.push({ type: 'modified', path: file.path, lineDiff: { lines } });
    }
  }

  const additions = fileChanges.filter((f) => f.type === 'added').length + addedLines;
  const deletions = fileChanges.filter((f) => f.type === 'removed').length + removedLines;
  const modifications = modifiedFileCount;

  return {
    result: { fileChanges },
    summary: { additions, deletions, modifications },
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Compute a structured `DiffResult` between two decrypted artifact content
 * snapshots. Dispatches by artifact type to the appropriate diff function.
 *
 * The caller is responsible for loading both revisions (with company
 * scoping + 404 handling) and passing their decrypted `content` payloads.
 *
 * For same-version diffs (v1 === v2), the caller should still call this
 * function — it will produce an empty diff naturally because the content
 * snapshots are identical.
 */
export function diffRevisions(
  type: ArtifactType,
  fromContent: Record<string, unknown>,
  toContent: Record<string, unknown>,
): DiffResult {
  switch (type) {
    case 'document': {
      const { result, summary } = diffDocument(fromContent, toContent);
      return { type, summary, document: result };
    }
    case 'sheet': {
      const { result, summary } = diffSheet(fromContent, toContent);
      return { type, summary, sheet: result };
    }
    case 'board': {
      const { result, summary } = diffBoard(fromContent, toContent);
      return { type, summary, board: result };
    }
    case 'slide_deck': {
      const { result, summary } = diffSlides(fromContent, toContent);
      return { type, summary, slides: result };
    }
    case 'timeline': {
      const { result, summary } = diffTimeline(fromContent, toContent);
      return { type, summary, timeline: result };
    }
    case 'gallery': {
      const { result, summary } = diffGallery(fromContent, toContent);
      return { type, summary, gallery: result };
    }
    case 'dashboard': {
      const { result, summary } = diffDashboard(fromContent, toContent);
      return { type, summary, dashboard: result };
    }
    case 'app': {
      const { result, summary } = diffFiles(fromContent, toContent);
      return { type, summary, app: result };
    }
    case 'code': {
      const { result, summary } = diffFiles(fromContent, toContent);
      return { type, summary, code: result };
    }
    default: {
      // Exhaustive check — if a new type is added, this will fail at compile
      // time because the switch is exhaustive over ArtifactType.
      const _exhaustive: never = type;
      throw new Error(`Unsupported artifact type for diff: ${_exhaustive}`);
    }
  }
}
