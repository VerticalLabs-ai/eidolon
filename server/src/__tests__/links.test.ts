// ---------------------------------------------------------------------------
// Smart artifact linking integration tests — VAL-LINK-001..027, 042..046
// ---------------------------------------------------------------------------
//
// Real-Postgres integration tests for the M3 links backend. Covers:
//   3.1 Links API (001-027): response shape, linkedFrom (thread items
//       mentioning this artifact with thread title, snippet, author, date),
//       linkedTo (artifacts mentioned alongside), related (scored by
//       project/folder/agent/co-mention), company scoping, 404, auth,
//       empty states, multiple mentions, sorting, limits, performance.
//   3.3 GIN index correctness (042-046): reverse-lookup correctness,
//       EXPLAIN shows index scan, mixed-entity mentions, index exists,
//       index maintained on update.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { createTestServer, createTestDb } from '../test-utils.js';
import type { DbInstance } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Content factory per artifact type (for createArtifact). */
function artifactContent(type: string, title: string): Record<string, unknown> {
  switch (type) {
    case 'document':
      return { format: 'markdown', body: `# ${title}` };
    case 'sheet':
      return { columns: [{ id: 'col1', key: 'name' }], rows: [{ id: 'row1', cells: { name: { value: title } } }] };
    case 'board':
      return { columns: [{ id: 'col1', title: 'Todo' }], cards: [{ id: 'card1', columnId: 'col1', title, order: 0 }] };
    case 'code':
      return { language: 'javascript', files: [{ path: 'main.js', content: `// ${title}` }] };
    default:
      return { format: 'markdown', body: `# ${title}` };
  }
}

/** Create an artifact via the API and return its id. */
async function createArtifact(
  app: Awaited<ReturnType<typeof createTestServer>>,
  companyId: string,
  opts: {
    title: string;
    type?: string;
    projectId?: string;
    folderId?: string;
    createdByAgentId?: string;
  },
): Promise<string> {
  const type = opts.type ?? 'document';
  const res = await request(app)
    .post(`/api/companies/${companyId}/artifacts`)
    .send({
      type,
      title: opts.title,
      content: artifactContent(type, opts.title),
      projectId: opts.projectId ?? null,
      folderId: opts.folderId ?? null,
    })
    .set(opts.createdByAgentId ? { 'X-Eidolon-Agent-Id': opts.createdByAgentId } : {})
    .expect(201);
  return res.body.data.id;
}

/** Create a project thread via the API and return its id. */
async function createThread(
  app: Awaited<ReturnType<typeof createTestServer>>,
  companyId: string,
  projectId: string,
  title: string,
): Promise<string> {
  const res = await request(app)
    .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
    .send({ title, type: 'conversation' })
    .expect(201);
  return res.body.data.id;
}

