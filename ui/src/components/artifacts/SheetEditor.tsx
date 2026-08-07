import { useEffect, useState, useCallback, useRef } from "react";
import { Save, Plus, Trash2, AlertTriangle, CloudOff } from "lucide-react";
import { clsx } from "clsx";
import { Button } from "@/components/ui/Button";
import type { Artifact } from "@/lib/api";

interface SheetEditorProps {
  artifact: Artifact;
  version: number;
  onSave: (data: {
    title: string;
    content: Record<string, unknown>;
  }) => Promise<void>;
  saving?: boolean;
  conflictState?: ConflictState | null;
  wsConnected?: boolean;
}

export interface ConflictState {
  currentVersion: number;
  currentTitle: string;
  currentContent: Record<string, unknown>;
}

interface SheetColumn {
  id: string;
  key: string;
  width?: number;
}

interface SheetCell {
  value: string | number | boolean | null;
  formula?: string;
}

interface SheetRow {
  id: string;
  cells: Record<string, SheetCell>;
}

interface SheetContent {
  columns: SheetColumn[];
  rows: SheetRow[];
}

function parseSheet(content: Record<string, unknown>): SheetContent {
  const columns = Array.isArray(content.columns)
    ? (content.columns as SheetColumn[])
    : [];
  const rows = Array.isArray(content.rows)
    ? (content.rows as SheetRow[])
    : [];
  return { columns, rows };
}

