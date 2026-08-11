// Helpers for parsing/serializing app artifact content and mutating the
// definition + file list. Kept in a side module so the editor component
// stays focused on rendering (mirrors gallery/dashboard-content.ts).

export interface AppDefinition {
  name?: string;
  entrypoint?: string;
  [key: string]: unknown;
}

export interface AppFile {
  path: string;
  content: string;
}

export interface AppContent {
  definition: AppDefinition;
  files: AppFile[];
}

/** Parse an artifact's raw content into a normalized app shape. */
export function parseApp(content: Record<string, unknown>): AppContent {
  const definition = (content.definition ?? {}) as AppDefinition;
  const files = Array.isArray(content.files) ? (content.files as AppFile[]) : [];
  return { definition, files };
}

/** Serialize app content to a stable JSON string for baseline comparison. */
export function serializeApp(a: AppContent): string {
  return JSON.stringify(a);
}

/** Generate a file path that is unique within the given list. */
export function genFilePath(existing: { path: string }[] = []): string {
  const taken = new Set(existing.map((f) => f.path));
  let n = 1;
  while (taken.has(`file-${n}.html`)) n += 1;
  return `file-${n}.html`;
}

/** Build a fresh, schema-valid app file. */
export function createFile(existing: { path: string }[] = []): AppFile {
  return { path: genFilePath(existing), content: '' };
}

/** Insert a file at an arbitrary index, returning a new array. */
export function insertFile(
  files: AppFile[],
  index: number,
  file: AppFile,
): AppFile[] {
  const next = [...files];
  next.splice(index, 0, file);
  return next;
}

/** Delete the file with the given path. */
export function deleteFile(files: AppFile[], path: string): AppFile[] {
  return files.filter((f) => f.path !== path);
}

/** Patch a single file by path. */
export function updateFile(
  files: AppFile[],
  path: string,
  patch: Partial<AppFile>,
): AppFile[] {
  return files.map((f) => (f.path === path ? { ...f, ...patch } : f));
}

/** Find a file by path. */
export function findFile(files: AppFile[], path: string): AppFile | undefined {
  return files.find((f) => f.path === path);
}

/**
 * Build the preview document for the app's entrypoint file. The preview is
 * rendered in a sandboxed iframe using srcdoc. If the entrypoint is an HTML
 * file, its content is used directly. Otherwise, the content is wrapped in a
 * minimal HTML document. When no entrypoint is set, the first HTML file is
 * used, or the first file as a fallback.
 */
export function buildPreviewDoc(app: AppContent): string {
  const entrypoint = app.definition.entrypoint?.trim() || '';
  let target: AppFile | undefined;
  if (entrypoint) {
    target = findFile(app.files, entrypoint);
  }
  if (!target) {
    // Fallback: first .html file, or just the first file
    target = app.files.find((f) => f.path.endsWith('.html')) ?? app.files[0];
  }
  if (!target) {
    return '<!DOCTYPE html><html><body style="font-family:system-ui;color:#888;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#0d0d0f"><p>No files to preview</p></body></html>';
  }
  if (target.path.endsWith('.html') || target.path.endsWith('.htm')) {
    return target.content;
  }
  // Wrap non-HTML content in a <pre> for display
  const escaped = target.content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!DOCTYPE html><html><body style="font-family:monospace;color:#ccc;white-space:pre-wrap;padding:1rem;margin:0;background:#0d0d0f">${escaped}</body></html>`;
}
