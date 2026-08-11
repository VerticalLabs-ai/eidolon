import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestServer, createTestDb } from '../test-utils.js';
import { ArtifactToolService } from '../services/artifact-tools.js';
import { eventBus } from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import type { EidolonEvent } from '../realtime/events.js';

// ---------------------------------------------------------------------------
// Dashboard artifact payloads
// ---------------------------------------------------------------------------

const DASH_EMPTY = { dataSources: [], widgets: [] };

const DASH_THREE_SOURCES = {
  dataSources: [
    { id: 'ds1', type: 'analytics_endpoint', config: { endpoint: '/analytics/overview' } },
    { id: 'ds2', type: 'integration', config: { integrationId: '00000000-0000-0000-0000-000000000000' } },
    { id: 'ds3', type: 'manual_json', config: { data: { rows: [{ label: 'A', value: 10 }] } } },
  ],
  widgets: [],
};

const DASH_THREE_WIDGETS = {
  dataSources: [
    { id: 'ds1', type: 'analytics_endpoint', config: { endpoint: '/analytics/overview' } },
    { id: 'ds3', type: 'manual_json', config: { data: { rows: [{ label: 'A', value: 10 }, { label: 'B', value: 20 }] } } },
  ],
  widgets: [
    { id: 'w1', type: 'chart', dataSourceId: 'ds1', config: { chartType: 'bar', xField: 'label', yField: 'value' } },
    { id: 'w2', type: 'table', dataSourceId: 'ds3', config: { columns: ['label', 'value'] } },
    { id: 'w3', type: 'metric', dataSourceId: 'ds1', config: { field: 'value', aggregate: 'sum' } },
  ],
};

const DASH_EDITED_WIDGET = {
  dataSources: DASH_THREE_WIDGETS.dataSources,
  widgets: [
    { id: 'w1', type: 'chart', dataSourceId: 'ds1', config: { chartType: 'line', xField: 'label', yField: 'value' } },
    { id: 'w2', type: 'table', dataSourceId: 'ds3', config: { columns: ['label', 'value'] } },
    { id: 'w3', type: 'metric', dataSourceId: 'ds1', config: { field: 'value', aggregate: 'sum' } },
  ],
};

