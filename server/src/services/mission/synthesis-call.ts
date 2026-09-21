/** Stable identity used by the external-call ledger and terminal budget accounting. */
export const SYNTHESIS_TOOL_ID = 'mission.synthesize_report';

/** Safe dispatch metadata; no prompts, credentials, or provider content. */
export interface SynthesisCallReservation {
  provider: string;
  model: string;
  reservedCents: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
}
