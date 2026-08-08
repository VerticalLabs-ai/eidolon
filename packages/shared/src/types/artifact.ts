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
const SlideDeckContentSchema = z.object({
  slides: z.array(z.object({ id: z.string().min(1), layout: z.string(), blocks: z.array(z.record(z.string(), z.unknown())) })),
});
const TimelineContentSchema = z.object({
  tasks: z.array(z.object({
    id: z.string().min(1), title: z.string(), start: z.string(), end: z.string(),
    dependsOn: z.array(z.string()).optional(), progress: z.number().min(0).max(100).optional(),
  })),
});
const GalleryContentSchema = z.object({
  items: z.array(z.object({ id: z.string().min(1), type: z.string(), url: z.string(), caption: z.string().optional() })),
});
const DashboardContentSchema = z.object({
  dataSources: z.array(z.object({ id: z.string(), type: z.string(), config: z.record(z.string(), z.unknown()) })),
  widgets: z.array(z.object({ id: z.string(), type: z.string(), dataSourceId: z.string(), config: z.record(z.string(), z.unknown()) })),
});
const AppContentSchema = z.object({ definition: z.record(z.string(), z.unknown()), files: z.array(z.object({ path: z.string(), content: z.string() })) });
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
