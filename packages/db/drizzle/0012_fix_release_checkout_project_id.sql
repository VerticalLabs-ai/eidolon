-- Replace release_active_task_checkouts to include project_id in the
-- task_thread_items INSERT, derived from the task's project via a same-company
-- join to projects.  tasks.project_id has no FK constraint, so it can hold
-- stale or cross-company IDs; the LEFT JOIN resolves only same-company
-- projects and yields NULL for everything else, preventing FK violations on
-- the new task_thread_items.project_id column added in migration 0011.

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
  resolved_project_id text;
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

    -- Resolve the task's project_id through a same-company join to projects.
    -- Stale, deleted, or cross-company project IDs yield NULL.
    SELECT p.id
    INTO resolved_project_id
    FROM public.tasks t
    LEFT JOIN public.projects p
      ON p.id = t.project_id
     AND p.company_id = t.company_id
    WHERE t.id = released_checkout.task_id
      AND t.company_id = released_checkout.company_id;

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
      project_id,
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
      resolved_project_id,
      p_released_at,
      p_released_at
    )
    ON CONFLICT (company_id, task_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
      DO NOTHING;
  END LOOP;
  RETURN released_count;
END;
$$;