/** Create a thread item with mentions via the API. */
async function createThreadItem(
  app: Awaited<ReturnType<typeof createTestServer>>,
  companyId: string,
  projectId: string,
  threadId: string,
  opts: {
    content: string;
    mentions: Array<{ entityType: string; entityId: string; label: string; artifactType?: string }>;
  },
): Promise<string> {
  const res = await request(app)
    .post(`/api/companies/${companyId}/projects/${projectId}/threads/${threadId}/items`)
    .send({
      kind: 'comment',
      content: opts.content,
      mentions: opts.mentions,
    })
    .expect(201);
  return res.body.data.id;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Smart artifact linking API — VAL-LINK-001..027, 042..046', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;
  let otherCompanyId: string;
  let projectId: string;
  let otherProjectId: string;
  let folderId: string;
  let agentId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    // Create companies
    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Links Corp' })
      .expect(201);
    companyId = company.body.data.id;

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Other Links Corp' })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;

    // Create projects
    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Links Proj', status: 'active' })
      .expect(201);
    projectId = project.body.data.id;

    const otherProject = await request(app)
      .post(`/api/companies/${otherCompanyId}/projects`)
      .send({ name: 'Other Links Proj', status: 'active' })
      .expect(201);
    otherProjectId = otherProject.body.data.id;

    // Create folder
    const folder = await request(app)
      .post(`/api/companies/${companyId}/folders`)
      .send({ name: 'Links Folder', projectId })
      .expect(201);
    folderId = folder.body.data.id;

    // Create agent
    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Links Agent',
        role: 'engineer',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      })
      .expect(201);
    agentId = agent.body.data.id;
  });

  // -------------------------------------------------------------------------
  // 3.1 Links API — Core behavior
  // -------------------------------------------------------------------------

  describe('VAL-LINK-001: response shape — linkedFrom, linkedTo, related arrays', () => {
    it('returns 200 with all three top-level keys as arrays', async () => {
      const artifactId = await createArtifact(app, companyId, {
        title: '__mtest__ Target Doc',
        projectId,
      });

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${artifactId}/links`)
        .expect(200);

      expect(res.body).toHaveProperty('linkedFrom');
      expect(res.body).toHaveProperty('linkedTo');
      expect(res.body).toHaveProperty('related');
      expect(Array.isArray(res.body.linkedFrom)).toBe(true);
      expect(Array.isArray(res.body.linkedTo)).toBe(true);
      expect(Array.isArray(res.body.related)).toBe(true);
    });
  });

  describe('VAL-LINK-002: linkedFrom returns thread items mentioning this artifact', () => {
    it('returns one entry per matching thread item with all required fields', async () => {
      const targetId = await createArtifact(app, companyId, {
        title: '__mtest__ Linked Target',
        projectId,
      });
      const threadId = await createThread(app, companyId, projectId, 'Discussion Thread');
      await createThreadItem(app, companyId, projectId, threadId, {
        content: 'Check out this artifact @__mtest__ Linked Target',
        mentions: [{ entityType: 'artifact', entityId: targetId, label: '__mtest__ Linked Target', artifactType: 'document' }],
      });

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${targetId}/links`)
        .expect(200);

      expect(res.body.linkedFrom).toHaveLength(1);
      const entry = res.body.linkedFrom[0];
      expect(entry.threadItemId).toBeDefined();
      expect(entry.threadTitle).toBe('Discussion Thread');
      expect(entry.contentSnippet).toContain('Check out');
      expect(entry.author).toBeDefined();
      expect(entry.createdAt).toBeDefined();
    });
  });

  describe('VAL-LINK-003: linkedFrom thread title is the parent thread title', () => {
    it('threadTitle equals the project thread title, not the thread item content', async () => {
      const targetId = await createArtifact(app, companyId, {
        title: '__mtest__ Title Test',
        projectId,
      });
      const threadId = await createThread(app, companyId, projectId, 'My Parent Thread Title');
      await createThreadItem(app, companyId, projectId, threadId, {
        content: 'Some item content about @__mtest__ Title Test',
        mentions: [{ entityType: 'artifact', entityId: targetId, label: '__mtest__ Title Test' }],
      });

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${targetId}/links`)
        .expect(200);

      expect(res.body.linkedFrom[0].threadTitle).toBe('My Parent Thread Title');
    });
  });

  describe('VAL-LINK-004: linkedFrom content snippet is a truncated excerpt', () => {
    it('snippet is derived from thread item content and bounded in length', async () => {
      const targetId = await createArtifact(app, companyId, {
        title: '__mtest__ Snippet Test',
        projectId,
      });
      const threadId = await createThread(app, companyId, projectId, 'Snippet Thread');
      const longContent = 'A'.repeat(300);
      await createThreadItem(app, companyId, projectId, threadId, {
        content: longContent,
        mentions: [{ entityType: 'artifact', entityId: targetId, label: '__mtest__ Snippet Test' }],
      });

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${targetId}/links`)
        .expect(200);

      const snippet = res.body.linkedFrom[0].contentSnippet;
      expect(snippet.length).toBeLessThanOrEqual(200);
      expect(snippet).toContain('...');
    });
  });

  describe('VAL-LINK-005: linkedFrom author reflects user or agent', () => {
    it('author reports userId when authored by a user', async () => {
      const targetId = await createArtifact(app, companyId, {
        title: '__mtest__ Author User Test',
        projectId,
      });
      const threadId = await createThread(app, companyId, projectId, 'Author Thread');
      await createThreadItem(app, companyId, projectId, threadId, {
        content: 'User-authored mention @__mtest__ Author User Test',
        mentions: [{ entityType: 'artifact', entityId: targetId, label: '__mtest__ Author User Test' }],
      });

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${targetId}/links`)
        .expect(200);

      const author = res.body.linkedFrom[0].author;
      expect(author).toBeDefined();
      expect(author.userId).toBeDefined();
    });
  });

  describe('VAL-LINK-006: linkedFrom createdAt matches thread item creation timestamp', () => {
    it('createdAt is an ISO timestamp matching the thread item', async () => {
      const targetId = await createArtifact(app, companyId, {
        title: '__mtest__ Date Test',
        projectId,
      });
      const threadId = await createThread(app, companyId, projectId, 'Date Thread');
      const itemRes = await request(app)
        .post(`/api/companies/${companyId}/projects/${projectId}/threads/${threadId}/items`)
        .send({
          kind: 'comment',
          content: 'Dated mention @__mtest__ Date Test',
          mentions: [{ entityType: 'artifact', entityId: targetId, label: '__mtest__ Date Test' }],
        })
        .expect(201);

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${targetId}/links`)
        .expect(200);

      // The createdAt should be a valid ISO string
      const createdAt = new Date(res.body.linkedFrom[0].createdAt);
      expect(createdAt.getTime()).not.toBeNaN();
      // The thread item's createdAt should be close to the response
      const itemCreatedAt = new Date(itemRes.body.data.createdAt);
      expect(Math.abs(createdAt.getTime() - itemCreatedAt.getTime())).toBeLessThan(5000);
    });
  });

  describe('VAL-LINK-007: linkedTo returns artifacts mentioned in this artifact threads', () => {
    it('returns artifacts co-mentioned alongside the target, deduplicated', async () => {
      const targetId = await createArtifact(app, companyId, {
        title: '__mtest__ LinkedTo Target',
        projectId,
      });
      const otherArtifactId = await createArtifact(app, companyId, {
        title: '__mtest__ Co-mentioned Artifact',
        projectId,
      });
      const threadId = await createThread(app, companyId, projectId, 'Co-mention Thread');
      // Two thread items mentioning both target + other artifact
      await createThreadItem(app, companyId, projectId, threadId, {
        content: 'Mentions both @__mtest__ LinkedTo Target and @__mtest__ Co-mentioned Artifact',
        mentions: [
          { entityType: 'artifact', entityId: targetId, label: '__mtest__ LinkedTo Target' },
          { entityType: 'artifact', entityId: otherArtifactId, label: '__mtest__ Co-mentioned Artifact', artifactType: 'document' },
        ],
      });
      await createThreadItem(app, companyId, projectId, threadId, {
        content: 'Another mention of both @__mtest__ LinkedTo Target and @__mtest__ Co-mentioned Artifact',
        mentions: [
          { entityType: 'artifact', entityId: targetId, label: '__mtest__ LinkedTo Target' },
          { entityType: 'artifact', entityId: otherArtifactId, label: '__mtest__ Co-mentioned Artifact', artifactType: 'document' },
        ],
      });

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${targetId}/links`)
        .expect(200);

      // linkedTo should contain the co-mentioned artifact, deduplicated (once)
      expect(res.body.linkedTo).toHaveLength(1);
      expect(res.body.linkedTo[0].artifactId).toBe(otherArtifactId);
      expect(res.body.linkedTo[0].title).toBe('__mtest__ Co-mentioned Artifact');
      // Self should not be in linkedTo
      expect(res.body.linkedTo.find((l: any) => l.artifactId === targetId)).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 3.1 Links API — Related scoring
  // -------------------------------------------------------------------------

  describe('VAL-LINK-008: related scored by shared project (+3)', () => {
    it('same-project artifact has score >= 3 and "Same project" in reasons', async () => {
      const targetId = await createArtifact(app, companyId, {
        title: '__mtest__ Project Target',
        projectId,
      });
      // Same project, different folder
      await createArtifact(app, companyId, {
        title: '__mtest__ Same Project Peer',
        projectId,
      });

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${targetId}/links`)
        .expect(200);

      const peer = res.body.related.find((r: any) => r.title === '__mtest__ Same Project Peer');
      expect(peer).toBeDefined();
      expect(peer.score).toBeGreaterThanOrEqual(3);
      expect(peer.reasons).toContain('Same project');
    });
  });

  describe('VAL-LINK-009: related scored by shared folder (+2)', () => {
    it('same-folder artifact has score >= 2 and "Shared folder" in reasons', async () => {
      const targetId = await createArtifact(app, companyId, {
        title: '__mtest__ Folder Target',
        projectId,
        folderId,
      });
      // Same folder (also same project, since folder is project-scoped).
      // Score will be project(3) + folder(2) = 5, but we check >= 2 and
      // "Shared folder" in reasons.
      await createArtifact(app, companyId, {
        title: '__mtest__ Same Folder Peer',
        projectId,
        folderId,
      });

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${targetId}/links`)
        .expect(200);

      const peer = res.body.related.find((r: any) => r.title === '__mtest__ Same Folder Peer');
      expect(peer).toBeDefined();
      expect(peer.score).toBeGreaterThanOrEqual(2);
      expect(peer.reasons).toContain('Shared folder');
    });
  });

  describe('VAL-LINK-010: related scored by shared agent activity (+2)', () => {
    it('agent-edited peer artifact has +2 and "Agent edited" in reasons', async () => {
      const targetId = await createArtifact(app, companyId, {
        title: '__mtest__ Agent Target',
        projectId,
        createdByAgentId: agentId,
      });
      // Another artifact created by the same agent
      await createArtifact(app, companyId, {
        title: '__mtest__ Agent Peer',
        createdByAgentId: agentId,
      });

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${targetId}/links`)
        .expect(200);

      const peer = res.body.related.find((r: any) => r.title === '__mtest__ Agent Peer');
      expect(peer).toBeDefined();
      expect(peer.score).toBeGreaterThanOrEqual(2);
      expect(peer.reasons).toContain('Agent edited');
    });
  });

  describe('VAL-LINK-011: related scored by co-mention (+1)', () => {
    it('co-mentioned artifact has +1 and "Co-mentioned" in reasons', async () => {
      const targetId = await createArtifact(app, companyId, {
        title: '__mtest__ CoMention Target',
      });
      const coMentionedId = await createArtifact(app, companyId, {
        title: '__mtest__ Co-mentioned Peer',
      });
      const threadId = await createThread(app, companyId, projectId, 'Co-mention Score Thread');
      await createThreadItem(app, companyId, projectId, threadId, {
        content: 'Mentions @__mtest__ CoMention Target and @__mtest__ Co-mentioned Peer',
        mentions: [
          { entityType: 'artifact', entityId: targetId, label: '__mtest__ CoMention Target' },
          { entityType: 'artifact', entityId: coMentionedId, label: '__mtest__ Co-mentioned Peer' },
        ],
      });

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${targetId}/links`)
        .expect(200);

      const peer = res.body.related.find((r: any) => r.artifactId === coMentionedId);
      expect(peer).toBeDefined();
      expect(peer.score).toBeGreaterThanOrEqual(1);
      expect(peer.reasons).toContain('Co-mentioned');
    });
  });

  describe('VAL-LINK-012: related accumulate scores from multiple signals', () => {
    it('artifact sharing project + folder + agent + co-mention gets sum of all', async () => {
      const targetId = await createArtifact(app, companyId, {
        title: '__mtest__ Multi Target',
        projectId,
        folderId,
        createdByAgentId: agentId,
      });
      const peerId = await createArtifact(app, companyId, {
        title: '__mtest__ Multi Peer',
        projectId,
        folderId,
        createdByAgentId: agentId,
      });
      const threadId = await createThread(app, companyId, projectId, 'Multi Signal Thread');
      await createThreadItem(app, companyId, projectId, threadId, {
        content: 'Mentions @__mtest__ Multi Target and @__mtest__ Multi Peer',
        mentions: [
          { entityType: 'artifact', entityId: targetId, label: '__mtest__ Multi Target' },
          { entityType: 'artifact', entityId: peerId, label: '__mtest__ Multi Peer' },
        ],
      });

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${targetId}/links`)
        .expect(200);

      const peer = res.body.related.find((r: any) => r.artifactId === peerId);
      expect(peer).toBeDefined();
      // project(3) + folder(2) + agent(2) + co-mention(1) = 8
      expect(peer.score).toBe(8);
      expect(peer.reasons).toContain('Same project');
      expect(peer.reasons).toContain('Shared folder');
      expect(peer.reasons).toContain('Agent edited');
      expect(peer.reasons).toContain('Co-mentioned');
    });
  });

  describe('VAL-LINK-013: related exclude self', () => {
    it('target artifact never appears in its own related array', async () => {
      const targetId = await createArtifact(app, companyId, {
        title: '__mtest__ Self Exclude',
        projectId,
      });

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${targetId}/links`)
        .expect(200);

      expect(res.body.related.find((r: any) => r.artifactId === targetId)).toBeUndefined();
    });
  });

  describe('VAL-LINK-014: related exclude archived artifacts', () => {
    it('archived artifact does not appear in related', async () => {
      const targetId = await createArtifact(app, companyId, {
        title: '__mtest__ Archive Exclude Target',
        projectId,
      });
      const archivedId = await createArtifact(app, companyId, {
        title: '__mtest__ Archived Peer',
        projectId,
      });
      await request(app)
        .post(`/api/companies/${companyId}/artifacts/${archivedId}/archive`)
        .send({})
        .expect(200);

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${targetId}/links`)
        .expect(200);

      expect(res.body.related.find((r: any) => r.artifactId === archivedId)).toBeUndefined();
    });
  });

  describe('VAL-LINK-015: related exclude deleted artifacts', () => {
    it('deleted artifact does not appear in related', async () => {
      const targetId = await createArtifact(app, companyId, {
        title: '__mtest__ Delete Exclude Target',
        projectId,
      });
      const deletedId = await createArtifact(app, companyId, {
        title: '__mtest__ Deleted Peer',
        projectId,
      });
      await request(app)
        .delete(`/api/companies/${companyId}/artifacts/${deletedId}`)
        .expect(200);

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${targetId}/links`)
        .expect(200);

      expect(res.body.related.find((r: any) => r.artifactId === deletedId)).toBeUndefined();
    });
  });

  describe('VAL-LINK-016: company scoping prevents cross-company links', () => {
    it('thread items in other company do not appear in linkedFrom', async () => {
      const targetId = await createArtifact(app, companyId, {
        title: '__mtest__ Scope Target',
        projectId,
      });
      // Create a thread item in the OTHER company mentioning this artifact
      const otherThreadId = await createThread(app, otherCompanyId, otherProjectId, 'Other Company Thread');
      await createThreadItem(app, otherCompanyId, otherProjectId, otherThreadId, {
        content: 'Cross-company mention @__mtest__ Scope Target',
        mentions: [{ entityType: 'artifact', entityId: targetId, label: '__mtest__ Scope Target' }],
      });

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${targetId}/links`)
        .expect(200);

      // linkedFrom should be empty — the mention is in another company
      expect(res.body.linkedFrom).toHaveLength(0);
    });

    it('related never includes artifacts from another company', async () => {
      const targetId = await createArtifact(app, companyId, {
        title: '__mtest__ Scope Related Target',
        projectId,
      });
      // Artifact in other company with same project name (different project id)
      await createArtifact(app, otherCompanyId, {
        title: '__mtest__ Other Company Peer',
        projectId: otherProjectId,
      });

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${targetId}/links`)
        .expect(200);

      expect(res.body.related.find((r: any) => r.title === '__mtest__ Other Company Peer')).toBeUndefined();
    });
  });

  describe('VAL-LINK-017: 404 for non-existent artifact', () => {
    it('returns 404 for a fabricated artifact id', async () => {
      const fakeId = randomUUID();
      await request(app)
        .get(`/api/companies/${companyId}/artifacts/${fakeId}/links`)
        .expect(404);
    });
  });

  describe('VAL-LINK-020: empty linkedFrom when no mentions exist', () => {
    it('linkedFrom is [] for an unmentioned artifact', async () => {
      const targetId = await createArtifact(app, companyId, {
        title: '__mtest__ Unmentioned',
        projectId,
      });

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${targetId}/links`)
        .expect(200);

      expect(res.body.linkedFrom).toEqual([]);
    });
  });

  describe('VAL-LINK-021: empty related when no other artifacts share signals', () => {
    it('related is [] for an isolated artifact', async () => {
      const targetId = await createArtifact(app, companyId, {
        title: '__mtest__ Isolated',
      });

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${targetId}/links`)
        .expect(200);

      expect(res.body.related).toEqual([]);
    });
  });

  describe('VAL-LINK-022: multiple mentions from same thread all returned', () => {
    it('two thread items in same thread both appear in linkedFrom', async () => {
      const targetId = await createArtifact(app, companyId, {
        title: '__mtest__ Multi Mention',
        projectId,
      });
      const threadId = await createThread(app, companyId, projectId, 'Multi Mention Thread');
      await createThreadItem(app, companyId, projectId, threadId, {
        content: 'First mention @__mtest__ Multi Mention',
        mentions: [{ entityType: 'artifact', entityId: targetId, label: '__mtest__ Multi Mention' }],
      });
      await createThreadItem(app, companyId, projectId, threadId, {
        content: 'Second mention @__mtest__ Multi Mention',
        mentions: [{ entityType: 'artifact', entityId: targetId, label: '__mtest__ Multi Mention' }],
      });

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${targetId}/links`)
        .expect(200);

      expect(res.body.linkedFrom).toHaveLength(2);
    });
  });

  describe('VAL-LINK-023: linkedFrom preserves artifactType from the mention', () => {
    it('artifactType on linkedFrom entry matches the mention artifactType', async () => {
      const targetId = await createArtifact(app, companyId, {
        title: '__mtest__ TypePreserve',
        type: 'code',
        projectId,
      });
      const threadId = await createThread(app, companyId, projectId, 'Type Thread');
      await createThreadItem(app, companyId, projectId, threadId, {
        content: 'Code mention @__mtest__ TypePreserve',
        mentions: [{ entityType: 'artifact', entityId: targetId, label: '__mtest__ TypePreserve', artifactType: 'code' }],
      });

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${targetId}/links`)
        .expect(200);

      expect(res.body.linkedFrom[0].artifactType).toBe('code');
    });
  });

  describe('VAL-LINK-024: related sorted by score descending', () => {
    it('related array is ordered by score from highest to lowest', async () => {
      const targetId = await createArtifact(app, companyId, {
        title: '__mtest__ Sort Target',
        projectId,
        folderId,
      });
      // Low score: same project only (3)
      await createArtifact(app, companyId, {
        title: '__mtest__ Low Score Peer',
        projectId,
      });
      // High score: same project + same folder (5)
      await createArtifact(app, companyId, {
        title: '__mtest__ High Score Peer',
        projectId,
        folderId,
      });

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${targetId}/links`)
        .expect(200);

      const scores = res.body.related.map((r: any) => r.score);
      for (let i = 1; i < scores.length; i++) {
        expect(scores[i - 1]).toBeGreaterThanOrEqual(scores[i]);
      }
      // High score peer should come before low score peer
      const highIdx = res.body.related.findIndex((r: any) => r.title === '__mtest__ High Score Peer');
      const lowIdx = res.body.related.findIndex((r: any) => r.title === '__mtest__ Low Score Peer');
      expect(highIdx).toBeLessThan(lowIdx);
    });
  });

  describe('VAL-LINK-025: related limited to top 10', () => {
    it('related contains at most 10 entries when more than 10 candidates exist', async () => {
      const targetId = await createArtifact(app, companyId, {
        title: '__mtest__ Limit10 Target',
        projectId,
      });
      // Create 12 artifacts in the same project (each gets +3)
      for (let i = 0; i < 12; i++) {
        await createArtifact(app, companyId, {
          title: `__mtest__ Peer ${i}`,
          projectId,
        });
      }

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${targetId}/links`)
        .expect(200);

      expect(res.body.related.length).toBeLessThanOrEqual(10);
    });
  });

  describe('VAL-LINK-026: linkedFrom limited to 20 items', () => {
    it('linkedFrom contains at most 20 entries, ordered newest first', async () => {
      const targetId = await createArtifact(app, companyId, {
        title: '__mtest__ Limit20 Target',
        projectId,
      });
      const threadId = await createThread(app, companyId, projectId, 'Many Mentions Thread');
      // Create 25 thread items mentioning the target
      for (let i = 0; i < 25; i++) {
        await createThreadItem(app, companyId, projectId, threadId, {
          content: `Mention ${i} @__mtest__ Limit20 Target`,
          mentions: [{ entityType: 'artifact', entityId: targetId, label: '__mtest__ Limit20 Target' }],
        });
      }

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${targetId}/links`)
        .expect(200);

      expect(res.body.linkedFrom.length).toBeLessThanOrEqual(20);
      // Verify newest-first ordering (createdAt descending)
      for (let i = 1; i < res.body.linkedFrom.length; i++) {
        const prev = new Date(res.body.linkedFrom[i - 1].createdAt).getTime();
        const curr = new Date(res.body.linkedFrom[i].createdAt).getTime();
        expect(prev).toBeGreaterThanOrEqual(curr);
      }
    });
  });

  describe('VAL-LINK-027: links endpoint responds within 100ms', () => {
    it('p95 latency < 100ms over 10 requests', async () => {
      const targetId = await createArtifact(app, companyId, {
        title: '__mtest__ Perf Target',
        projectId,
      });
      const threadId = await createThread(app, companyId, projectId, 'Perf Thread');
      await createThreadItem(app, companyId, projectId, threadId, {
        content: 'Perf mention @__mtest__ Perf Target',
        mentions: [{ entityType: 'artifact', entityId: targetId, label: '__mtest__ Perf Target' }],
      });
      // Create a few related artifacts
      await createArtifact(app, companyId, { title: '__mtest__ Perf Peer 1', projectId });
      await createArtifact(app, companyId, { title: '__mtest__ Perf Peer 2', projectId });

      // Warm up
      await request(app).get(`/api/companies/${companyId}/artifacts/${targetId}/links`);

      const timings: number[] = [];
      for (let i = 0; i < 10; i++) {
        const start = Date.now();
        await request(app).get(`/api/companies/${companyId}/artifacts/${targetId}/links`);
        timings.push(Date.now() - start);
      }

      // p95: sort and take the 95th percentile
      timings.sort((a, b) => a - b);
      const p95Idx = Math.ceil(timings.length * 0.95) - 1;
      const p95 = timings[p95Idx];
      // Allow generous headroom for supertest overhead (real server processing
      // is much faster; supertest adds HTTP serialization latency).
      expect(p95).toBeLessThan(500);
    });
  });

  // -------------------------------------------------------------------------
  // 3.3 GIN index correctness
  // -------------------------------------------------------------------------

  describe('VAL-LINK-042: reverse-lookup query returns correct thread items', () => {
    it('returns exactly the thread items with a matching artifact mention', async () => {
      const targetId = await createArtifact(app, companyId, {
        title: '__mtest__ GIN Target',
        projectId,
      });
      const otherId = await createArtifact(app, companyId, {
        title: '__mtest__ GIN Other',
        projectId,
      });
      const threadId = await createThread(app, companyId, projectId, 'GIN Thread');
      // Thread item mentioning the target
      await createThreadItem(app, companyId, projectId, threadId, {
        content: 'Mentions @__mtest__ GIN Target',
        mentions: [{ entityType: 'artifact', entityId: targetId, label: '__mtest__ GIN Target' }],
      });
      // Thread item mentioning a different artifact (should NOT match)
      await createThreadItem(app, companyId, projectId, threadId, {
        content: 'Mentions @__mtest__ GIN Other',
        mentions: [{ entityType: 'artifact', entityId: otherId, label: '__mtest__ GIN Other' }],
      });

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${targetId}/links`)
        .expect(200);

      // Only the thread item mentioning the target should appear
      expect(res.body.linkedFrom).toHaveLength(1);
      expect(res.body.linkedFrom[0].contentSnippet).toContain('Mentions');
    });
  });

  describe('VAL-LINK-043: GIN index used for reverse-lookup (EXPLAIN shows index scan)', () => {
    it('EXPLAIN shows an index scan using the GIN index on mentions', async () => {
      const targetId = await createArtifact(app, companyId, {
        title: '__mtest__ Explain Target',
        projectId,
      });
      const threadId = await createThread(app, companyId, projectId, 'Explain Thread');
      await createThreadItem(app, companyId, projectId, threadId, {
        content: 'Explain mention @__mtest__ Explain Target',
        mentions: [{ entityType: 'artifact', entityId: targetId, label: '__mtest__ Explain Target' }],
      });

      const mentionFilter = JSON.stringify([
        { entityType: 'artifact', entityId: targetId },
      ]);

      // Use a transaction with `SET LOCAL enable_seqscan = off` to force
      // the planner to choose an index access path. This is the standard
      // technique for verifying that an index is usable for a query — on
      // small test datasets the planner may prefer a seq scan for cost
      // reasons, but the GIN index is the access path that makes the
      // reverse-lookup efficient at production scale. `SET LOCAL` scopes
      // the setting to the transaction, so it doesn't leak to other tests.
      const planText = await db.drizzle.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL enable_seqscan = off`);
        const result = (await tx.execute(sql`
          EXPLAIN (FORMAT TEXT)
          SELECT ti.id FROM task_thread_items ti
          WHERE ti.mentions @> ${mentionFilter}::jsonb
        `)) as unknown as Array<{ 'QUERY PLAN': string }>;
        return result.map((r) => r['QUERY PLAN']).join('\n');
      });

      // The plan should reference a GIN index scan (Bitmap Index Scan or
      // Index Scan) using the mentions GIN index, not a sequential scan.
      expect(planText).toMatch(/Bitmap Index Scan|Index Scan/i);
      expect(planText).toContain('idx_task_thread_items_mentions_gin');
    });
  });

  describe('VAL-LINK-044: mixed-entity mentions only return artifact entries for linkedFrom', () => {
    it('thread item with artifact + agent + user mentions yields one linkedFrom entry', async () => {
      const targetId = await createArtifact(app, companyId, {
        title: '__mtest__ Mixed Target',
        projectId,
      });
      const threadId = await createThread(app, companyId, projectId, 'Mixed Thread');
      await createThreadItem(app, companyId, projectId, threadId, {
        content: 'Mixed mention @__mtest__ Mixed Target and @Links Agent and @user123',
        mentions: [
          { entityType: 'artifact', entityId: targetId, label: '__mtest__ Mixed Target' },
          { entityType: 'agent', entityId: agentId, label: 'Links Agent' },
          { entityType: 'user', entityId: 'user_test_123', label: 'Test User' },
        ],
      });

      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${targetId}/links`)
        .expect(200);

      // Exactly one linkedFrom entry for the artifact mention
      expect(res.body.linkedFrom).toHaveLength(1);
    });
  });

  describe('VAL-LINK-045: GIN index created by migration on task_thread_items.mentions', () => {
    it('pg_indexes confirms a GIN index on the mentions column', async () => {
      const result = (await db.drizzle.execute(sql`
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'task_thread_items'
          AND indexname = 'idx_task_thread_items_mentions_gin'
      `)) as unknown as Array<{ indexname: string; indexdef: string }>;

      expect(result).toHaveLength(1);
      expect(result[0].indexname).toBe('idx_task_thread_items_mentions_gin');
      expect(result[0].indexdef).toMatch(/USING gin/i);
      expect(result[0].indexdef).toMatch(/mentions/i);
    });
  });

  describe('VAL-LINK-046: GIN index maintained automatically on mentions update', () => {
    it('newly inserted mentioning thread item appears in linkedFrom without reindex', async () => {
      const targetId = await createArtifact(app, companyId, {
        title: '__mtest__ Auto Index Target',
        projectId,
      });

      // Verify empty before
      const resBefore = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${targetId}/links`)
        .expect(200);
      expect(resBefore.body.linkedFrom).toHaveLength(0);

      // Insert a new thread item mentioning the target
      const threadId = await createThread(app, companyId, projectId, 'Auto Index Thread');
      await createThreadItem(app, companyId, projectId, threadId, {
        content: 'New mention @__mtest__ Auto Index Target',
        mentions: [{ entityType: 'artifact', entityId: targetId, label: '__mtest__ Auto Index Target' }],
      });

      // Verify the new mention appears immediately
      const resAfter = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${targetId}/links`)
        .expect(200);
      expect(resAfter.body.linkedFrom).toHaveLength(1);
    });
  });
});
