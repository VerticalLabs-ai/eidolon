-- Add execution_earmark_cents column to budget_reservations for atomic
-- approval budget earmarking (VAL-PLAN-094, VAL-PLAN-126).
--
-- Approval never reacquires or double-reserves company funds: it verifies
-- the approved execution envelope fits the residual root hold and atomically
-- earmarks that residual by setting this column in the same transaction as
-- the binding and queue transition. The column is nullable because existing
-- rows predate the earmark and runs that have not yet been approved have no
-- earmark. Forward-only and additive.
ALTER TABLE "budget_reservations" ADD COLUMN "execution_earmark_cents" integer;
