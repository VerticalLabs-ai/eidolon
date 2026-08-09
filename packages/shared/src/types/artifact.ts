import { z } from 'zod';

const artifactBlockSchema = z.record(z.string(), z.unknown());

export const DocumentContentSchema = z.discriminatedUnion('format', [
  z.object({ format: z.literal('markdown'), body: z.string() }),
  z.object({ format: z.literal('delta'), body: z.array(artifactBlockSchema) }),
]);

const sheetColumnSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  width: z.number().finite().positive().optional(),
});

const sheetCellSchema = z.object({
  value: z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
  formula: z.string().optional(),
});

const sheetRowSchema = z.object({
  id: z.string().min(1),
  cells: z.record(z.string(), sheetCellSchema),
});

export const SheetContentSchema = z
  .object({
    columns: z.array(sheetColumnSchema),
    rows: z.array(sheetRowSchema),
  })
  .superRefine((sheet, ctx) => {
    const keys = new Set(sheet.columns.map((column) => column.key));
    sheet.rows.forEach((row, rowIndex) => {
      Object.keys(row.cells).forEach((key) => {
        if (!keys.has(key)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['rows', rowIndex, 'cells', key],
            message: `Cell references unknown column key "${key}"`,
          });
        }
      });
    });
  });

const boardColumnSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
});

const boardCardSchema = z.object({
  id: z.string().min(1),
  columnId: z.string().min(1),
  title: z.string(),
  order: z.number().finite(),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export const BoardContentSchema = z
  .object({
    columns: z.array(boardColumnSchema),
    cards: z.array(boardCardSchema),
  })
  .superRefine((board, ctx) => {
    const columnIds = new Set<string>();
    board.columns.forEach((column, columnIndex) => {
      if (columnIds.has(column.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['columns', columnIndex, 'id'],
          message: `Duplicate column id "${column.id}"`,
        });
        return;
      }
      columnIds.add(column.id);
    });

    const cardIds = new Set<string>();
    board.cards.forEach((card, cardIndex) => {
      if (cardIds.has(card.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cards', cardIndex, 'id'],
          message: `Duplicate card id "${card.id}"`,
        });
      } else {
        cardIds.add(card.id);
      }
      if (!columnIds.has(card.columnId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cards', cardIndex, 'columnId'],
          message: `Card references unknown column id "${card.columnId}"`,
        });
      }
    });
  });

export type DocumentContent = z.infer<typeof DocumentContentSchema>;
export type SheetContent = z.infer<typeof SheetContentSchema>;
export type BoardContent = z.infer<typeof BoardContentSchema>;

/**
 * A block is the atomic content unit on a slide. It has a `type` (e.g.
 * "text", "heading", "image", "list") and a `content` record holding the
 * type-specific payload (text string, url, items array, etc.).
 */
const slideBlockSchema = z.object({
  type: z.string().min(1),
  content: z.record(z.string(), z.unknown()),
});

const slideSchema = z.object({
  id: z.string().min(1),
  layout: z.string().min(1),
  blocks: z.array(slideBlockSchema),
});

export const SlideDeckContentSchema = z
  .object({
    slides: z.array(slideSchema),
  })
  .superRefine((deck, ctx) => {
    const slideIds = new Set<string>();
    deck.slides.forEach((slide, index) => {
      if (slideIds.has(slide.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['slides', index, 'id'],
          message: `Duplicate slide id "${slide.id}"`,
        });
      } else {
        slideIds.add(slide.id);
      }
    });
  });

export type SlideDeckContent = z.infer<typeof SlideDeckContentSchema>;

const timelineTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  start: z.string().min(1),
  end: z.string().min(1),
  dependsOn: z.array(z.string()).optional(),
  progress: z.number().min(0).max(100).optional(),
});

