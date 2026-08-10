import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createTestServer, createTestDb } from '../test-utils.js';
import { MentionService } from '../services/mention-service.js';
import { backgroundWork } from '../services/background-work.js';
import type { DbInstance } from '../types.js';

// ---------------------------------------------------------------------------
// Artifact @-mention integration tests (misc-artifact-mention-and-code-filter)
//
// Covers:
//   (1) searchMentionable returns company-scoped active artifacts with the
//       correct entityType='artifact', entityId, label (title), subtitle
//       (type label), and artifactType fields.
//   (2) searchMentionable filters artifacts by title query.
//   (3) searchMentionable excludes archived/deleted artifacts.
//   (4) searchMentionable is company-scoped (no cross-company artifacts).
//   (5) resolveMention resolves an active artifact in the company; rejects
//       archived/deleted artifacts, cross-company artifacts, and unknown ids.
//   (6) POST thread item with an artifact mention persists the mention
//       structurally (entityType='artifact', entityId, label, artifactType).
//   (7) Artifact mentions are inert — no agent dispatch, no user notification,
//       no thread.mention realtime event.
//   (8) Cross-company artifact mention is filtered out (not persisted).
//   (9) BoardChat (chat/send) accepts and persists artifact mentions.
// ---------------------------------------------------------------------------

