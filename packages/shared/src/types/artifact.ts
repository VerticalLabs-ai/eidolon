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

export type DocumentContent = z.infer<typeof DocumentContentSchema>;
export type SheetContent = z.infer<typeof SheetContentSchema>;
