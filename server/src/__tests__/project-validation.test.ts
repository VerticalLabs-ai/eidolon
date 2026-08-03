import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestDb } from '../test-utils.js';
import { validateProjectOwnership } from '../utils/project-validation.js';
import { AppError } from '../middleware/error-handler.js';
import type { DbInstance } from '../types.js';

describe('validateProjectOwnership utility', () => {
  let db: DbInstance;
  let companyId: string;
  let projectId: string;
  let otherCompanyId: string;
  let otherProjectId: string;

  beforeEach(async () => {
    db = await createTestDb();

    const now = new Date();
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    projectId = randomUUID();
    otherProjectId = randomUUID();

    await db.drizzle
      .insert(db.schema.companies)
      .values({ id: companyId, name: 'Owner Corp' })
      .returning();
    await db.drizzle
      .insert(db.schema.companies)
      .values({ id: otherCompanyId, name: 'Other Corp' })
      .returning();

    await db.drizzle
      .insert(db.schema.projects)
      .values({ id: projectId, companyId, name: 'Owner Project', createdAt: now, updatedAt: now })
      .returning();
    await db.drizzle
      .insert(db.schema.projects)
      .values({ id: otherProjectId, companyId: otherCompanyId, name: 'Other Project', createdAt: now, updatedAt: now })
      .returning();
  });

  // VAL-VAL-001: Owned project is returned for the requested company
  it('returns the project row when projectId belongs to companyId', async () => {
    const project = await validateProjectOwnership(db, companyId, projectId);
    expect(project).not.toBeNull();
    expect(project!.id).toBe(projectId);
    expect(project!.companyId).toBe(companyId);
  });

  // VAL-VAL-002: Cross-company project ownership is rejected
  it('throws PROJECT_INVALID (404) when projectId belongs to another company', async () => {
    await expect(validateProjectOwnership(db, companyId, otherProjectId)).rejects.toMatchObject({
      status: 404,
      code: 'PROJECT_INVALID',
    });
  });

  // VAL-VAL-003: Missing project ownership is rejected
  it('throws PROJECT_INVALID (404) when projectId does not exist', async () => {
    await expect(validateProjectOwnership(db, companyId, randomUUID())).rejects.toMatchObject({
      status: 404,
      code: 'PROJECT_INVALID',
    });
  });

  // VAL-VAL-004: Nullish project IDs skip validation
  it('returns null when projectId is null', async () => {
    const result = await validateProjectOwnership(db, companyId, null);
    expect(result).toBeNull();
  });

  it('returns null when projectId is undefined', async () => {
    const result = await validateProjectOwnership(db, companyId, undefined);
    expect(result).toBeNull();
  });

  it('throws an AppError instance for cross-company', async () => {
    try {
      await validateProjectOwnership(db, companyId, otherProjectId);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(404);
      expect((err as AppError).code).toBe('PROJECT_INVALID');
    }
  });
});
