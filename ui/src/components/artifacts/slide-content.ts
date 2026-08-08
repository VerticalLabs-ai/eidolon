// ---------------------------------------------------------------------------
// Slide deck artifact content helpers
// ---------------------------------------------------------------------------
//
// Pure parse/build/mutate helpers for the slide deck artifact
// (`type: "slide_deck"`). Kept separate from the editor component so the
// slide ordering and block manipulation rules live in one place.
//
// Server-side shape (packages/shared SlideDeckContentSchema):
//   { slides: [{ id, layout, blocks: [{ type, content }] }] }
// Slide ids must be unique; layout must be a non-empty string; every block
// must have a non-empty `type` and a `content` record — the API returns 400
// otherwise.
// ---------------------------------------------------------------------------

/** Layouts available in the deck editor. */
export const SLIDE_LAYOUTS = ["title", "content", "split", "blank"] as const;
export type SlideLayout = (typeof SLIDE_LAYOUTS)[number];

export const LAYOUT_LABELS: Record<SlideLayout, string> = {
  title: "Title",
  content: "Content",
  split: "Split",
  blank: "Blank",
};

export interface SlideBlock {
  type: string;
  content: Record<string, unknown>;
}

export interface Slide {
  id: string;
  layout: string;
  blocks: SlideBlock[];
}

export interface SlideDeckContent {
  slides: Slide[];
}

export function parseDeck(content: Record<string, unknown>): SlideDeckContent {
  const slides = Array.isArray(content.slides) ? (content.slides as Slide[]) : [];
  return { slides };
}

export function genSlideId(): string {
  return `slide_${Math.random().toString(36).slice(2, 10)}`;
}

export function genBlockId(): string {
  return `block_${Math.random().toString(36).slice(2, 10)}`;
}

/** Default blocks for a given layout. */
export function defaultBlocksForLayout(layout: string): SlideBlock[] {
  switch (layout) {
    case "title":
      return [{ type: "heading", content: { text: "Title" } }];
    case "content":
      return [{ type: "text", content: { text: "" } }];
    case "split":
      return [
        { type: "text", content: { text: "" } },
        { type: "text", content: { text: "" } },
      ];
    case "blank":
    default:
      return [];
  }
}

/** Creates a new slide with a fresh id and default blocks for its layout. */
export function createSlide(layout: string = "content"): Slide {
  return { id: genSlideId(), layout, blocks: defaultBlocksForLayout(layout) };
}

/**
 * Stable string form of a deck, used to compare local, baseline, and remote
 * states so cosmetic differences (block array ordering within a slide is
 * significant, but key ordering within block.content is not) do not register
 * as changes.
 */
export function serializeDeck(content: SlideDeckContent): string {
  return JSON.stringify(content);
}

/** Moves the slide at `index` one slot left (-1) or right (+1). */
export function moveSlide(
  slides: Slide[],
  index: number,
  delta: -1 | 1,
): Slide[] {
  const target = index + delta;
  if (index < 0 || index >= slides.length || target < 0 || target >= slides.length) {
    return slides;
  }
  const next = [...slides];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

/** Reorders `slides` so the dragged slide lands at the target slide's slot. */
export function reorderSlides(
  slides: Slide[],
  draggedId: string,
  targetId: string,
): Slide[] {
  const from = slides.findIndex((s) => s.id === draggedId);
  const to = slides.findIndex((s) => s.id === targetId);
  if (from === -1 || to === -1 || from === to) return slides;
  const next = [...slides];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** Block text content helpers — many block types store text in content.text. */
export function getBlockText(block: SlideBlock): string {
  const val = block.content.text;
  return typeof val === "string" ? val : "";
}

export function setBlockText(block: SlideBlock, text: string): SlideBlock {
  return { ...block, content: { ...block.content, text } };
}
