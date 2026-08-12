export interface BudgetStatus {
  withinBudget: boolean;
  budgetCents: number;
  spentCents: number;
  remainingCents: number;
  utilizationPct: number;
}

export function calculateBudgetStatus(
  budgetMonthlyCents: number,
  spentMonthlyCents: number,
): BudgetStatus {
  const remainingCents = budgetMonthlyCents - spentMonthlyCents;
  const utilizationPct =
    budgetMonthlyCents > 0 ? Math.round((spentMonthlyCents / budgetMonthlyCents) * 100) : 0;

  return {
    withinBudget: remainingCents > 0 || budgetMonthlyCents === 0,
    budgetCents: budgetMonthlyCents,
    spentCents: spentMonthlyCents,
    remainingCents: Math.max(0, remainingCents),
    utilizationPct,
  };
}
