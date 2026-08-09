// Helpers for parsing/serializing code artifact content and mutating the
// file list. Mirrors app-content.ts / gallery-content.ts so the editor
// component stays focused on rendering.

export interface CodeFile {
  path: string;
  content: string;
}

export interface CodeContent {
  language: string;
  entrypoint?: string;
  files: CodeFile[];
}

/** Parse an artifact's raw content into a normalized code shape. */
export function parseCode(content: Record<string, unknown>): CodeContent {
  const language = typeof content.language === 'string' ? content.language : 'javascript';
  const entrypoint = typeof content.entrypoint === 'string' ? content.entrypoint : undefined;
  const files = Array.isArray(content.files) ? (content.files as CodeFile[]) : [];
  return { language, entrypoint, files };
}

/** Serialize code content to a stable JSON string for baseline comparison. */
export function serializeCode(c: CodeContent): string {
  return JSON.stringify({
    language: c.language,
    entrypoint: c.entrypoint,
    files: c.files,
  });
}

/** Generate a file path that is unique within the given list. */
export function genCodeFilePath(
  existing: { path: string }[] = [],
  language: string,
): string {
  const ext = language === 'python' ? 'py' : language === 'typescript' ? 'ts' : 'js';
  const taken = new Set(existing.map((f) => f.path));
  let n = 1;
  while (taken.has(`main-${n}.${ext}`)) n += 1;
  return `main-${n}.${ext}`;
}

/** Build a fresh, schema-valid code file. */
export function createCodeFile(
  existing: { path: string }[] = [],
  language: string,
): CodeFile {
  return { path: genCodeFilePath(existing, language), content: '' };
}

/** Insert a file at an arbitrary index, returning a new array. */
export function insertCodeFile(
  files: CodeFile[],
  index: number,
  file: CodeFile,
): CodeFile[] {
  const next = [...files];
  next.splice(index, 0, file);
  return next;
}

/** Delete the file with the given path. */
export function deleteCodeFile(files: CodeFile[], path: string): CodeFile[] {
  return files.filter((f) => f.path !== path);
}

/** Patch a single file by path. */
export function updateCodeFile(
  files: CodeFile[],
  path: string,
  patch: Partial<CodeFile>,
): CodeFile[] {
  return files.map((f) => (f.path === path ? { ...f, ...patch } : f));
}

/** Find a file by path. */
export function findCodeFile(
  files: CodeFile[],
  path: string,
): CodeFile | undefined {
  return files.find((f) => f.path === path);
}

/** The supported languages (must match @eidolon/shared CodeLanguageSchema). */
export const CODE_LANGUAGES = ['javascript', 'typescript', 'python'] as const;
export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

/** Map a code language to a Prism-style css class suffix for highlighting. */
export function languageClass(language: string): string {
  if (language === 'python') return 'language-python';
  if (language === 'typescript') return 'language-typescript';
  return 'language-javascript';
}
