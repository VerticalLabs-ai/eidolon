export interface DirtyEditorGuard {
  isDirty: () => boolean;
  save: () => Promise<void>;
  discard: () => void;
}

let activeGuard: DirtyEditorGuard | null = null;

export function setDirtyEditorGuard(guard: DirtyEditorGuard | null): void {
  activeGuard = guard;
}

export function getDirtyEditorGuard(): DirtyEditorGuard | null {
  return activeGuard?.isDirty() ? activeGuard : null;
}
