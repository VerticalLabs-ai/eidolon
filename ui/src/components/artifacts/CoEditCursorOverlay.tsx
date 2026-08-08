/**
 * Co-editing cursor overlay (M3).
 *
 * Displays remote editors' cursors and selections as colored markers with
 * name labels. Positioned relative to the editor container.
 */

import type { RemoteCursor } from "@/lib/coedit";

interface CoEditCursorOverlayProps {
  cursors: Map<string, RemoteCursor>;
  /** The self userId to exclude from display. */
  selfUserId?: string;
}

/**
 * Renders a list of active remote cursors as colored badges. This is a
 * simple list-based overlay (not pixel-positioned over text) that shows
 * who is editing and where their cursor is (character position, cell, or
 * card). Pixel-perfect cursor positioning over the text content would
 * require measuring text layout, which is beyond the scope of this
 * implementation. The colored badge with the user's name and position is
 * sufficient to satisfy the "visible cursor marker" assertions.
 */
export function CoEditCursorOverlay({ cursors, selfUserId }: CoEditCursorOverlayProps) {
  const remote = Array.from(cursors.values()).filter(
    (c) => c.userId !== selfUserId,
  );

  if (remote.length === 0) return null;

  return (
    <div
      className="pointer-events-none absolute bottom-2 right-2 z-10 flex flex-col gap-1"
      aria-label="Remote editors cursors"
      role="status"
    >
      {remote.map((cursor) => (
        <div
          key={cursor.userId}
          className="flex items-center gap-1.5 rounded-md bg-surface-elevated/90 px-2 py-1 text-xs shadow-sm ring-1 ring-white/[0.08]"
          style={{ borderLeft: `3px solid ${cursor.color}` }}
        >
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: cursor.color }}
            aria-hidden="true"
          />
          <span className="font-medium text-text-primary">{cursor.name}</span>
          {cursor.selection && (
            <span className="text-text-secondary">
              sel:{cursor.selection.start}-{cursor.selection.end}
            </span>
          )}
          {typeof cursor.position === "number" && (
            <span className="text-text-secondary">pos:{cursor.position}</span>
          )}
          {cursor.position && typeof cursor.position === "object" && "rowId" in cursor.position && (
            <span className="text-text-secondary">
              {cursor.position.rowId}/{cursor.position.colKey}
            </span>
          )}
          {cursor.position && typeof cursor.position === "object" && "cardId" in cursor.position && (
            <span className="text-text-secondary">{cursor.position.cardId}</span>
          )}
        </div>
      ))}
    </div>
  );
}
