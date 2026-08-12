import { z } from 'zod';
import { ArtifactTypeSchema } from './artifact.js';

// ---------------------------------------------------------------------------
// Revision diff types (M2 — Artifact Intelligence & Discovery)
// ---------------------------------------------------------------------------
//
// Structured diff results for comparing two artifact revisions. The diff
// service dispatches by artifact type and produces a `DiffResult` with a
// common `summary` plus a type-specific payload.
//
// All diff endpoints are company-scoped (requireAuth + requireOrgMember).
// The `summary` carries additions/deletions/modifications counts that are
// consistent with the type-specific payload.
// ---------------------------------------------------------------------------

/** Common summary counting added/removed/modified entities. */
export const DiffSummarySchema = z.object({
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  modifications: z.number().int().nonnegative(),
});
export type DiffSummary = z.infer<typeof DiffSummarySchema>;

/** A single line in a line-level diff (document/code/app). */
export const LineDiffSchema = z.object({
  type: z.enum(['added', 'removed', 'unchanged']),
  content: z.string(),
  /** 1-based line number in the source revision (added→to, removed→from). */
  lineNumber: z.number().int().positive().optional(),
});
export type LineDiff = z.infer<typeof LineDiffSchema>;

/** Line-level diff result for document/code/app content. */
export const LineDiffResultSchema = z.object({
  lines: z.array(LineDiffSchema),
});
export type LineDiffResult = z.infer<typeof LineDiffResultSchema>;

// ---------------------------------------------------------------------------
// Sheet diff (cell-level)
// ---------------------------------------------------------------------------

export const SheetColumnChangeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('added'),
    column: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('removed'),
    column: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('modified'),
    columnId: z.string(),
    changes: z.array(
      z.object({
        field: z.string(),
        from: z.unknown(),
        to: z.unknown(),
      }),
    ),
  }),
]);
export type SheetColumnChange = z.infer<typeof SheetColumnChangeSchema>;

export const SheetCellDeltaSchema = z.object({
  columnKey: z.string(),
  from: z.unknown(),
  to: z.unknown(),
});
export type SheetCellDelta = z.infer<typeof SheetCellDeltaSchema>;

export const SheetRowChangeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('added'),
    row: z.record(z.string(), z.unknown()),
  index: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('removed'),
    row: z.record(z.string(), z.unknown()),
    index: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('modified'),
    rowId: z.string(),
    cellDeltas: z.array(SheetCellDeltaSchema),
  }),
]);
export type SheetRowChange = z.infer<typeof SheetRowChangeSchema>;

export const SheetDiffResultSchema = z.object({
  columnChanges: z.array(SheetColumnChangeSchema),
  rowChanges: z.array(SheetRowChangeSchema),
});
export type SheetDiffResult = z.infer<typeof SheetDiffResultSchema>;

// ---------------------------------------------------------------------------
// Board diff (card-level)
// ---------------------------------------------------------------------------

export const BoardCardChangeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('added'),
    card: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('removed'),
    card: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('moved'),
    cardId: z.string(),
    from: z.record(z.string(), z.unknown()),
    to: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('modified'),
    cardId: z.string(),
    changes: z.array(
      z.object({
        field: z.string(),
        from: z.unknown(),
        to: z.unknown(),
      }),
    ),
  }),
]);
export type BoardCardChange = z.infer<typeof BoardCardChangeSchema>;

export const BoardDiffResultSchema = z.object({
  cardChanges: z.array(BoardCardChangeSchema),
});
export type BoardDiffResult = z.infer<typeof BoardDiffResultSchema>;

// ---------------------------------------------------------------------------
// Slides diff (slide + block level)
// ---------------------------------------------------------------------------

export const SlideBlockDeltaSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('added'),
    block: z.record(z.string(), z.unknown()),
    index: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('removed'),
    block: z.record(z.string(), z.unknown()),
    index: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('modified'),
    blockIndex: z.number().int().nonnegative(),
    changes: z.array(
      z.object({
        field: z.string(),
        from: z.unknown(),
        to: z.unknown(),
      }),
    ),
  }),
]);
export type SlideBlockDelta = z.infer<typeof SlideBlockDeltaSchema>;

export const SlideChangeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('added'),
    slide: z.record(z.string(), z.unknown()),
    index: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('removed'),
    slide: z.record(z.string(), z.unknown()),
    index: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('reordered'),
    slideId: z.string(),
    fromIndex: z.number().int().nonnegative(),
    toIndex: z.number().int().nonnegative(),
  }),
  z.object({
    type: z.literal('modified'),
    slideId: z.string(),
    blockDeltas: z.array(SlideBlockDeltaSchema),
  }),
]);
export type SlideChange = z.infer<typeof SlideChangeSchema>;

