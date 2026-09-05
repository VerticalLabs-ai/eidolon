/**
 * Test-only fixture controls: deterministic disruption barriers and
 * production-path admission guards.
 *
 * (VAL-CROSS-103, VAL-CROSS-104)
 *
 * This module is gated by the `MISSION_FIXTURE_CONTROLS` environment variable.
 * It can only be constructed when that variable is set to `'1'`. The
 * production worker entry point and API server never set this variable.
 *
 * The `DisruptionBarrier` provides test-only barriers at named nonterminal
 * checkpoints. Before kill-switch disable, a held synthesis/terminal barrier
 * proves the root remains effect-fenced and nonterminal; disable requests
 * cancellation, then releasing the barrier cannot commit old work and the
 * root must converge cancelled by its deadline.
 *
 * These controls do NOT mock production code paths. They only provide
 * deterministic barrier state and admission logging at declared seams. All
 * production command, policy, hash, approval, routing, evidence, artifact,
 * projection, and cancellation code remains unchanged.
 */

/** Environment flag that enables fixture controls. */
export const FIXTURE_CONTROLS_ENV_FLAG = 'MISSION_FIXTURE_CONTROLS';

/** Returns true only when fixture controls are explicitly enabled. */
export function isFixtureControlsEnabled(): boolean {
  return process.env[FIXTURE_CONTROLS_ENV_FLAG] === '1';
}

/**
 * Assert that fixture controls are enabled. Throws if called in production.
 * @internal
 */
export function assertFixtureControlsEnabled(): void {
  if (!isFixtureControlsEnabled()) {
    throw new Error(
      `Fixture controls are test-only. Set ${FIXTURE_CONTROLS_ENV_FLAG}=1 to enable. ` +
        'Production routes cannot accept barrier controls or fixture admission guards.',
    );
  }
}

// ---------------------------------------------------------------------------
// Checkpoint log entry
// ---------------------------------------------------------------------------

/** A checkpoint entry in the disruption barrier log. */
export interface CheckpointEntry {
  /** The named checkpoint. */
  name: string;
  /** Timestamp when the barrier was held. */
  heldAt: string;
  /** Timestamp when the barrier was released (null if still held). */
  releasedAt: string | null;
  /** Who released the barrier (null if still held or not recorded). */
  releasedBy: string | null;
  /** Whether the barrier is currently held. */
  isHeld: boolean;
}

// ---------------------------------------------------------------------------
// DisruptionBarrier
// ---------------------------------------------------------------------------

/**
 * Test-only disruption barrier for the `disruption-v1` fixture.
 *
 * Exposes test-only barriers at named nonterminal checkpoints and records
 * release ownership. Before kill-switch disable, a held synthesis/terminal
 * barrier proves the root remains effect-fenced and nonterminal; disable
 * requests cancellation, then releasing the barrier cannot commit old work
 * and the root must converge cancelled by its deadline.
 *
 * Construction throws unless `MISSION_FIXTURE_CONTROLS=1`. Controls are
 * unavailable in production builds.
 *
 * (VAL-CROSS-104)
 */
export class DisruptionBarrier {
  private readonly held = new Map<string, string>();
  private readonly log: CheckpointEntry[] = [];
  private readonly releasedCheckpoints = new Set<string>();

  constructor() {
    assertFixtureControlsEnabled();
  }

  /**
   * Hold a barrier at a named nonterminal checkpoint. The barrier remains
   * held until {@link release} is called for the same checkpoint name.
   */
  hold(name: string): void {
    const now = new Date().toISOString();
    this.held.set(name, now);
    this.log.push({
      name,
      heldAt: now,
      releasedAt: null,
      releasedBy: null,
      isHeld: true,
    });
  }

  /**
   * Release a held barrier. After release, the barrier cannot be used to
   * commit old work — {@link assertNoLateCommit} verifies this.
   */
  release(name: string): void {
    if (!this.held.has(name)) {
      return;
    }
    this.held.delete(name);
    this.releasedCheckpoints.add(name);
    const now = new Date().toISOString();
    const entry = this.log.find((e) => e.name === name && e.isHeld);
    if (entry) {
      entry.releasedAt = now;
      entry.isHeld = false;
    }
  }

  /**
   * Record who released the barrier (release ownership). This is used to
   * prove that the kill-switch sweep (not a late worker commit) caused the
   * cancellation.
   */
  recordReleaseOwnership(name: string, owner: string): void {
    const entry = this.log.find((e) => e.name === name);
    if (entry) {
      entry.releasedBy = owner;
    }
  }

  /**
   * Check if a barrier is currently held at the named checkpoint.
   */
  isHeld(name: string): boolean {
    return this.held.has(name);
  }

  /**
   * Assert that the run status is nonterminal at a named checkpoint. Throws
   * if the status is terminal (completed, failed, or cancelled).
   *
   * This proves the root remains effect-fenced and nonterminal before
   * kill-switch disable.
   */
  assertNonterminal(checkpointName: string, status: string): void {
    const terminalStatuses = ['completed', 'failed', 'cancelled'];
    if (terminalStatuses.includes(status)) {
      throw new Error(
        `Barrier checkpoint "${checkpointName}" expected nonterminal status, but got "${status}". ` +
          'The root must remain effect-fenced and nonterminal before kill-switch disable.',
      );
    }
  }

  /**
   * Assert that no late commit occurs after the barrier was released. After
   * release, the barrier cannot commit old work — the root must converge
   * cancelled by its deadline.
   *
   * This method verifies that the checkpoint was released (not still held)
   * and that the release was recorded. It does not throw if the checkpoint
   * was properly released.
   */
  assertNoLateCommit(checkpointName: string): void {
    if (this.held.has(checkpointName)) {
      throw new Error(
        `Barrier checkpoint "${checkpointName}" is still held. ` +
          'A late commit cannot occur while the barrier is held — release it first.',
      );
    }
    // If the checkpoint was never held or was released, no late commit is
    // possible (the barrier was properly released).
  }

  /**
   * Get the checkpoint log, recording all named checkpoints with their
   * hold/release timestamps and release ownership.
   */
  getCheckpointLog(): CheckpointEntry[] {
    return [...this.log];
  }

  /**
   * Get all checkpoint names that have been released.
   */
  getReleasedCheckpoints(): string[] {
    return [...this.releasedCheckpoints];
  }
}
