import type { ArtifactType } from "@/lib/api";

/** Human label for an artifact type, used in titles and toasts. */
const TYPE_LABELS: Partial<Record<ArtifactType, string>> = {
  document: "Document",
  sheet: "Sheet",
  board: "Board",
  slide_deck: "Slides",
};

export function artifactTypeLabel(type: ArtifactType): string {
  return TYPE_LABELS[type] ?? "Artifact";
}

/**
 * Starter content for a newly created artifact. It must already satisfy the
 * type's server-side Zod schema so the create call succeeds without an edit.
 */
export function defaultArtifactContent(type: ArtifactType): Record<string, unknown> {
  switch (type) {
    case "sheet":
      return {
        columns: [{ id: "col_1", key: "column1" }],
        rows: [{ id: "row_1", cells: { column1: { value: "" } } }],
      };
    case "board":
      return {
        columns: [
          { id: "col_todo", title: "Todo" },
          { id: "col_doing", title: "In Progress" },
          { id: "col_done", title: "Done" },
        ],
        cards: [],
      };
    case "slide_deck":
      return {
        slides: [
          {
            id: "slide_1",
            layout: "title",
            blocks: [{ type: "heading", content: { text: "" } }],
          },
        ],
      };
    case "document":
    default:
      return { format: "markdown", body: "" };
  }
}