export const SlidesDiffResultSchema = z.object({
  slideChanges: z.array(SlideChangeSchema),
});
export type SlidesDiffResult = z.infer<typeof SlidesDiffResultSchema>;

// ---------------------------------------------------------------------------
// Timeline diff (task-level)
// ---------------------------------------------------------------------------

export const TimelineTaskChangeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('added'),
    task: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('removed'),
    task: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('modified'),
    taskId: z.string(),
    fieldDeltas: z.array(
      z.object({
        field: z.string(),
        from: z.unknown(),
        to: z.unknown(),
      }),
    ),
  }),
]);
export type TimelineTaskChange = z.infer<typeof TimelineTaskChangeSchema>;

export const TimelineDiffResultSchema = z.object({
  taskChanges: z.array(TimelineTaskChangeSchema),
});
export type TimelineDiffResult = z.infer<typeof TimelineDiffResultSchema>;

// ---------------------------------------------------------------------------
// Gallery diff (item-level)
// ---------------------------------------------------------------------------

export const GalleryItemChangeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('added'),
    item: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('removed'),
    item: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('modified'),
    itemId: z.string(),
    fieldDeltas: z.array(
      z.object({
        field: z.string(),
        from: z.unknown(),
        to: z.unknown(),
      }),
    ),
  }),
]);
export type GalleryItemChange = z.infer<typeof GalleryItemChangeSchema>;

export const GalleryDiffResultSchema = z.object({
  itemChanges: z.array(GalleryItemChangeSchema),
});
export type GalleryDiffResult = z.infer<typeof GalleryDiffResultSchema>;

// ---------------------------------------------------------------------------
// Dashboard diff (data source + widget)
// ---------------------------------------------------------------------------

export const DashboardDataSourceChangeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('added'),
    dataSource: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('removed'),
    dataSource: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('modified'),
    dataSourceId: z.string(),
    fieldDeltas: z.array(
      z.object({
        field: z.string(),
        from: z.unknown(),
        to: z.unknown(),
      }),
    ),
  }),
]);
export type DashboardDataSourceChange = z.infer<typeof DashboardDataSourceChangeSchema>;

export const DashboardWidgetChangeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('added'),
    widget: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('removed'),
    widget: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('modified'),
    widgetId: z.string(),
    fieldDeltas: z.array(
      z.object({
        field: z.string(),
        from: z.unknown(),
        to: z.unknown(),
      }),
    ),
  }),
]);
export type DashboardWidgetChange = z.infer<typeof DashboardWidgetChangeSchema>;

export const DashboardDiffResultSchema = z.object({
  dataSourceChanges: z.array(DashboardDataSourceChangeSchema),
  widgetChanges: z.array(DashboardWidgetChangeSchema),
});
export type DashboardDiffResult = z.infer<typeof DashboardDiffResultSchema>;

// ---------------------------------------------------------------------------
// App / Code diff (file-level + line diff)
// ---------------------------------------------------------------------------

export const FileChangeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('added'),
    path: z.string(),
  }),
  z.object({
    type: z.literal('removed'),
    path: z.string(),
  }),
  z.object({
    type: z.literal('modified'),
    path: z.string(),
    lineDiff: LineDiffResultSchema,
  }),
]);
export type FileChange = z.infer<typeof FileChangeSchema>;

export const FileDiffResultSchema = z.object({
  fileChanges: z.array(FileChangeSchema),
});
export type FileDiffResult = z.infer<typeof FileDiffResultSchema>;

// ---------------------------------------------------------------------------
// Top-level DiffResult
// ---------------------------------------------------------------------------

export const DiffResultSchema = z.object({
  type: ArtifactTypeSchema,
  summary: DiffSummarySchema,
  document: LineDiffResultSchema.optional(),
  sheet: SheetDiffResultSchema.optional(),
  board: BoardDiffResultSchema.optional(),
  slides: SlidesDiffResultSchema.optional(),
  timeline: TimelineDiffResultSchema.optional(),
  gallery: GalleryDiffResultSchema.optional(),
  dashboard: DashboardDiffResultSchema.optional(),
  app: FileDiffResultSchema.optional(),
  code: FileDiffResultSchema.optional(),
});
export type DiffResult = z.infer<typeof DiffResultSchema>;

/** Top-level response envelope for the diff endpoint. */
export const DiffResponseSchema = z.object({
  diff: DiffResultSchema,
  fromRevision: z.record(z.string(), z.unknown()),
  toRevision: z.record(z.string(), z.unknown()),
  artifactType: ArtifactTypeSchema,
});
export type DiffResponse = z.infer<typeof DiffResponseSchema>;
