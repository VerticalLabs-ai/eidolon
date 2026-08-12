// ---------------------------------------------------------------------------
// Revision diff integration tests — VAL-DIFF-001..048, 072..075
// ---------------------------------------------------------------------------
//
// Real-Postgres integration tests for the M2 revision diff backend. Covers:
//   2.1 Endpoint & envelope (001-012): response shape, summary, type
//       discriminator, from/to revision, 404/401/403, same-version empty,
//       reverse diff, ordering, determinism.
//   2.2 Document diff (013-016): line-level added/removed/unchanged,
//       summary counts, ordering, identical empty.
//   2.3 Sheet diff (017-020): column + row changes, cell-level deltas,
//       summary counts, identical empty.
//   2.4 Board diff (021-024): card added/removed/moved/modified, moved vs
//       modified distinction, summary, identical empty.
//   2.5 Slides diff (025-028): slide add/remove/reorder + block-level
//       deltas, summary, identical empty.
//   2.6 Timeline diff (029-032): task add/remove/modify, field-level
//       deltas, summary, identical empty.
//   2.7 Gallery diff (033-036): item add/remove/modify, url/caption
//       deltas, summary, identical empty.
//   2.8 Dashboard diff (037-040): data source + widget changes, summary,
//       identical empty.
//   2.9 App diff (041-044): file-level + line diff, summary, identical
//       empty.
//   2.10 Code diff (045-048): file-level + line diff, summary, identical
//        empty.
//   2.16 Performance & robustness (072-075): <100ms, revision belongs to
//        artifact, malformed version 400, large snapshots.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestServer, createTestDb } from '../test-utils.js';
import type { DbInstance } from '../types.js';

// ---------------------------------------------------------------------------
// Content fixtures per artifact type
// ---------------------------------------------------------------------------

const DOC_V1 = { format: 'markdown' as const, body: 'Line 1\nLine 2\nLine 3' };
const DOC_V2 = { format: 'markdown' as const, body: 'Line 1\nLine 2 modified\nLine 3\nLine 4' };

const SHEET_V1 = {
  columns: [
    { id: 'col1', key: 'name' },
    { id: 'col2', key: 'age' },
  ],
  rows: [
    { id: 'row1', cells: { name: { value: 'Alice' }, age: { value: 30 } } },
    { id: 'row2', cells: { name: { value: 'Bob' }, age: { value: 25 } } },
  ],
};
const SHEET_V2 = {
  columns: [
    { id: 'col1', key: 'name' },
    { id: 'col3', key: 'email' },
  ],
  rows: [
    { id: 'row1', cells: { name: { value: 'Alice Smith' }, email: { value: 'alice@test.com' } } },
    { id: 'row3', cells: { name: { value: 'Carol' }, email: { value: 'carol@test.com' } } },
  ],
};

const BOARD_V1 = {
  columns: [{ id: 'col1', title: 'Todo' }, { id: 'col2', title: 'Done' }],
  cards: [
    { id: 'card1', columnId: 'col1', title: 'Task A', order: 0 },
    { id: 'card2', columnId: 'col1', title: 'Task B', order: 1 },
    { id: 'card3', columnId: 'col2', title: 'Task C', order: 0 },
  ],
};
const BOARD_V2 = {
  columns: [{ id: 'col1', title: 'Todo' }, { id: 'col2', title: 'Done' }],
  cards: [
    { id: 'card1', columnId: 'col2', title: 'Task A', order: 1 }, // moved (col1→col2, order 0→1)
    { id: 'card2', columnId: 'col1', title: 'Task B Updated', order: 1 }, // modified (title)
    // card3 removed
    { id: 'card4', columnId: 'col1', title: 'Task D', order: 0 }, // added
  ],
};

const SLIDES_V1 = {
  slides: [
    { id: 'slide1', layout: 'title', blocks: [{ type: 'text', content: { text: 'Intro' } }] },
    { id: 'slide2', layout: 'content', blocks: [{ type: 'text', content: { text: 'Body' } }] },
  ],
};
const SLIDES_V2 = {
  slides: [
    { id: 'slide2', layout: 'content', blocks: [{ type: 'text', content: { text: 'Body Updated' } }] }, // modified (block) + reordered (index 1→0)
    { id: 'slide3', layout: 'title', blocks: [{ type: 'text', content: { text: 'Conclusion' } }] }, // added
    // slide1 removed
  ],
};

const TIMELINE_V1 = {
  tasks: [
    { id: 'task1', title: 'Design', start: '2025-01-01', end: '2025-01-15', progress: 50 },
    { id: 'task2', title: 'Build', start: '2025-01-16', end: '2025-02-01', dependsOn: ['task1'] },
  ],
};
const TIMELINE_V2 = {
  tasks: [
    { id: 'task1', title: 'Design', start: '2025-01-01', end: '2025-01-20', progress: 100 }, // modified (end, progress)
    { id: 'task3', title: 'Test', start: '2025-02-02', end: '2025-02-15' }, // added
    // task2 removed
  ],
};

const GALLERY_V1 = {
  items: [
    { id: 'item1', type: 'image' as const, url: 'https://example.com/a.png', caption: 'Photo A' },
    { id: 'item2', type: 'image' as const, url: 'https://example.com/b.png', caption: 'Photo B' },
  ],
};
const GALLERY_V2 = {
  items: [
    { id: 'item1', type: 'image' as const, url: 'https://example.com/a-v2.png', caption: 'Photo A' }, // modified (url)
    { id: 'item3', type: 'image' as const, url: 'https://example.com/c.png', caption: 'Photo C' }, // added
    // item2 removed
  ],
};

