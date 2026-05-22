-- Enable Row Level Security on all public tables.
--
-- The server connects as the `postgres` superuser via POSTGRES_URL, which
-- bypasses RLS, so server-side queries are unaffected. This change blocks
-- direct PostgREST access from the `anon` and `authenticated` roles, which
-- is what the Supabase advisor flags as critical. No policies are created;
-- with RLS enabled and zero policies, those roles get deny-by-default.
--
-- If a future feature needs browser-direct access to a specific table,
-- add a `CREATE POLICY` for that table at that time.

ALTER TABLE public.agent_collaborations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_config_revisions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_evaluations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_executions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_files             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_memories          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agents                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approval_comments       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.approvals               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_alerts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.companies               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.company_templates       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cost_events             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.execution_environments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.goals                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.heartbeats              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inbox_read_states       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integrations            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_chunks        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.knowledge_documents     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mcp_servers             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.projects                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prompt_templates        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prompt_versions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.secrets                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_holds              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.task_thread_items       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks                   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhooks                ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflows               ENABLE ROW LEVEL SECURITY;
