export interface DirtyEditorGuard {
  isDirty: () => boolean;
  /** Returns true on success, false on failure (error is surfaced in the editor). */
  save: () => Promise<boolean>;
  discard: () => void;
}

let activeGuard: DirtyEditorGuard | null = null;

export function setDirtyEditorGuard(guard: DirtyEditorGuard | null): void {
  activeGuard = guard;
}

export function getDirtyEditorGuard(): DirtyEditorGuard | null {
  return activeGuard?.isDirty() ? activeGuard : null;
}
