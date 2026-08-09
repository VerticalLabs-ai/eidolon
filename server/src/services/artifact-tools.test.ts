import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestServer, createTestDb } from '../test-utils.js';
import { ArtifactToolService } from './artifact-tools.js';
import type { DbInstance } from '../types.js';

describe('ArtifactToolService — agent company-scope enforcement', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;
  let otherCompanyId: string;
  let agentId: string;
  let service: ArtifactToolService;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);
    service = new ArtifactToolService(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Tool Scope Corp' })
      .expect(201);
    companyId = company.body.data.id;

    const other = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Other Scope Corp' })
      .expect(201);
    otherCompanyId = other.body.data.id;

    const agent = await request(app)
      .post(`/api/companies/${companyId}/agents`)
      .send({ name: 'Scope Agent', role: 'engineer', provider: 'anthropic', model: 'claude-sonnet-4-6' })
      .expect(201);
    agentId = agent.body.data.id;
  });

  it('creates an agent-authored artifact when the agent belongs to the company', async () => {
    const result = await service.executeTool(
      'artifact.create',
      { type: 'document', title: '__mtest__ Tool Doc', content: { format: 'markdown', body: '# Hi' } },
      { companyId, agentId, projectId: null },
    );

    expect(result.isError).toBeFalsy();
    const artifactId = result.data?.artifactId as string;
    expect(artifactId).toBeTruthy();

    const created = await request(app)
      .get(`/api/companies/${companyId}/artifacts/${artifactId}`)
      .expect(200);
    expect(created.body.data.createdByAgentId).toBe(agentId);
    expect(created.body.data.createdByUserId).toBeNull();
  });

  it('rejects artifact.create when the agent does not belong to the company', async () => {
    const result = await service.executeTool(
      'artifact.create',
      { type: 'document', title: '__mtest__ Wrong Scope', content: { format: 'markdown', body: 'x' } },
      // agent belongs to companyId, but context claims otherCompanyId
      { companyId: otherCompanyId, agentId, projectId: null },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('403');

    // No artifact was created in the other company.
    const list = await request(app)
      .get(`/api/companies/${otherCompanyId}/artifacts`)
      .expect(200);
    expect(list.body.data).toHaveLength(0);
  });

  it('rejects artifact tools when the agent id is unknown', async () => {
    const result = await service.executeTool(
      'artifact.list',
      {},
      { companyId, agentId: randomUUID(), projectId: null },
    );

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('403');
  });

  it('artifact.list filters out restricted artifacts the agent cannot view (VAL-TEAM-006)', async () => {
    // Create two artifacts in the company (unrestricted by default).
    const openArtifact = await request(app)
      .post(`/api/companies/${companyId}/artifacts`)
      .send({ type: 'document', title: '__mtest__ Open Doc', content: { format: 'markdown', body: 'open' } })
      .expect(201);
    const restrictedArtifact = await request(app)
      .post(`/api/companies/${companyId}/artifacts`)
      .send({ type: 'document', title: '__mtest__ Restricted Doc', content: { format: 'markdown', body: 'restricted' } })
      .expect(201);

    // Restrict the second artifact: grant view to a different test user so
    // the artifact becomes restricted (only that user can view it). The
    // agent (member-level, no grant) should NOT see it in the list.
    const otherUser = await request(app)
      .post('/api/auth/local-trusted/create-test-user')
      .send({ email: 'other-user@mtest.test', name: 'Other', companyId })
      .expect(201);
    await request(app)
      .post(`/api/companies/${companyId}/permissions`)
      .send({
        resourceType: 'artifact',
        resourceId: restrictedArtifact.body.data.id,
        granteeType: 'user',
        granteeId: otherUser.body.data.id,
        accessLevel: 'view',
      })
      .expect(201);

    // Agent lists artifacts — only the open one should be returned.
    const result = await service.executeTool(
      'artifact.list',
      {},
      { companyId, agentId, projectId: null },
    );

    expect(result.isError).toBeFalsy();
    const artifacts = result.data?.artifacts as Array<{ artifactId: string }>;
    const ids = artifacts.map((a) => a.artifactId);
    expect(ids).toContain(openArtifact.body.data.id);
    expect(ids).not.toContain(restrictedArtifact.body.data.id);
  });
});
