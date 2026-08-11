import type { ArtifactType } from "@/lib/api";

/** Human label for an artifact type, used in titles and toasts. */
const TYPE_LABELS: Partial<Record<ArtifactType, string>> = {
  document: "Document",
  sheet: "Sheet",
  board: "Board",
  slide_deck: "Slides",
  timeline: "Timeline",
  gallery: "Gallery",
  dashboard: "Dashboard",
  app: "App",
  code: "Code",
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
    case "timeline":
      return {
        tasks: [
          {
            id: "task_1",
            title: "",
            start: new Date().toISOString().slice(0, 10),
            end: new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10),
            progress: 0,
          },
        ],
      };
    case "gallery":
      return { items: [] };
    case "dashboard":
      return { dataSources: [], widgets: [] };
    case "app":
      return {
        definition: { name: "", entrypoint: "index.html" },
        files: [{ path: "index.html", content: "" }],
      };
    case "code":
      return {
        language: "javascript",
        files: [{ path: "main.js", content: "console.log('hello');\n" }],
      };
    case "document":
    default:
      return { format: "markdown", body: "" };
  }
}
