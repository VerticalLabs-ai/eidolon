import { useState, useMemo } from "react";
import { useParams } from "react-router-dom";
import {
  FileText,
  Plus,
  Search,
  Hash,
  Trash2,
  Save,
  Eye,
  ChevronRight,
  Zap,
  Globe,
  History,
  ArrowRight,
  Sparkles,
} from "lucide-react";
import { clsx } from "clsx";
import {
  usePromptTemplates,
  useCreatePromptTemplate,
  useUpdatePromptTemplate,
  useDeletePromptTemplate,
  usePromptVersions,
  useApplyPromptToAgent,
  useAgents,
} from "@/lib/hooks";
import type { PromptTemplate, PromptVersion } from "@/lib/api";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/Input";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORIES = [
  { value: "", label: "All Categories" },
  { value: "general", label: "General" },
  { value: "engineering", label: "Engineering" },
  { value: "marketing", label: "Marketing" },
  { value: "leadership", label: "Leadership" },
  { value: "support", label: "Support" },
  { value: "design", label: "Design" },
  { value: "analytics", label: "Analytics" },
];

const CATEGORY_COLORS: Record<string, string> = {
  general: "default",
  engineering: "info",
  marketing: "warning",
  leadership: "success",
  support: "medium",
  design: "high",
  analytics: "low",
};

// ---------------------------------------------------------------------------
// Variable Highlighting Component
// ---------------------------------------------------------------------------

