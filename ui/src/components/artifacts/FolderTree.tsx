import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import {
  Folder as FolderIcon,
  FolderOpen,
  FolderPlus,
  ChevronRight,
  ChevronDown,
  Pencil,
  Trash2,
  Home,
  FileText,
  Check,
  X,
} from 'lucide-react';
import { clsx } from 'clsx';
import { toast } from 'sonner';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import {
  useCreateFolder,
  useUpdateFolder,
  useDeleteFolder,
  useMoveArtifactToFolder,
} from '@/lib/hooks';
import { usePermission } from '@/lib/permissions';
import type { ArtifactFolder } from '@/lib/api';

// ---------------------------------------------------------------------------
// Tree helpers
// ---------------------------------------------------------------------------

interface TreeNode extends ArtifactFolder {
  children: TreeNode[];
}

/** Build a nested tree from a flat folder list. */
export function buildFolderTree(folders: ArtifactFolder[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const f of folders) {byId.set(f.id, { ...f, children: [] });}
  const roots: TreeNode[] = [];
  for (const f of folders) {
    const node = byId.get(f.id)!;
    if (f.parentId && byId.has(f.parentId)) {
      byId.get(f.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  // Sort each level by name.
  const sortRec = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    nodes.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

/** Compute the ancestor chain (root → ... → folder) for a given folder id. */
export function folderAncestry(
  folders: ArtifactFolder[],
  folderId: string | null,
): ArtifactFolder[] {
  if (!folderId) {return [];}
  const byId = new Map(folders.map((f) => [f.id, f]));
  const chain: ArtifactFolder[] = [];
  let current: string | null = folderId;
  const seen = new Set<string>();
  while (current && !seen.has(current)) {
    seen.add(current);
    const f = byId.get(current);
    if (!f) {break;}
    chain.unshift(f);
    current = f.parentId;
  }
  return chain;
}

// ---------------------------------------------------------------------------
// FolderTree
// ---------------------------------------------------------------------------

interface FolderTreeProps {
  companyId: string;
  projectId: string | null;
  folders: ArtifactFolder[];
  selectedFolderId: string | null;
  /** "all" = show all artifacts; a folder id = scoped; null = unfiled. */
  selectionMode: 'all' | 'folder' | 'unfiled';
  onSelectAll: () => void;
  onSelectFolder: (folderId: string) => void;
  onSelectUnfiled: () => void;
}

export function FolderTree({
  companyId,
  projectId,
  folders,
  selectedFolderId,
  selectionMode,
  onSelectAll,
  onSelectFolder,
  onSelectUnfiled,
}: FolderTreeProps) {
  const tree = useMemo(() => buildFolderTree(folders), [folders]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [creatingUnder, setCreatingUnder] = useState<string | null | undefined>(undefined);
  const [newName, setNewName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ArtifactFolder | null>(null);

  const { hasPermission } = usePermission(companyId);
  const canCreateFolder = hasPermission('content.create');
  const canUpdateFolder = hasPermission('content.update');
  const canDeleteFolder = hasPermission('content.delete');

  const createMutation = useCreateFolder(companyId);
  const updateMutation = useUpdateFolder(companyId);
  const deleteMutation = useDeleteFolder(companyId);

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {next.delete(id);}
      else {next.add(id);}
      return next;
    });
  }, []);

  const handleCreate = useCallback(
    async (parentId: string | null) => {
      const name = newName.trim();
      if (!name) {return;}
      try {
        await createMutation.mutateAsync({ name, projectId, parentId });
        setNewName('');
        setCreatingUnder(undefined);
        if (parentId) {setExpanded((prev) => new Set(prev).add(parentId));}
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Create failed';
        toast.error(msg);
      }
    },
    [createMutation, newName, projectId],
  );

  const handleRename = useCallback(
    async (folderId: string) => {
      const name = renameValue.trim();
      if (!name) {return;}
      try {
        await updateMutation.mutateAsync({ id: folderId, name });
        setRenamingId(null);
        setRenameValue('');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Rename failed';
        toast.error(msg);
      }
    },
    [updateMutation, renameValue],
  );

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) {return;}
    try {
      await deleteMutation.mutateAsync(deleteTarget.id);
      toast.success(`Folder "${deleteTarget.name}" deleted`);
      setDeleteTarget(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Delete failed';
      toast.error(msg);
    }
  }, [deleteMutation, deleteTarget]);

  const startCreate = useCallback((parentId: string | null) => {
    setCreatingUnder(parentId);
    setNewName('');
  }, []);

  const startRename = useCallback((folder: ArtifactFolder) => {
    setRenamingId(folder.id);
    setRenameValue(folder.name);
  }, []);

  // Auto-expand the selected folder's ancestors so it's visible.
  useEffect(() => {
    if (!selectedFolderId) {return;}
    const ancestry = folderAncestry(folders, selectedFolderId);
    if (ancestry.length <= 1) {return;}
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const f of ancestry.slice(0, -1)) {next.add(f.id);}
      return next;
    });
  }, [selectedFolderId, folders]);

  const renderNode = (node: TreeNode, depth: number) => {
    const isExpanded = expanded.has(node.id);
    const isSelected = selectionMode === 'folder' && selectedFolderId === node.id;
    const hasChildren = node.children.length > 0;
    return (
      <li
        key={node.id}
        role="treeitem"
        aria-expanded={hasChildren ? isExpanded : undefined}
        aria-selected={isSelected}
      >
        <div
          className={clsx(
            'group flex items-center gap-1 rounded-lg pr-1 transition-colors cursor-pointer',
            isSelected
              ? 'bg-accent/10 text-text-primary'
              : 'hover:bg-white/[0.03] text-text-secondary',
          )}
          style={{ paddingLeft: depth * 12 + 4 }}
        >
          <button
            onClick={() => hasChildren && toggle(node.id)}
            className={clsx(
              'shrink-0 rounded p-0.5 text-text-secondary hover:text-text-primary',
              !hasChildren && 'invisible',
            )}
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
            tabIndex={-1}
          >
            {isExpanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            onClick={() => onSelectFolder(node.id)}
            className="flex min-w-0 flex-1 items-center gap-1.5 py-1.5 text-left text-xs"
          >
            {isExpanded ? (
              <FolderOpen className="h-3.5 w-3.5 shrink-0 text-accent/70" />
            ) : (
              <FolderIcon className="h-3.5 w-3.5 shrink-0 text-accent/70" />
            )}
            {renamingId === node.id ? (
              <span className="flex flex-1 items-center gap-1">
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {void handleRename(node.id);}
                    if (e.key === 'Escape') {
                      setRenamingId(null);
                      setRenameValue('');
                    }
                  }}
                  className="w-full rounded border border-accent/40 bg-surface px-1 py-0.5 text-xs text-text-primary outline-none"
                  onClick={(e) => e.stopPropagation()}
                />
                <button
                  onClick={() => void handleRename(node.id)}
                  className="text-accent hover:text-neon-cyan"
                  aria-label="Confirm rename"
                >
                  <Check className="h-3 w-3" />
                </button>
                <button
                  onClick={() => {
                    setRenamingId(null);
                    setRenameValue('');
                  }}
                  className="text-text-secondary hover:text-error"
                  aria-label="Cancel rename"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ) : (
              <span className="truncate">{node.name}</span>
            )}
          </button>
          {renamingId !== node.id && (
            <div className="flex shrink-0 items-center opacity-0 group-hover:opacity-100 transition-opacity">
              {canCreateFolder && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    startCreate(node.id);
                  }}
                  className="rounded p-0.5 text-text-secondary hover:text-neon-cyan"
                  aria-label={`Add subfolder to ${node.name}`}
                  title="New subfolder"
                >
                  <FolderPlus className="h-3 w-3" />
                </button>
              )}
              {canUpdateFolder && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    startRename(node);
                  }}
                  className="rounded p-0.5 text-text-secondary hover:text-neon-cyan"
                  aria-label={`Rename ${node.name}`}
                  title="Rename"
                >
                  <Pencil className="h-3 w-3" />
                </button>
              )}
              {canDeleteFolder && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteTarget(node);
                  }}
                  className="rounded p-0.5 text-text-secondary hover:text-error"
                  aria-label={`Delete ${node.name}`}
                  title="Delete"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              )}
            </div>
          )}
        </div>
        {hasChildren && isExpanded && (
          <ul role="group" className="space-y-0.5">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </ul>
        )}
        {creatingUnder === node.id && (
          <div
            className="flex items-center gap-1 py-1"
            style={{ paddingLeft: (depth + 1) * 12 + 4 }}
          >
            <FolderPlus className="h-3.5 w-3.5 shrink-0 text-accent/70" />
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {void handleCreate(node.id);}
                if (e.key === 'Escape') {
                  setCreatingUnder(undefined);
                  setNewName('');
                }
              }}
              placeholder="Folder name"
              className="w-full rounded border border-accent/40 bg-surface px-1.5 py-0.5 text-xs text-text-primary outline-none placeholder:text-text-secondary/40"
            />
            <button
              onClick={() => void handleCreate(node.id)}
              className="text-accent hover:text-neon-cyan"
              aria-label="Confirm create"
            >
              <Check className="h-3 w-3" />
            </button>
            <button
              onClick={() => {
                setCreatingUnder(undefined);
                setNewName('');
              }}
              className="text-text-secondary hover:text-error"
              aria-label="Cancel create"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
      </li>
    );
  };

  const allSelected = selectionMode === 'all';
  const unfiledSelected = selectionMode === 'unfiled';

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-2 py-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary font-display">
          Folders
        </h3>
        {canCreateFolder && (
          <button
            onClick={() => startCreate(null)}
            className="rounded p-1 text-text-secondary hover:text-neon-cyan hover:bg-white/[0.05] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            aria-label="New top-level folder"
            title="New folder"
          >
            <FolderPlus className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-1 pb-2">
        <ul role="tree" className="space-y-0.5">
          <li role="treeitem" aria-selected={allSelected}>
            <button
              onClick={onSelectAll}
              className={clsx(
                'flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                allSelected
                  ? 'bg-accent/10 text-text-primary'
                  : 'hover:bg-white/[0.03] text-text-secondary',
              )}
            >
              <Home className="h-3.5 w-3.5 shrink-0" />
              <span>All artifacts</span>
            </button>
          </li>
          <li role="treeitem" aria-selected={unfiledSelected}>
            <button
              onClick={onSelectUnfiled}
              className={clsx(
                'flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                unfiledSelected
                  ? 'bg-accent/10 text-text-primary'
                  : 'hover:bg-white/[0.03] text-text-secondary',
              )}
            >
              <FileText className="h-3.5 w-3.5 shrink-0" />
              <span>Unfiled</span>
            </button>
          </li>
          {tree.map((node) => renderNode(node, 0))}
        </ul>
        {creatingUnder === null && (
          <div className="flex items-center gap-1 px-2 py-1">
            <FolderPlus className="h-3.5 w-3.5 shrink-0 text-accent/70" />
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {void handleCreate(null);}
                if (e.key === 'Escape') {
                  setCreatingUnder(undefined);
                  setNewName('');
                }
              }}
              placeholder="Folder name"
              className="w-full rounded border border-accent/40 bg-surface px-1.5 py-0.5 text-xs text-text-primary outline-none placeholder:text-text-secondary/40"
            />
            <button
              onClick={() => void handleCreate(null)}
              className="text-accent hover:text-neon-cyan"
              aria-label="Confirm create"
            >
              <Check className="h-3 w-3" />
            </button>
            <button
              onClick={() => {
                setCreatingUnder(undefined);
                setNewName('');
              }}
              className="text-text-secondary hover:text-error"
              aria-label="Cancel create"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        {folders.length === 0 && creatingUnder === undefined && (
          <p className="px-3 py-2 text-xs text-text-secondary/60">
            No folders yet. Click + to create one.
          </p>
        )}
      </div>

      {/* Delete confirmation dialog */}
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Delete folder">
        <div className="space-y-4">
          <p className="text-sm text-text-secondary">
            Delete folder{' '}
            <span className="font-semibold text-text-primary">"{deleteTarget?.name}"</span>? Its
            contents (folders and artifacts) will be moved to the parent folder (or unfiled if
            top-level). No artifacts will be deleted.
          </p>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => void handleDeleteConfirm()}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'Deleting...' : 'Delete folder'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// FolderBreadcrumbs
// ---------------------------------------------------------------------------

interface FolderBreadcrumbsProps {
  folders: ArtifactFolder[];
  selectedFolderId: string | null;
  selectionMode: 'all' | 'folder' | 'unfiled';
  onNavigate: (folderId: string | null, mode: 'all' | 'folder' | 'unfiled') => void;
}

export function FolderBreadcrumbs({
  folders,
  selectedFolderId,
  selectionMode,
  onNavigate,
}: FolderBreadcrumbsProps) {
  const ancestry = useMemo(
    () => folderAncestry(folders, selectedFolderId),
    [folders, selectedFolderId],
  );

  if (selectionMode === 'all') {
    return <span className="text-xs text-text-secondary">All artifacts</span>;
  }
  if (selectionMode === 'unfiled') {
    return <span className="text-xs text-text-secondary">Unfiled</span>;
  }

  return (
    <nav
      aria-label="Folder path"
      className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-text-secondary"
    >
      <button
        onClick={() => onNavigate(null, 'all')}
        className="hover:text-text-primary transition-colors"
      >
        All
      </button>
      {ancestry.map((f, i) => (
        <span key={f.id} className="flex items-center gap-1">
          <ChevronRight className="h-3 w-3 shrink-0 text-text-secondary/50" />
          <button
            onClick={() => onNavigate(f.id, 'folder')}
            className={clsx(
              'truncate transition-colors hover:text-text-primary',
              i === ancestry.length - 1 && 'text-text-primary font-medium',
            )}
          >
            {f.name}
          </button>
        </span>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// MoveArtifactMenu — a compact select to move an artifact into a folder
// ---------------------------------------------------------------------------

interface MoveArtifactMenuProps {
  companyId: string;
  artifactId: string;
  currentFolderId: string | null;
  folders: ArtifactFolder[];
  onSuccess?: () => void;
}

export function MoveArtifactMenu({
  companyId,
  artifactId,
  currentFolderId,
  folders,
  onSuccess,
}: MoveArtifactMenuProps) {
  const moveMutation = useMoveArtifactToFolder(companyId);
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleMove = useCallback(
    async (folderId: string | null) => {
      if (folderId === currentFolderId) {
        setOpen(false);
        return;
      }
      try {
        await moveMutation.mutateAsync({ artifactId, folderId });
        toast.success(folderId ? 'Moved to folder' : 'Moved to unfiled');
        setOpen(false);
        onSuccess?.();
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Move failed';
        toast.error(msg);
      }
    },
    [moveMutation, artifactId, currentFolderId, onSuccess],
  );

  const currentFolder = folders.find((f) => f.id === currentFolderId);
  const label = currentFolder ? currentFolder.name : 'Unfiled';

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setOpen((o) => !o)}
        className="rounded-md px-2 py-1 text-xs text-text-secondary hover:text-text-primary hover:bg-white/[0.05] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        aria-label={`Move artifact (currently ${label})`}
        title={`Move to folder (currently ${label})`}
      >
        <FolderIcon className="inline h-3 w-3 mr-1" />
        {label}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 max-h-64 w-56 overflow-y-auto rounded-lg border border-white/[0.08] bg-surface-raised p-1 shadow-xl shadow-black/40">
            <button
              onClick={() => void handleMove(null)}
              className={clsx(
                'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                currentFolderId === null ? 'text-accent' : 'text-text-secondary',
              )}
            >
              <FileText className="h-3 w-3" />
              Unfiled
              {currentFolderId === null && <Check className="ml-auto h-3 w-3" />}
            </button>
            <div className="my-1 border-t border-white/[0.06]" />
            {folders.length === 0 && (
              <p className="px-2 py-1.5 text-xs text-text-secondary/60">No folders</p>
            )}
            {folders.map((f) => (
              <button
                key={f.id}
                onClick={() => void handleMove(f.id)}
                className={clsx(
                  'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
                  currentFolderId === f.id ? 'text-accent' : 'text-text-secondary',
                )}
              >
                <FolderIcon className="h-3 w-3 shrink-0" />
                <span className="truncate">{f.name}</span>
                {currentFolderId === f.id && <Check className="ml-auto h-3 w-3 shrink-0" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
