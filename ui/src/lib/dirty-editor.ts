export interface DirtyEditorGuard {
  isDirty: () => boolean;
  /** Returns true on success, false on failure (error is surfaced in the editor). */
  save: () => Promise<boolean>;
  discard: () => void;
}

let activeGuard: DirtyEditorGuard | null = null;

function handleBeforeUnload(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = "";
}

export function setDirtyEditorGuard(guard: DirtyEditorGuard | null): void {
  if (activeGuard && !guard?.isDirty()) {
    window.removeEventListener("beforeunload", handleBeforeUnload);
  }

  activeGuard = guard;

  if (guard?.isDirty()) {
    window.addEventListener("beforeunload", handleBeforeUnload);
  }
}

export function getDirtyEditorGuard(): DirtyEditorGuard | null {
  return activeGuard?.isDirty() ? activeGuard : null;
}
