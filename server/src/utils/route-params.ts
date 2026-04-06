import type { Request } from "express";

/** Normalize Express `req.params` to plain strings (mergeParams + Express 5 typings). */
export function routeParams(req: Request): Record<string, string> {
  const raw = req.params as Record<string, string | string[] | undefined>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = Array.isArray(v) ? (v[0] ?? "") : (v ?? "");
  }
  return out;
}
