import { describe, expect, it } from 'vitest';
import {
  authorizeResearchOperation,
  RESEARCH_OPERATION_PERMISSIONS,
  isResearchReadOperation,
  isResearchMutationOperation,
  type ResearchActor,
  type ResearchOperation,
} from '../services/mission/research/rbac.js';
import { AppError } from '../middleware/error-handler.js';

/**
 * Research RBAC enforcement tests.
 *
 * VAL-RES-071: Viewer read-only access
 * VAL-RES-072: Research mutation permissions
 * VAL-RES-075: Agent credential scope
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserActor(
  role: 'owner' | 'admin' | 'member' | 'viewer',
  companyId: string,
): ResearchActor {
  return {
    actorType: 'user',
    actorId: `user-${role}`,
    role,
    companyId,
  };
}

function makeAgentActor(
  companyId: string,
  role: 'owner' | 'admin' | 'member' | 'viewer',
  scopes: string[] = [],
  keyCompanyId?: string,
): ResearchActor {
  return {
    actorType: 'agent',
    actorId: 'agent-key-1',
    role,
    companyId: keyCompanyId ?? companyId,
    agentKeyScopes: scopes,
    agentKeyCompanyId: keyCompanyId ?? companyId,
  };
}

const COMPANY_A = '00000000-0000-4000-8000-000000000001';
const COMPANY_B = '00000000-0000-4000-8000-000000000002';

// ---------------------------------------------------------------------------
// VAL-RES-071: Viewer read-only access
// ---------------------------------------------------------------------------

describe('VAL-RES-071: Viewer read-only access', () => {
  const viewer = makeUserActor('viewer', COMPANY_A);

  it('allows viewer to read source summaries', () => {
    expect(() =>
      authorizeResearchOperation(viewer, 'research.read_sources', COMPANY_A),
    ).not.toThrow();
  });

  it('allows viewer to read cited artifacts', () => {
    expect(() =>
      authorizeResearchOperation(viewer, 'research.read_artifacts', COMPANY_A),
    ).not.toThrow();
  });

  it('allows viewer to read provenance', () => {
    expect(() =>
      authorizeResearchOperation(viewer, 'research.read_provenance', COMPANY_A),
    ).not.toThrow();
  });

  it('allows viewer to read events/snapshot', () => {
    expect(() =>
      authorizeResearchOperation(viewer, 'research.read_events', COMPANY_A),
    ).not.toThrow();
    expect(() =>
      authorizeResearchOperation(viewer, 'research.read_snapshot', COMPANY_A),
    ).not.toThrow();
  });

  it('denies viewer from starting research', () => {
    expect(() => authorizeResearchOperation(viewer, 'research.start', COMPANY_A)).toThrow(AppError);
    try {
      authorizeResearchOperation(viewer, 'research.start', COMPANY_A);
    } catch (err) {
      expect((err as AppError).status).toBe(403);
      expect((err as AppError).code).toBe('INSUFFICIENT_PERMISSION');
    }
  });

  it('denies viewer from cancelling', () => {
    expect(() => authorizeResearchOperation(viewer, 'research.cancel', COMPANY_A)).toThrow(
      AppError,
    );
  });

  it('denies viewer from retrying', () => {
    expect(() => authorizeResearchOperation(viewer, 'research.retry', COMPANY_A)).toThrow(AppError);
  });

  it('denies viewer from answering questions', () => {
    expect(() => authorizeResearchOperation(viewer, 'research.answer', COMPANY_A)).toThrow(
      AppError,
    );
  });

  it('denies viewer from revising a plan', () => {
    expect(() => authorizeResearchOperation(viewer, 'research.revise', COMPANY_A)).toThrow(
      AppError,
    );
  });

  it('denies viewer from approving a plan', () => {
    expect(() => authorizeResearchOperation(viewer, 'research.approve', COMPANY_A)).toThrow(
      AppError,
    );
  });

  it('denies viewer from rejecting a plan', () => {
    expect(() => authorizeResearchOperation(viewer, 'research.reject', COMPANY_A)).toThrow(
      AppError,
    );
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-072: Research mutation permissions
// ---------------------------------------------------------------------------

describe('VAL-RES-072: Research mutation permissions', () => {
  it('owner can start, cancel, retry, answer, revise, approve, reject', () => {
    const owner = makeUserActor('owner', COMPANY_A);
    const mutations: ResearchOperation[] = [
      'research.start',
      'research.cancel',
      'research.retry',
      'research.answer',
      'research.revise',
      'research.approve',
      'research.reject',
    ];
    for (const op of mutations) {
      expect(() => authorizeResearchOperation(owner, op, COMPANY_A)).not.toThrow();
    }
  });

  it('admin can start, cancel, retry, answer, revise, approve, reject', () => {
    const admin = makeUserActor('admin', COMPANY_A);
    const mutations: ResearchOperation[] = [
      'research.start',
      'research.cancel',
      'research.retry',
      'research.answer',
      'research.revise',
      'research.approve',
      'research.reject',
    ];
    for (const op of mutations) {
      expect(() => authorizeResearchOperation(admin, op, COMPANY_A)).not.toThrow();
    }
  });

  it('member can start, cancel, retry, answer, revise but NOT approve or reject', () => {
    const member = makeUserActor('member', COMPANY_A);
    // Allowed:
    for (const op of [
      'research.start',
      'research.cancel',
      'research.retry',
      'research.answer',
      'research.revise',
    ] as ResearchOperation[]) {
      expect(() => authorizeResearchOperation(member, op, COMPANY_A)).not.toThrow();
    }
    // Denied:
    expect(() => authorizeResearchOperation(member, 'research.approve', COMPANY_A)).toThrow(
      AppError,
    );
    expect(() => authorizeResearchOperation(member, 'research.reject', COMPANY_A)).toThrow(
      AppError,
    );
  });

  it('member approval denial is 403 INSUFFICIENT_PERMISSION', () => {
    const member = makeUserActor('member', COMPANY_A);
    try {
      authorizeResearchOperation(member, 'research.approve', COMPANY_A);
      expect.fail('Should have thrown');
    } catch (err) {
      expect((err as AppError).status).toBe(403);
      expect((err as AppError).code).toBe('INSUFFICIENT_PERMISSION');
    }
  });

  it('all roles can read (company.view is universal)', () => {
    for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
      const actor = makeUserActor(role, COMPANY_A);
      for (const op of [
        'research.read_sources',
        'research.read_artifacts',
        'research.read_provenance',
        'research.read_events',
        'research.read_snapshot',
      ] as ResearchOperation[]) {
        expect(() => authorizeResearchOperation(actor, op, COMPANY_A)).not.toThrow();
      }
    }
  });

  it('permission mapping is consistent with mutation matrix', () => {
    expect(RESEARCH_OPERATION_PERMISSIONS['research.start']).toBe('content.create');
    expect(RESEARCH_OPERATION_PERMISSIONS['research.cancel']).toBe('content.create');
    expect(RESEARCH_OPERATION_PERMISSIONS['research.retry']).toBe('content.create');
    expect(RESEARCH_OPERATION_PERMISSIONS['research.answer']).toBe('content.update');
    expect(RESEARCH_OPERATION_PERMISSIONS['research.revise']).toBe('content.update');
    expect(RESEARCH_OPERATION_PERMISSIONS['research.approve']).toBe('mission.approve');
    expect(RESEARCH_OPERATION_PERMISSIONS['research.reject']).toBe('mission.approve');
    expect(RESEARCH_OPERATION_PERMISSIONS['research.read_sources']).toBe('company.view');
    expect(RESEARCH_OPERATION_PERMISSIONS['research.read_artifacts']).toBe('company.view');
    expect(RESEARCH_OPERATION_PERMISSIONS['research.read_provenance']).toBe('company.view');
    expect(RESEARCH_OPERATION_PERMISSIONS['research.read_events']).toBe('company.view');
    expect(RESEARCH_OPERATION_PERMISSIONS['research.read_snapshot']).toBe('company.view');
  });
});

// ---------------------------------------------------------------------------
// VAL-RES-075: Agent credential scope
// ---------------------------------------------------------------------------

describe('VAL-RES-075: Agent credential scope', () => {
  it('agent key with correct research scope and company can start research', () => {
    const agent = makeAgentActor(COMPANY_A, 'member', ['mission.research.run'], COMPANY_A);
    expect(() => authorizeResearchOperation(agent, 'research.start', COMPANY_A)).not.toThrow();
  });

  it('agent key without research scope is denied', () => {
    const agent = makeAgentActor(COMPANY_A, 'member', [], COMPANY_A);
    expect(() => authorizeResearchOperation(agent, 'research.start', COMPANY_A)).toThrow(AppError);
    try {
      authorizeResearchOperation(agent, 'research.start', COMPANY_A);
    } catch (err) {
      expect((err as AppError).status).toBe(403);
      expect((err as AppError).code).toBe('INSUFFICIENT_PERMISSION');
    }
  });

  it('agent key with wrong company scope is denied', () => {
    const agent = makeAgentActor(COMPANY_A, 'member', ['mission.research.run'], COMPANY_B);
    // Agent key belongs to COMPANY_B but is trying to operate on COMPANY_A
    expect(() => authorizeResearchOperation(agent, 'research.start', COMPANY_A)).toThrow(AppError);
  });

  it('agent key cannot approve plans even with research scope', () => {
    const agent = makeAgentActor(COMPANY_A, 'member', ['mission.research.run'], COMPANY_A);
    expect(() => authorizeResearchOperation(agent, 'research.approve', COMPANY_A)).toThrow(
      AppError,
    );
  });

  it('agent key with admin role cannot approve (no implicit elevation)', () => {
    const agent = makeAgentActor(COMPANY_A, 'admin', ['mission.research.run'], COMPANY_A);
    expect(() => authorizeResearchOperation(agent, 'research.approve', COMPANY_A)).toThrow(
      AppError,
    );
  });

  it('agent key with research.run scope can cancel and retry', () => {
    const agent = makeAgentActor(COMPANY_A, 'member', ['mission.research.run'], COMPANY_A);
    expect(() => authorizeResearchOperation(agent, 'research.cancel', COMPANY_A)).not.toThrow();
    expect(() => authorizeResearchOperation(agent, 'research.retry', COMPANY_A)).not.toThrow();
  });

  it('agent key with research.answer scope can answer and revise', () => {
    const agent = makeAgentActor(COMPANY_A, 'member', ['mission.research.answer'], COMPANY_A);
    expect(() => authorizeResearchOperation(agent, 'research.answer', COMPANY_A)).not.toThrow();
    expect(() => authorizeResearchOperation(agent, 'research.revise', COMPANY_A)).not.toThrow();
  });

  it('agent key with only research.answer scope cannot start', () => {
    const agent = makeAgentActor(COMPANY_A, 'member', ['mission.research.answer'], COMPANY_A);
    expect(() => authorizeResearchOperation(agent, 'research.start', COMPANY_A)).toThrow(AppError);
  });

  it('agent key can read sources with any scope (company.view implied)', () => {
    const agent = makeAgentActor(COMPANY_A, 'viewer', [], COMPANY_A);
    expect(() =>
      authorizeResearchOperation(agent, 'research.read_sources', COMPANY_A),
    ).not.toThrow();
  });

  it('agent key cross-company read is denied', () => {
    const agent = makeAgentActor(COMPANY_A, 'viewer', [], COMPANY_B);
    expect(() => authorizeResearchOperation(agent, 'research.read_sources', COMPANY_A)).toThrow(
      AppError,
    );
  });
});

// ---------------------------------------------------------------------------
// Operation classification helpers
// ---------------------------------------------------------------------------

describe('Research operation classification', () => {
  it('classifies read operations', () => {
    expect(isResearchReadOperation('research.read_sources')).toBe(true);
    expect(isResearchReadOperation('research.read_artifacts')).toBe(true);
    expect(isResearchReadOperation('research.read_provenance')).toBe(true);
    expect(isResearchReadOperation('research.read_events')).toBe(true);
    expect(isResearchReadOperation('research.read_snapshot')).toBe(true);
    expect(isResearchReadOperation('research.start')).toBe(false);
  });

  it('classifies mutation operations', () => {
    expect(isResearchMutationOperation('research.start')).toBe(true);
    expect(isResearchMutationOperation('research.cancel')).toBe(true);
    expect(isResearchMutationOperation('research.retry')).toBe(true);
    expect(isResearchMutationOperation('research.answer')).toBe(true);
    expect(isResearchMutationOperation('research.revise')).toBe(true);
    expect(isResearchMutationOperation('research.approve')).toBe(true);
    expect(isResearchMutationOperation('research.reject')).toBe(true);
    expect(isResearchMutationOperation('research.read_sources')).toBe(false);
  });
});
