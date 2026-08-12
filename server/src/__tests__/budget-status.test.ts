import { describe, expect, it } from 'vitest';
import { calculateBudgetStatus } from '../services/budget-status.js';

describe('calculateBudgetStatus', () => {
  it('reports remaining budget and utilization', () => {
    expect(calculateBudgetStatus(10_000, 2_500)).toEqual({
      withinBudget: true,
      budgetCents: 10_000,
      spentCents: 2_500,
      remainingCents: 7_500,
      utilizationPct: 25,
    });
  });

  it('allows unlimited budgets and clamps negative remaining budget', () => {
    expect(calculateBudgetStatus(0, 50)).toMatchObject({
      withinBudget: true,
      remainingCents: 0,
      utilizationPct: 0,
    });
    expect(calculateBudgetStatus(100, 125)).toMatchObject({
      withinBudget: false,
      remainingCents: 0,
      utilizationPct: 125,
    });
  });
});
