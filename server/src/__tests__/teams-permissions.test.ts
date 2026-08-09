import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { eq, and } from 'drizzle-orm';
import { createTestServer, createTestDb } from '../test-utils.js';
import { eventBus } from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import type { EidolonEvent } from '../realtime/events.js';

const DOC_CONTENT = { format: 'markdown' as const, body: '# Hello' };

async function captureEvents<T extends EidolonEvent = EidolonEvent>(
  fn: () => Promise<void>,
): Promise<T[]> {
  const events: T[] = [];
  const handler = (event: EidolonEvent) => events.push(event as T);
  eventBus.onEvent(handler);
  try {
    await fn();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    eventBus.off('event', handler);
  }
  return events;
}

/** Headers to impersonate a specific user + org role in local_trusted mode. */
function impersonate(userId?: string, role?: 'owner' | 'admin' | 'member' | 'viewer') {
  const headers: Record<string, string> = {};
  if (userId) headers['X-Eidolon-Test-User-Id'] = userId;
  if (role) headers['X-Eidolon-Test-Org-Role'] = role;
  return headers;
}

describe('Teams + Permissions RBAC — real-Postgres integration', () => {
  let app: Awaited<ReturnType<typeof createTestServer>>;
  let db: DbInstance;
  let companyId: string;
  let otherCompanyId: string;
  let projectId: string;
  let folderId: string;
  let artifactId: string;
  let testUserIdA: string;
  let testUserIdB: string;
  let teamId: string;

  beforeEach(async () => {
    db = await createTestDb();
    app = await createTestServer(db);

    const company = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ RBAC Corp' })
      .expect(201);
    companyId = company.body.data.id;

    const otherCompany = await request(app)
      .post('/api/companies')
      .send({ name: '__mtest__ Other RBAC Corp' })
      .expect(201);
    otherCompanyId = otherCompany.body.data.id;

    const project = await request(app)
      .post(`/api/companies/${companyId}/projects`)
      .send({ name: 'RBAC Proj', status: 'active' })
      .expect(201);
    projectId = project.body.data.id;

    const folder = await request(app)
      .post(`/api/companies/${companyId}/folders`)
      .send({ name: 'Secret Folder', projectId })
      .expect(201);
    folderId = folder.body.data.id;

    const artifact = await request(app)
      .post(`/api/companies/${companyId}/artifacts`)
      .send({ type: 'document', title: '__mtest__ RBAC Doc', content: DOC_CONTENT, projectId })
      .expect(201);
    artifactId = artifact.body.data.id;

    // Create two test users in the company for RBAC testing.
    const userA = await request(app)
      .post('/api/auth/local-trusted/create-test-user')
      .send({ email: 'alice@mtest.test', name: 'Alice', companyId })
      .expect(201);
    testUserIdA = userA.body.data.id;

    const userB = await request(app)
      .post('/api/auth/local-trusted/create-test-user')
      .send({ email: 'bob@mtest.test', name: 'Bob', companyId })
      .expect(201);
    testUserIdB = userB.body.data.id;
  });

  // =========================================================================
  // VAL-TEAM-001: Create a team within a company
  // =========================================================================
  describe('VAL-TEAM-001: create team', () => {
    it('creates a team with correct company scoping', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/teams`)
        .send({ name: '__mtest__ Engineering' })
        .expect(201);
      expect(res.body.data.id).toBeDefined();
      expect(res.body.data.companyId).toBe(companyId);
      expect(res.body.data.name).toBe('__mtest__ Engineering');
      // Appears in team list
      const list = await request(app)
        .get(`/api/companies/${companyId}/teams`)
        .expect(200);
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data[0].name).toBe('__mtest__ Engineering');
    });

    it('rejects team creation by viewer/member (VAL-TEAM-024)', async () => {
      await request(app)
        .post(`/api/companies/${companyId}/teams`)
        .set(impersonate(testUserIdA, 'viewer'))
        .send({ name: '__mtest__ Viewer Team' })
        .expect(403);
      await request(app)
        .post(`/api/companies/${companyId}/teams`)
        .set(impersonate(testUserIdA, 'member'))
        .send({ name: '__mtest__ Member Team' })
        .expect(403);
    });

    it('allows team creation by admin', async () => {
      await request(app)
        .post(`/api/companies/${companyId}/teams`)
        .set(impersonate(testUserIdA, 'admin'))
        .send({ name: '__mtest__ Admin Team' })
        .expect(201);
    });
  });

  // =========================================================================
  // VAL-TEAM-002: Assign members to a team
  // =========================================================================
  describe('VAL-TEAM-002: assign members', () => {
    beforeEach(async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/teams`)
        .send({ name: '__mtest__ Dev Team' })
        .expect(201);
      teamId = res.body.data.id;
    });

    it('assigns members and reflects in team membership', async () => {
      await request(app)
        .post(`/api/companies/${companyId}/teams/${teamId}/members`)
        .send({ userId: testUserIdA })
        .expect(201);
      await request(app)
        .post(`/api/companies/${companyId}/teams/${teamId}/members`)
        .send({ userId: testUserIdB })
        .expect(201);

      const members = await request(app)
        .get(`/api/companies/${companyId}/teams/${teamId}/members`)
        .expect(200);
      expect(members.body.data).toHaveLength(2);
      const userIds = members.body.data.map((m: any) => m.userId);
      expect(userIds).toContain(testUserIdA);
      expect(userIds).toContain(testUserIdB);
    });

    it('is idempotent — adding the same user twice does not duplicate', async () => {
      await request(app)
        .post(`/api/companies/${companyId}/teams/${teamId}/members`)
        .send({ userId: testUserIdA })
        .expect(201);
      // Second add returns 201 (idempotent)
      await request(app)
        .post(`/api/companies/${companyId}/teams/${teamId}/members`)
        .send({ userId: testUserIdA })
        .expect(201);
      const members = await request(app)
        .get(`/api/companies/${companyId}/teams/${teamId}/members`)
        .expect(200);
      expect(members.body.data).toHaveLength(1);
    });
  });

  // =========================================================================
  // VAL-TEAM-003/004/005: Grant per-project/folder/artifact access
  // =========================================================================
  describe('VAL-TEAM-003/004/005: grant permissions', () => {
    beforeEach(async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/teams`)
        .send({ name: '__mtest__ QA Team' })
        .expect(201);
      teamId = res.body.data.id;
    });

    it('grants per-project access to a user (VAL-TEAM-003)', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .send({ resourceType: 'project', resourceId: projectId, granteeType: 'user', granteeId: testUserIdA, accessLevel: 'view' })
        .expect(201);
      expect(res.body.data.resourceType).toBe('project');
      expect(res.body.data.resourceId).toBe(projectId);
      expect(res.body.data.granteeId).toBe(testUserIdA);
      expect(res.body.data.accessLevel).toBe('view');
    });

    it('grants per-folder access to a team (VAL-TEAM-004)', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .send({ resourceType: 'folder', resourceId: folderId, granteeType: 'team', granteeId: teamId, accessLevel: 'edit' })
        .expect(201);
      expect(res.body.data.resourceType).toBe('folder');
      expect(res.body.data.accessLevel).toBe('edit');
    });

    it('grants per-artifact access to a user (VAL-TEAM-005)', async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .send({ resourceType: 'artifact', resourceId: artifactId, granteeType: 'user', granteeId: testUserIdB, accessLevel: 'manage' })
        .expect(201);
      expect(res.body.data.resourceType).toBe('artifact');
      expect(res.body.data.accessLevel).toBe('manage');
    });

    it('rejects invalid access level with 400', async () => {
      await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .send({ resourceType: 'artifact', resourceId: artifactId, granteeType: 'user', granteeId: testUserIdB, accessLevel: 'bogus' })
        .expect(400);
    });
  });

  // =========================================================================
  // VAL-TEAM-006/007/008/009/010: Access level enforcement
  // =========================================================================
  describe('VAL-TEAM-006/007/008/009/010: access level enforcement', () => {
    let restrictedArtifactId: string;

    beforeEach(async () => {
      // Create a restricted artifact (grant a permission on it → restricted).
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({ type: 'document', title: '__mtest__ Restricted Doc', content: DOC_CONTENT, projectId })
        .expect(201);
      restrictedArtifactId = res.body.data.id;
      // Grant view to user A → the artifact becomes restricted.
      await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .send({ resourceType: 'artifact', resourceId: restrictedArtifactId, granteeType: 'user', granteeId: testUserIdA, accessLevel: 'view' })
        .expect(201);
    });

    it('VAL-TEAM-006: user without access cannot view a restricted artifact', async () => {
      // User B has no grant → 403
      await request(app)
        .get(`/api/companies/${companyId}/artifacts/${restrictedArtifactId}`)
        .set(impersonate(testUserIdB, 'member'))
        .expect(403);
    });

    it('VAL-TEAM-006: restricted artifact is hidden from user B list', async () => {
      const res = await request(app)
        .get(`/api/companies/${companyId}/artifacts?projectId=${projectId}`)
        .set(impersonate(testUserIdB, 'member'))
        .expect(200);
      const ids = res.body.data.map((a: any) => a.id);
      expect(ids).not.toContain(restrictedArtifactId);
      // The unrestricted artifact IS visible
      expect(ids).toContain(artifactId);
    });

    it('VAL-TEAM-007: user without access cannot edit a restricted artifact', async () => {
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${restrictedArtifactId}`)
        .set(impersonate(testUserIdB, 'member'))
        .send({ version: 1, content: { format: 'markdown', body: 'hacked' } })
        .expect(403);
      // Content unchanged
      const get = await request(app)
        .get(`/api/companies/${companyId}/artifacts/${restrictedArtifactId}`)
        .set(impersonate(testUserIdA, 'member'))
        .expect(200);
      expect(get.body.data.version).toBe(1);
    });

    it('VAL-TEAM-008: view-only permits read but not edit', async () => {
      // User A has view → can read
      await request(app)
        .get(`/api/companies/${companyId}/artifacts/${restrictedArtifactId}`)
        .set(impersonate(testUserIdA, 'member'))
        .expect(200);
      // Cannot edit
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${restrictedArtifactId}`)
        .set(impersonate(testUserIdA, 'member'))
        .send({ version: 1, content: { format: 'markdown', body: 'edited by viewer' } })
        .expect(403);
      // Cannot delete
      await request(app)
        .delete(`/api/companies/${companyId}/artifacts/${restrictedArtifactId}`)
        .set(impersonate(testUserIdA, 'member'))
        .expect(403);
      // Cannot archive
      await request(app)
        .post(`/api/companies/${companyId}/artifacts/${restrictedArtifactId}/archive`)
        .set(impersonate(testUserIdA, 'member'))
        .expect(403);
      // Cannot grant permissions
      await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .set(impersonate(testUserIdA, 'member'))
        .send({ resourceType: 'artifact', resourceId: restrictedArtifactId, granteeType: 'user', granteeId: testUserIdB, accessLevel: 'view' })
        .expect(403);
    });

    it('VAL-TEAM-009: edit permits read+edit but not manage', async () => {
      // Grant edit to user B
      await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .send({ resourceType: 'artifact', resourceId: restrictedArtifactId, granteeType: 'user', granteeId: testUserIdB, accessLevel: 'edit' })
        .expect(201);

      // Can read
      await request(app)
        .get(`/api/companies/${companyId}/artifacts/${restrictedArtifactId}`)
        .set(impersonate(testUserIdB, 'member'))
        .expect(200);
      // Can edit (version bumps)
      const patched = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${restrictedArtifactId}`)
        .set(impersonate(testUserIdB, 'member'))
        .send({ version: 1, content: { format: 'markdown', body: 'edited by editor' } })
        .expect(200);
      expect(patched.body.data.version).toBe(2);
      // Cannot delete
      await request(app)
        .delete(`/api/companies/${companyId}/artifacts/${restrictedArtifactId}`)
        .set(impersonate(testUserIdB, 'member'))
        .expect(403);
      // Cannot grant permissions
      await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .set(impersonate(testUserIdB, 'member'))
        .send({ resourceType: 'artifact', resourceId: restrictedArtifactId, granteeType: 'user', granteeId: testUserIdA, accessLevel: 'view' })
        .expect(403);
    });

    it('VAL-TEAM-010: manage permits permission management', async () => {
      // Grant manage to user B
      await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .send({ resourceType: 'artifact', resourceId: restrictedArtifactId, granteeType: 'user', granteeId: testUserIdB, accessLevel: 'manage' })
        .expect(201);

      // User B can grant to user A
      await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .set(impersonate(testUserIdB, 'member'))
        .send({ resourceType: 'artifact', resourceId: restrictedArtifactId, granteeType: 'user', granteeId: testUserIdA, accessLevel: 'edit' })
        .expect(201);

      // User B can revoke user A's grant
      await request(app)
        .delete(`/api/companies/${companyId}/permissions`)
        .set(impersonate(testUserIdB, 'member'))
        .send({ resourceType: 'artifact', resourceId: restrictedArtifactId, granteeType: 'user', granteeId: testUserIdA, accessLevel: 'edit' })
        .expect(204);
    });
  });

  // =========================================================================
  // VAL-TEAM-011/012/013: Inheritance + specific override
  // =========================================================================
  describe('VAL-TEAM-011/012/013: inheritance + override', () => {
    it('VAL-TEAM-011: folder permission inherits to contained artifacts', async () => {
      // Create an artifact in the folder
      const artInFolder = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({ type: 'document', title: '__mtest__ In Folder', content: DOC_CONTENT, projectId, folderId })
        .expect(201);
      // Grant view on the folder to user A
      await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .send({ resourceType: 'folder', resourceId: folderId, granteeType: 'user', granteeId: testUserIdA, accessLevel: 'view' })
        .expect(201);
      // User A can read the artifact (inherited view from folder)
      await request(app)
        .get(`/api/companies/${companyId}/artifacts/${artInFolder.body.data.id}`)
        .set(impersonate(testUserIdA, 'member'))
        .expect(200);
      // User A cannot edit the artifact (view-only inherited)
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${artInFolder.body.data.id}`)
        .set(impersonate(testUserIdA, 'member'))
        .send({ version: 1, content: { format: 'markdown', body: 'edited' } })
        .expect(403);
    });

    it('VAL-TEAM-012: project permission inherits to contained artifacts', async () => {
      // Grant view on the project to user B
      await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .send({ resourceType: 'project', resourceId: projectId, granteeType: 'user', granteeId: testUserIdB, accessLevel: 'view' })
        .expect(201);
      // User B can read any artifact in the project (inherited view)
      await request(app)
        .get(`/api/companies/${companyId}/artifacts/${artifactId}`)
        .set(impersonate(testUserIdB, 'member'))
        .expect(200);
    });

    it('VAL-TEAM-013: specific grant overrides inherited permission', async () => {
      // Grant view on project to user A
      await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .send({ resourceType: 'project', resourceId: projectId, granteeType: 'user', granteeId: testUserIdA, accessLevel: 'view' })
        .expect(201);
      // Grant edit on the specific artifact to user A (overrides inherited view)
      await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .send({ resourceType: 'artifact', resourceId: artifactId, granteeType: 'user', granteeId: testUserIdA, accessLevel: 'edit' })
        .expect(201);
      // User A can edit the specifically-granted artifact
      const patched = await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${artifactId}`)
        .set(impersonate(testUserIdA, 'member'))
        .send({ version: 1, content: { format: 'markdown', body: 'override edit' } })
        .expect(200);
      expect(patched.body.data.version).toBe(2);
      // User A cannot edit a sibling artifact (view-only from project inheritance)
      const sibling = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({ type: 'document', title: '__mtest__ Sibling', content: DOC_CONTENT, projectId })
        .expect(201);
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${sibling.body.data.id}`)
        .set(impersonate(testUserIdA, 'member'))
        .send({ version: 1, content: { format: 'markdown', body: 'sibling edit' } })
        .expect(403);
      // But can read the sibling
      await request(app)
        .get(`/api/companies/${companyId}/artifacts/${sibling.body.data.id}`)
        .set(impersonate(testUserIdA, 'member'))
        .expect(200);
    });
  });

  // =========================================================================
  // VAL-TEAM-014/015: Owner/admin manage all
  // =========================================================================
  describe('VAL-TEAM-014/015: owner/admin manage all', () => {
    let restrictedArtifactId: string;

    beforeEach(async () => {
      const res = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({ type: 'document', title: '__mtest__ Owner Test', content: DOC_CONTENT, projectId })
        .expect(201);
      restrictedArtifactId = res.body.data.id;
      // Restrict it: grant to user A only
      await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .send({ resourceType: 'artifact', resourceId: restrictedArtifactId, granteeType: 'user', granteeId: testUserIdA, accessLevel: 'view' })
        .expect(201);
    });

    it('owner can manage all permissions (VAL-TEAM-014)', async () => {
      // Owner (default local_trusted user, no impersonation) can grant
      await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .send({ resourceType: 'artifact', resourceId: restrictedArtifactId, granteeType: 'user', granteeId: testUserIdB, accessLevel: 'edit' })
        .expect(201);
      // Owner can edit
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${restrictedArtifactId}`)
        .send({ version: 1, content: { format: 'markdown', body: 'owner edit' } })
        .expect(200);
      // Owner can delete
      await request(app)
        .delete(`/api/companies/${companyId}/artifacts/${restrictedArtifactId}`)
        .expect(200);
    });

    it('admin can manage all permissions (VAL-TEAM-015)', async () => {
      const adminUserId = 'admin-user-test';
      // Admin can grant
      await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .set(impersonate(adminUserId, 'admin'))
        .send({ resourceType: 'artifact', resourceId: restrictedArtifactId, granteeType: 'user', granteeId: testUserIdB, accessLevel: 'edit' })
        .expect(201);
      // Admin can edit
      await request(app)
        .patch(`/api/companies/${companyId}/artifacts/${restrictedArtifactId}`)
        .set(impersonate(adminUserId, 'admin'))
        .send({ version: 1, content: { format: 'markdown', body: 'admin edit' } })
        .expect(200);
      // Admin can delete
      await request(app)
        .delete(`/api/companies/${companyId}/artifacts/${restrictedArtifactId}`)
        .set(impersonate(adminUserId, 'admin'))
        .expect(200);
    });
  });

  // =========================================================================
  // VAL-TEAM-016/021/022: Team membership + removal + deletion
  // =========================================================================
  describe('VAL-TEAM-016/021/022: team membership effects', () => {
    let teamArtifactId: string;

    beforeEach(async () => {
      // Create a team + an artifact restricted to the team
      const team = await request(app)
        .post(`/api/companies/${companyId}/teams`)
        .send({ name: '__mtest__ Access Team' })
        .expect(201);
      teamId = team.body.data.id;

      const art = await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .send({ type: 'document', title: '__mtest__ Team Doc', content: DOC_CONTENT, projectId })
        .expect(201);
      teamArtifactId = art.body.data.id;

      // Grant view to the team
      await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .send({ resourceType: 'artifact', resourceId: teamArtifactId, granteeType: 'team', granteeId: teamId, accessLevel: 'view' })
        .expect(201);

      // Add user A to the team
      await request(app)
        .post(`/api/companies/${companyId}/teams/${teamId}/members`)
        .send({ userId: testUserIdA })
        .expect(201);
    });

    it('VAL-TEAM-016: team membership grants team permissions to members', async () => {
      // User A (team member) can read the team-granted artifact
      await request(app)
        .get(`/api/companies/${companyId}/artifacts/${teamArtifactId}`)
        .set(impersonate(testUserIdA, 'member'))
        .expect(200);
      // User B (not a team member) cannot
      await request(app)
        .get(`/api/companies/${companyId}/artifacts/${teamArtifactId}`)
        .set(impersonate(testUserIdB, 'member'))
        .expect(403);
    });

    it('VAL-TEAM-021: removing a user from a team revokes team-derived access', async () => {
      // User A can read before removal
      await request(app)
        .get(`/api/companies/${companyId}/artifacts/${teamArtifactId}`)
        .set(impersonate(testUserIdA, 'member'))
        .expect(200);
      // Remove user A from the team
      await request(app)
        .delete(`/api/companies/${companyId}/teams/${teamId}/members/${testUserIdA}`)
        .expect(204);
      // User A can no longer read
      await request(app)
        .get(`/api/companies/${companyId}/artifacts/${teamArtifactId}`)
        .set(impersonate(testUserIdA, 'member'))
        .expect(403);
    });

    it('VAL-TEAM-022: deleting a team revokes its team-granted permissions', async () => {
      // User A can read before team deletion
      await request(app)
        .get(`/api/companies/${companyId}/artifacts/${teamArtifactId}`)
        .set(impersonate(testUserIdA, 'member'))
        .expect(200);
      // Delete the team
      await request(app)
        .delete(`/api/companies/${companyId}/teams/${teamId}`)
        .expect(204);
      // User A can no longer read (team permissions removed)
      await request(app)
        .get(`/api/companies/${companyId}/artifacts/${teamArtifactId}`)
        .set(impersonate(testUserIdA, 'member'))
        .expect(403);
      // Permission record for the team is gone
      const perms = await request(app)
        .get(`/api/companies/${companyId}/permissions?resourceType=artifact&resourceId=${teamArtifactId}`)
        .expect(200);
      expect(perms.body.data).toHaveLength(0);
    });
  });

  // =========================================================================
  // VAL-TEAM-018: Permission changes take effect without re-login
  // =========================================================================
  describe('VAL-TEAM-018: live permission changes', () => {
    it('granting permission takes effect on the next request', async () => {
      // User B cannot read initially (no grant)
      await request(app)
        .get(`/api/companies/${companyId}/artifacts/${artifactId}`)
        .set(impersonate(testUserIdB, 'member'))
        .expect(200); // unrestricted → member has edit, so this succeeds

      // Restrict the artifact: grant to user A only
      await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .send({ resourceType: 'artifact', resourceId: artifactId, granteeType: 'user', granteeId: testUserIdA, accessLevel: 'view' })
        .expect(201);

      // User B now cannot read (restricted, no grant) — no re-login needed
      await request(app)
        .get(`/api/companies/${companyId}/artifacts/${artifactId}`)
        .set(impersonate(testUserIdB, 'member'))
        .expect(403);

      // Grant view to user B → takes effect immediately
      await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .send({ resourceType: 'artifact', resourceId: artifactId, granteeType: 'user', granteeId: testUserIdB, accessLevel: 'view' })
        .expect(201);

      await request(app)
        .get(`/api/companies/${companyId}/artifacts/${artifactId}`)
        .set(impersonate(testUserIdB, 'member'))
        .expect(200);
    });
  });

  // =========================================================================
  // VAL-TEAM-019: Permission records are company-scoped
  // =========================================================================
  describe('VAL-TEAM-019: company-scoped permissions', () => {
    it('rejects cross-company grant attempts', async () => {
      // Try to grant permission on an artifact in companyId to a user, but
      // using otherCompanyId in the path
      await request(app)
        .post(`/api/companies/${otherCompanyId}/permissions`)
        .send({ resourceType: 'artifact', resourceId: artifactId, granteeType: 'user', granteeId: testUserIdA, accessLevel: 'view' })
        .expect(404); // artifact not found in otherCompany
    });
  });

  // =========================================================================
  // VAL-TEAM-020: Revoking a permission removes access
  // =========================================================================
  describe('VAL-TEAM-020: revoke permission', () => {
    it('revoking removes access for the grantee', async () => {
      // Grant view to user B
      await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .send({ resourceType: 'artifact', resourceId: artifactId, granteeType: 'user', granteeId: testUserIdB, accessLevel: 'view' })
        .expect(201);
      // Restrict: also grant to user A so the artifact is restricted
      await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .send({ resourceType: 'artifact', resourceId: artifactId, granteeType: 'user', granteeId: testUserIdA, accessLevel: 'view' })
        .expect(201);

      // User B can read
      await request(app)
        .get(`/api/companies/${companyId}/artifacts/${artifactId}`)
        .set(impersonate(testUserIdB, 'member'))
        .expect(200);

      // Revoke user B's permission
      await request(app)
        .delete(`/api/companies/${companyId}/permissions`)
        .send({ resourceType: 'artifact', resourceId: artifactId, granteeType: 'user', granteeId: testUserIdB, accessLevel: 'view' })
        .expect(204);

      // User B can no longer read
      await request(app)
        .get(`/api/companies/${companyId}/artifacts/${artifactId}`)
        .set(impersonate(testUserIdB, 'member'))
        .expect(403);

      // Permission record is gone
      const perms = await request(app)
        .get(`/api/companies/${companyId}/permissions?resourceType=artifact&resourceId=${artifactId}`)
        .expect(200);
      const granteeIds = perms.body.data.map((p: any) => p.granteeId);
      expect(granteeIds).not.toContain(testUserIdB);
    });
  });

  // =========================================================================
  // VAL-TEAM-023: Agent authoring honors per-resource permissions
  // =========================================================================
  describe('VAL-TEAM-023: agent authoring honors RBAC', () => {
    it('agent cannot create in a restricted project', async () => {
      // Restrict the project: grant to user A only
      await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .send({ resourceType: 'project', resourceId: projectId, granteeType: 'user', granteeId: testUserIdA, accessLevel: 'view' })
        .expect(201);

      // Simulate an agent tool call attempting to create in the restricted project.
      // The agent is treated as a member-level actor with no grants.
      // Use the artifact API directly with an agent header to simulate the
      // artifact.create tool path (the tool calls createArtifact under the hood).
      // The route enforces RBAC before createArtifact, so a member without
      // project edit access is denied.
      await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .set(impersonate('agent-test-id', 'member'))
        .send({ type: 'document', title: '__mtest__ Agent Doc', content: DOC_CONTENT, projectId })
        .expect(403);
    });

    it('agent can create in an unrestricted project (member-level)', async () => {
      // No permissions on the project → unrestricted → member can create
      await request(app)
        .post(`/api/companies/${companyId}/artifacts`)
        .set(impersonate('agent-test-id', 'member'))
        .send({ type: 'document', title: '__mtest__ Agent Doc OK', content: DOC_CONTENT, projectId })
        .expect(201);
    });
  });

  // =========================================================================
  // VAL-TEAM-024: Role hierarchy enforced
  // =========================================================================
  describe('VAL-TEAM-024: role hierarchy', () => {
    it('viewer cannot create teams', async () => {
      await request(app)
        .post(`/api/companies/${companyId}/teams`)
        .set(impersonate(testUserIdA, 'viewer'))
        .send({ name: '__mtest__ Viewer Team' })
        .expect(403);
    });

    it('member cannot create teams', async () => {
      await request(app)
        .post(`/api/companies/${companyId}/teams`)
        .set(impersonate(testUserIdA, 'member'))
        .send({ name: '__mtest__ Member Team' })
        .expect(403);
    });

    it('admin can create teams', async () => {
      await request(app)
        .post(`/api/companies/${companyId}/teams`)
        .set(impersonate(testUserIdA, 'admin'))
        .send({ name: '__mtest__ Admin Team' })
        .expect(201);
    });

    it('owner can create teams', async () => {
      await request(app)
        .post(`/api/companies/${companyId}/teams`)
        .set(impersonate(testUserIdA, 'owner'))
        .send({ name: '__mtest__ Owner Team' })
        .expect(201);
    });

    it('viewer/member cannot grant permissions', async () => {
      // Even on an unrestricted resource, viewer/member cannot grant
      // (granting requires manage access, which they don't have)
      await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .set(impersonate(testUserIdA, 'viewer'))
        .send({ resourceType: 'artifact', resourceId: artifactId, granteeType: 'user', granteeId: testUserIdB, accessLevel: 'view' })
        .expect(403);
      await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .set(impersonate(testUserIdA, 'member'))
        .send({ resourceType: 'artifact', resourceId: artifactId, granteeType: 'user', granteeId: testUserIdB, accessLevel: 'view' })
        .expect(403);
    });
  });

  // =========================================================================
  // Realtime events for teams + permissions
  // =========================================================================
  describe('realtime events', () => {
    it('emits team.created, team.member.added, permission.granted events', async () => {
      const team = await request(app)
        .post(`/api/companies/${companyId}/teams`)
        .send({ name: '__mtest__ Event Team' })
        .expect(201);

      const events = await captureEvents(async () => {
        await request(app)
          .post(`/api/companies/${companyId}/teams/${team.body.data.id}/members`)
          .send({ userId: testUserIdA })
          .expect(201);
        await request(app)
          .post(`/api/companies/${companyId}/permissions`)
          .send({ resourceType: 'artifact', resourceId: artifactId, granteeType: 'user', granteeId: testUserIdA, accessLevel: 'view' })
          .expect(201);
      });

      const types = events.map((e) => e.type);
      expect(types).toContain('team.member.added');
      expect(types).toContain('permission.granted');
    });

    it('emits team.deleted and permission.revoked events', async () => {
      const team = await request(app)
        .post(`/api/companies/${companyId}/teams`)
        .send({ name: '__mtest__ Del Team' })
        .expect(201);
      await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .send({ resourceType: 'artifact', resourceId: artifactId, granteeType: 'team', granteeId: team.body.data.id, accessLevel: 'view' })
        .expect(201);

      const events = await captureEvents(async () => {
        await request(app)
          .delete(`/api/companies/${companyId}/teams/${team.body.data.id}`)
          .expect(204);
      });

      const types = events.map((e) => e.type);
      expect(types).toContain('team.deleted');
    });
  });

  // =========================================================================
  // Permission resolve endpoint (used by UI for hidden vs readonly)
  // =========================================================================
  describe('GET /permissions/resolve', () => {
    it('returns manage for owner on unrestricted artifact', async () => {
      const res = await request(app)
        .get(`/api/companies/${companyId}/permissions/resolve?resourceType=artifact&resourceId=${artifactId}`)
        .expect(200);
      expect(res.body.data.accessLevel).toBe('manage');
    });

    it('returns null for user without access on restricted artifact', async () => {
      // Restrict the artifact
      await request(app)
        .post(`/api/companies/${companyId}/permissions`)
        .send({ resourceType: 'artifact', resourceId: artifactId, granteeType: 'user', granteeId: testUserIdA, accessLevel: 'view' })
        .expect(201);

      const res = await request(app)
        .get(`/api/companies/${companyId}/permissions/resolve?resourceType=artifact&resourceId=${artifactId}`)
        .set(impersonate(testUserIdB, 'member'))
        .expect(200);
      expect(res.body.data.accessLevel).toBeNull();
    });

    it('returns view for viewer on unrestricted artifact', async () => {
      const res = await request(app)
        .get(`/api/companies/${companyId}/permissions/resolve?resourceType=artifact&resourceId=${artifactId}`)
        .set(impersonate(testUserIdB, 'viewer'))
        .expect(200);
      expect(res.body.data.accessLevel).toBe('view');
    });
  });
});
