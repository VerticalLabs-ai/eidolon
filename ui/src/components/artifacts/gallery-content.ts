// Helpers for parsing/serializing gallery artifact content and mutating
// the items list. Kept in a side module so the editor component stays
// focused on rendering (mirrors board/slide/timeline-content.ts).

export interface GalleryItem {
  id: string;
  type: 'image' | 'video';
  url: string;
  caption?: string;
}

export interface GalleryContent {
  items: GalleryItem[];
}

const ITEM_ID_PREFIX = 'item_';

/** Generate a gallery item id that is unique within the given list. */
export function genItemId(existing: { id: string }[] = []): string {
  const taken = new Set(existing.map((i) => i.id));
  let n = 1;
  while (taken.has(`${ITEM_ID_PREFIX}${n}`)) n += 1;
  return `${ITEM_ID_PREFIX}${n}`;
}

/** Parse an artifact's raw content into a normalized gallery shape. */
export function parseGallery(content: Record<string, unknown>): GalleryContent {
  const items = Array.isArray(content.items) ? (content.items as GalleryItem[]) : [];
  return { items };
}

/** Serialize gallery content to a stable JSON string for baseline comparison. */
export function serializeGallery(g: GalleryContent): string {
  return JSON.stringify(g);
}

/** Build a fresh, schema-valid gallery item. */
export function createItem(existing: { id: string }[] = []): GalleryItem {
  return { id: genItemId(existing), type: 'image', url: '', caption: undefined };
}

/** Insert an item at an arbitrary index, returning a new array. */
export function insertItem(
  items: GalleryItem[],
  index: number,
  item: GalleryItem,
): GalleryItem[] {
  const next = [...items];
  next.splice(index, 0, item);
  return next;
}

/** Delete the item with the given id. */
export function deleteItem(items: GalleryItem[], id: string): GalleryItem[] {
  return items.filter((i) => i.id !== id);
}

/** Move an item up (toward index 0). No-op at the top. */
export function moveUp(items: GalleryItem[], id: string): GalleryItem[] {
  const index = items.findIndex((i) => i.id === id);
  if (index <= 0) return items;
  const next = [...items];
  [next[index - 1], next[index]] = [next[index], next[index - 1]];
  return next;
}

/** Move an item down (toward the end). No-op at the bottom. */
export function moveDown(items: GalleryItem[], id: string): GalleryItem[] {
  const index = items.findIndex((i) => i.id === id);
  if (index < 0 || index >= items.length - 1) return items;
  const next = [...items];
  [next[index + 1], next[index]] = [next[index], next[index + 1]];
  return next;
}

/** Patch a single item by id. */
export function updateItem(
  items: GalleryItem[],
  id: string,
  patch: Partial<GalleryItem>,
): GalleryItem[] {
  return items.map((i) => (i.id === id ? { ...i, ...patch } : i));
}