function genId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function SheetEditor({
  artifact,
  version,
  onSave,
  saving,
  conflictState,
  wsConnected,
}: SheetEditorProps) {
  const parsed = parseSheet(artifact.content);
  const [title, setTitle] = useState(artifact.title);
  const [columns, setColumns] = useState<SheetColumn[]>(parsed.columns);
  const [rows, setRows] = useState<SheetRow[]>(parsed.rows);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [focusedCell, setFocusedCell] = useState<{ row: number; col: number } | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // Sync local state when artifact changes
  useEffect(() => {
    setTitle(artifact.title);
    const p = parseSheet(artifact.content);
    setColumns(p.columns);
    setRows(p.rows);
    setSaveError(null);
  }, [artifact.id, artifact.version, artifact.title, artifact.content]);

  const currentParsed = parseSheet(artifact.content);
  const isDirty =
    title !== artifact.title ||
    JSON.stringify(columns) !== JSON.stringify(currentParsed.columns) ||
    JSON.stringify(rows) !== JSON.stringify(currentParsed.rows);

  const buildContent = useCallback((): Record<string, unknown> => {
    return {
      columns: columns.map((c) => ({
        id: c.id,
        key: c.key,
        ...(c.width !== undefined ? { width: c.width } : {}),
      })),
      rows: rows.map((r) => ({
        id: r.id,
        cells: r.cells,
      })),
    };
  }, [columns, rows]);

  const handleSave = useCallback(async () => {
    if (!isDirty || saving) return;
    setSaveError(null);
    try {
      await onSave({ title, content: buildContent() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Save failed";
      setSaveError(msg);
    }
  }, [isDirty, saving, title, buildContent, onSave]);

  // Ctrl/Cmd+S
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (isDirty && !saving) void handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave, isDirty, saving]);

  const addColumn = () => {
    const col: SheetColumn = {
      id: genId("col"),
      key: `col_${columns.length + 1}`,
    };
    setColumns((prev) => [...prev, col]);
  };

  const addRow = () => {
    const row: SheetRow = {
      id: genId("row"),
      cells: {},
    };
    setRows((prev) => [...prev, row]);
  };

  const deleteColumn = (colIndex: number) => {
    const col = columns[colIndex];
    if (!col) return;
    setColumns((prev) => prev.filter((_, i) => i !== colIndex));
    setRows((prev) =>
      prev.map((r) => {
        if (!(col.key in r.cells)) return r;
        const rest = { ...r.cells };
        delete rest[col.key];
        return { ...r, cells: rest };
      }),
    );
  };

  const deleteRow = (rowIndex: number) => {
    setRows((prev) => prev.filter((_, i) => i !== rowIndex));
  };

  const updateCell = (rowIndex: number, colKey: string, value: string) => {
    setRows((prev) =>
      prev.map((r, i) => {
        if (i !== rowIndex) return r;
        const currentCell = r.cells[colKey];
        // Try to parse number
        let parsedVal: string | number | boolean | null = value;
        if (value === "") {
          parsedVal = null;
        } else if (!isNaN(Number(value)) && value.trim() !== "") {
          parsedVal = Number(value);
        } else if (value === "true") {
          parsedVal = true;
        } else if (value === "false") {
          parsedVal = false;
        }
        return {
          ...r,
          cells: {
            ...r.cells,
            [colKey]: { ...(currentCell ?? {}), value: parsedVal },
          },
        };
      }),
    );
  };

  const updateColumnKey = (colIndex: number, newKey: string) => {
    const oldKey = columns[colIndex]?.key;
    if (!oldKey || oldKey === newKey) return;
    setColumns((prev) =>
      prev.map((c, i) => (i === colIndex ? { ...c, key: newKey } : c)),
    );
    // Update cell keys in all rows
    setRows((prev) =>
      prev.map((r) => {
        if (!(oldKey in r.cells)) return r;
        const cellValue = r.cells[oldKey];
        const rest = { ...r.cells };
        delete rest[oldKey];
        return { ...r, cells: { ...rest, [newKey]: cellValue } };
      }),
    );
  };

  // Keyboard navigation for cells
  const handleCellKeyDown = (
    e: React.KeyboardEvent,
    rowIndex: number,
    colIndex: number,
  ) => {
    if (e.key === "ArrowUp" && rowIndex > 0) {
      e.preventDefault();
      setFocusedCell({ row: rowIndex - 1, col: colIndex });
    } else if (e.key === "ArrowDown" && rowIndex < rows.length - 1) {
      e.preventDefault();
      setFocusedCell({ row: rowIndex + 1, col: colIndex });
    } else if (e.key === "ArrowLeft" && colIndex > 0) {
      e.preventDefault();
      setFocusedCell({ row: rowIndex, col: colIndex - 1 });
    } else if (e.key === "ArrowRight" && colIndex < columns.length - 1) {
      e.preventDefault();
      setFocusedCell({ row: rowIndex, col: colIndex + 1 });
    } else if (e.key === "Tab") {
      e.preventDefault();
      if (e.shiftKey && colIndex > 0) {
        setFocusedCell({ row: rowIndex, col: colIndex - 1 });
      } else if (!e.shiftKey && colIndex < columns.length - 1) {
        setFocusedCell({ row: rowIndex, col: colIndex + 1 });
      } else if (!e.shiftKey && colIndex === columns.length - 1 && rowIndex < rows.length - 1) {
        setFocusedCell({ row: rowIndex + 1, col: 0 });
      } else if (e.shiftKey && colIndex === 0 && rowIndex > 0) {
        setFocusedCell({ row: rowIndex - 1, col: columns.length - 1 });
      }
    }
  };

  // Focus the active cell
  useEffect(() => {
    if (!focusedCell) return;
    const el = gridRef.current?.querySelector<HTMLInputElement>(
      `[data-cell-row="${focusedCell.row}"][data-cell-col="${focusedCell.col}"]`,
    );
    el?.focus();
  }, [focusedCell]);

  const isEmpty = columns.length === 0 && rows.length === 0 && !isDirty;

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-2.5">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Untitled sheet"
          aria-label="Sheet title"
          className="flex-1 bg-transparent text-sm font-semibold text-text-primary font-display outline-none placeholder:text-text-secondary/40 focus:outline-none focus:ring-1 focus:ring-accent/30 rounded px-1 py-0.5"
        />
        <span className="shrink-0 text-xs text-text-secondary tabular-nums">
          v{version}
        </span>
        {wsConnected === false && (
          <span
            className="flex items-center gap-1 text-xs text-warning"
            title="Realtime connection lost — your draft is preserved"
          >
            <CloudOff className="h-3.5 w-3.5" />
            Disconnected
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          icon={<Plus className="h-3 w-3" />}
          onClick={addRow}
        >
          Row
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={<Plus className="h-3 w-3" />}
          onClick={addColumn}
        >
          Column
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon={<Save className="h-3 w-3" />}
          onClick={handleSave}
          disabled={!isDirty || saving}
          loading={saving}
        >
          Save
        </Button>
      </div>

      {/* Conflict banner */}
      {conflictState && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-warning/20 bg-warning/10 px-4 py-2 text-xs text-warning"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            Version conflict — another client saved v{conflictState.currentVersion}.
            Your draft is preserved. Save again to overwrite, or discard to load latest.
          </span>
        </div>
      )}

      {/* Save error */}
      {saveError && !conflictState && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-error/20 bg-error/10 px-4 py-2 text-xs text-error"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>Not saved: {saveError}. Your draft is preserved.</span>
        </div>
      )}

      {/* Grid */}
      <div className="flex-1 overflow-auto p-4" ref={gridRef}>
        {isEmpty ? (
          <div
            className="flex h-full items-center justify-center text-text-secondary"
            data-testid="sheet-empty-state"
          >
            <div className="text-center">
              <p className="text-sm">This sheet is empty.</p>
              <p className="text-xs mt-1 text-text-secondary/60">
                Add a column and a row to get started.
              </p>
              <div className="mt-3 flex justify-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Plus className="h-3 w-3" />}
                  onClick={addColumn}
                >
                  Add Column
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Plus className="h-3 w-3" />}
                  onClick={addRow}
                >
                  Add Row
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="inline-block min-w-full">
            <table className="border-separate border-spacing-0" role="grid">
              <thead>
                <tr>
                  <th
                    className="w-8 border-b border-r border-white/[0.06] bg-surface/80 px-1 py-1 text-center text-[10px] text-text-secondary sticky left-0 z-10"
                    scope="col"
                  >
                    #
                  </th>
                  {columns.map((col, colIndex) => (
                    <th
                      key={col.id}
                      scope="col"
                      className="border-b border-r border-white/[0.06] bg-surface/80 px-1 py-1 min-w-[120px]"
                    >
                      <div className="flex items-center gap-1">
                        <input
                          value={col.key}
                          onChange={(e) =>
                            updateColumnKey(colIndex, e.target.value)
                          }
                          aria-label={`Column ${colIndex + 1} key`}
                          className="w-full bg-transparent text-xs font-semibold text-text-primary font-display outline-none focus:ring-1 focus:ring-accent/30 rounded px-1 py-0.5"
                        />
                        <button
                          onClick={() => deleteColumn(colIndex)}
                          className="shrink-0 text-text-secondary hover:text-error transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-error/40 rounded"
                          aria-label={`Delete column ${col.key}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </th>
                  ))}
                  <th className="border-b border-white/[0.06] bg-surface/80 px-1 py-1 w-8">
                    <button
                      onClick={addColumn}
                      className="text-text-secondary hover:text-accent transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded"
                      aria-label="Add column"
                    >
                      <Plus className="h-3.5 w-3.5" />
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, rowIndex) => (
                  <tr key={row.id}>
                    <td
                      className="border-b border-r border-white/[0.06] bg-surface/80 px-1 py-1 text-center text-[10px] text-text-secondary sticky left-0 z-10"
                    >
                      <div className="flex items-center justify-center gap-0.5">
                        <span>{rowIndex + 1}</span>
                        <button
                          onClick={() => deleteRow(rowIndex)}
                          className="text-text-secondary hover:text-error transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-error/40 rounded"
                          aria-label={`Delete row ${rowIndex + 1}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </td>
                    {columns.map((col, colIndex) => {
                      const cell = row.cells[col.key];
                      const value = cell?.value ?? "";
                      const displayValue =
                        value === null ? "" : String(value);
                      return (
                        <td
                          key={col.id}
                          className="border-b border-r border-white/[0.06]"
                        >
                          <input
                            data-cell-row={rowIndex}
                            data-cell-col={colIndex}
                            value={displayValue}
                            onChange={(e) =>
                              updateCell(rowIndex, col.key, e.target.value)
                            }
                            onFocus={() =>
                              setFocusedCell({ row: rowIndex, col: colIndex })
                            }
                            onKeyDown={(e) =>
                              handleCellKeyDown(e, rowIndex, colIndex)
                            }
                            aria-label={`Row ${rowIndex + 1}, column ${col.key}`}
                            className={clsx(
                              "w-full bg-transparent px-2 py-1.5 text-sm text-text-primary outline-none focus:ring-1 focus:ring-accent/30 focus:bg-accent/[0.04] rounded-sm",
                            )}
                          />
                        </td>
                      );
                    })}
                    <td className="border-b border-white/[0.06]" />
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={columns.length + 2} className="py-1">
                    <button
                      onClick={addRow}
                      className="flex items-center gap-1 px-2 py-1 text-xs text-text-secondary hover:text-accent transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/40 rounded"
                      aria-label="Add row"
                    >
                      <Plus className="h-3 w-3" />
                      Add row
                    </button>
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Dirty indicator */}
      {isDirty && (
        <div className="shrink-0 border-t border-white/[0.04] px-4 py-1.5 text-xs text-text-secondary">
          Unsaved changes — press Ctrl/Cmd+S to save
        </div>
      )}
    </div>
  );
}