function HighlightedContent({ content }: { content: string }) {
  const parts = content.split(/(\{\{[^}]+\}\})/g);
  return (
    <div className="whitespace-pre-wrap text-sm leading-relaxed text-text-secondary font-mono">
      {parts.map((part, i) =>
        part.startsWith("{{") ? (
          <span
            key={i}
            className="inline-block rounded bg-accent/15 px-1.5 py-0.5 text-accent font-semibold text-xs"
          >
            {part}
          </span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Template List Item
// ---------------------------------------------------------------------------

function TemplateListItem({
  template,
  selected,
  onClick,
}: {
  template: PromptTemplate;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "w-full text-left rounded-lg px-3.5 py-3 transition-all duration-200 cursor-pointer group",
        selected
          ? "glass-raised border border-accent/20 shadow-[0_0_15px_rgba(245,158,11,0.06)]"
          : "hover:bg-white/[0.03] border border-transparent",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p
              className={clsx(
                "text-sm font-medium truncate font-display",
                selected ? "text-accent" : "text-text-primary",
              )}
            >
              {template.name}
            </p>
            {template.isGlobal ? (
              <Globe className="h-3 w-3 text-text-secondary shrink-0" />
            ) : null}
          </div>
          {template.description && (
            <p className="mt-0.5 text-xs text-text-secondary line-clamp-2">
              {template.description}
            </p>
          )}
          <div className="mt-2 flex items-center gap-2">
            <Badge
              variant={
                (CATEGORY_COLORS[template.category] as any) || "default"
              }
            >
              {template.category}
            </Badge>
            <span className="text-[10px] text-text-secondary flex items-center gap-1">
              <Hash className="h-2.5 w-2.5" />v{template.version}
            </span>
            <span className="text-[10px] text-text-secondary flex items-center gap-1">
              <Zap className="h-2.5 w-2.5" />
              {template.usageCount}
            </span>
          </div>
        </div>
        <ChevronRight
          className={clsx(
            "h-4 w-4 shrink-0 mt-0.5 transition-colors",
            selected ? "text-accent" : "text-text-secondary/50",
          )}
        />
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Version History Panel
// ---------------------------------------------------------------------------

function VersionHistory({
  companyId,
  templateId,
  onRestore,
}: {
  companyId: string;
  templateId: string;
  onRestore: (content: string) => void;
}) {
  const { data: versions } = usePromptVersions(companyId, templateId);

  if (!versions || versions.length === 0) {
    return (
      <p className="text-xs text-text-secondary italic">No version history</p>
    );
  }

  return (
    <div className="space-y-2 max-h-60 overflow-y-auto">
      {versions.map((v: PromptVersion) => (
        <div
          key={v.id}
          className="rounded-lg bg-white/[0.02] border border-white/[0.05] p-3 group"
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-accent">v{v.version}</span>
              <span className="text-[10px] text-text-secondary">
                {new Date(v.createdAt).toLocaleDateString()}
              </span>
            </div>
            <button
              onClick={() => onRestore(v.content)}
              className="text-[10px] text-text-secondary hover:text-accent transition-colors opacity-0 group-hover:opacity-100 cursor-pointer"
            >
              Restore
            </button>
          </div>
          {v.changeNote && (
            <p className="mt-1 text-xs text-text-secondary">{v.changeNote}</p>
          )}
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Apply to Agent Modal
// ---------------------------------------------------------------------------

function ApplyModal({
  open,
  onClose,
  companyId,
  template,
}: {
  open: boolean;
  onClose: () => void;
  companyId: string;
  template: PromptTemplate;
}) {
  const { data: agents } = useAgents(companyId);
  const applyMut = useApplyPromptToAgent(companyId);
  const [selectedAgent, setSelectedAgent] = useState("");
  const [applied, setApplied] = useState(false);

  const handleApply = async () => {
    if (!selectedAgent) return;
    await applyMut.mutateAsync({
      templateId: template.id,
      agentId: selectedAgent,
    });
    setApplied(true);
    setTimeout(() => {
      setApplied(false);
      onClose();
    }, 1500);
  };

  return (
    <Modal open={open} onClose={onClose} title="Apply Template to Agent">
      <div className="space-y-4">
        <div>
          <p className="text-xs text-text-secondary mb-2">
            This will set the selected agent's instructions to a rendered version
            of <span className="text-accent font-medium">"{template.name}"</span>.
            Variables like {"{{agent_name}}"} and {"{{company_name}}"} will be auto-filled.
          </p>
        </div>

        <div className="space-y-1.5">
          <label className="block text-sm font-medium text-text-secondary font-display">
            Target Agent
          </label>
          <select
            value={selectedAgent}
            onChange={(e) => setSelectedAgent(e.target.value)}
            className="w-full rounded-lg border border-white/[0.08] bg-surface/80 backdrop-blur-sm px-3 py-2 text-sm text-text-primary outline-none transition-all duration-300 focus:border-neon-cyan/40 cursor-pointer appearance-none"
          >
            <option value="">Select an agent...</option>
            {agents?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.role})
              </option>
            ))}
          </select>
        </div>

        {applied ? (
          <div className="rounded-lg bg-success/10 border border-success/20 p-3 text-center">
            <p className="text-sm text-success font-medium">
              Template applied successfully
            </p>
          </div>
        ) : (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              onClick={handleApply}
              disabled={!selectedAgent || applyMut.isPending}
              loading={applyMut.isPending}
              icon={<ArrowRight className="h-3.5 w-3.5" />}
            >
              Apply
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Preview Mode
// ---------------------------------------------------------------------------

function PreviewPanel({ content, variables }: { content: string; variables: string[] }) {
  const sampleValues: Record<string, string> = {
    agent_name: "Atlas",
    company_name: "Acme Corp",
    company_mission: "To build the future of AI-powered productivity.",
  };

  let rendered = content;
  for (const v of variables) {
    const value = sampleValues[v] || `[${v}]`;
    rendered = rendered.replace(new RegExp(`\\{\\{${v}\\}\\}`, "g"), value);
  }

  return (
    <div className="rounded-xl glass border border-white/[0.06] p-5">
      <div className="flex items-center gap-2 mb-3">
        <Eye className="h-4 w-4 text-accent" />
        <span className="text-xs font-medium text-text-primary font-display uppercase tracking-wide">
          Preview (Sample Variables)
        </span>
      </div>
      <div className="text-sm text-text-secondary whitespace-pre-wrap leading-relaxed max-h-96 overflow-y-auto">
        {rendered}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function PromptStudio() {
  const { companyId } = useParams();
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [showApply, setShowApply] = useState(false);
  const [showNewModal, setShowNewModal] = useState(false);

  // Editor state
  const [editName, setEditName] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editCategory, setEditCategory] = useState("general");
  const [editContent, setEditContent] = useState("");
  const [editVariables, setEditVariables] = useState<string[]>([]);
  const [changeNote, setChangeNote] = useState("");
  const [saved, setSaved] = useState(false);

  // New template form
  const [newName, setNewName] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newCategory, setNewCategory] = useState("general");
  const [newContent, setNewContent] = useState("");

  const { data: templates, isLoading } = usePromptTemplates(
    companyId,
    categoryFilter || undefined,
  );
  const createMut = useCreatePromptTemplate(companyId!);
  const updateMut = useUpdatePromptTemplate(companyId!);
  const deleteMut = useDeletePromptTemplate(companyId!);

  // Filter templates
  const filtered = useMemo(() => {
    if (!templates) return [];
    let list = templates;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      list = list.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.description?.toLowerCase().includes(q) ||
          t.category.toLowerCase().includes(q),
      );
    }
    return list;
  }, [templates, searchQuery]);

  const selected = useMemo(
    () => templates?.find((t) => t.id === selectedId) ?? null,
    [templates, selectedId],
  );

  // Auto-detect variables from content
  const detectVariables = (content: string): string[] => {
    const matches = content.match(/\{\{([^}]+)\}\}/g);
    if (!matches) return [];
    return [...new Set(matches.map((m) => m.slice(2, -2).trim()))];
  };

  const handleSelect = (template: PromptTemplate) => {
    setSelectedId(template.id);
    setEditName(template.name);
    setEditDescription(template.description ?? "");
    setEditCategory(template.category);
    setEditContent(template.content);
    setEditVariables(template.variables || []);
    setChangeNote("");
    setSaved(false);
    setShowPreview(false);
    setShowVersions(false);
  };

  const handleSave = async () => {
    if (!selectedId) return;
    const detectedVars = detectVariables(editContent);
    await updateMut.mutateAsync({
      templateId: selectedId,
      data: {
        name: editName,
        description: editDescription,
        category: editCategory,
        content: editContent,
        variables: detectedVars,
        changeNote: changeNote || undefined,
      },
    });
    setEditVariables(detectedVars);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  const handleDelete = async () => {
    if (!selectedId) return;
    if (!window.confirm("Delete this template? This cannot be undone.")) return;
    await deleteMut.mutateAsync(selectedId);
    setSelectedId(null);
  };

  const handleCreate = async () => {
    const detectedVars = detectVariables(newContent);
    const res = await createMut.mutateAsync({
      name: newName,
      description: newDescription || undefined,
      category: newCategory,
      content: newContent,
      variables: detectedVars,
    });
    setShowNewModal(false);
    setNewName("");
    setNewDescription("");
    setNewCategory("general");
    setNewContent("");
    // Select the newly created template
    const created = (res as any)?.data ?? res;
    if (created?.id) {
      handleSelect(created);
    }
  };

  return (
    <div className="flex h-full">
      {/* ------ Left Panel: Template List ------- */}
      <div className="w-80 shrink-0 flex flex-col border-r border-white/[0.06] bg-surface/50">
        {/* Header */}
        <div className="p-4 border-b border-white/[0.06]">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4.5 w-4.5 text-accent" />
              <h2 className="text-sm font-bold text-text-primary font-display tracking-wide">
                Prompt Studio
              </h2>
            </div>
            <Button
              size="sm"
              onClick={() => setShowNewModal(true)}
              icon={<Plus className="h-3.5 w-3.5" />}
            >
              New
            </Button>
          </div>

          {/* Search */}
          <div className="relative mb-2">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-secondary" />
            <input
              type="text"
              placeholder="Search templates..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-lg bg-white/[0.04] border border-white/[0.06] pl-8 pr-3 py-1.5 text-xs text-text-primary placeholder:text-text-secondary/50 outline-none focus:border-accent/30 transition-colors"
            />
          </div>

          {/* Category Filter */}
          <div className="flex gap-1 flex-wrap">
            {CATEGORIES.map((cat) => (
              <button
                key={cat.value}
                onClick={() => setCategoryFilter(cat.value)}
                className={clsx(
                  "text-[10px] px-2 py-0.5 rounded-full transition-all cursor-pointer",
                  categoryFilter === cat.value
                    ? "bg-accent/15 text-accent border border-accent/20"
                    : "bg-white/[0.03] text-text-secondary border border-white/[0.06] hover:border-white/[0.12]",
                )}
              >
                {cat.label}
              </button>
            ))}
          </div>
        </div>

        {/* Template List */}
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <div className="h-5 w-5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center py-12 px-4 text-center">
              <FileText className="h-8 w-8 text-text-secondary/30 mb-2" />
              <p className="text-xs text-text-secondary">No templates found</p>
            </div>
          ) : (
            filtered.map((t) => (
              <TemplateListItem
                key={t.id}
                template={t}
                selected={t.id === selectedId}
                onClick={() => handleSelect(t)}
              />
            ))
          )}
        </div>
      </div>

      {/* ------ Right Panel: Editor ------- */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {selected ? (
          <>
            {/* Editor Header */}
            <div className="flex items-center justify-between border-b border-white/[0.06] px-6 py-3">
              <div className="flex items-center gap-3 min-w-0">
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  className="text-base font-semibold text-text-primary font-display bg-transparent border-none outline-none focus:text-accent transition-colors min-w-0"
                />
                <Badge
                  variant={
                    (CATEGORY_COLORS[editCategory] as any) || "default"
                  }
                >
                  {editCategory}
                </Badge>
                {selected.isGlobal ? (
                  <Badge variant="info">Global</Badge>
                ) : null}
                <span className="text-xs text-text-secondary font-mono">
                  v{selected.version}
                </span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowVersions(!showVersions)}
                  icon={<History className="h-3.5 w-3.5" />}
                >
                  History
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowPreview(!showPreview)}
                  icon={<Eye className="h-3.5 w-3.5" />}
                >
                  Preview
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setShowApply(true)}
                  icon={<ArrowRight className="h-3.5 w-3.5" />}
                >
                  Apply
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleDelete}
                  disabled={
                    !!(selected.isGlobal && selected.createdBy === "system")
                  }
                >
                  <Trash2 className="h-3.5 w-3.5 text-error" />
                </Button>
                <Button
                  size="sm"
                  onClick={handleSave}
                  loading={updateMut.isPending}
                  icon={
                    saved ? null : <Save className="h-3.5 w-3.5" />
                  }
                >
                  {saved ? "Saved" : "Save"}
                </Button>
              </div>
            </div>

            {/* Editor Body */}
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {/* Description & Category Row */}
              <div className="grid grid-cols-3 gap-4">
                <div className="col-span-2">
                  <label className="block text-[10px] font-medium text-text-secondary uppercase tracking-wider mb-1.5 font-display">
                    Description
                  </label>
                  <input
                    type="text"
                    value={editDescription}
                    onChange={(e) => setEditDescription(e.target.value)}
                    placeholder="Brief description of this template..."
                    className="w-full rounded-lg bg-white/[0.04] border border-white/[0.06] px-3 py-2 text-xs text-text-primary placeholder:text-text-secondary/40 outline-none focus:border-accent/30 transition-colors"
                  />
                </div>
                <div>
                  <label className="block text-[10px] font-medium text-text-secondary uppercase tracking-wider mb-1.5 font-display">
                    Category
                  </label>
                  <select
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value)}
                    className="w-full rounded-lg bg-white/[0.04] border border-white/[0.06] px-3 py-2 text-xs text-text-primary outline-none focus:border-accent/30 transition-colors cursor-pointer"
                  >
                    {CATEGORIES.filter((c) => c.value).map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Variables */}
              {editVariables.length > 0 && (
                <div>
                  <label className="block text-[10px] font-medium text-text-secondary uppercase tracking-wider mb-1.5 font-display">
                    Variables
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {editVariables.map((v) => (
                      <span
                        key={v}
                        className="inline-flex items-center gap-1 rounded-md bg-accent/10 border border-accent/20 px-2 py-0.5 text-xs text-accent font-mono"
                      >
                        {`{{${v}}}`}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Content Editor */}
              <div>
                <label className="block text-[10px] font-medium text-text-secondary uppercase tracking-wider mb-1.5 font-display">
                  Template Content
                </label>
                <textarea
                  value={editContent}
                  onChange={(e) => {
                    setEditContent(e.target.value);
                    setEditVariables(detectVariables(e.target.value));
                  }}
                  rows={20}
                  className="w-full rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3 text-sm text-text-primary font-mono leading-relaxed placeholder:text-text-secondary/30 outline-none focus:border-accent/20 transition-colors resize-y min-h-[300px]"
                  placeholder="Write your prompt template here. Use {{variable_name}} for placeholders..."
                />
              </div>

              {/* Change Note */}
              <div>
                <label className="block text-[10px] font-medium text-text-secondary uppercase tracking-wider mb-1.5 font-display">
                  Change Note (optional)
                </label>
                <input
                  type="text"
                  value={changeNote}
                  onChange={(e) => setChangeNote(e.target.value)}
                  placeholder="What changed in this version..."
                  className="w-full rounded-lg bg-white/[0.04] border border-white/[0.06] px-3 py-2 text-xs text-text-primary placeholder:text-text-secondary/40 outline-none focus:border-accent/30 transition-colors"
                />
              </div>

              {/* Version History Panel */}
              {showVersions && (
                <div>
                  <label className="block text-[10px] font-medium text-text-secondary uppercase tracking-wider mb-2 font-display">
                    Version History
                  </label>
                  <VersionHistory
                    companyId={companyId!}
                    templateId={selectedId!}
                    onRestore={(content) => {
                      setEditContent(content);
                      setEditVariables(detectVariables(content));
                    }}
                  />
                </div>
              )}

              {/* Preview Panel */}
              {showPreview && (
                <PreviewPanel
                  content={editContent}
                  variables={editVariables}
                />
              )}
            </div>

            {/* Apply Modal */}
            {showApply && (
              <ApplyModal
                open={showApply}
                onClose={() => setShowApply(false)}
                companyId={companyId!}
                template={selected}
              />
            )}
          </>
        ) : (
          /* Empty State */
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center max-w-sm">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl glass border border-white/[0.06]">
                <FileText className="h-7 w-7 text-text-secondary/40" />
              </div>
              <h3 className="text-sm font-semibold text-text-primary font-display mb-1">
                Prompt Studio
              </h3>
              <p className="text-xs text-text-secondary leading-relaxed mb-4">
                Create, test, and manage prompt templates with version history.
                Select a template from the sidebar or create a new one to get
                started.
              </p>
              <Button
                onClick={() => setShowNewModal(true)}
                icon={<Plus className="h-3.5 w-3.5" />}
              >
                New Template
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* ------ New Template Modal ------- */}
      <Modal
        open={showNewModal}
        onClose={() => setShowNewModal(false)}
        title="New Prompt Template"
      >
        <div className="space-y-4">
          <Input
            label="Name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="e.g., Product Manager"
          />
          <Input
            label="Description"
            value={newDescription}
            onChange={(e) => setNewDescription(e.target.value)}
            placeholder="Brief description..."
          />
          <div className="space-y-1.5">
            <label className="block text-sm font-medium text-text-secondary font-display">
              Category
            </label>
            <select
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value)}
              className="w-full rounded-lg border border-white/[0.08] bg-surface/80 backdrop-blur-sm px-3 py-2 text-sm text-text-primary outline-none transition-all duration-300 focus:border-neon-cyan/40 cursor-pointer appearance-none"
            >
              {CATEGORIES.filter((c) => c.value).map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-[10px] font-medium text-text-secondary uppercase tracking-wider mb-1.5 font-display">
              Content
            </label>
            <textarea
              value={newContent}
              onChange={(e) => setNewContent(e.target.value)}
              rows={8}
              className="w-full rounded-xl bg-white/[0.03] border border-white/[0.06] px-4 py-3 text-sm text-text-primary font-mono leading-relaxed placeholder:text-text-secondary/30 outline-none focus:border-accent/20 transition-colors resize-y"
              placeholder="Write your prompt template here..."
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setShowNewModal(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!newName || !newContent || createMut.isPending}
              loading={createMut.isPending}
              icon={<Plus className="h-3.5 w-3.5" />}
            >
              Create
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
