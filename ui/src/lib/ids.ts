export function shortId(id?: string | null) {
  if (!id) return "";
  return id.slice(0, 8);
}
