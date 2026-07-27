CREATE OR REPLACE FUNCTION public.release_active_task_checkouts(
  p_company_id text,
  p_task_id text,
  p_execution_id text,
  p_reason text,
  p_released_at timestamp with time zone
) RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  released_checkout public.task_checkouts%ROWTYPE;
  released_count integer := 0;
BEGIN
  FOR released_checkout IN
    UPDATE public.task_checkouts
    SET
      status = 'released',
      released_at = p_released_at,
      release_reason = p_reason,
      updated_at = p_released_at
    WHERE company_id = p_company_id
      AND task_id = p_task_id
      AND execution_id = p_execution_id
      AND status = 'active'
    RETURNING *
  LOOP
    released_count := released_count + 1;
    INSERT INTO public.task_thread_items (
      id,
      company_id,
      task_id,
      kind,
      author_agent_id,
      content,
      payload,
      status,
      idempotency_key,
      related_execution_id,
      created_at,
      updated_at
    ) VALUES (
      gen_random_uuid()::text,
      released_checkout.company_id,
      released_checkout.task_id,
      'execution_event',
      released_checkout.agent_id,
      p_reason,
      jsonb_build_object(
        'event', 'task_checkout_released',
        'checkoutId', released_checkout.id,
        'agentId', released_checkout.agent_id,
        'executionId', released_checkout.execution_id,
        'reason', p_reason
      ),
      'linked',
      'task-release:' || released_checkout.id,
      released_checkout.execution_id,
      p_released_at,
      p_released_at
    )
    ON CONFLICT (company_id, task_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
      DO NOTHING;
  END LOOP;
  RETURN released_count;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.release_checkout_on_execution_terminal()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  release_time timestamp with time zone := COALESCE(NEW.completed_at, now());
  released_count integer;
BEGIN
  IF NEW.status IN ('completed', 'failed', 'cancelled', 'timed_out')
    AND OLD.status IS DISTINCT FROM NEW.status
  THEN
    PERFORM 1
    FROM public.tasks
    WHERE id = NEW.task_id
      AND company_id = NEW.company_id
    FOR UPDATE;

    released_count := public.release_active_task_checkouts(
      NEW.company_id,
      NEW.task_id,
      NEW.id,
      'Execution ' || NEW.id || ' became ' || NEW.status || '.',
      release_time
    );

    IF released_count > 0 AND NEW.status = 'completed' THEN
      UPDATE public.tasks
      SET status = 'review', updated_at = release_time
      WHERE id = NEW.task_id
        AND company_id = NEW.company_id
        AND status = 'in_progress';
    ELSIF released_count > 0 AND NEW.status = 'failed' THEN
      UPDATE public.tasks
      SET status = 'todo', started_at = NULL, updated_at = release_time
      WHERE id = NEW.task_id
        AND company_id = NEW.company_id
        AND status = 'in_progress';
    ELSIF released_count > 0 AND NEW.status = 'cancelled' THEN
      UPDATE public.tasks
      SET status = 'cancelled', updated_at = release_time
      WHERE id = NEW.task_id
        AND company_id = NEW.company_id
        AND status = 'in_progress';
    ELSIF released_count > 0 THEN
      UPDATE public.tasks
      SET status = 'timed_out', updated_at = release_time
      WHERE id = NEW.task_id
        AND company_id = NEW.company_id
        AND status = 'in_progress';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER release_checkout_on_execution_terminal
AFTER UPDATE OF status ON public.agent_executions
FOR EACH ROW
EXECUTE FUNCTION public.release_checkout_on_execution_terminal();--> statement-breakpoint

DO $$
DECLARE
  terminal_checkout record;
BEGIN
  FOR terminal_checkout IN
    SELECT
      checkout.company_id,
      checkout.task_id,
      checkout.agent_id,
      checkout.execution_id,
      execution.status AS execution_status,
      COALESCE(execution.completed_at, now()) AS release_time
    FROM public.task_checkouts AS checkout
    INNER JOIN public.agent_executions AS execution
      ON execution.id = checkout.execution_id
      AND execution.company_id = checkout.company_id
    WHERE checkout.status = 'active'
      AND execution.status IN ('completed', 'failed', 'cancelled', 'timed_out')
    ORDER BY checkout.id
    FOR UPDATE OF checkout
  LOOP
    PERFORM 1
    FROM public.tasks
    WHERE id = terminal_checkout.task_id
      AND company_id = terminal_checkout.company_id
    FOR UPDATE;

    PERFORM public.release_active_task_checkouts(
      terminal_checkout.company_id,
      terminal_checkout.task_id,
      terminal_checkout.execution_id,
      'Execution ' || terminal_checkout.execution_id || ' was already '
        || terminal_checkout.execution_status || ' when checkout lifecycle guards were installed.',
      terminal_checkout.release_time
    );

    UPDATE public.tasks
    SET
      status = CASE terminal_checkout.execution_status
        WHEN 'completed' THEN 'review'
        WHEN 'failed' THEN 'todo'
        WHEN 'cancelled' THEN 'cancelled'
        ELSE 'timed_out'
      END,
      started_at = CASE
        WHEN terminal_checkout.execution_status = 'failed' THEN NULL
        ELSE started_at
      END,
      updated_at = terminal_checkout.release_time
    WHERE id = terminal_checkout.task_id
      AND company_id = terminal_checkout.company_id
      AND status = 'in_progress';

    IF NOT EXISTS (
      SELECT 1
      FROM public.task_checkouts
      WHERE company_id = terminal_checkout.company_id
        AND agent_id = terminal_checkout.agent_id
        AND status = 'active'
    ) THEN
      UPDATE public.agents
      SET status = 'idle', updated_at = terminal_checkout.release_time
      WHERE id = terminal_checkout.agent_id
        AND company_id = terminal_checkout.company_id
        AND status = 'working';
    END IF;
  END LOOP;
END;
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.reject_task_mutation_with_active_checkout()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  active_execution_id text;
  active_agent_id text;
BEGIN
  IF (OLD.status = 'in_progress' AND NEW.status <> 'in_progress')
    OR OLD.dependencies IS DISTINCT FROM NEW.dependencies
    OR OLD.assignee_agent_id IS DISTINCT FROM NEW.assignee_agent_id
  THEN
    SELECT execution_id, agent_id
    INTO active_execution_id, active_agent_id
    FROM public.task_checkouts
    WHERE company_id = NEW.company_id
      AND task_id = NEW.id
      AND status = 'active'
    LIMIT 1;

    IF active_execution_id IS NOT NULL
      AND (
        (OLD.status = 'in_progress' AND NEW.status <> 'in_progress')
        OR OLD.dependencies IS DISTINCT FROM NEW.dependencies
        OR NEW.assignee_agent_id IS DISTINCT FROM active_agent_id
      )
    THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'TASK_CHECKOUT_ACTIVE',
        DETAIL = 'Task ' || NEW.id || ' has active execution ' || active_execution_id;
    END IF;
  END IF;

  IF OLD.status = 'done' AND NEW.status <> 'done' THEN
    SELECT checkout.execution_id
    INTO active_execution_id
    FROM public.tasks AS dependent
    INNER JOIN public.task_checkouts AS checkout
      ON checkout.company_id = dependent.company_id
      AND checkout.task_id = dependent.id
      AND checkout.status = 'active'
    WHERE dependent.company_id = NEW.company_id
      AND dependent.dependencies @> jsonb_build_array(NEW.id)
    LIMIT 1;

    IF active_execution_id IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = 'P0001',
        MESSAGE = 'TASK_DEPENDENCY_ACTIVE',
        DETAIL = 'Task ' || NEW.id || ' is required by active execution ' || active_execution_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER reject_task_mutation_with_active_checkout
BEFORE UPDATE OF status, dependencies, assignee_agent_id ON public.tasks
FOR EACH ROW
EXECUTE FUNCTION public.reject_task_mutation_with_active_checkout();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.reject_active_checkout_dependency_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  active_execution_id text;
BEGIN
  SELECT checkout.execution_id
  INTO active_execution_id
  FROM public.tasks AS dependent
  INNER JOIN public.task_checkouts AS checkout
    ON checkout.company_id = dependent.company_id
    AND checkout.task_id = dependent.id
    AND checkout.status = 'active'
  WHERE dependent.company_id = OLD.company_id
    AND dependent.dependencies @> jsonb_build_array(OLD.id)
  LIMIT 1;

  IF active_execution_id IS NOT NULL THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'TASK_DEPENDENCY_ACTIVE',
      DETAIL = 'Task ' || OLD.id || ' is required by active execution ' || active_execution_id;
  END IF;
  RETURN OLD;
END;
$$;--> statement-breakpoint

CREATE TRIGGER reject_active_checkout_dependency_delete
BEFORE DELETE ON public.tasks
FOR EACH ROW
EXECUTE FUNCTION public.reject_active_checkout_dependency_delete();--> statement-breakpoint

CREATE OR REPLACE FUNCTION public.idle_agent_after_checkout_release()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status = 'active' AND NEW.status = 'released' THEN
    PERFORM 1
    FROM public.agents
    WHERE id = NEW.agent_id
      AND company_id = NEW.company_id
    FOR UPDATE;

    IF NOT EXISTS (
      SELECT 1
      FROM public.task_checkouts
      WHERE company_id = NEW.company_id
        AND agent_id = NEW.agent_id
        AND status = 'active'
    ) THEN
      UPDATE public.agents
      SET status = 'idle', updated_at = NEW.updated_at
      WHERE id = NEW.agent_id
        AND company_id = NEW.company_id
        AND status = 'working';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER idle_agent_after_checkout_release
AFTER UPDATE OF status ON public.task_checkouts
FOR EACH ROW
EXECUTE FUNCTION public.idle_agent_after_checkout_release();
