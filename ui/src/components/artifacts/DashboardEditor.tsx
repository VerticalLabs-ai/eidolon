import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Save,
  Plus,
  AlertTriangle,
  CloudOff,
  Trash2,
  RefreshCw,
  Database,
  LayoutGrid,
  BarChart3,
  Table as TableIcon,
  Hash,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Input";
import { Textarea } from "@/components/ui/Input";
import type { Artifact } from "@/lib/api";
import {
  resolveDashboardAll,
  type ResolvedDataSource,
} from "@/lib/api";
import { useArtifactDraftSync } from "./useArtifactDraftSync";
import {
  type DashboardDataSource,
  type DashboardDataSourceType,
  type DashboardWidget,
  type DashboardWidgetType,
  type DashboardContent,
  parseDashboard,
  serializeDashboard,
  createDataSource,
  createWidget,
  updateDataSource,
  updateWidget,
  deleteDataSource,
  deleteWidget,
} from "./dashboard-content";

interface DashboardEditorProps {
  artifact: Artifact;
  version: number;
  onSave: (data: {
    title: string;
    content: Record<string, unknown>;
  }) => Promise<void>;
  saving?: boolean;
  conflictState?: ConflictState | null;
  wsConnected?: boolean;
  onStateChange?: (state: {
    dirty: boolean;
    save: () => Promise<boolean>;
    discard: () => void;
  }) => void;
}

export interface ConflictState {
  currentVersion: number;
  currentTitle: string;
  currentContent: Record<string, unknown>;
}

const DATA_SOURCE_TYPE_OPTIONS = [
  { value: "analytics_endpoint", label: "Analytics Endpoint" },
  { value: "integration", label: "Integration" },
  { value: "manual_json", label: "Manual / JSON" },
];

const WIDGET_TYPE_OPTIONS = [
  { value: "chart", label: "Chart" },
  { value: "table", label: "Table" },
  { value: "metric", label: "Metric" },
];

const WIDGET_ICONS: Record<DashboardWidgetType, React.ReactNode> = {
  chart: <BarChart3 className="h-4 w-4" />,
  table: <TableIcon className="h-4 w-4" />,
  metric: <Hash className="h-4 w-4" />,
};

