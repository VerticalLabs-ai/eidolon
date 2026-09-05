/**
 * Machine-readable Mission mutation precondition matrix (VAL-RUN-137).
 *
 * One declared contract enumerates every stable Mission mutation's required
 * permission, `Idempotency-Key` requirement, `If-Match` requirement, success
 * status, already-terminal behavior, and legal source states. The API and UI
 * follow the same matrix.
 *
 * `ifMatch` values:
 *  - `none`               : no run ETag is required (start has no run yet).
 *  - `required`           : an `If-Match` run ETag is required and must match.
 *  - `required-nonterminal`: required while the run is nonterminal; an exact
 *                            same-key replay still wins after advancement;
 *                            not required (and the command is a no-op 200)
 *                            when the run is already terminal.
 *  - `required-terminal`  : required and must match the terminal run ETag.
 */

export type IfMatchRequirement = 'none' | 'required' | 'required-nonterminal' | 'required-terminal';

export interface MutationMatrixEntry {
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

/**
 * The declared mutation precondition matrix. This is the public contract that
 * the API and UI follow; tests assert the API conforms to it for every
 * implemented command.
 */
export const MUTATION_MATRIX: Record<string, MutationMatrixEntry> = {
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
    // Legal from awaiting_approval, or from queued after approval but
    // before any approved-step effect or child shell starts. A queued
    // revision atomically revokes execution eligibility and returns the
    // run to planning for fresh approval (VAL-PLAN-039, VAL-PLAN-101).
    // After execution starts, revision returns 409 EXECUTION_ALREADY_STARTED.
    legalSourceStates: ['awaiting_approval', 'queued'],
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
    // Legal from every nonterminal status; terminal statuses return the
    // already-terminal 200 snapshot.
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
};