export const TimelineContentSchema = z
  .object({
    tasks: z.array(timelineTaskSchema),
  })
  .superRefine((timeline, ctx) => {
    const taskIds = new Set<string>();
    timeline.tasks.forEach((task, index) => {
      // Duplicate task id detection
      if (taskIds.has(task.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tasks', index, 'id'],
          message: `Duplicate task id "${task.id}"`,
        });
      } else {
        taskIds.add(task.id);
      }

      // Date parsability: reject unparsable start/end BEFORE the date-order
      // check runs. Without this, `new Date('not-a-date')` produces an Invalid
      // Date whose comparisons are always false, so the end<start check
      // silently passes and TimelineEditor later throws RangeError on
      // toISOString().
      const start = new Date(task.start);
      const end = new Date(task.end);
      let datesValid = true;
      if (Number.isNaN(start.getTime())) {
        datesValid = false;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tasks', index, 'start'],
          message: `Task start date "${task.start}" is not a valid date`,
        });
      }
      if (Number.isNaN(end.getTime())) {
        datesValid = false;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tasks', index, 'end'],
          message: `Task end date "${task.end}" is not a valid date`,
        });
      }

      // Date validation: end must be >= start (only when both parse)
      if (datesValid && end < start) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tasks', index, 'end'],
          message: `Task end date is before its start date`,
        });
      }
    });

    // Dependency reference validation + cycle detection
    const adj = new Map<string, string[]>();
    timeline.tasks.forEach((task) => {
      const deps = task.dependsOn ?? [];
      adj.set(task.id, []);
      deps.forEach((dep) => {
        if (!taskIds.has(dep)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tasks', timeline.tasks.indexOf(task), 'dependsOn'],
            message: `Task "${task.id}" depends on unknown task id "${dep}"`,
          });
        } else {
          adj.get(task.id)?.push(dep);
        }
      });
    });

    // Cycle detection via DFS
    const WHITE = 0; // unvisited
    const GRAY = 1; // in current DFS stack
    const BLACK = 2; // fully explored
    const color = new Map<string, number>();
    for (const id of taskIds) color.set(id, WHITE);

    function dfs(node: string): boolean {
      color.set(node, GRAY);
      for (const neighbor of adj.get(node) ?? []) {
        const c = color.get(neighbor);
        if (c === GRAY) return true; // back edge → cycle
        if (c === WHITE && dfs(neighbor)) return true;
      }
      color.set(node, BLACK);
      return false;
    }

    for (const id of taskIds) {
      if (color.get(id) === WHITE && dfs(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tasks'],
          message: `Dependency graph contains a cycle`,
        });
        break; // one cycle error is sufficient
      }
    }
  });

export type TimelineContent = z.infer<typeof TimelineContentSchema>;

const galleryItemSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['image', 'video']),
  url: z.string().min(1),
  caption: z.string().optional(),
});

export const GalleryContentSchema = z
  .object({
    items: z.array(galleryItemSchema),
  })
  .superRefine((gallery, ctx) => {
    const ids = new Set<string>();
    gallery.items.forEach((item, index) => {
      if (ids.has(item.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['items', index, 'id'],
          message: `Duplicate gallery item id "${item.id}"`,
        });
      } else {
        ids.add(item.id);
      }
    });
  });

export type GalleryContent = z.infer<typeof GalleryContentSchema>;

// ---------------------------------------------------------------------------
// Dashboard artifact — data sources + widgets bound to data sources
// ---------------------------------------------------------------------------

/** Supported data-source provider types (pluggable provider registry). */
export const DashboardDataSourceTypeSchema = z.enum([
  'analytics_endpoint',
  'integration',
  'manual_json',
]);
export type DashboardDataSourceType = z.infer<typeof DashboardDataSourceTypeSchema>;

/** Supported widget types that render live data from a bound data source. */
export const DashboardWidgetTypeSchema = z.enum(['chart', 'table', 'metric']);
export type DashboardWidgetType = z.infer<typeof DashboardWidgetTypeSchema>;

const dashboardDataSourceConfigSchema = z.record(z.string(), z.unknown());

const dashboardDataSourceSchema = z.object({
  id: z.string().min(1),
  type: DashboardDataSourceTypeSchema,
  config: dashboardDataSourceConfigSchema,
});

const dashboardWidgetConfigSchema = z.record(z.string(), z.unknown());

const dashboardWidgetSchema = z.object({
  id: z.string().min(1),
  type: DashboardWidgetTypeSchema,
  dataSourceId: z.string().min(1),
  config: dashboardWidgetConfigSchema,
});