export function DashboardEditor({
  artifact,
  version,
  onSave,
  saving,
  conflictState,
  wsConnected,
  onStateChange,
}: DashboardEditorProps) {
  const parsed = parseDashboard(artifact.content);
  const [title, setTitle] = useState(artifact.title);
  const [dataSources, setDataSources] = useState<DashboardDataSource[]>(parsed.dataSources);
  const [widgets, setWidgets] = useState<DashboardWidget[]>(parsed.widgets);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [pendingDeleteDs, setPendingDeleteDs] = useState<DashboardDataSource | null>(null);
  const [pendingDeleteWidget, setPendingDeleteWidget] = useState<DashboardWidget | null>(null);
  const [resolved, setResolved] = useState<Record<string, ResolvedDataSource>>({});
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);

  const localSnapshot = serializeDashboard({ dataSources, widgets });

  const adoptRemote = useCallback((content: Record<string, unknown>, remoteTitle: string) => {
    const next = parseDashboard(content);
    setTitle(remoteTitle);
    setDataSources(next.dataSources);
    setWidgets(next.widgets);
    setSaveError(null);
  }, []);

  const {
    isDirty,
    remoteUpdate,
    clearRemoteUpdate,
    resetBaselineToArtifact,
    markSaved,
  } = useArtifactDraftSync({
    artifact,
    localTitle: title,
    serializedLocalContent: localSnapshot,
    serializeArtifactContent: (c) => serializeDashboard(parseDashboard(c)),
    onAdoptRemote: adoptRemote,
  });

  const discardDraft = useCallback(() => {
    resetBaselineToArtifact();
    adoptRemote(artifact.content, artifact.title);
  }, [artifact.content, artifact.title, adoptRemote, resetBaselineToArtifact]);

  const buildContent = useCallback(
    (): Record<string, unknown> => ({ dataSources, widgets }) as unknown as Record<string, unknown>,
    [dataSources, widgets],
  );

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (!isDirty || saving) return false;
    setSaveError(null);
    const content = buildContent();
    try {
      await onSave({ title, content });
      markSaved(title, content);
      clearRemoteUpdate();
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Save failed";
      setSaveError(msg);
      return false;
    }
  }, [isDirty, saving, title, buildContent, onSave, markSaved, clearRemoteUpdate]);

  useEffect(() => {
    onStateChange?.({ dirty: isDirty, save: handleSave, discard: discardDraft });
  }, [discardDraft, handleSave, isDirty, onStateChange]);

  // Ctrl/Cmd+S to save.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        if (isDirty && !saving) void handleSave();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSave, isDirty, saving]);

  // ── Data-source resolution (live data) ────────────────────────────────
  const companyId = useMemo(() => {
    // The artifact's companyId is on the artifact object.
    return (artifact as Artifact & { companyId: string }).companyId;
  }, [artifact]);

  const refreshData = useCallback(async () => {
    if (!artifact.id || dataSources.length === 0) {
      setResolved({});
      return;
    }
    setResolving(true);
    setResolveError(null);
    try {
      const resp = await resolveDashboardAll(companyId, artifact.id);
      const map: Record<string, ResolvedDataSource> = {};
      for (const s of resp.data.sources) {
        map[s.dataSourceId] = s;
      }
      setResolved(map);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load data";
      setResolveError(msg);
    } finally {
      setResolving(false);
    }
  }, [companyId, artifact.id, dataSources.length]);

  // Auto-resolve on mount and whenever the saved content's data sources change.
  // We intentionally only re-resolve on saved-version changes (artifact.version/
  // artifact.id), not on every local draft edit, so the live data reflects the
  // last saved state. refreshData is stable enough for the effect's purpose.
  useEffect(() => {
    if (dataSources.length > 0 && !isDirty) {
      void refreshData();
    }
  }, [artifact.version, artifact.id, dataSources.length, isDirty, refreshData]);

  // -- data source mutations ----------------------------------------------

  const addDataSource = () => {
    const ds = createDataSource(dataSources);
    setDataSources((prev) => [...prev, ds]);
  };

  const confirmDeleteDs = () => {
    if (!pendingDeleteDs) return;
    const result = deleteDataSource(dataSources, widgets, pendingDeleteDs.id);
    setDataSources(result.dataSources);
    setWidgets(result.widgets);
    setPendingDeleteDs(null);
  };

  const handleDsTypeChange = (id: string, type: DashboardDataSourceType) => {
    // Reset config to a valid default for the new type.
    const defaultConfig: Record<DashboardDataSourceType, Record<string, unknown>> = {
      analytics_endpoint: { endpoint: "/analytics/overview" },
      integration: { integrationId: "" },
      manual_json: { data: { rows: [] } },
    };
    setDataSources((prev) =>
      updateDataSource(prev, id, { type, config: defaultConfig[type] }),
    );
  };

  const handleDsConfigField = (id: string, field: string, value: unknown) => {
    setDataSources((prev) =>
      updateDataSource(prev, id, {
        config: { ...prev.find((d) => d.id === id)!.config, [field]: value },
      }),
    );
  };

  // -- widget mutations ----------------------------------------------------

  const addWidget = () => {
    const w = createWidget(widgets, dataSources);
    setWidgets((prev) => [...prev, w]);
  };

  const confirmDeleteWidget = () => {
    if (!pendingDeleteWidget) return;
    setWidgets((prev) => deleteWidget(prev, pendingDeleteWidget.id));
    setPendingDeleteWidget(null);
  };

  const handleWidgetTypeChange = (id: string, type: DashboardWidgetType) => {
    setWidgets((prev) => updateWidget(prev, id, { type }));
  };

  const handleWidgetSourceChange = (id: string, dataSourceId: string) => {
    setWidgets((prev) => updateWidget(prev, id, { dataSourceId }));
  };

  const handleWidgetConfigField = (id: string, field: string, value: unknown) => {
    setWidgets((prev) =>
      updateWidget(prev, id, {
        config: { ...prev.find((w) => w.id === id)!.config, [field]: value },
      }),
    );
  };

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-3 border-b border-white/[0.06] px-4 py-2.5">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Untitled dashboard"
          aria-label="Dashboard title"
          className="flex-1 bg-transparent text-sm font-semibold text-text-primary font-display placeholder:text-text-secondary/40 rounded px-1 py-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
        />
        <span className="shrink-0 text-xs text-text-secondary tabular-nums">
          v{version}
        </span>
        {wsConnected === false && (
          <span
            className="flex items-center gap-1 text-xs text-warning"
            title="Realtime connection lost — your draft is preserved"
            role="status"
            aria-label="Realtime disconnected"
          >
            <CloudOff className="h-3.5 w-3.5" />
            Disconnected
          </span>
        )}
        <Button
          variant="ghost"
          size="sm"
          icon={<RefreshCw className={resolving ? "h-3 w-3 animate-spin" : "h-3 w-3"} />}
          onClick={refreshData}
          disabled={resolving || dataSources.length === 0}
          aria-label="Refresh dashboard data"
        >
          Refresh
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={<Database className="h-3 w-3" />}
          onClick={addDataSource}
          aria-label="Add data source"
        >
          Source
        </Button>
        <Button
          variant="ghost"
          size="sm"
          icon={<Plus className="h-3 w-3" />}
          onClick={addWidget}
          aria-label="Add widget"
        >
          Widget
        </Button>
        <Button
          variant="primary"
          size="sm"
          icon={<Save className="h-3 w-3" />}
          onClick={handleSave}
          disabled={!isDirty || saving}
          loading={saving}
        >
          Save
        </Button>
      </div>

      {wsConnected === false && (
        <div
          role="status"
          aria-label="Realtime connection disconnected"
          className="flex items-center gap-2 border-b border-warning/20 bg-warning/10 px-4 py-2 text-xs text-warning"
        >
          <CloudOff className="h-4 w-4 shrink-0" />
          <span>
            Realtime connection lost. Your draft is preserved — you can still save.
          </span>
        </div>
      )}

      {remoteUpdate && !conflictState && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-warning/20 bg-warning/10 px-4 py-2 text-xs text-warning"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1">
            This artifact changed elsewhere. Your draft is preserved.
          </span>
          <Button variant="ghost" size="sm" onClick={discardDraft}>
            Reload remote
          </Button>
        </div>
      )}
      {conflictState && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-warning/20 bg-warning/10 px-4 py-2 text-xs text-warning"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            Version conflict — another client saved v{conflictState.currentVersion}.
            Your draft is preserved. Save again to overwrite, or discard to load latest.
          </span>
        </div>
      )}

      {saveError && !conflictState && (
        <div
          role="alert"
          aria-label="Save failed"
          className="flex items-center gap-2 border-b border-error/20 bg-error/10 px-4 py-2 text-xs text-error"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1">Not saved: {saveError}. Your draft is preserved.</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSave}
            disabled={!isDirty || saving}
          >
            Retry save
          </Button>
        </div>
      )}

      {resolveError && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b border-error/20 bg-error/10 px-4 py-2 text-xs text-error"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="flex-1">Data load error: {resolveError}</span>
        </div>
      )}

      {/* Dashboard body */}
      <div className="flex-1 overflow-auto p-4" data-testid="dashboard-body">
        {dataSources.length === 0 && widgets.length === 0 ? (
          <div className="flex h-full items-center justify-center text-text-secondary">
            <div className="text-center">
              <LayoutGrid className="mx-auto h-8 w-8 text-text-secondary/40" />
              <p className="mt-2 text-sm">This dashboard is empty.</p>
              <p className="mt-1 text-xs text-text-secondary/60">
                Add a data source, then add widgets bound to it.
              </p>
              <div className="mt-3 flex justify-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Database className="h-3 w-3" />}
                  onClick={addDataSource}
                >
                  Add Data Source
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Data sources section */}
            {dataSources.length > 0 && (
              <section aria-label="Dashboard data sources">
                <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                  <Database className="h-3.5 w-3.5" />
                  Data Sources
                </h3>
                <div className="space-y-2">
                  {dataSources.map((ds) => (
                    <DataSourceRow
                      key={ds.id}
                      ds={ds}
                      resolved={resolved[ds.id]}
                      onTypeChange={(t) => handleDsTypeChange(ds.id, t)}
                      onConfigField={(f, v) => handleDsConfigField(ds.id, f, v)}
                      onDelete={() => setPendingDeleteDs(ds)}
                    />
                  ))}
                </div>
              </section>
            )}

            {/* Widgets section */}
            {widgets.length > 0 && (
              <section aria-label="Dashboard widgets">
                <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-text-secondary">
                  <LayoutGrid className="h-3.5 w-3.5" />
                  Widgets
                </h3>
                <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                  {widgets.map((w) => (
                    <WidgetCard
                      key={w.id}
                      widget={w}
                      dataSources={dataSources}
                      resolved={resolved[w.dataSourceId]}
                      onTypeChange={(t) => handleWidgetTypeChange(w.id, t)}
                      onSourceChange={(s) => handleWidgetSourceChange(w.id, s)}
                      onConfigField={(f, v) => handleWidgetConfigField(w.id, f, v)}
                      onDelete={() => setPendingDeleteWidget(w)}
                    />
                  ))}
                </div>
              </section>
            )}

            {dataSources.length > 0 && widgets.length === 0 && (
              <div className="flex justify-center">
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Plus className="h-3 w-3" />}
                  onClick={addWidget}
                >
                  Add Widget
                </Button>
              </div>
            )}
          </div>
        )}
      </div>

      {isDirty && (
        <div className="shrink-0 border-t border-white/[0.04] px-4 py-1.5 text-xs text-text-secondary">
          Unsaved changes — press Ctrl/Cmd+S to save
        </div>
      )}

      {/* Delete confirmation modals */}
      <Modal
        open={pendingDeleteDs !== null}
        onClose={() => setPendingDeleteDs(null)}
        title="Delete data source"
      >
        <p className="text-sm text-text-secondary">
          Delete data source{" "}
          <strong className="text-text-primary">{pendingDeleteDs?.id}</strong>?
        </p>
        <p className="mt-2 text-xs text-text-secondary/70">
          Widgets bound to this data source will also be removed. This change
          applies on save.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={() => setPendingDeleteDs(null)}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={confirmDeleteDs}>
            Delete
          </Button>
        </div>
      </Modal>

      <Modal
        open={pendingDeleteWidget !== null}
        onClose={() => setPendingDeleteWidget(null)}
        title="Delete widget"
      >
        <p className="text-sm text-text-secondary">
          Delete widget{" "}
          <strong className="text-text-primary">{pendingDeleteWidget?.id}</strong>?
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={() => setPendingDeleteWidget(null)}>
            Cancel
          </Button>
          <Button variant="danger" size="sm" onClick={confirmDeleteWidget}>
            Delete
          </Button>
        </div>
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data source row
// ---------------------------------------------------------------------------

