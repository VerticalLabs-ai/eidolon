// ---------------------------------------------------------------------------
// Cost calculation utility shared across all providers
// ---------------------------------------------------------------------------

import { TOKEN_COSTS_PER_MILLION, type KnownModel } from '@eidolon/shared';

/**
 * Calculate cost in cents for a given provider/model and token counts.
 * Falls back to 0 for unknown models (e.g. custom or local).
 */
export function calculateCostCents(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const key = `${provider}/${model}` as KnownModel;
  const rates = TOKEN_COSTS_PER_MILLION[key];

  if (!rates) {
    return 0;
  }

  const inputCost = (inputTokens / 1_000_000) * rates.input;
  const outputCost = (outputTokens / 1_000_000) * rates.output;

  // Round to nearest cent
  return Math.round(inputCost + outputCost);
}
