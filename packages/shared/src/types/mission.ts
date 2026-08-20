/**
 * Mission mutation precondition contract — shared client contract.
 *
 * This is the generated/shared contract that publishes the complete stable
 * command precondition matrix through a consumable format. The server's
 * `MUTATION_MATRIX` is the authoritative source; this contract is kept in
 * sync so that API and UI clients can consume the same declared
 * preconditions without importing server internals.
 *
 * Schema version 1 is the Phase 1 stable contract.
 */

export type IfMatchRequirement = 'none' | 'required' | 'required-nonterminal' | 'required-terminal';

export interface MutationContractEntry {
  /** Stable command type from the run_commands enum. */
  type: string;
  /** Required content permission (RBAC enforcement is the auth feature). */
  permission: string;
  /** Every mutation requires an Idempotency-Key. */
  idempotencyKeyRequired: true;
  ifMatch: IfMatchRequirement;
  /** HTTP status on a successful first application. */
  successStatus: number;
  /** Behavior when the run is already terminal when the command arrives. */
  alreadyTerminalBehavior: 'replay-200-snapshot' | 'not-applicable' | 'rejected-invalid-state';
  /** Lifecycle statuses from which the command is a legal transition. */
  legalSourceStates: string[];
}

export interface MissionMutationContract {
  /** Contract schema version for stable evolution. */
  schemaVersion: number;
  /** One entry per stable command type. */
  commands: Record<string, MutationContractEntry>;
}

/**
 * The complete stable Mission command precondition matrix.
 *
 * This contract is the public declaration that the API and UI follow. It
 * mirrors `server/src/services/mission/mutation-matrix.ts` exactly. When
 * the server matrix changes, this contract must be updated in the same
 * commit so clients and server stay in sync.
 */
export const MISSION_MUTATION_CONTRACT: MissionMutationContract = {
  schemaVersion: 1,
  commands: {
    'run.start': {
      type: 'run.start',
      permission: 'content.create',
      idempotencyKeyRequired: true,
      ifMatch: 'none',
      successStatus: 202,
      alreadyTerminalBehavior: 'not-applicable',
      legalSourceStates: [],
    },
    'questions.answer': {
      type: 'questions.answer',
      permission: 'content.update',
      idempotencyKeyRequired: true,
      ifMatch: 'required',
      successStatus: 200,
      alreadyTerminalBehavior: 'rejected-invalid-state',
      legalSourceStates: ['awaiting_input'],
    },
    'plan.revision_request': {
      type: 'plan.revision_request',
      permission: 'content.update',
      idempotencyKeyRequired: true,
      ifMatch: 'required',
      successStatus: 202,
      alreadyTerminalBehavior: 'rejected-invalid-state',
      legalSourceStates: ['awaiting_approval'],
    },
    'plan.approve': {
      type: 'plan.approve',
      permission: 'mission.approve',
      idempotencyKeyRequired: true,
      ifMatch: 'required',
      successStatus: 200,
      alreadyTerminalBehavior: 'rejected-invalid-state',
      legalSourceStates: ['awaiting_approval'],
    },
    'plan.reject': {
      type: 'plan.reject',
      permission: 'mission.approve',
      idempotencyKeyRequired: true,
      ifMatch: 'required',
      successStatus: 200,
      alreadyTerminalBehavior: 'rejected-invalid-state',
      legalSourceStates: ['awaiting_approval'],
    },
    'run.cancel': {
      type: 'run.cancel',
      permission: 'content.create',
      idempotencyKeyRequired: true,
      ifMatch: 'required-nonterminal',
      successStatus: 202,
      alreadyTerminalBehavior: 'replay-200-snapshot',
      legalSourceStates: [
        'draft',
        'awaiting_input',
        'planning',
        'awaiting_approval',
        'queued',
        'running',
        'synthesizing',
        'completed',
        'failed',
        'cancelled',
      ],
    },
    'run.retry': {
      type: 'run.retry',
      permission: 'content.create',
      idempotencyKeyRequired: true,
      ifMatch: 'required-terminal',
      successStatus: 202,
      alreadyTerminalBehavior: 'not-applicable',
      legalSourceStates: ['failed', 'cancelled'],
    },
  },
};