/** Collect EventBus events emitted during an async operation. */
async function captureEvents(fn: () => Promise<void>): Promise<EidolonEvent[]> {
  const events: EidolonEvent[] = [];
  const handler = (event: EidolonEvent) => events.push(event);
  eventBus.onEvent(handler);
  try {
    await fn();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    eventBus.off('event', handler);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Suite — VAL-DASHBOARD-001..010 + M5 shared behaviors
// ---------------------------------------------------------------------------

describe('Dashboard artifact API — real-Postgres integration', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;
  let otherCompanyId: string;
  let projectId: string;
  let secondProjectId: string;
  let otherProjectId: string;
  let agentId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Dashboard Corp', settings: { testFixture: true } })
      .expect(201);
    companyId = company.body.data.id;

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Dashboard Other Corp', settings: { testFixture: true } })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Dashboard Proj', status: 'active' })
      .expect(201);
    projectId = project.body.data.id;

    const project2 = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Dashboard Proj 2', status: 'active' })
      .expect(201);
    secondProjectId = project2.body.data.id;

    const otherProject = await request(app)
      .post(`/api/companies/${otherCompanyId}/projects`)
      .send({ name: 'Dashboard Other Proj', status: 'active' })
      .expect(201);
    otherProjectId = otherProject.body.data.id;

    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Dashboard Agent', role: 'engineer', provider: 'anthropic', model: 'claude-sonnet-4-6' })
      .expect(201);
    agentId = agent.body.data.id;
  });

  function createDashboard(
    overrides: {
      companyId?: string;
      projectId?: string | null;
      title?: string;
      content?: unknown;
    } = {},
  ) {
    return request(app)
      .post(`/api/companies/${overrides.companyId ?? companyId}/artifacts`)
      .send({
        type: 'dashboard',
        title: overrides.title ?? '__mtest__ Dashboard',
        content: overrides.content ?? DASH_EMPTY,
        ...(overrides.projectId === undefined
          ? { projectId }
          : { projectId: overrides.projectId }),
      });
  }

  // =========================================================================
  // VAL-DASHBOARD-001: create a dashboard with empty data sources + widgets
  // =========================================================================

  describe('VAL-DASHBOARD-001: create a dashboard artifact with empty data sources and widgets', () => {
    it('creates a dashboard at version 1 scoped to the project with content echoed', async () => {
      const res = await createDashboard({ title: '__mtest__ M5 dashboard' }).expect(201);
      expect(res.body.data.id).toBeTruthy();
      expect(res.body.data.type).toBe('dashboard');
      expect(res.body.data.version).toBe(1);
      expect(res.body.data.contentSchemaVersion).toBe(1);
      expect(res.body.data.status).toBe('active');
      expect(res.body.data.projectId).toBe(projectId);
      expect(res.body.data.content).toEqual(DASH_EMPTY);
    });

    it('lists the dashboard under the type=dashboard filter', async () => {
      const created = await createDashboard().expect(201);
      const listed = await request(app)
        .get(`/api/companies/${companyId}/artifacts?type=dashboard`)
        .expect(200);
      expect(listed.body.data.map((a: { id: string }) => a.id)).toContain(created.body.data.id);
    });

    it('does not list the dashboard under a different type filter', async () => {
      await createDashboard().expect(201);
      const docs = await request(app)
        .get(`/api/companies/${companyId}/artifacts?type=document`)
        .expect(200);
      expect(docs.body.data).toHaveLength(0);
    });
  });

  // =========================================================================
  // VAL-DASHBOARD-002: add a data source of each supported type with config
  // =========================================================================

  describe('VAL-DASHBOARD-002: add a data source of each supported type with config', () => {
    it('patches three data sources (analytics/integration/manual) and preserves config', async () => {
      const created = await createDashboard().expect(201);
      const id = created.body.data.id;

      const patched = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: DASH_THREE_SOURCES, version: 1 })
        .expect(200);
      expect(patched.body.data.version).toBe(2);
      expect(patched.body.data.content.dataSources).toHaveLength(3);
      expect(patched.body.data.content.dataSources[0].type).toBe('analytics_endpoint');
      expect(patched.body.data.content.dataSources[0].config.endpoint).toBe('/analytics/overview');
      expect(patched.body.data.content.dataSources[1].type).toBe('integration');
      expect(patched.body.data.content.dataSources[1].config.integrationId).toBeTruthy();
      expect(patched.body.data.content.dataSources[2].type).toBe('manual_json');
      expect(patched.body.data.content.dataSources[2].config.data).toEqual({ rows: [{ label: 'A', value: 10 }] });

      const reopened = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(reopened.body.data.content.dataSources).toHaveLength(3);
    });
  });

  // =========================================================================
  // VAL-DASHBOARD-003: add widgets bound to data sources (chart/table/metric)
  // =========================================================================

  describe('VAL-DASHBOARD-003: add widgets bound to data sources (chart/table/metric)', () => {
    it('patches three widgets bound to declared data sources and preserves bindings', async () => {
      const created = await createDashboard().expect(201);
      const id = created.body.data.id;

      // First add data sources
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: DASH_THREE_SOURCES, version: 1 })
        .expect(200);

      // Then add widgets bound to ds1 and ds3
      const widgetContent = {
        dataSources: DASH_THREE_SOURCES.dataSources,
        widgets: [
          { id: 'w1', type: 'chart', dataSourceId: 'ds1', config: { chartType: 'bar', xField: 'label', yField: 'value' } },
          { id: 'w2', type: 'table', dataSourceId: 'ds3', config: { columns: ['label', 'value'] } },
          { id: 'w3', type: 'metric', dataSourceId: 'ds1', config: { field: 'value', aggregate: 'sum' } },
        ],
      };
      const patched = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: widgetContent, version: 2 })
        .expect(200);
      expect(patched.body.data.version).toBe(3);
      expect(patched.body.data.content.widgets).toHaveLength(3);
      expect(patched.body.data.content.widgets.map((w: { type: string }) => w.type)).toEqual(['chart', 'table', 'metric']);
      expect(patched.body.data.content.widgets.map((w: { dataSourceId: string }) => w.dataSourceId)).toEqual(['ds1', 'ds3', 'ds1']);
    });
  });

  // =========================================================================
  // VAL-DASHBOARD-004: widget binding validation — dangling dataSourceId
  // =========================================================================

  describe('VAL-DASHBOARD-004: widget binding validation — dangling dataSourceId is rejected', () => {
    it('rejects a PATCH with a widget referencing an undeclared data source with 400', async () => {
      const created = await createDashboard().expect(201);
      const id = created.body.data.id;

      const res = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({
          content: {
            dataSources: [{ id: 'ds1', type: 'manual_json', config: { data: { rows: [] } } }],
            widgets: [{ id: 'wX', type: 'chart', dataSourceId: 'dsMissing', config: {} }],
          },
          version: 1,
        })
        .expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');

      // content/version unchanged, no new revision
      const after = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(after.body.data.version).toBe(1);
      expect(after.body.data.content).toEqual(DASH_EMPTY);
      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(revs.body.data).toHaveLength(1);
    });

    it('accepts a PATCH with a widget referencing a declared data source', async () => {
      const created = await createDashboard().expect(201);
      const id = created.body.data.id;

      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({
          content: {
            dataSources: [{ id: 'ds1', type: 'manual_json', config: { data: { rows: [] } } }],
            widgets: [{ id: 'w1', type: 'chart', dataSourceId: 'ds1', config: { chartType: 'bar' } }],
          },
          version: 1,
        })
        .expect(200);
    });
  });

  // =========================================================================
  // VAL-DASHBOARD-007: data source validation — invalid source config
  // =========================================================================

  describe('VAL-DASHBOARD-007: data source validation — invalid source config is rejected', () => {
    it('rejects an analytics_endpoint with no endpoint config with 400', async () => {
      const created = await createDashboard().expect(201);
      const id = created.body.data.id;

      const res = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({
          content: {
            dataSources: [{ id: 'dsB', type: 'analytics_endpoint', config: {} }],
            widgets: [],
          },
          version: 1,
        })
        .expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects a data source with an unknown type with 400', async () => {
      const created = await createDashboard().expect(201);
      const id = created.body.data.id;

      const res = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({
          content: {
            dataSources: [{ id: 'dsX', type: 'bogus', config: {} }],
            widgets: [],
          },
          version: 1,
        })
        .expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects an integration source missing integrationId with 400', async () => {
      const created = await createDashboard().expect(201);
      const id = created.body.data.id;

      const res = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({
          content: {
            dataSources: [{ id: 'dsI', type: 'integration', config: {} }],
            widgets: [],
          },
          version: 1,
        })
        .expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects a manual_json source missing data with 400', async () => {
      const created = await createDashboard().expect(201);
      const id = created.body.data.id;

      const res = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({
          content: {
            dataSources: [{ id: 'dsM', type: 'manual_json', config: {} }],
            widgets: [],
          },
          version: 1,
        })
        .expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects a widget with an unknown type with 400', async () => {
      const created = await createDashboard().expect(201);
      const id = created.body.data.id;

      const res = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({
          content: {
            dataSources: [{ id: 'ds1', type: 'manual_json', config: { data: {} } }],
            widgets: [{ id: 'w1', type: 'bogus_widget', dataSourceId: 'ds1', config: {} }],
          },
          version: 1,
        })
        .expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects a create with a dangling widget binding with 400', async () => {
      const res = await createDashboard({
        content: {
          dataSources: [],
          widgets: [{ id: 'w1', type: 'chart', dataSourceId: 'dsMissing', config: {} }],
        },
      }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects duplicate data source ids with 400', async () => {
      const res = await createDashboard({
        content: {
          dataSources: [
            { id: 'dup', type: 'manual_json', config: { data: {} } },
            { id: 'dup', type: 'manual_json', config: { data: {} } },
          ],
          widgets: [],
        },
      }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });

    it('rejects duplicate widget ids with 400', async () => {
      const res = await createDashboard({
        content: {
          dataSources: [{ id: 'ds1', type: 'manual_json', config: { data: {} } }],
          widgets: [
            { id: 'dup', type: 'chart', dataSourceId: 'ds1', config: {} },
            { id: 'dup', type: 'table', dataSourceId: 'ds1', config: {} },
          ],
        },
      }).expect(400);
      expect(res.body.code).toBe('INVALID_ARTIFACT_CONTENT');
    });
  });

  // =========================================================================
  // VAL-DASHBOARD-005: widgets render live data (data-source resolve API)
  // =========================================================================

  describe('VAL-DASHBOARD-005: data-source resolve endpoint returns live data', () => {
    it('resolves a manual_json data source to its inline data', async () => {
      const created = await createDashboard({
        content: {
          dataSources: [{ id: 'ds3', type: 'manual_json', config: { data: { rows: [{ label: 'A', value: 10 }] } } }],
          widgets: [{ id: 'w2', type: 'table', dataSourceId: 'ds3', config: { columns: ['label', 'value'] } }],
        },
      }).expect(201);
      const id = created.body.data.id;

      const resolved = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/dashboard/sources/ds3/resolve`)
        .expect(200);
      expect(resolved.body.data.dataSourceId).toBe('ds3');
      expect(resolved.body.data.type).toBe('manual_json');
      expect(resolved.body.data.data).toEqual({ rows: [{ label: 'A', value: 10 }] });
    });

    it('resolves an analytics_endpoint data source to live analytics data', async () => {
      const created = await createDashboard({
        content: {
          dataSources: [{ id: 'ds1', type: 'analytics_endpoint', config: { endpoint: '/analytics/overview' } }],
          widgets: [{ id: 'w1', type: 'chart', dataSourceId: 'ds1', config: { chartType: 'bar' } }],
        },
      }).expect(201);
      const id = created.body.data.id;

      const resolved = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/dashboard/sources/ds1/resolve`)
        .expect(200);
      expect(resolved.body.data.dataSourceId).toBe('ds1');
      expect(resolved.body.data.type).toBe('analytics_endpoint');
      // The overview payload contains agents/tasks summaries
      expect(resolved.body.data.data).toHaveProperty('agents');
      expect(resolved.body.data.data).toHaveProperty('tasks');
    });

    it('resolves an integration data source to the stored integration row', async () => {
      // Create an integration in the company first
      const integration = await request(app)
        .post(`/api/companies/${companyId}/integrations`)
        .send({ name: 'Test Int', type: 'github', provider: 'github', config: { token: 'x' } })
        .expect(201);
      const integrationId = integration.body.data.id;

      const created = await createDashboard({
        content: {
          dataSources: [{ id: 'ds2', type: 'integration', config: { integrationId } }],
          widgets: [],
        },
      }).expect(201);
      const id = created.body.data.id;

      const resolved = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/dashboard/sources/ds2/resolve`)
        .expect(200);
      expect(resolved.body.data.dataSourceId).toBe('ds2');
      expect(resolved.body.data.type).toBe('integration');
      expect((resolved.body.data.data as { integrationId: string }).integrationId).toBe(integrationId);
    });

    it('rejects resolve on a non-dashboard artifact with 400', async () => {
      const doc = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({ type: 'document', title: '__mtest__ doc', content: { format: 'markdown', body: 'hi' }, projectId })
        .expect(201);
      await request(app)
        .get(`/api/companies/${companyId}/artifacts/${doc.body.data.id}/dashboard/sources/ds1/resolve`)
        .expect(400);
    });

    it('rejects resolve for an undeclared data source id with 404', async () => {
      const created = await createDashboard().expect(201);
      await request(app)
        .get(`/api/companies/${companyId}/artifacts/${created.body.data.id}/dashboard/sources/dsMissing/resolve`)
        .expect(404);
    });

    it('rejects resolve from another company with 404', async () => {
      const created = await createDashboard().expect(201);
      await request(app)
        .get(`/api/companies/${otherCompanyId}/artifacts/${created.body.data.id}/dashboard/sources/ds1/resolve`)
        .expect(404);
    });

    it('resolves all data sources in one call', async () => {
      const created = await createDashboard({
        content: {
          dataSources: [
            { id: 'ds1', type: 'analytics_endpoint', config: { endpoint: '/analytics/overview' } },
            { id: 'ds3', type: 'manual_json', config: { data: { rows: [] } } },
          ],
          widgets: [],
        },
      }).expect(201);
      const id = created.body.data.id;

      const resolved = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/dashboard/resolve`)
        .expect(200);
      expect(resolved.body.data.sources).toHaveLength(2);
      expect(resolved.body.data.sources.map((s: { dataSourceId: string }) => s.dataSourceId)).toEqual(['ds1', 'ds3']);
    });
  });

  // =========================================================================
  // VAL-DASHBOARD-006: edit a widget config (API side — version bump)
  // =========================================================================

  describe('VAL-DASHBOARD-006: edit a widget config and the version bumps', () => {
    it('changes w1 chartType from bar to line and persists', async () => {
      const created = await createDashboard({ content: DASH_THREE_WIDGETS }).expect(201);
      const id = created.body.data.id;

      const patched = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: DASH_EDITED_WIDGET, version: 1 })
        .expect(200);
      expect(patched.body.data.version).toBe(2);
      expect(patched.body.data.content.widgets[0].config.chartType).toBe('line');

      const reopened = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(reopened.body.data.content.widgets[0].config.chartType).toBe('line');
    });
  });

  // =========================================================================
  // VAL-DASHBOARD-008: dashboard updates when underlying data changes
  // =========================================================================

  describe('VAL-DASHBOARD-008: dashboard reflects updated source data on refresh', () => {
    it('updating manual_json data then re-resolving returns the new data', async () => {
      const created = await createDashboard({
        content: {
          dataSources: [{ id: 'ds3', type: 'manual_json', config: { data: { rows: [{ label: 'A', value: 10 }] } } }],
          widgets: [{ id: 'w2', type: 'table', dataSourceId: 'ds3', config: { columns: ['label', 'value'] } }],
        },
      }).expect(201);
      const id = created.body.data.id;

      // Initial resolve
      const r1 = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/dashboard/sources/ds3/resolve`)
        .expect(200);
      expect((r1.body.data.data as { rows: { value: number }[] }).rows[0].value).toBe(10);

      // Update the manual_json data
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({
          content: {
            dataSources: [{ id: 'ds3', type: 'manual_json', config: { data: { rows: [{ label: 'A', value: 99 }] } } }],
            widgets: [{ id: 'w2', type: 'table', dataSourceId: 'ds3', config: { columns: ['label', 'value'] } }],
          },
          version: 1,
        })
        .expect(200);

      // Re-resolve — reflects updated source data
      const r2 = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/dashboard/sources/ds3/resolve`)
        .expect(200);
      expect((r2.body.data.data as { rows: { value: number }[] }).rows[0].value).toBe(99);
    });

    it('analytics_endpoint reflects new agent counts after an agent is added', async () => {
      const created = await createDashboard({
        content: {
          dataSources: [{ id: 'ds1', type: 'analytics_endpoint', config: { endpoint: '/analytics/overview' } }],
          widgets: [],
        },
      }).expect(201);
      const id = created.body.data.id;

      const r1 = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/dashboard/sources/ds1/resolve`)
        .expect(200);
      const before = (r1.body.data.data as { agents: { total: number } }).agents.total;

      // Add another agent
      await request(app)
        .post(`/api/companies/${companyId}/agents`)
        .send({ name: 'Second Agent', role: 'engineer', provider: 'anthropic', model: 'claude-sonnet-4-6' })
        .expect(201);

      const r2 = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/dashboard/sources/ds1/resolve`)
        .expect(200);
      const after = (r2.body.data.data as { agents: { total: number } }).agents.total;
      expect(after).toBe(before + 1);
    });
  });

  // =========================================================================
  // VAL-DASHBOARD-009: versioning — full content snapshots
  // =========================================================================

  describe('VAL-DASHBOARD-009: versioning — dashboard revisions capture full content snapshots', () => {
    it('each revision is a full snapshot and restore recovers prior state', async () => {
      // v1: empty
      const created = await createDashboard().expect(201);
      const id = created.body.data.id;
      // v2: three sources
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: DASH_THREE_SOURCES, version: 1 })
        .expect(200);
      // v3: sources + widgets
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: DASH_THREE_WIDGETS, version: 2 })
        .expect(200);

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(revs.body.data.map((r: { version: number }) => r.version)).toEqual([1, 2, 3]);
      // v1 revision is a full snapshot with empty widgets
      expect(revs.body.data[0].content.widgets).toEqual([]);
      expect(revs.body.data[0].content.dataSources).toEqual([]);
      // v3 revision has the widgets
      expect(revs.body.data[2].content.widgets).toHaveLength(3);

      // Restore v1 (before widgets were added) -> v4 with empty widgets
      const restored = await request(app)
        .post(`/api/companies/${companyId}/artifacts/${id}/revisions/1/restore`)
        .expect(200);
      expect(restored.body.data.version).toBe(4);
      expect(restored.body.data.content.widgets).toEqual([]);
      expect(restored.body.data.content.dataSources).toEqual([]);

      // v1 revision row unchanged (append-only)
      const rev1 = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions/1`)
        .expect(200);
      expect(rev1.body.data.content).toEqual(DASH_EMPTY);

      // full list is [1,2,3,4]
      const revsAfter = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(revsAfter.body.data.map((r: { version: number }) => r.version)).toEqual([1, 2, 3, 4]);
    });
  });

  // =========================================================================
  // VAL-DASHBOARD-010: agent authors a dashboard from a described data source
  // =========================================================================

  describe('VAL-DASHBOARD-010: agent authors a dashboard via artifact.create tool', () => {
    it('an agent tool call creates a project-scoped dashboard attributed to the agent', async () => {
      const service = new ArtifactToolService(db);
      const result = await service.executeTool(
        'artifact.create',
        {
          type: 'dashboard',
          title: '__mtest__ agent dashboard',
          content: {
            dataSources: [
              { id: 'ds1', type: 'manual_json', config: { data: { rows: [{ label: 'Q1', value: 100 }, { label: 'Q2', value: 200 }] } } },
            ],
            widgets: [
              { id: 'w1', type: 'table', dataSourceId: 'ds1', config: { columns: ['label', 'value'] } },
            ],
          },
          projectId,
        },
        { companyId, agentId, projectId },
      );
      expect(result.isError).toBeFalsy();
      const artifactId = result.data?.artifactId as string;
      expect(artifactId).toBeTruthy();

      const created = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${artifactId}`)
        .expect(200);
      expect(created.body.data.type).toBe('dashboard');
      expect(created.body.data.version).toBe(1);
      expect(created.body.data.projectId).toBe(projectId);
      expect(created.body.data.createdByAgentId).toBe(agentId);
      expect(created.body.data.createdByUserId).toBeNull();
      expect(created.body.data.content.dataSources).toHaveLength(1);
      expect(created.body.data.content.widgets).toHaveLength(1);

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${artifactId}/revisions`)
        .expect(200);
      expect(revs.body.data[0].editSource).toBe('agent');
      expect(revs.body.data[0].editedByAgentId).toBe(agentId);
    });

    it('the agent tool rejects a dashboard with a dangling widget binding', async () => {
      const service = new ArtifactToolService(db);
      const result = await service.executeTool(
        'artifact.create',
        {
          type: 'dashboard',
          title: '__mtest__ bad agent dashboard',
          content: {
            dataSources: [],
            widgets: [{ id: 'w1', type: 'table', dataSourceId: 'dsMissing', config: { columns: ['label'] } }],
          },
          projectId,
        },
        { companyId, agentId, projectId },
      );
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('400');
    });

    it('an agent update bumps the version and records editSource=agent', async () => {
      const created = await createDashboard().expect(201);
      const id = created.body.data.id;

      const service = new ArtifactToolService(db);
      const result = await service.executeTool(
        'artifact.update',
        { artifactId: id, version: 1, content: DASH_THREE_SOURCES, message: 'agent added sources' },
        { companyId, agentId, projectId },
      );
      expect(result.isError).toBeFalsy();
      expect(result.data?.version).toBe(2);

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      const agentRev = revs.body.data[1];
      expect(agentRev.version).toBe(2);
      expect(agentRev.editSource).toBe('agent');
      expect(agentRev.editedByAgentId).toBe(agentId);
      expect(agentRev.content.dataSources).toHaveLength(3);
    });

    it('an agent-authored dashboard via X-Eidolon-Agent-Id header records agent source', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .set('X-Eidolon-Agent-Id', agentId)
        .send({ type: 'dashboard', title: '__mtest__ Header Dashboard', content: DASH_THREE_WIDGETS, projectId })
        .expect(201);
      expect(res.body.data.createdByAgentId).toBe(agentId);

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${res.body.data.id}/revisions`)
        .expect(200);
      expect(revs.body.data[0].editSource).toBe('agent');
    });
  });

  // =========================================================================
  // VAL-M5-002: CRUD round-trip for dashboard
  // =========================================================================

  describe('VAL-M5-002 (dashboard): create/list/get/update/delete round-trip', () => {
    it('supports the full CRUD round-trip', async () => {
      const created = await createDashboard().expect(201);
      const id = created.body.data.id;
      expect(created.body.data.version).toBe(1);

      const got = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);
      expect(got.body.data.content).toEqual(DASH_EMPTY);

      const patched = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: DASH_THREE_SOURCES, version: 1 })
        .expect(200);
      expect(patched.body.data.version).toBe(2);

      await request(app)
        .delete(`/api/companies/${companyId}/artifacts/${id}`)
        .expect(200);

      const active = await request(app)
        .get(`/api/companies/${companyId}/artifacts?type=dashboard`)
        .expect(200);
      expect(active.body.data.map((a: { id: string }) => a.id)).not.toContain(id);
    });
  });

  // =========================================================================
  // VAL-M5-004: version + append-only revision per save
  // =========================================================================

  describe('VAL-M5-004 (dashboard): version + append-only revision per save', () => {
    it('create -> v1 + 1 revision; PATCH -> v2 + 1 revision (editSource=user)', async () => {
      const created = await createDashboard().expect(201);
      const id = created.body.data.id;

      const initialRevs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(initialRevs.body.data).toHaveLength(1);
      expect(initialRevs.body.data[0].version).toBe(1);
      expect(initialRevs.body.data[0].editSource).toBe('user');
      expect(initialRevs.body.data[0].content).toEqual(DASH_EMPTY);

      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: DASH_THREE_SOURCES, version: 1 })
        .expect(200);

      const revs = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${id}/revisions`)
        .expect(200);
      expect(revs.body.data).toHaveLength(2);
      expect(revs.body.data[1].version).toBe(2);
      expect(revs.body.data[1].editSource).toBe('user');
      expect(revs.body.data[1].content.dataSources).toHaveLength(3);
    });

    it('rejects a stale optimistic version with 409', async () => {
      const created = await createDashboard().expect(201);
      const id = created.body.data.id;

      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: DASH_THREE_SOURCES, version: 1 })
        .expect(200);

      const stale = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${id}`)
        .send({ content: DASH_EMPTY, version: 1 })
        .expect(409);
      expect(stale.body.code).toBe('ARTIFACT_VERSION_CONFLICT');
      expect(stale.body.details.current.version).toBe(2);
    });
  });

  // =========================================================================
  // VAL-M5-005: project + company isolation
  // =========================================================================

  describe('VAL-M5-005 (dashboard): project + company isolation', () => {
    it('does not return a dashboard from another company', async () => {
      const created = await createDashboard().expect(201);
      const id = created.body.data.id;

      await request(app).get(`/api/companies/${otherCompanyId}/artifacts/${id}`).expect(404);
      const otherList = await request(app)
        .get(`/api/companies/${otherCompanyId}/artifacts?type=dashboard`)
        .expect(200);
      expect(otherList.body.data).toHaveLength(0);
    });

    it('cannot create a dashboard scoped to a project in another company', async () => {
      await createDashboard({ projectId: otherProjectId }).expect(404);
    });

    it('a project-scoped list returns only that project dashboards', async () => {
      const inProject = await createDashboard({ title: '__mtest__ Dash P1' }).expect(201);
      const inSecond = await createDashboard({
        title: '__mtest__ Dash P2',
        projectId: secondProjectId,
      }).expect(201);
      const unscoped = await createDashboard({ title: '__mtest__ Dash none', projectId: null }).expect(201);

      const p1 = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/artifacts`)
        .expect(200);
      const p1Ids = p1.body.data.map((a: { id: string }) => a.id);
      expect(p1Ids).toContain(inProject.body.data.id);
      expect(p1Ids).not.toContain(inSecond.body.data.id);
      expect(p1Ids).not.toContain(unscoped.body.data.id);
    });

    it('appears in the project home composed view', async () => {
      const created = await createDashboard().expect(201);
      const home = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/home`)
        .expect(200);
      const ids = home.body.data.artifacts.map((a: { id: string }) => a.id);
      expect(ids).toContain(created.body.data.id);
    });
  });

  // =========================================================================
  // VAL-M5-006: realtime artifact.* events
  // =========================================================================

  describe('VAL-M5-006 (dashboard): realtime artifact.* events', () => {
    it('emits artifact.created + artifact.revision.created on dashboard create', async () => {
      const events = await captureEvents(async () => {
        await createDashboard().expect(201);
      });
      const created = events.filter((e) => e.type === 'artifact.created');
      expect(created).toHaveLength(1);
      expect(created[0].companyId).toBe(companyId);
      expect(
        (created[0].payload as { artifact: { type: string } }).artifact.type,
      ).toBe('dashboard');
      expect(events.filter((e) => e.type === 'artifact.revision.created')).toHaveLength(1);
    });

    it('emits artifact.updated on dashboard update', async () => {
      const created = await createDashboard().expect(201);
      const id = created.body.data.id;

      const events = await captureEvents(async () => {
        await request(app)
          .patch(`/api/companies/${companyId}/artifacts/${id}`)
          .send({ content: DASH_THREE_SOURCES, version: 1 })
          .expect(200);
      });
      expect(events.filter((e) => e.type === 'artifact.updated')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'artifact.revision.created')).toHaveLength(1);
    });

    it('emits artifact.deleted on dashboard delete', async () => {
      const created = await createDashboard().expect(201);
      const id = created.body.data.id;

      const events = await captureEvents(async () => {
        await request(app).delete(`/api/companies/${companyId}/artifacts/${id}`).expect(200);
      });
      const deleted = events.filter((e) => e.type === 'artifact.deleted');
      expect(deleted).toHaveLength(1);
      expect(
        (deleted[0].payload as { artifact: { id: string } }).artifact.id,
      ).toBe(id);
    });
  });
});