const DASHBOARD_V1 = {
  dataSources: [
    { id: 'ds1', type: 'manual_json' as const, config: { data: { value: 1 } } },
    { id: 'ds2', type: 'manual_json' as const, config: { data: { value: 2 } } },
  ],
  widgets: [
    { id: 'w1', type: 'metric' as const, dataSourceId: 'ds1', config: { title: 'Metric 1' } },
    { id: 'w2', type: 'chart' as const, dataSourceId: 'ds2', config: { title: 'Chart 1' } },
  ],
};
const DASHBOARD_V2 = {
  dataSources: [
    { id: 'ds1', type: 'manual_json' as const, config: { data: { value: 10 } } }, // modified (config)
    { id: 'ds3', type: 'manual_json' as const, config: { data: { value: 3 } } }, // added
    // ds2 removed
  ],
  widgets: [
    { id: 'w1', type: 'metric' as const, dataSourceId: 'ds1', config: { title: 'Metric 1 Updated' } }, // modified (config)
    { id: 'w3', type: 'table' as const, dataSourceId: 'ds3', config: { title: 'Table 1' } }, // added
    // w2 removed
  ],
};

const APP_V1 = {
  definition: { name: 'Demo App' },
  files: [
    { path: 'index.html', content: '<html>\n<body>\nHello\n</body>\n</html>' },
    { path: 'style.css', content: 'body { color: black; }' },
  ],
};
const APP_V2 = {
  definition: { name: 'Demo App' },
  files: [
    { path: 'index.html', content: '<html>\n<body>\nHello World\n</body>\n</html>' }, // modified
    { path: 'app.js', content: 'console.log("hi");' }, // added
    // style.css removed
  ],
};