export const DashboardContentSchema = z
  .object({
    dataSources: z.array(dashboardDataSourceSchema),
    widgets: z.array(dashboardWidgetSchema),
  })
  .superRefine((dashboard, ctx) => {
    // Duplicate data-source id detection
    const dsIds = new Set<string>();
    dashboard.dataSources.forEach((ds, index) => {
      if (dsIds.has(ds.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dataSources', index, 'id'],
          message: `Duplicate data source id "${ds.id}"`,
        });
      } else {
        dsIds.add(ds.id);
      }
      // Per-type config validation
      const cfg = ds.config ?? {};
      if (ds.type === 'analytics_endpoint') {
        if (typeof cfg.endpoint !== 'string' || cfg.endpoint.trim() === '') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['dataSources', index, 'config', 'endpoint'],
            message: 'analytics_endpoint data source requires a non-empty "endpoint" config field',
          });
        }
      } else if (ds.type === 'integration') {
        if (typeof cfg.integrationId !== 'string' || cfg.integrationId.trim() === '') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['dataSources', index, 'config', 'integrationId'],
            message: 'integration data source requires a non-empty "integrationId" config field',
          });
        }
      } else if (ds.type === 'manual_json') {
        if (cfg.data === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['dataSources', index, 'config', 'data'],
            message: 'manual_json data source requires a "data" config field',
          });
        }
      }
    });

    // Duplicate widget id detection + binding validation
    const widgetIds = new Set<string>();
    dashboard.widgets.forEach((widget, index) => {
      if (widgetIds.has(widget.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['widgets', index, 'id'],
          message: `Duplicate widget id "${widget.id}"`,
        });
      } else {
        widgetIds.add(widget.id);
      }
      if (!dsIds.has(widget.dataSourceId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['widgets', index, 'dataSourceId'],
          message: `Widget references unknown data source id "${widget.dataSourceId}"`,
        });
      }
    });
  });

export type DashboardContent = z.infer<typeof DashboardContentSchema>;

// ---------------------------------------------------------------------------
// App artifact — definition + files (bounded app builder)
// ---------------------------------------------------------------------------

/**
 * The app definition is a permissive record so future fields can be added
 * without a schema migration. The UI surfaces `name` and `entrypoint`; both
 * are optional strings (an empty `{}` is well-formed and accepted).
 */
const appDefinitionSchema = z.object({
  name: z.string().optional(),
  entrypoint: z.string().optional(),
}).catchall(z.unknown());

const appFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
});

export const AppContentSchema = z
  .object({
    definition: appDefinitionSchema,
    files: z.array(appFileSchema),
  })
  .superRefine((app, ctx) => {
    // Duplicate file path detection — paths must be unique within the app.
    const paths = new Set<string>();
    app.files.forEach((file, index) => {
      if (paths.has(file.path)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['files', index, 'path'],
          message: `Duplicate file path "${file.path}"`,
        });
      } else {
        paths.add(file.path);
      }
    });
  });

export type AppContent = z.infer<typeof AppContentSchema>;
export type AppFile = z.infer<typeof appFileSchema>;
const CodeContentSchema = z.object({
  language: z.string(), entrypoint: z.string().optional(),
  files: z.array(z.object({ path: z.string(), content: z.string() })),
});

export const ArtifactTypeSchema = z.enum([
  'document', 'sheet', 'board', 'slide_deck', 'timeline', 'gallery', 'dashboard', 'app', 'code',
]);
export const ArtifactContentSchema = z.union([
  DocumentContentSchema, SheetContentSchema, BoardContentSchema, SlideDeckContentSchema,
  TimelineContentSchema, GalleryContentSchema, DashboardContentSchema, AppContentSchema, CodeContentSchema,
]);

export function validateArtifactContent(type: z.infer<typeof ArtifactTypeSchema>, content: unknown): z.SafeParseReturnType<unknown, unknown> {
  const schemas: Record<string, z.ZodType> = {
    document: DocumentContentSchema, sheet: SheetContentSchema, board: BoardContentSchema,
    slide_deck: SlideDeckContentSchema, timeline: TimelineContentSchema, gallery: GalleryContentSchema,
    dashboard: DashboardContentSchema, app: AppContentSchema, code: CodeContentSchema,
  };
  return (schemas[type] ?? z.never()).safeParse(content);
}
