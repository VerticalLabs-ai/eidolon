// Helpers for parsing/serializing dashboard artifact content and mutating
// the data sources + widgets lists. Kept in a side module so the editor
// component stays focused on rendering (mirrors gallery-content.ts).

export type DashboardDataSourceType = 'analytics_endpoint' | 'integration' | 'manual_json';
export type DashboardWidgetType = 'chart' | 'table' | 'metric';

export interface DashboardDataSource {
  id: string;
  type: DashboardDataSourceType;
  config: Record<string, unknown>;
}

export interface DashboardWidget {
  id: string;
  type: DashboardWidgetType;
  dataSourceId: string;
  config: Record<string, unknown>;
}

export interface DashboardContent {
  dataSources: DashboardDataSource[];
  widgets: DashboardWidget[];
}

const DS_ID_PREFIX = 'ds_';
const WIDGET_ID_PREFIX = 'w_';

/** Generate a data source id unique within the given list. */
export function genDataSourceId(existing: { id: string }[] = []): string {
  const taken = new Set(existing.map((d) => d.id));
  let n = 1;
  while (taken.has(`${DS_ID_PREFIX}${n}`)) n += 1;
  return `${DS_ID_PREFIX}${n}`;
}

/** Generate a widget id unique within the given list. */
export function genWidgetId(existing: { id: string }[] = []): string {
  const taken = new Set(existing.map((w) => w.id));
  let n = 1;
  while (taken.has(`${WIDGET_ID_PREFIX}${n}`)) n += 1;
  return `${WIDGET_ID_PREFIX}${n}`;
}

/** Parse an artifact's raw content into a normalized dashboard shape. */
export function parseDashboard(content: Record<string, unknown>): DashboardContent {
  const dataSources = Array.isArray(content.dataSources)
    ? (content.dataSources as DashboardDataSource[])
    : [];
  const widgets = Array.isArray(content.widgets)
    ? (content.widgets as DashboardWidget[])
    : [];
  return { dataSources, widgets };
}

/** Serialize dashboard content to a stable JSON string for comparison. */
export function serializeDashboard(d: DashboardContent): string {
  return JSON.stringify(d);
}

/** Build a fresh, schema-valid data source. */
export function createDataSource(existing: { id: string }[] = []): DashboardDataSource {
  return { id: genDataSourceId(existing), type: 'manual_json', config: { data: { rows: [] } } };
}

/** Build a fresh, schema-valid widget bound to the first data source (if any). */
export function createWidget(
  existing: { id: string }[] = [],
  dataSources: DashboardDataSource[] = [],
): DashboardWidget {
  const dataSourceId = dataSources[0]?.id ?? '';
  return { id: genWidgetId(existing), type: 'table', dataSourceId, config: { columns: [] } };
}

/** Patch a single data source by id. */
export function updateDataSource(
  dataSources: DashboardDataSource[],
  id: string,
  patch: Partial<DashboardDataSource>,
): DashboardDataSource[] {
  return dataSources.map((d) => (d.id === id ? { ...d, ...patch } : d));
}

/** Patch a single widget by id. */
export function updateWidget(
  widgets: DashboardWidget[],
  id: string,
  patch: Partial<DashboardWidget>,
): DashboardWidget[] {
  return widgets.map((w) => (w.id === id ? { ...w, ...patch } : w));
}

/** Delete a data source by id. Widgets bound to it are also removed (no
 *  orphans — the server schema rejects dangling bindings on save). */
export function deleteDataSource(
  dataSources: DashboardDataSource[],
  widgets: DashboardWidget[],
  id: string,
): { dataSources: DashboardDataSource[]; widgets: DashboardWidget[] } {
  return {
    dataSources: dataSources.filter((d) => d.id !== id),
    widgets: widgets.filter((w) => w.dataSourceId !== id),
  };
}

/** Delete a widget by id. */
export function deleteWidget(widgets: DashboardWidget[], id: string): DashboardWidget[] {
  return widgets.filter((w) => w.id !== id);
}
