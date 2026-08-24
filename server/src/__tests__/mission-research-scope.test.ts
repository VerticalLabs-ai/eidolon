import { describe, expect, it } from 'vitest';
import {
  assertScopedResource,
  nonEnumerating404,
  type ScopedResource,
} from '../services/mission/research/scope.js';
import type { AppError } from '../middleware/error-handler.js';

/**
 * Research scope enforcement tests.
 *
 * VAL-RES-073: Cross-company run isolation
 * VAL-RES-074: Cross-project isolation
 */

const COMPANY_A = '00000000-0000-4000-8000-000000000001';
const COMPANY_B = '00000000-0000-4000-8000-000000000002';
const PROJECT_A1 = '00000000-0000-4000-8000-000000000011';
const PROJECT_A2 = '00000000-0000-4000-8000-000000000012';
const PROJECT_B1 = '00000000-0000-4000-8000-000000000021';

const RUN_ID = '00000000-0000-4000-8000-000000000101';
const LOGICAL_CALL_ID = '00000000-0000-4000-8000-000000000107';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResource(
  companyId: string,
  projectId: string,
  id: string,
  type: ScopedResource['type'],
  extra: Record<string, unknown> = {},
): ScopedResource {
  return { companyId, projectId, id, type, ...extra };
}

// ---------------------------------------------------------------------------
// VAL-RES-073: Cross-company run isolation
// ---------------------------------------------------------------------------

describe('VAL-RES-073: Cross-company run isolation', () => {
  const resourceTypes: ScopedResource['type'][] = [
    'run',
    'logical_call',
    'source',
    'source_revision',
    'citation',
    'artifact',
    'provenance',
  ];

  for (const type of resourceTypes) {
    it(`returns non-enumerating 404 for ${type} from company A used in company B scope`, () => {
      const resource = makeResource(COMPANY_A, PROJECT_A1, RUN_ID, type, {
        title: 'Company A Secret Title',
        canonicalUrl: 'https://company-a.example.com/secret',
        quote: 'Company A secret quote text',
      });
      try {
        assertScopedResource(resource, COMPANY_B, PROJECT_B1);
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as AppError).status).toBe(404);
        expect((err as AppError).code).toBe('RESOURCE_NOT_FOUND');
        // Non-enumerating: the error message must not reveal the resource's
        // actual scope or content.
        const msg = (err as AppError).message;
        expect(msg).not.toContain(COMPANY_A);
        expect(msg).not.toContain(PROJECT_A1);
        expect(msg).not.toContain('Company A Secret Title');
        expect(msg).not.toContain('company-a.example.com');
        expect(msg).not.toContain('Company A secret quote');
      }
    });
  }

  it('allows same-company same-project resource access', () => {
    const resource = makeResource(COMPANY_A, PROJECT_A1, RUN_ID, 'run');
    expect(() => assertScopedResource(resource, COMPANY_A, PROJECT_A1)).not.toThrow();
  });

  it('allows same-company cross-project resource when resource is company-scoped only', () => {
    // Some resources (like logical_call, provider_health) may be company-scoped
    // without a project. When projectId is null, only company is checked.
    const resource: ScopedResource = {
      companyId: COMPANY_A,
      projectId: null,
      id: LOGICAL_CALL_ID,
      type: 'logical_call',
    };
    expect(() => assertScopedResource(resource, COMPANY_A, PROJECT_A2)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-074: Cross-project isolation
// ---------------------------------------------------------------------------

describe('VAL-RES-074: Cross-project isolation', () => {
  const projectScopedTypes: ScopedResource['type'][] = [
    'run',
    'source',
    'source_revision',
    'citation',
    'artifact',
    'provenance',
  ];

  for (const type of projectScopedTypes) {
    it(`returns non-enumerating 404 for ${type} from project A1 used in project A2 scope`, () => {
      const resource = makeResource(COMPANY_A, PROJECT_A1, RUN_ID, type, {
        title: 'Project A1 Artifact',
        content: 'Project A1 content text',
      });
      try {
        assertScopedResource(resource, COMPANY_A, PROJECT_A2);
        expect.fail('Should have thrown');
      } catch (err) {
        expect((err as AppError).status).toBe(404);
        expect((err as AppError).code).toBe('RESOURCE_NOT_FOUND');
        const msg = (err as AppError).message;
        expect(msg).not.toContain(PROJECT_A1);
        expect(msg).not.toContain('Project A1 Artifact');
        expect(msg).not.toContain('Project A1 content');
      }
    });
  }

  it('allows same-project resource access', () => {
    const resource = makeResource(COMPANY_A, PROJECT_A1, RUN_ID, 'run');
    expect(() => assertScopedResource(resource, COMPANY_A, PROJECT_A1)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Non-enumerating 404 helper
// ---------------------------------------------------------------------------

describe('nonEnumerating404', () => {
  it('produces a 404 with RESOURCE_NOT_FOUND code', () => {
    const err = nonEnumerating404();
    expect(err.status).toBe(404);
    expect(err.code).toBe('RESOURCE_NOT_FOUND');
  });

  it('does not include the resource type in a way that reveals existence', () => {
    const err = nonEnumerating404();
    // The message should be generic — no detail about what was looked up.
    expect(err.message).not.toContain(COMPANY_A);
    expect(err.message).not.toContain(RUN_ID);
  });
});