const CODE_V1 = {
  language: 'javascript',
  files: [
    { path: 'main.js', content: 'function main() {\n  return 1;\n}' },
    { path: 'util.js', content: 'function util() {\n  return 0;\n}' },
  ],
};
const CODE_V2 = {
  language: 'javascript',
  files: [
    { path: 'main.js', content: 'function main() {\n  return 2;\n}' }, // modified (line 2)
    { path: 'helper.js', content: 'function helper() {\n  return 3;\n}' }, // added
    // util.js removed
  ],
};

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Revision diff API — VAL-DIFF-001..048, 072..075', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;
  let otherCompanyId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Diff Corp' })
      .expect(201);
    companyId = company.body.data.id;

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Other Diff Corp' })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;
  });

  /** Create an artifact via the API (returns the created row). */
  async function createArtifact(opts: {
    type: string;
    content: Record<string, unknown>;
    title?: string;
    companyId?: string;
  }) {
    const res = await request(app)
      .post(`/api/companies/${opts.companyId ?? companyId}/artifacts`)
      .send({
        type: opts.type,
        title: opts.title ?? '__mtest__ Diff Artifact',
        content: opts.content,
      })
      .expect(201);
    return res.body.data;
  }

  /** Update an artifact's content, bumping its version (creates a revision). */
  async function updateArtifact(id: string, content: Record<string, unknown>, version: number) {
    const res = await request(app)
      .patch(`/api/companies/${companyId}/artifacts/${id}`)
      .send({ content, version })
      .expect(200);
    return res.body.data;
  }

  /** Build the diff endpoint URL for a given artifact + revision pair. */
  function diffUrl(id: string, v1: string | number, v2: string | number, cid: string = companyId) {
    return `/api/companies/${cid}/artifacts/${id}/revisions/${v1}/diff/${v2}`;
  }

  // =========================================================================
  // 2.1 Endpoint & Envelope (VAL-DIFF-001..012)
  // =========================================================================
  describe('2.1 Endpoint & envelope', () => {
    // VAL-DIFF-001: Diff endpoint returns structured diff envelope
    it('returns 200 with { diff, fromRevision, toRevision, artifactType }', async () => {
      const artifact = await createArtifact({ type: 'document', content: DOC_V1 });
      await updateArtifact(artifact.id, DOC_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      expect(res.body).toHaveProperty('diff');
      expect(res.body).toHaveProperty('fromRevision');
      expect(res.body).toHaveProperty('toRevision');
      expect(res.body).toHaveProperty('artifactType');
      expect(typeof res.body.diff).toBe('object');
      expect(res.body.artifactType).toBe('document');
    });

    // VAL-DIFF-002: DiffResult carries a summary with additions/deletions/modifications
    it('summary has numeric additions/deletions/modifications', async () => {
      const artifact = await createArtifact({ type: 'document', content: DOC_V1 });
      await updateArtifact(artifact.id, DOC_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const summary = res.body.diff.summary;
      expect(summary).toHaveProperty('additions');
      expect(summary).toHaveProperty('deletions');
      expect(summary).toHaveProperty('modifications');
      expect(Number.isInteger(summary.additions)).toBe(true);
      expect(Number.isInteger(summary.deletions)).toBe(true);
      expect(Number.isInteger(summary.modifications)).toBe(true);
      expect(summary.additions).toBeGreaterThanOrEqual(0);
      expect(summary.deletions).toBeGreaterThanOrEqual(0);
      expect(summary.modifications).toBeGreaterThanOrEqual(0);
      // For document: additions == count of added lines
      const addedLines = res.body.diff.document.lines.filter((l: { type: string }) => l.type === 'added');
      expect(summary.additions).toBe(addedLines.length);
    });

    // VAL-DIFF-003: DiffResult carries the artifact type discriminator
    it('diff.type equals artifactType', async () => {
      const artifact = await createArtifact({ type: 'sheet', content: SHEET_V1 });
      await updateArtifact(artifact.id, SHEET_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      expect(res.body.diff.type).toBe('sheet');
      expect(res.body.diff.type).toBe(res.body.artifactType);
    });

    // VAL-DIFF-004: fromRevision and toRevision are the requested snapshots
    it('fromRevision.version == v1 and toRevision.version == v2 with content', async () => {
      const artifact = await createArtifact({ type: 'document', content: DOC_V1 });
      await updateArtifact(artifact.id, DOC_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      expect(res.body.fromRevision.version).toBe(1);
      expect(res.body.toRevision.version).toBe(2);
      expect(res.body.fromRevision).toHaveProperty('content');
      expect(res.body.toRevision).toHaveProperty('content');
    });

    // VAL-DIFF-005: 404 for non-existent revision
    it('returns 404 for non-existent revision version', async () => {
      const artifact = await createArtifact({ type: 'document', content: DOC_V1 });
      const res = await request(app).get(diffUrl(artifact.id, 1, 99)).expect(404);
      expect(res.body).toHaveProperty('code');
    });

    // VAL-DIFF-006: 404 for non-existent artifact
    it('returns 404 for non-existent artifact', async () => {
      const fakeId = randomUUID();
      await request(app).get(diffUrl(fakeId, 1, 2)).expect(404);
    });

    // VAL-DIFF-007: Company scoping — no cross-company access
    it('returns 404 for artifact in another company', async () => {
      const artifact = await createArtifact({ type: 'document', content: DOC_V1, companyId: otherCompanyId });
      await request(app).get(diffUrl(artifact.id, 1, 1, companyId)).expect(404);
    });

    // VAL-DIFF-009: Same-version diff is empty
    it('same version diff returns empty summary and no changes', async () => {
      const artifact = await createArtifact({ type: 'document', content: DOC_V1 });
      const res = await request(app).get(diffUrl(artifact.id, 1, 1)).expect(200);
      expect(res.body.diff.summary).toEqual({ additions: 0, deletions: 0, modifications: 0 });
      expect(res.body.diff.document.lines.every((l: { type: string }) => l.type === 'unchanged')).toBe(true);
    });

    // VAL-DIFF-010: Reverse diff inverts the result
    it('reverse diff inverts added↔removed and swaps summary additions↔deletions', async () => {
      const artifact = await createArtifact({ type: 'document', content: DOC_V1 });
      await updateArtifact(artifact.id, DOC_V2, 1);

      const forward = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const reverse = await request(app).get(diffUrl(artifact.id, 2, 1)).expect(200);

      const fwdAdded = forward.body.diff.document.lines.filter((l: { type: string }) => l.type === 'added').map((l: { content: string }) => l.content);
      const fwdRemoved = forward.body.diff.document.lines.filter((l: { type: string }) => l.type === 'removed').map((l: { content: string }) => l.content);
      const revAdded = reverse.body.diff.document.lines.filter((l: { type: string }) => l.type === 'added').map((l: { content: string }) => l.content);
      const revRemoved = reverse.body.diff.document.lines.filter((l: { type: string }) => l.type === 'removed').map((l: { content: string }) => l.content);

      expect(revAdded.sort()).toEqual(fwdRemoved.sort());
      expect(revRemoved.sort()).toEqual(fwdAdded.sort());
      expect(reverse.body.diff.summary.additions).toBe(forward.body.diff.summary.deletions);
      expect(reverse.body.diff.summary.deletions).toBe(forward.body.diff.summary.additions);
    });

    // VAL-DIFF-011: Revision ordering does not require v1 < v2
    it('accepts v1 > v2 (reverse order)', async () => {
      const artifact = await createArtifact({ type: 'document', content: DOC_V1 });
      await updateArtifact(artifact.id, DOC_V2, 1);
      await request(app).get(diffUrl(artifact.id, 2, 1)).expect(200);
    });

    // VAL-DIFF-012: Diff is deterministic for the same revision pair
    it('returns the same diff for identical requests', async () => {
      const artifact = await createArtifact({ type: 'document', content: DOC_V1 });
      await updateArtifact(artifact.id, DOC_V2, 1);

      const res1 = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const res2 = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      expect(res2.body.diff).toEqual(res1.body.diff);
    });
  });

  // =========================================================================
  // 2.2 Document diff (VAL-DIFF-013..016)
  // =========================================================================
  describe('2.2 Document diff', () => {
    // VAL-DIFF-013: Document diff is line-level with added/removed/unchanged
    it('produces line-level added/removed/unchanged entries', async () => {
      const artifact = await createArtifact({ type: 'document', content: DOC_V1 });
      await updateArtifact(artifact.id, DOC_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const lines = res.body.diff.document.lines;
      expect(Array.isArray(lines)).toBe(true);
      for (const line of lines) {
        expect(['added', 'removed', 'unchanged']).toContain(line.type);
        expect(typeof line.content).toBe('string');
      }
      // "Line 2" removed, "Line 2 modified" + "Line 4" added
      const added = lines.filter((l: { type: string }) => l.type === 'added').map((l: { content: string }) => l.content);
      const removed = lines.filter((l: { type: string }) => l.type === 'removed').map((l: { content: string }) => l.content);
      expect(removed).toContain('Line 2');
      expect(added).toContain('Line 2 modified');
      expect(added).toContain('Line 4');
    });

    // VAL-DIFF-014: Document diff summary counts match line classifications
    it('summary counts match line classifications', async () => {
      const artifact = await createArtifact({ type: 'document', content: DOC_V1 });
      await updateArtifact(artifact.id, DOC_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const lines = res.body.diff.document.lines;
      const additions = lines.filter((l: { type: string }) => l.type === 'added').length;
      const deletions = lines.filter((l: { type: string }) => l.type === 'removed').length;
      expect(res.body.diff.summary.additions).toBe(additions);
      expect(res.body.diff.summary.deletions).toBe(deletions);
      expect(res.body.diff.summary.modifications).toBe(0);
    });

    // VAL-DIFF-015: Document diff preserves line ordering
    it('preserves merged reading order (unchanged+added reconstructs v2)', async () => {
      const artifact = await createArtifact({ type: 'document', content: DOC_V1 });
      await updateArtifact(artifact.id, DOC_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const lines = res.body.diff.document.lines;
      // unchanged + added (in order) should reconstruct v2 body
      const v2Reconstructed = lines
        .filter((l: { type: string }) => l.type === 'unchanged' || l.type === 'added')
        .map((l: { content: string }) => l.content)
        .join('\n');
      expect(v2Reconstructed).toBe(DOC_V2.body);
      // unchanged + removed (in order) should reconstruct v1 body
      const v1Reconstructed = lines
        .filter((l: { type: string }) => l.type === 'unchanged' || l.type === 'removed')
        .map((l: { content: string }) => l.content)
        .join('\n');
      expect(v1Reconstructed).toBe(DOC_V1.body);
    });

    // VAL-DIFF-016: Document diff with identical bodies is empty
    it('identical bodies produce empty diff', async () => {
      const artifact = await createArtifact({ type: 'document', content: DOC_V1 });
      await updateArtifact(artifact.id, DOC_V1, 1); // same content

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      expect(res.body.diff.summary).toEqual({ additions: 0, deletions: 0, modifications: 0 });
      const changed = res.body.diff.document.lines.filter((l: { type: string }) => l.type !== 'unchanged');
      expect(changed).toHaveLength(0);
    });
  });

  // =========================================================================
  // 2.3 Sheet diff (VAL-DIFF-017..020)
  // =========================================================================
  describe('2.3 Sheet diff', () => {
    // VAL-DIFF-017: Sheet diff reports column changes
    it('reports column changes (added/removed/modified)', async () => {
      const artifact = await createArtifact({ type: 'sheet', content: SHEET_V1 });
      await updateArtifact(artifact.id, SHEET_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const colChanges = res.body.diff.sheet.columnChanges;
      expect(Array.isArray(colChanges)).toBe(true);
      // col2 removed, col3 added
      const removed = colChanges.filter((c: { type: string }) => c.type === 'removed');
      const added = colChanges.filter((c: { type: string }) => c.type === 'added');
      expect(removed.some((c: { column: { id: string } }) => c.column.id === 'col2')).toBe(true);
      expect(added.some((c: { column: { id: string } }) => c.column.id === 'col3')).toBe(true);
    });

    // VAL-DIFF-018: Sheet diff reports row changes with cell-level deltas
    it('reports row changes with cell-level value deltas', async () => {
      const artifact = await createArtifact({ type: 'sheet', content: SHEET_V1 });
      await updateArtifact(artifact.id, SHEET_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const rowChanges = res.body.diff.sheet.rowChanges;
      expect(Array.isArray(rowChanges)).toBe(true);
      // row2 removed, row3 added, row1 modified
      const removed = rowChanges.filter((r: { type: string }) => r.type === 'removed');
      const added = rowChanges.filter((r: { type: string }) => r.type === 'added');
      const modified = rowChanges.filter((r: { type: string }) => r.type === 'modified');
      expect(removed.some((r: { row: { id: string } }) => r.row.id === 'row2')).toBe(true);
      expect(added.some((r: { row: { id: string } }) => r.row.id === 'row3')).toBe(true);
      const row1Mod = modified.find((r: { rowId: string }) => r.rowId === 'row1');
      expect(row1Mod).toBeDefined();
      expect(row1Mod.cellDeltas).toBeInstanceOf(Array);
      expect(row1Mod.cellDeltas.length).toBeGreaterThan(0);
      // Cell value changed: name from 'Alice' to 'Alice Smith'
      const nameDelta = row1Mod.cellDeltas.find((d: { columnKey: string }) => d.columnKey === 'name');
      expect(nameDelta).toBeDefined();
      expect(nameDelta.from).toBe('Alice');
      expect(nameDelta.to).toBe('Alice Smith');
    });

    // VAL-DIFF-019: Sheet diff summary counts rows + columns
    it('summary counts columns + rows', async () => {
      const artifact = await createArtifact({ type: 'sheet', content: SHEET_V1 });
      await updateArtifact(artifact.id, SHEET_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const colChanges = res.body.diff.sheet.columnChanges;
      const rowChanges = res.body.diff.sheet.rowChanges;
      const expectedAdditions = colChanges.filter((c: { type: string }) => c.type === 'added').length + rowChanges.filter((r: { type: string }) => r.type === 'added').length;
      const expectedDeletions = colChanges.filter((c: { type: string }) => c.type === 'removed').length + rowChanges.filter((r: { type: string }) => r.type === 'removed').length;
      const expectedModifications = colChanges.filter((c: { type: string }) => c.type === 'modified').length + rowChanges.filter((r: { type: string }) => r.type === 'modified').length;
      expect(res.body.diff.summary.additions).toBe(expectedAdditions);
      expect(res.body.diff.summary.deletions).toBe(expectedDeletions);
      expect(res.body.diff.summary.modifications).toBe(expectedModifications);
    });

    // VAL-DIFF-020: Sheet diff with identical content is empty
    it('identical sheet content produces empty diff', async () => {
      const artifact = await createArtifact({ type: 'sheet', content: SHEET_V1 });
      await updateArtifact(artifact.id, SHEET_V1, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      expect(res.body.diff.summary).toEqual({ additions: 0, deletions: 0, modifications: 0 });
      expect(res.body.diff.sheet.columnChanges).toHaveLength(0);
      expect(res.body.diff.sheet.rowChanges).toHaveLength(0);
    });
  });

  // =========================================================================
  // 2.4 Board diff (VAL-DIFF-021..024)
  // =========================================================================
  describe('2.4 Board diff', () => {
    // VAL-DIFF-021: Board diff reports card changes
    it('reports card added/removed/moved/modified', async () => {
      const artifact = await createArtifact({ type: 'board', content: BOARD_V1 });
      await updateArtifact(artifact.id, BOARD_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const cardChanges = res.body.diff.board.cardChanges;
      expect(Array.isArray(cardChanges)).toBe(true);
      const added = cardChanges.filter((c: { type: string }) => c.type === 'added');
      const removed = cardChanges.filter((c: { type: string }) => c.type === 'removed');
      const moved = cardChanges.filter((c: { type: string }) => c.type === 'moved');
      const modified = cardChanges.filter((c: { type: string }) => c.type === 'modified');
      expect(added.some((c: { card: { id: string } }) => c.card.id === 'card4')).toBe(true);
      expect(removed.some((c: { card: { id: string } }) => c.card.id === 'card3')).toBe(true);
      expect(moved.some((c: { cardId: string }) => c.cardId === 'card1')).toBe(true);
      expect(modified.some((c: { cardId: string }) => c.cardId === 'card2')).toBe(true);
    });

    // VAL-DIFF-022: Board diff distinguishes moved from modified
    it('classifies position-only change as moved, title-only as modified', async () => {
      const artifact = await createArtifact({ type: 'board', content: BOARD_V1 });
      await updateArtifact(artifact.id, BOARD_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const cardChanges = res.body.diff.board.cardChanges;
      // card1: columnId changed (col1→col2) + order changed (0→1), title same → moved
      const card1 = cardChanges.find((c: { cardId?: string; card?: { id: string } }) =>
        c.cardId === 'card1' || c.card?.id === 'card1');
      expect(card1.type).toBe('moved');
      // card2: title changed, position same (col1, order 1) → modified
      const card2 = cardChanges.find((c: { cardId?: string; card?: { id: string } }) =>
        c.cardId === 'card2' || c.card?.id === 'card2');
      expect(card2.type).toBe('modified');
    });

    // VAL-DIFF-023: Board diff summary counts cards
    it('summary counts cards (moved counted as modifications)', async () => {
      const artifact = await createArtifact({ type: 'board', content: BOARD_V1 });
      await updateArtifact(artifact.id, BOARD_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const cardChanges = res.body.diff.board.cardChanges;
      const additions = cardChanges.filter((c: { type: string }) => c.type === 'added').length;
      const deletions = cardChanges.filter((c: { type: string }) => c.type === 'removed').length;
      const modifications = cardChanges.filter((c: { type: string }) => c.type === 'moved' || c.type === 'modified').length;
      expect(res.body.diff.summary.additions).toBe(additions);
      expect(res.body.diff.summary.deletions).toBe(deletions);
      expect(res.body.diff.summary.modifications).toBe(modifications);
    });

    // VAL-DIFF-024: Board diff with identical cards is empty
    it('identical board content produces empty diff', async () => {
      const artifact = await createArtifact({ type: 'board', content: BOARD_V1 });
      await updateArtifact(artifact.id, BOARD_V1, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      expect(res.body.diff.summary).toEqual({ additions: 0, deletions: 0, modifications: 0 });
      expect(res.body.diff.board.cardChanges).toHaveLength(0);
    });
  });

  // =========================================================================
  // 2.5 Slides diff (VAL-DIFF-025..028)
  // =========================================================================
  describe('2.5 Slides diff', () => {
    // VAL-DIFF-025: Slides diff reports slide-level changes
    it('reports slide added/removed/reordered', async () => {
      const artifact = await createArtifact({ type: 'slide_deck', content: SLIDES_V1 });
      await updateArtifact(artifact.id, SLIDES_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const slideChanges = res.body.diff.slides.slideChanges;
      expect(Array.isArray(slideChanges)).toBe(true);
      const added = slideChanges.filter((s: { type: string }) => s.type === 'added');
      const removed = slideChanges.filter((s: { type: string }) => s.type === 'removed');
      expect(added.some((s: { slide: { id: string } }) => s.slide.id === 'slide3')).toBe(true);
      expect(removed.some((s: { slide: { id: string } }) => s.slide.id === 'slide1')).toBe(true);
    });

    // VAL-DIFF-026: Slides diff reports block-level changes within a slide
    it('reports block-level deltas within a modified slide', async () => {
      const artifact = await createArtifact({ type: 'slide_deck', content: SLIDES_V1 });
      await updateArtifact(artifact.id, SLIDES_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const slideChanges = res.body.diff.slides.slideChanges;
      // slide2 has a block content change (Body → Body Updated)
      const slide2Change = slideChanges.find((s: { slideId?: string; slide?: { id: string } }) =>
        s.slideId === 'slide2' || s.slide?.id === 'slide2');
      expect(slide2Change).toBeDefined();
      // It should be modified (block changed) — reordered would also be true but
      // block changes take priority in our implementation
      expect(['modified', 'reordered']).toContain(slide2Change.type);
      if (slide2Change.type === 'modified') {
        expect(slide2Change.blockDeltas).toBeInstanceOf(Array);
        expect(slide2Change.blockDeltas.length).toBeGreaterThan(0);
      }
    });

    // VAL-DIFF-027: Slides diff summary counts slides + blocks
    it('summary counts slide changes', async () => {
      const artifact = await createArtifact({ type: 'slide_deck', content: SLIDES_V1 });
      await updateArtifact(artifact.id, SLIDES_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const slideChanges = res.body.diff.slides.slideChanges;
      const additions = slideChanges.filter((s: { type: string }) => s.type === 'added').length;
      const deletions = slideChanges.filter((s: { type: string }) => s.type === 'removed').length;
      const modifications = slideChanges.filter((s: { type: string }) => s.type === 'modified' || s.type === 'reordered').length;
      expect(res.body.diff.summary.additions).toBe(additions);
      expect(res.body.diff.summary.deletions).toBe(deletions);
      expect(res.body.diff.summary.modifications).toBe(modifications);
    });

    // VAL-DIFF-028: Slides diff with identical content is empty
    it('identical slides produce empty diff', async () => {
      const artifact = await createArtifact({ type: 'slide_deck', content: SLIDES_V1 });
      await updateArtifact(artifact.id, SLIDES_V1, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      expect(res.body.diff.summary).toEqual({ additions: 0, deletions: 0, modifications: 0 });
      expect(res.body.diff.slides.slideChanges).toHaveLength(0);
    });
  });

  // =========================================================================
  // 2.6 Timeline diff (VAL-DIFF-029..032)
  // =========================================================================
  describe('2.6 Timeline diff', () => {
    // VAL-DIFF-029: Timeline diff reports task changes
    it('reports task added/removed/modified', async () => {
      const artifact = await createArtifact({ type: 'timeline', content: TIMELINE_V1 });
      await updateArtifact(artifact.id, TIMELINE_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const taskChanges = res.body.diff.timeline.taskChanges;
      expect(Array.isArray(taskChanges)).toBe(true);
      const added = taskChanges.filter((t: { type: string }) => t.type === 'added');
      const removed = taskChanges.filter((t: { type: string }) => t.type === 'removed');
      const modified = taskChanges.filter((t: { type: string }) => t.type === 'modified');
      expect(added.some((t: { task: { id: string } }) => t.task.id === 'task3')).toBe(true);
      expect(removed.some((t: { task: { id: string } }) => t.task.id === 'task2')).toBe(true);
      expect(modified.some((t: { taskId: string }) => t.taskId === 'task1')).toBe(true);
    });

    // VAL-DIFF-030: Timeline diff reports field-level task deltas
    it('modified task has field-level deltas with from/to values', async () => {
      const artifact = await createArtifact({ type: 'timeline', content: TIMELINE_V1 });
      await updateArtifact(artifact.id, TIMELINE_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const task1Change = res.body.diff.timeline.taskChanges.find((t: { taskId?: string }) => t.taskId === 'task1');
      expect(task1Change).toBeDefined();
      expect(task1Change.fieldDeltas).toBeInstanceOf(Array);
      expect(task1Change.fieldDeltas.length).toBeGreaterThan(0);
      // end changed from 2025-01-15 to 2025-01-20
      const endDelta = task1Change.fieldDeltas.find((d: { field: string }) => d.field === 'end');
      expect(endDelta).toBeDefined();
      expect(endDelta.from).toBe('2025-01-15');
      expect(endDelta.to).toBe('2025-01-20');
      // progress changed from 50 to 100
      const progressDelta = task1Change.fieldDeltas.find((d: { field: string }) => d.field === 'progress');
      expect(progressDelta).toBeDefined();
      expect(progressDelta.from).toBe(50);
      expect(progressDelta.to).toBe(100);
    });

    // VAL-DIFF-031: Timeline diff summary counts tasks
    it('summary counts task changes', async () => {
      const artifact = await createArtifact({ type: 'timeline', content: TIMELINE_V1 });
      await updateArtifact(artifact.id, TIMELINE_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const taskChanges = res.body.diff.timeline.taskChanges;
      expect(res.body.diff.summary.additions).toBe(taskChanges.filter((t: { type: string }) => t.type === 'added').length);
      expect(res.body.diff.summary.deletions).toBe(taskChanges.filter((t: { type: string }) => t.type === 'removed').length);
      expect(res.body.diff.summary.modifications).toBe(taskChanges.filter((t: { type: string }) => t.type === 'modified').length);
    });

    // VAL-DIFF-032: Timeline diff with identical tasks is empty
    it('identical timeline produces empty diff', async () => {
      const artifact = await createArtifact({ type: 'timeline', content: TIMELINE_V1 });
      await updateArtifact(artifact.id, TIMELINE_V1, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      expect(res.body.diff.summary).toEqual({ additions: 0, deletions: 0, modifications: 0 });
      expect(res.body.diff.timeline.taskChanges).toHaveLength(0);
    });
  });

  // =========================================================================
  // 2.7 Gallery diff (VAL-DIFF-033..036)
  // =========================================================================
  describe('2.7 Gallery diff', () => {
    // VAL-DIFF-033: Gallery diff reports item changes
    it('reports item added/removed/modified', async () => {
      const artifact = await createArtifact({ type: 'gallery', content: GALLERY_V1 });
      await updateArtifact(artifact.id, GALLERY_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const itemChanges = res.body.diff.gallery.itemChanges;
      expect(Array.isArray(itemChanges)).toBe(true);
      const added = itemChanges.filter((i: { type: string }) => i.type === 'added');
      const removed = itemChanges.filter((i: { type: string }) => i.type === 'removed');
      const modified = itemChanges.filter((i: { type: string }) => i.type === 'modified');
      expect(added.some((i: { item: { id: string } }) => i.item.id === 'item3')).toBe(true);
      expect(removed.some((i: { item: { id: string } }) => i.item.id === 'item2')).toBe(true);
      expect(modified.some((i: { itemId: string }) => i.itemId === 'item1')).toBe(true);
    });

    // VAL-DIFF-034: Gallery diff reports url/caption deltas
    it('modified item has url/caption field deltas with from/to', async () => {
      const artifact = await createArtifact({ type: 'gallery', content: GALLERY_V1 });
      await updateArtifact(artifact.id, GALLERY_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const item1Change = res.body.diff.gallery.itemChanges.find((i: { itemId?: string }) => i.itemId === 'item1');
      expect(item1Change).toBeDefined();
      expect(item1Change.fieldDeltas).toBeInstanceOf(Array);
      const urlDelta = item1Change.fieldDeltas.find((d: { field: string }) => d.field === 'url');
      expect(urlDelta).toBeDefined();
      expect(urlDelta.from).toBe('https://example.com/a.png');
      expect(urlDelta.to).toBe('https://example.com/a-v2.png');
    });

    // VAL-DIFF-035: Gallery diff summary counts items
    it('summary counts item changes', async () => {
      const artifact = await createArtifact({ type: 'gallery', content: GALLERY_V1 });
      await updateArtifact(artifact.id, GALLERY_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const itemChanges = res.body.diff.gallery.itemChanges;
      expect(res.body.diff.summary.additions).toBe(itemChanges.filter((i: { type: string }) => i.type === 'added').length);
      expect(res.body.diff.summary.deletions).toBe(itemChanges.filter((i: { type: string }) => i.type === 'removed').length);
      expect(res.body.diff.summary.modifications).toBe(itemChanges.filter((i: { type: string }) => i.type === 'modified').length);
    });

    // VAL-DIFF-036: Gallery diff with identical items is empty
    it('identical gallery produces empty diff', async () => {
      const artifact = await createArtifact({ type: 'gallery', content: GALLERY_V1 });
      await updateArtifact(artifact.id, GALLERY_V1, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      expect(res.body.diff.summary).toEqual({ additions: 0, deletions: 0, modifications: 0 });
      expect(res.body.diff.gallery.itemChanges).toHaveLength(0);
    });
  });

  // =========================================================================
  // 2.8 Dashboard diff (VAL-DIFF-037..040)
  // =========================================================================
  describe('2.8 Dashboard diff', () => {
    // VAL-DIFF-037: Dashboard diff reports data source changes
    it('reports data source added/removed/modified', async () => {
      const artifact = await createArtifact({ type: 'dashboard', content: DASHBOARD_V1 });
      await updateArtifact(artifact.id, DASHBOARD_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const dsChanges = res.body.diff.dashboard.dataSourceChanges;
      expect(Array.isArray(dsChanges)).toBe(true);
      expect(dsChanges.filter((d: { type: string }) => d.type === 'added').some((d: { dataSource: { id: string } }) => d.dataSource.id === 'ds3')).toBe(true);
      expect(dsChanges.filter((d: { type: string }) => d.type === 'removed').some((d: { dataSource: { id: string } }) => d.dataSource.id === 'ds2')).toBe(true);
      expect(dsChanges.filter((d: { type: string }) => d.type === 'modified').some((d: { dataSourceId: string }) => d.dataSourceId === 'ds1')).toBe(true);
    });

    // VAL-DIFF-038: Dashboard diff reports widget changes
    it('reports widget added/removed/modified', async () => {
      const artifact = await createArtifact({ type: 'dashboard', content: DASHBOARD_V1 });
      await updateArtifact(artifact.id, DASHBOARD_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const wChanges = res.body.diff.dashboard.widgetChanges;
      expect(Array.isArray(wChanges)).toBe(true);
      expect(wChanges.filter((w: { type: string }) => w.type === 'added').some((w: { widget: { id: string } }) => w.widget.id === 'w3')).toBe(true);
      expect(wChanges.filter((w: { type: string }) => w.type === 'removed').some((w: { widget: { id: string } }) => w.widget.id === 'w2')).toBe(true);
      expect(wChanges.filter((w: { type: string }) => w.type === 'modified').some((w: { widgetId: string }) => w.widgetId === 'w1')).toBe(true);
    });

    // VAL-DIFF-039: Dashboard diff summary counts data sources + widgets
    it('summary counts data sources + widgets', async () => {
      const artifact = await createArtifact({ type: 'dashboard', content: DASHBOARD_V1 });
      await updateArtifact(artifact.id, DASHBOARD_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const ds = res.body.diff.dashboard.dataSourceChanges;
      const ws = res.body.diff.dashboard.widgetChanges;
      const additions = ds.filter((d: { type: string }) => d.type === 'added').length + ws.filter((w: { type: string }) => w.type === 'added').length;
      const deletions = ds.filter((d: { type: string }) => d.type === 'removed').length + ws.filter((w: { type: string }) => w.type === 'removed').length;
      const modifications = ds.filter((d: { type: string }) => d.type === 'modified').length + ws.filter((w: { type: string }) => w.type === 'modified').length;
      expect(res.body.diff.summary.additions).toBe(additions);
      expect(res.body.diff.summary.deletions).toBe(deletions);
      expect(res.body.diff.summary.modifications).toBe(modifications);
    });

    // VAL-DIFF-040: Dashboard diff with identical content is empty
    it('identical dashboard produces empty diff', async () => {
      const artifact = await createArtifact({ type: 'dashboard', content: DASHBOARD_V1 });
      await updateArtifact(artifact.id, DASHBOARD_V1, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      expect(res.body.diff.summary).toEqual({ additions: 0, deletions: 0, modifications: 0 });
      expect(res.body.diff.dashboard.dataSourceChanges).toHaveLength(0);
      expect(res.body.diff.dashboard.widgetChanges).toHaveLength(0);
    });
  });

  // =========================================================================
  // 2.9 App diff (VAL-DIFF-041..044)
  // =========================================================================
  describe('2.9 App diff', () => {
    // VAL-DIFF-041: App diff reports file-level changes
    it('reports file added/removed/modified', async () => {
      const artifact = await createArtifact({ type: 'app', content: APP_V1 });
      await updateArtifact(artifact.id, APP_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const fileChanges = res.body.diff.app.fileChanges;
      expect(Array.isArray(fileChanges)).toBe(true);
      expect(fileChanges.filter((f: { type: string }) => f.type === 'added').some((f: { path: string }) => f.path === 'app.js')).toBe(true);
      expect(fileChanges.filter((f: { type: string }) => f.type === 'removed').some((f: { path: string }) => f.path === 'style.css')).toBe(true);
      expect(fileChanges.filter((f: { type: string }) => f.type === 'modified').some((f: { path: string }) => f.path === 'index.html')).toBe(true);
    });

    // VAL-DIFF-042: App diff reports line diff within modified files
    it('modified file contains line-level diff', async () => {
      const artifact = await createArtifact({ type: 'app', content: APP_V1 });
      await updateArtifact(artifact.id, APP_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const modFile = res.body.diff.app.fileChanges.find((f: { type: string; path: string }) => f.type === 'modified' && f.path === 'index.html');
      expect(modFile).toBeDefined();
      expect(modFile.lineDiff).toBeDefined();
      expect(Array.isArray(modFile.lineDiff.lines)).toBe(true);
      const added = modFile.lineDiff.lines.filter((l: { type: string }) => l.type === 'added');
      const removed = modFile.lineDiff.lines.filter((l: { type: string }) => l.type === 'removed');
      expect(added.length).toBeGreaterThan(0);
      expect(removed.length).toBeGreaterThan(0);
    });

    // VAL-DIFF-043: App diff summary counts files + lines
    it('summary is consistent with file + line counts', async () => {
      const artifact = await createArtifact({ type: 'app', content: APP_V1 });
      await updateArtifact(artifact.id, APP_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const fileChanges = res.body.diff.app.fileChanges;
      // additions = added files + added lines within modified files
      const addedFiles = fileChanges.filter((f: { type: string }) => f.type === 'added').length;
      const removedFiles = fileChanges.filter((f: { type: string }) => f.type === 'removed').length;
      const modifiedFiles = fileChanges.filter((f: { type: string }) => f.type === 'modified');
      let addedLines = 0;
      let removedLines = 0;
      for (const f of modifiedFiles) {
        addedLines += f.lineDiff.lines.filter((l: { type: string }) => l.type === 'added').length;
        removedLines += f.lineDiff.lines.filter((l: { type: string }) => l.type === 'removed').length;
      }
      expect(res.body.diff.summary.additions).toBe(addedFiles + addedLines);
      expect(res.body.diff.summary.deletions).toBe(removedFiles + removedLines);
      expect(res.body.diff.summary.modifications).toBe(modifiedFiles.length);
    });

    // VAL-DIFF-044: App diff with identical files is empty
    it('identical app files produce empty diff', async () => {
      const artifact = await createArtifact({ type: 'app', content: APP_V1 });
      await updateArtifact(artifact.id, APP_V1, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      expect(res.body.diff.summary).toEqual({ additions: 0, deletions: 0, modifications: 0 });
      expect(res.body.diff.app.fileChanges).toHaveLength(0);
    });
  });

  // =========================================================================
  // 2.10 Code diff (VAL-DIFF-045..048)
  // =========================================================================
  describe('2.10 Code diff', () => {
    // VAL-DIFF-045: Code diff reports file-level changes
    it('reports file added/removed/modified', async () => {
      const artifact = await createArtifact({ type: 'code', content: CODE_V1 });
      await updateArtifact(artifact.id, CODE_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const fileChanges = res.body.diff.code.fileChanges;
      expect(Array.isArray(fileChanges)).toBe(true);
      expect(fileChanges.filter((f: { type: string }) => f.type === 'added').some((f: { path: string }) => f.path === 'helper.js')).toBe(true);
      expect(fileChanges.filter((f: { type: string }) => f.type === 'removed').some((f: { path: string }) => f.path === 'util.js')).toBe(true);
      expect(fileChanges.filter((f: { type: string }) => f.type === 'modified').some((f: { path: string }) => f.path === 'main.js')).toBe(true);
    });

    // VAL-DIFF-046: Code diff reports line diff within modified files
    it('modified file contains line-level diff', async () => {
      const artifact = await createArtifact({ type: 'code', content: CODE_V1 });
      await updateArtifact(artifact.id, CODE_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const modFile = res.body.diff.code.fileChanges.find((f: { type: string; path: string }) => f.type === 'modified' && f.path === 'main.js');
      expect(modFile).toBeDefined();
      expect(modFile.lineDiff).toBeDefined();
      expect(Array.isArray(modFile.lineDiff.lines)).toBe(true);
      // Line 2 changed: "  return 1;" → "  return 2;"
      const removed = modFile.lineDiff.lines.filter((l: { type: string }) => l.type === 'removed').map((l: { content: string }) => l.content);
      const added = modFile.lineDiff.lines.filter((l: { type: string }) => l.type === 'added').map((l: { content: string }) => l.content);
      expect(removed).toContain('  return 1;');
      expect(added).toContain('  return 2;');
    });

    // VAL-DIFF-047: Code diff summary counts files + lines
    it('summary is consistent with file + line counts', async () => {
      const artifact = await createArtifact({ type: 'code', content: CODE_V1 });
      await updateArtifact(artifact.id, CODE_V2, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const fileChanges = res.body.diff.code.fileChanges;
      const addedFiles = fileChanges.filter((f: { type: string }) => f.type === 'added').length;
      const removedFiles = fileChanges.filter((f: { type: string }) => f.type === 'removed').length;
      const modifiedFiles = fileChanges.filter((f: { type: string }) => f.type === 'modified');
      let addedLines = 0;
      let removedLines = 0;
      for (const f of modifiedFiles) {
        addedLines += f.lineDiff.lines.filter((l: { type: string }) => l.type === 'added').length;
        removedLines += f.lineDiff.lines.filter((l: { type: string }) => l.type === 'removed').length;
      }
      expect(res.body.diff.summary.additions).toBe(addedFiles + addedLines);
      expect(res.body.diff.summary.deletions).toBe(removedFiles + removedLines);
      expect(res.body.diff.summary.modifications).toBe(modifiedFiles.length);
    });

    // VAL-DIFF-048: Code diff with identical files is empty
    it('identical code files produce empty diff', async () => {
      const artifact = await createArtifact({ type: 'code', content: CODE_V1 });
      await updateArtifact(artifact.id, CODE_V1, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      expect(res.body.diff.summary).toEqual({ additions: 0, deletions: 0, modifications: 0 });
      expect(res.body.diff.code.fileChanges).toHaveLength(0);
    });
  });

  // =========================================================================
  // 2.16 Performance & Robustness (VAL-DIFF-072..075)
  // =========================================================================
  describe('2.16 Performance & robustness', () => {
    // VAL-DIFF-072: Diff completes under 100ms for in-memory snapshots
    it('completes in under 100ms for typical revisions', async () => {
      const artifact = await createArtifact({ type: 'document', content: DOC_V1 });
      await updateArtifact(artifact.id, DOC_V2, 1);

      const start = Date.now();
      await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const elapsed = Date.now() - start;
      // Allow generous headroom for supertest + Express overhead. The
      // service-layer diff itself is in-memory and sub-millisecond; this
      // asserts the full round-trip stays well under the 100ms budget.
      expect(elapsed).toBeLessThan(100);
    });

    // VAL-DIFF-073: Diff endpoint validates revision belongs to the artifact
    it('returns 404 when revision version belongs to a different artifact', async () => {
      const artifact1 = await createArtifact({ type: 'document', content: DOC_V1 });
      await updateArtifact(artifact1.id, DOC_V2, 1); // v1, v2
      const artifact2 = await createArtifact({ type: 'document', content: DOC_V1 });
      // artifact2 only has v1; requesting v2 (which belongs to artifact1) → 404
      await request(app).get(diffUrl(artifact2.id, 1, 2)).expect(404);
    });

    // VAL-DIFF-074: Diff endpoint rejects malformed version params
    it('returns 400 for non-numeric version parameter', async () => {
      const artifact = await createArtifact({ type: 'document', content: DOC_V1 });
      await request(app).get(diffUrl(artifact.id, 'abc', 2)).expect(400);
      await request(app).get(diffUrl(artifact.id, 1, 'xyz')).expect(400);
    });

    // VAL-DIFF-075: Diff endpoint handles large snapshots without truncation
    it('handles large document snapshots without truncation', async () => {
      const largeBody1 = Array.from({ length: 500 }, (_, i) => `Line ${i}`).join('\n');
      const largeBody2 = Array.from({ length: 500 }, (_, i) => i === 250 ? 'Line 250 MODIFIED' : `Line ${i}`).join('\n');
      const artifact = await createArtifact({ type: 'document', content: { format: 'markdown', body: largeBody1 } });
      await updateArtifact(artifact.id, { format: 'markdown', body: largeBody2 }, 1);

      const res = await request(app).get(diffUrl(artifact.id, 1, 2)).expect(200);
      const lines = res.body.diff.document.lines;
      // Should have 1 removed + 1 added (the modified line) + 499 unchanged
      const added = lines.filter((l: { type: string }) => l.type === 'added');
      const removed = lines.filter((l: { type: string }) => l.type === 'removed');
      expect(added).toHaveLength(1);
      expect(removed).toHaveLength(1);
      expect(added[0].content).toBe('Line 250 MODIFIED');
      expect(removed[0].content).toBe('Line 250');
    });
  });
});