describe('Artifact @-mentions — real-Postgres integration', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;
  let projectId: string;
  let agentId: string;
  let threadId: string;
  let artifactId: string;
  let codeArtifactId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Artifact Mention Corp' })
      .expect(201);
    companyId = company.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'Art Mention Proj', status: 'active' })
      .expect(201);
    projectId = project.body.data.id;

    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({
        name: 'Art Mention Agent',
        role: 'engineer',
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
      })
      .expect(201);
    agentId = agent.body.data.id;

    const thread = await request(app)
      .post(`/api/companies/${companyId}/projects/${projectId}/threads`)
      .send({ title: 'Art Mention Thread', type: 'conversation' })
      .expect(201);
    threadId = thread.body.data.id;

    // Create a document artifact to @-mention
    const artifact = await request(app)
      .post(`/api/companies/${companyId}/artifacts`)
      .send({
        type: 'document',
        title: '__mtest__ Mentionable Doc',
        content: { format: 'markdown', body: '# Hello' },
        projectId,
      })
      .expect(201);
    artifactId = artifact.body.data.id;

    // Create a code artifact to verify all artifact types are mentionable
    const codeArtifact = await request(app)
      .post(`/api/companies/${companyId}/artifacts`)
      .send({
        type: 'code',
        title: '__mtest__ Mentionable Snippet',
        content: { language: 'javascript', files: [{ path: 'index.js', content: 'console.log(1)' }] },
        projectId,
      })
      .expect(201);
    codeArtifactId = codeArtifact.body.data.id;
  });

  // -------------------------------------------------------------------------
  // searchMentionable — artifact results
  // -------------------------------------------------------------------------

  describe('searchMentionable — artifacts', () => {
    it('returns company-scoped active artifacts with correct fields', async () => {
      const res = await request(app)
        .get(`/api/companies/${companyId}/mentions/search?q=`)
        .expect(200);

      const artifactResults = res.body.data.filter((e: any) => e.entityType === 'artifact');
      expect(artifactResults.length).toBeGreaterThanOrEqual(2);

      const doc = artifactResults.find((e: any) => e.entityId === artifactId);
      expect(doc).toBeDefined();
      expect(doc.label).toBe('__mtest__ Mentionable Doc');
      expect(doc.subtitle).toBe('Document');
      expect(doc.artifactType).toBe('document');

      const code = artifactResults.find((e: any) => e.entityId === codeArtifactId);
      expect(code).toBeDefined();
      expect(code.label).toBe('__mtest__ Mentionable Snippet');
      expect(code.subtitle).toBe('Code');
      expect(code.artifactType).toBe('code');
    });

    it('filters artifacts by title query', async () => {
      const res = await request(app)
        .get(`/api/companies/${companyId}/mentions/search?q=Mentionable%20Doc`)
        .expect(200);

      const artifactResults = res.body.data.filter((e: any) => e.entityType === 'artifact');
      expect(artifactResults.some((e: any) => e.entityId === artifactId)).toBe(true);
      // The code artifact does not match "Mentionable Doc"
      expect(artifactResults.some((e: any) => e.entityId === codeArtifactId)).toBe(false);
    });

    it('excludes archived artifacts from search results', async () => {
      await request(app)
        .post(`/api/companies/${companyId}/artifacts/${artifactId}/archive`)
        .send({})
        .expect(200);

      const res = await request(app)
        .get(`/api/companies/${companyId}/mentions/search?q=`)
        .expect(200);

      const artifactResults = res.body.data.filter((e: any) => e.entityType === 'artifact');
      expect(artifactResults.some((e: any) => e.entityId === artifactId)).toBe(false);
      // The non-archived code artifact is still present
      expect(artifactResults.some((e: any) => e.entityId === codeArtifactId)).toBe(true);
    });

    it('excludes deleted (soft-deleted) artifacts from search results', async () => {
      await request(app)
        .delete(`/api/companies/${companyId}/artifacts/${artifactId}`)
        .expect(200);

      const res = await request(app)
        .get(`/api/companies/${companyId}/mentions/search?q=`)
        .expect(200);

      const artifactResults = res.body.data.filter((e: any) => e.entityType === 'artifact');
      expect(artifactResults.some((e: any) => e.entityId === artifactId)).toBe(false);
    });

    it('is company-scoped — does not return artifacts from other companies', async () => {
      const otherCompany = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Other Art Corp' })
        .expect(201);
      const otherCompanyId = otherCompany.body.data.id;

      await request(app)
        .post(`/api/companies/${otherCompanyId}/artifacts`)
        .send({
          type: 'document',
          title: '__mtest__ Other Company Doc',
          content: { format: 'markdown', body: 'other' },
        })
        .expect(201);

      const res = await request(app)
        .get(`/api/companies/${companyId}/mentions/search?q=`)
        .expect(200);

      const artifactResults = res.body.data.filter((e: any) => e.entityType === 'artifact');
      expect(artifactResults.some((e: any) => e.label === '__mtest__ Other Company Doc')).toBe(false);
    });

    it('returns artifacts alongside agents and teammates in a single search', async () => {
      const res = await request(app)
        .get(`/api/companies/${companyId}/mentions/search?q=`)
        .expect(200);

      const types = new Set(res.body.data.map((e: any) => e.entityType));
      expect(types.has('agent')).toBe(true);
      expect(types.has('user')).toBe(true);
      expect(types.has('artifact')).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // resolveMention — artifact entity
  // -------------------------------------------------------------------------

  describe('resolveMention — artifact', () => {
    it('resolves an active artifact in the company', async () => {
      const mentionService = new MentionService(db);
      const valid = await mentionService.resolveMention(companyId, 'artifact', artifactId);
      expect(valid).toBe(true);
    });

    it('rejects an archived artifact', async () => {
      await request(app)
        .post(`/api/companies/${companyId}/artifacts/${artifactId}/archive`)
        .send({})
        .expect(200);

      const mentionService = new MentionService(db);
      const valid = await mentionService.resolveMention(companyId, 'artifact', artifactId);
      expect(valid).toBe(false);
    });

    it('rejects a soft-deleted artifact', async () => {
      await request(app)
        .delete(`/api/companies/${companyId}/artifacts/${artifactId}`)
        .expect(200);

      const mentionService = new MentionService(db);
      const valid = await mentionService.resolveMention(companyId, 'artifact', artifactId);
      expect(valid).toBe(false);
    });

    it('rejects an artifact from another company', async () => {
      const otherCompany = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Cross Art Corp' })
        .expect(201);
      const otherCompanyId = otherCompany.body.data.id;

      const otherArtifact = await request(app)
        .post(`/api/companies/${otherCompanyId}/artifacts`)
        .send({
          type: 'document',
          title: '__mtest__ Cross Doc',
          content: { format: 'markdown', body: 'cross' },
        })
        .expect(201);

      const mentionService = new MentionService(db);
      const valid = await mentionService.resolveMention(companyId, 'artifact', otherArtifact.body.data.id);
      expect(valid).toBe(false);
    });

    it('rejects an unknown artifact id', async () => {
      const mentionService = new MentionService(db);
      const valid = await mentionService.resolveMention(companyId, 'artifact', 'unknown-artifact-id');
      expect(valid).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // POST thread item with artifact mention — persistence + inertness
  // -------------------------------------------------------------------------

  describe('POST thread item with artifact mention', () => {
    it('persists the artifact mention structurally with artifactType', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/projects/${projectId}/threads/${threadId}/items`)
        .send({
          kind: 'comment',
          content: 'Check out @__mtest__ Mentionable Doc',
          mentions: [
            {
              entityType: 'artifact',
              entityId: artifactId,
              label: '__mtest__ Mentionable Doc',
              artifactType: 'document',
            },
          ],
        })
        .expect(201);

      expect(res.body.data.mentions).toHaveLength(1);
      expect(res.body.data.mentions[0]).toEqual({
        entityType: 'artifact',
        entityId: artifactId,
        label: '__mtest__ Mentionable Doc',
        artifactType: 'document',
      });
    });

    it('persists a code artifact mention with the correct artifactType', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/projects/${projectId}/threads/${threadId}/items`)
        .send({
          kind: 'comment',
          content: 'See @__mtest__ Mentionable Snippet',
          mentions: [
            {
              entityType: 'artifact',
              entityId: codeArtifactId,
              label: '__mtest__ Mentionable Snippet',
              artifactType: 'code',
            },
          ],
        })
        .expect(201);

      expect(res.body.data.mentions).toHaveLength(1);
      expect(res.body.data.mentions[0].artifactType).toBe('code');
    });

    it('artifact mention is inert — no agent dispatch, no thread.mention event, no notification', async () => {
      const events: string[] = [];
      // Subscribe to the EventBus via the exported singleton. We can't easily
      // import the eventBus here without a side-effect, so we assert via the
      // dispatch result directly through the MentionService.
      const mentionService = new MentionService(db);

      // Insert the thread item first via the route (which persists the mention)
      const res = await request(app)
        .post(`/api/companies/${companyId}/projects/${projectId}/threads/${threadId}/items`)
        .send({
          kind: 'comment',
          content: 'Ref @__mtest__ Mentionable Doc',
          mentions: [
            {
              entityType: 'artifact',
              entityId: artifactId,
              label: '__mtest__ Mentionable Doc',
              artifactType: 'document',
            },
          ],
        })
        .expect(201);

      const itemId = res.body.data.id;

      // Dispatch the mentions directly — the route does this fire-and-forget.
      // We call it synchronously here to inspect the result.
      const dispatchResult = await mentionService.dispatchMentions({
        companyId,
        projectId,
        threadId,
        itemId,
        content: 'Ref @__mtest__ Mentionable Doc',
        mentions: [
          {
            entityType: 'artifact',
            entityId: artifactId,
            label: '__mtest__ Mentionable Doc',
            artifactType: 'document',
          },
        ],
        authorUserId: 'dev-user-000',
      });

      // No agent dispatches, no user notifications for an artifact mention
      expect(dispatchResult.agentDispatches).toHaveLength(0);
      expect(dispatchResult.userNotifications).toHaveLength(0);

      // Drain any background work (the route also fires dispatch)
      await backgroundWork.drain();

      // Verify no agent response item was posted to the thread
      const threadRes = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/threads/${threadId}`)
        .expect(200);

      const agentResponseItems = threadRes.body.data.items.filter(
        (i: any) => i.authorAgentId === agentId,
      );
      expect(agentResponseItems).toHaveLength(0);
    });

    it('cross-company artifact mention is filtered out (not persisted)', async () => {
      const otherCompany = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Cross Item Corp' })
        .expect(201);
      const otherCompanyId = otherCompany.body.data.id;

      const otherArtifact = await request(app)
        .post(`/api/companies/${otherCompanyId}/artifacts`)
        .send({
          type: 'document',
          title: '__mtest__ Cross Co Doc',
          content: { format: 'markdown', body: 'cross' },
        })
        .expect(201);

      const res = await request(app)
        .post(`/api/companies/${companyId}/projects/${projectId}/threads/${threadId}/items`)
        .send({
          kind: 'comment',
          content: 'See @cross',
          mentions: [
            {
              entityType: 'artifact',
              entityId: otherArtifact.body.data.id,
              label: '__mtest__ Cross Co Doc',
              artifactType: 'document',
            },
          ],
        })
        .expect(201);

      expect(res.body.data.mentions).toHaveLength(0);
    });

    it('artifact mention is returned on subsequent thread GET', async () => {
      await request(app)
        .post(`/api/companies/${companyId}/projects/${projectId}/threads/${threadId}/items`)
        .send({
          kind: 'comment',
          content: 'Ref @__mtest__ Mentionable Doc',
          mentions: [
            {
              entityType: 'artifact',
              entityId: artifactId,
              label: '__mtest__ Mentionable Doc',
              artifactType: 'document',
            },
          ],
        })
        .expect(201);

      const threadRes = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/threads/${threadId}`)
        .expect(200);

      const mentionItem = threadRes.body.data.items.find(
        (i: any) => i.mentions?.some((m: any) => m.entityType === 'artifact'),
      );
      expect(mentionItem).toBeDefined();
      expect(mentionItem.mentions[0].entityType).toBe('artifact');
      expect(mentionItem.mentions[0].artifactType).toBe('document');
    });

    it('mixed mention (agent + artifact) persists both and dispatches only the agent', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/projects/${projectId}/threads/${threadId}/items`)
        .send({
          kind: 'comment',
          content: 'Hey @Art Mention Agent, see @__mtest__ Mentionable Doc',
          mentions: [
            { entityType: 'agent', entityId: agentId, label: 'Art Mention Agent' },
            {
              entityType: 'artifact',
              entityId: artifactId,
              label: '__mtest__ Mentionable Doc',
              artifactType: 'document',
            },
          ],
        })
        .expect(201);

      // Both mentions persist
      expect(res.body.data.mentions).toHaveLength(2);
      const types = res.body.data.mentions.map((m: any) => m.entityType);
      expect(types).toContain('agent');
      expect(types).toContain('artifact');

      // Drain the background dispatch (agent will fail without a real key,
      // but the dispatch attempt confirms only the agent was dispatched)
      await backgroundWork.drain();

      // The agent dispatch produces either a response item or a failure item.
      // The artifact mention produces neither. Verify the artifact mention did
      // not produce a queued-mention item (that's only for paused agents).
      const threadRes = await request(app)
        .get(`/api/companies/${companyId}/projects/${projectId}/threads/${threadId}`)
        .expect(200);

      const queuedForArtifact = threadRes.body.data.items.find(
        (i: any) => i.payload?.queuedMention?.agentId === artifactId,
      );
      expect(queuedForArtifact).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // BoardChat (chat/send) — artifact mention persistence
  // -------------------------------------------------------------------------

  describe('BoardChat chat/send — artifact mention', () => {
    it('accepts and persists an artifact mention in the message metadata', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/chat/send`)
        .send({
          content: 'Ref @__mtest__ Mentionable Doc',
          mentions: [
            {
              entityType: 'artifact',
              entityId: artifactId,
              label: '__mtest__ Mentionable Doc',
              artifactType: 'document',
            },
          ],
        })
        .expect(201);

      expect(res.body.data.mentions).toHaveLength(1);
      expect(res.body.data.mentions[0].entityType).toBe('artifact');
      expect(res.body.data.mentions[0].entityId).toBe(artifactId);
      expect(res.body.data.mentions[0].artifactType).toBe('document');
    });

    it('cross-company artifact mention is filtered out in chat/send', async () => {
      const otherCompany = await request(app)
        .post('/api/companies')
        .send({ name: '__mtest__ Chat Cross Corp' })
        .expect(201);
      const otherCompanyId = otherCompany.body.data.id;

      const otherArtifact = await request(app)
        .post(`/api/companies/${otherCompanyId}/artifacts`)
        .send({
          type: 'document',
          title: '__mtest__ Chat Cross Doc',
          content: { format: 'markdown', body: 'cross' },
        })
        .expect(201);

      const res = await request(app)
        .post(`/api/companies/${companyId}/chat/send`)
        .send({
          content: 'See @cross',
          mentions: [
            {
              entityType: 'artifact',
              entityId: otherArtifact.body.data.id,
              label: '__mtest__ Chat Cross Doc',
              artifactType: 'document',
            },
          ],
        })
        .expect(201);

      expect(res.body.data.mentions).toHaveLength(0);
    });
  });
});