interface DataSourceRowProps {
  ds: DashboardDataSource;
  resolved?: ResolvedDataSource;
  onTypeChange: (type: DashboardDataSourceType) => void;
  onConfigField: (field: string, value: unknown) => void;
  onDelete: () => void;
}

function DataSourceRow({ ds, resolved, onTypeChange, onConfigField, onDelete }: DataSourceRowProps) {
  const configJson =
    ds.type === "manual_json"
      ? JSON.stringify(ds.config.data ?? {}, null, 2)
      : "";

  return (
    <div
      className="rounded-lg border border-white/[0.08] bg-surface/60 p-3"
      aria-label={`Data source ${ds.id}`}
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-xs font-mono text-text-secondary">{ds.id}</span>
        <div className="flex-1">
          <Select
            aria-label={`Data source ${ds.id} type`}
            value={ds.type}
            onChange={(e) => onTypeChange(e.target.value as DashboardDataSourceType)}
            options={DATA_SOURCE_TYPE_OPTIONS}
            className="w-full"
          />
        </div>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete data source ${ds.id}`}
          className="flex h-7 w-7 items-center justify-center rounded text-text-secondary hover:text-error hover:bg-error/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="mt-2">
        {ds.type === "analytics_endpoint" && (
          <div>
            <label
              htmlFor={`ds-${ds.id}-endpoint`}
              className="mb-1 block text-[10px] text-text-secondary"
            >
              Analytics endpoint
            </label>
            <input
              id={`ds-${ds.id}-endpoint`}
              value={typeof ds.config.endpoint === "string" ? ds.config.endpoint : ""}
              onChange={(e) => onConfigField("endpoint", e.target.value)}
              placeholder="/analytics/overview"
              aria-label={`Data source ${ds.id} endpoint`}
              className="w-full rounded border border-white/[0.08] bg-surface/60 px-2 py-1.5 text-xs text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
            <p className="mt-1 text-[10px] text-text-secondary/60">
              Allowed: /analytics/overview, /analytics/agents, /analytics/costs, /analytics/tasks
            </p>
          </div>
        )}
        {ds.type === "integration" && (
          <div>
            <label
              htmlFor={`ds-${ds.id}-integrationId`}
              className="mb-1 block text-[10px] text-text-secondary"
            >
              Integration ID
            </label>
            <input
              id={`ds-${ds.id}-integrationId`}
              value={typeof ds.config.integrationId === "string" ? ds.config.integrationId : ""}
              onChange={(e) => onConfigField("integrationId", e.target.value)}
              placeholder="integration uuid"
              aria-label={`Data source ${ds.id} integration id`}
              className="w-full rounded border border-white/[0.08] bg-surface/60 px-2 py-1.5 text-xs text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
          </div>
        )}
        {ds.type === "manual_json" && (
          <div>
            <label
              htmlFor={`ds-${ds.id}-data`}
              className="mb-1 block text-[10px] text-text-secondary"
            >
              Data (JSON)
            </label>
            <Textarea
              id={`ds-${ds.id}-data`}
              value={configJson}
              onChange={(e) => {
                try {
                  onConfigField("data", JSON.parse(e.target.value));
                } catch {
                  // keep raw text unparseable; the server validates on save
                }
              }}
              aria-label={`Data source ${ds.id} JSON data`}
              className="min-h-[100px] font-mono text-xs"
              placeholder='{"rows":[]}'
            />
          </div>
        )}
      </div>

      {resolved && (
        <div className="mt-2 rounded bg-white/[0.02] p-2 text-[10px] text-text-secondary">
          <span className="font-semibold text-text-secondary/80">Live:</span>{" "}
          {resolved.error ? (
            <span className="text-error">{resolved.error}</span>
          ) : (
            <span className="font-mono text-text-secondary/70">
              {JSON.stringify(resolved.data).slice(0, 120)}
              {JSON.stringify(resolved.data).length > 120 ? "…" : ""}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Widget card
// ---------------------------------------------------------------------------

interface WidgetCardProps {
  widget: DashboardWidget;
  dataSources: DashboardDataSource[];
  resolved?: ResolvedDataSource;
  onTypeChange: (type: DashboardWidgetType) => void;
  onSourceChange: (dataSourceId: string) => void;
  onConfigField: (field: string, value: unknown) => void;
  onDelete: () => void;
}

function WidgetCard({
  widget,
  dataSources,
  resolved,
  onTypeChange,
  onSourceChange,
  onConfigField,
  onDelete,
}: WidgetCardProps) {
  const sourceOptions = dataSources.map((d) => ({ value: d.id, label: d.id }));

  const configField = (field: string): string => {
    const v = widget.config[field];
    return typeof v === "string" ? v : v != null ? String(v) : "";
  };

  return (
    <div
      className="flex flex-col rounded-lg border border-white/[0.08] bg-surface/60 p-3"
      aria-label={`Widget ${widget.id}`}
      data-testid={`widget-${widget.id}`}
    >
      <div className="flex items-center gap-2">
        <span className="text-text-secondary">{WIDGET_ICONS[widget.type]}</span>
        <span className="shrink-0 text-xs font-mono text-text-secondary">{widget.id}</span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete widget ${widget.id}`}
          className="flex h-6 w-6 items-center justify-center rounded text-text-secondary hover:text-error hover:bg-error/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <Trash2 className="h-3 w-3" />
        </button>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <Select
          aria-label={`Widget ${widget.id} type`}
          value={widget.type}
          onChange={(e) => onTypeChange(e.target.value as DashboardWidgetType)}
          options={WIDGET_TYPE_OPTIONS}
          className="w-full"
        />
        <Select
          aria-label={`Widget ${widget.id} data source`}
          value={widget.dataSourceId}
          onChange={(e) => onSourceChange(e.target.value)}
          options={sourceOptions}
          placeholder="Bind to source"
          className="w-full"
        />
      </div>

      {/* Per-type config fields */}
      <div className="mt-2 space-y-2">
        {widget.type === "chart" && (
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="mb-1 block text-[10px] text-text-secondary">Chart type</label>
              <Select
                aria-label={`Widget ${widget.id} chart type`}
                value={configField("chartType")}
                onChange={(e) => onConfigField("chartType", e.target.value)}
                options={[
                  { value: "bar", label: "Bar" },
                  { value: "line", label: "Line" },
                  { value: "pie", label: "Pie" },
                ]}
                className="w-full"
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] text-text-secondary">X field</label>
              <input
                value={configField("xField")}
                onChange={(e) => onConfigField("xField", e.target.value)}
                aria-label={`Widget ${widget.id} x field`}
                className="w-full rounded border border-white/[0.08] bg-surface/60 px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] text-text-secondary">Y field</label>
              <input
                value={configField("yField")}
                onChange={(e) => onConfigField("yField", e.target.value)}
                aria-label={`Widget ${widget.id} y field`}
                className="w-full rounded border border-white/[0.08] bg-surface/60 px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              />
            </div>
          </div>
        )}
        {widget.type === "table" && (
          <div>
            <label className="mb-1 block text-[10px] text-text-secondary">Columns (comma-separated)</label>
            <input
              value={Array.isArray(widget.config.columns)
                ? (widget.config.columns as string[]).join(",")
                : configField("columns")}
              onChange={(e) =>
                onConfigField(
                  "columns",
                  e.target.value.split(",").map((s) => s.trim()).filter(Boolean),
                )
              }
              aria-label={`Widget ${widget.id} columns`}
              className="w-full rounded border border-white/[0.08] bg-surface/60 px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
            />
          </div>
        )}
        {widget.type === "metric" && (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-[10px] text-text-secondary">Field</label>
              <input
                value={configField("field")}
                onChange={(e) => onConfigField("field", e.target.value)}
                aria-label={`Widget ${widget.id} metric field`}
                className="w-full rounded border border-white/[0.08] bg-surface/60 px-2 py-1.5 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] text-text-secondary">Aggregate</label>
              <Select
                aria-label={`Widget ${widget.id} aggregate`}
                value={configField("aggregate")}
                onChange={(e) => onConfigField("aggregate", e.target.value)}
                options={[
                  { value: "sum", label: "Sum" },
                  { value: "avg", label: "Average" },
                  { value: "max", label: "Max" },
                  { value: "min", label: "Min" },
                  { value: "count", label: "Count" },
                ]}
                className="w-full"
              />
            </div>
          </div>
        )}
      </div>

      {/* Live render */}
      <div className="mt-3 flex-1 rounded bg-white/[0.02] p-2" data-testid={`widget-${widget.id}-render`}>
        {resolved ? (
          resolved.error ? (
            <p className="text-xs text-error">{resolved.error}</p>
          ) : (
            <WidgetRender widget={widget} data={resolved.data} />
          )
        ) : (
          <p className="text-xs text-text-secondary/50">
            {widget.dataSourceId
              ? "Click Refresh to load data."
              : "Bind to a data source to render."}
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Widget render — renders live data from the bound source per widget type
// ---------------------------------------------------------------------------

function WidgetRender({ widget, data }: { widget: DashboardWidget; data: unknown }) {
  if (widget.type === "metric") {
    const value = extractMetric(data, widget.config);
    const label =
      typeof widget.config.field === "string" ? widget.config.field : "value";
    return (
      <div className="flex flex-col items-center justify-center py-3">
        <span className="text-2xl font-bold text-text-primary tabular-nums">
          {formatMetric(value)}
        </span>
        <span className="mt-1 text-[10px] uppercase tracking-wide text-text-secondary">
          {label}
        </span>
      </div>
    );
  }
  if (widget.type === "table") {
    const rows = extractRows(data);
    const columns =
      Array.isArray(widget.config.columns) && widget.config.columns.length > 0
        ? (widget.config.columns as string[])
        : rows.length > 0
          ? Object.keys(rows[0])
          : [];
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          {columns.length > 0 && (
            <thead>
              <tr className="border-b border-white/[0.06]">
                {columns.map((c) => (
                  <th
                    key={c}
                    className="px-2 py-1 text-left font-semibold text-text-secondary"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td className="px-2 py-2 text-text-secondary/50" colSpan={Math.max(columns.length, 1)}>
                  No rows
                </td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <tr key={i} className="border-b border-white/[0.03]">
                  {columns.map((c) => (
                    <td key={c} className="px-2 py-1 text-text-primary">
                      {formatCell((row as Record<string, unknown>)[c])}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    );
  }
  // chart — render a simple bar/line visualization from extracted rows
  const rows = extractRows(data);
  const xField =
    typeof widget.config.xField === "string" ? widget.config.xField : "label";
  const yField =
    typeof widget.config.yField === "string" ? widget.config.yField : "value";
  const chartType =
    typeof widget.config.chartType === "string" ? widget.config.chartType : "bar";
  const points = rows.map((r) => ({
    x: String((r as Record<string, unknown>)[xField] ?? ""),
    y: Number((r as Record<string, unknown>)[yField] ?? 0),
  }));
  const maxY = Math.max(1, ...points.map((p) => p.y));
  return (
    <div className="py-2" aria-label={`Chart ${chartType}`}>
      {points.length === 0 ? (
        <p className="text-xs text-text-secondary/50">No data points</p>
      ) : chartType === "line" ? (
        <LineChart points={points} maxY={maxY} />
      ) : (
        <div className="flex items-end gap-1 h-24">
          {points.map((p, i) => (
            <div key={i} className="flex flex-1 flex-col items-center justify-end">
              <div
                className="w-full rounded-t bg-accent/60"
                style={{ height: `${Math.max(2, (p.y / maxY) * 100)}%` }}
                title={`${p.x}: ${p.y}`}
              />
              <span className="mt-1 text-[9px] text-text-secondary/70 truncate w-full text-center">
                {p.x}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LineChart({ points, maxY }: { points: { x: string; y: number }[]; maxY: number }) {
  const w = 100;
  const h = 80;
  const stepX = points.length > 1 ? w / (points.length - 1) : w;
  const coords = points.map((p, i) => ({
    x: i * stepX,
    y: h - (p.y / maxY) * h,
  }));
  const path = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x} ${c.y}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-24" preserveAspectRatio="none">
      <path d={path} fill="none" stroke="rgb(0 243 255 / 0.7)" strokeWidth="2" />
      {coords.map((c, i) => (
        <circle key={i} cx={c.x} cy={c.y} r="2" fill="rgb(0 243 255)" />
      ))}
    </svg>
  );
}

/** Extract a flat array of row records from a resolved data payload. */
function extractRows(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.rows)) return obj.rows as Record<string, unknown>[];
    if (Array.isArray(obj.data)) return obj.data as Record<string, unknown>[];
    if (Array.isArray(obj.items)) return obj.items as Record<string, unknown>[];
    if (Array.isArray(obj.agents)) return obj.agents as Record<string, unknown>[];
  }
  return [];
}

/** Compute a metric value from resolved data per the widget config. */
function extractMetric(
  data: unknown,
  config: Record<string, unknown>,
): number | null {
  const rows = extractRows(data);
  const field = typeof config.field === "string" ? config.field : "";
  const aggregate =
    typeof config.aggregate === "string" ? config.aggregate : "sum";
  if (rows.length === 0) return null;
  const values = rows
    .map((r) => Number(r[field]))
    .filter((n) => !Number.isNaN(n));
  if (values.length === 0) {
    // Fall back to a count metric
    if (aggregate === "count") return rows.length;
    return null;
  }
  switch (aggregate) {
    case "sum":
      return values.reduce((a, b) => a + b, 0);
    case "avg":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "max":
      return Math.max(...values);
    case "min":
      return Math.min(...values);
    case "count":
      return values.length;
    default:
      return values.reduce((a, b) => a + b, 0);
  }
}

function formatMetric(value: number | null): string {
  if (value === null) return "—";
  if (Number.isInteger(value)) return value.toLocaleString();
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
