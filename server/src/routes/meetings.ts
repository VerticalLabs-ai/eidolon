import { Router } from 'express';
import {
  CreateMeetingBodySchema,
  UpdateMeetingBodySchema,
  AttachTranscriptBodySchema,
  MeetingListQuerySchema,
} from '@eidolon/shared';
import { validate } from '../middleware/validate.js';
import { routeParams } from '../utils/route-params.js';
import { AppError } from '../middleware/error-handler.js';
import { agentBelongsToCompany } from '../utils/agent-validation.js';
import {
  createMeeting,
  getMeeting,
  listMeetings,
  updateMeeting,
  attachTranscript,
  setMeetingStatus,
  summarizeMeeting,
  extractActionItems,
  getMeetingTasks,
} from '../services/meeting-service.js';
import type { DbInstance } from '../types.js';

async function editor(db: DbInstance, companyId: string, req: any) {
  // Support agent-authored meeting actions via X-Eidolon-Agent-Id header
  // (used by MCP-server tool calls and built-in agent tools). The header is
  // caller-controlled, so the agent id is only trusted for attribution when
  // it names an agent that actually belongs to the path company.
  const agentId = req.get('X-Eidolon-Agent-Id');
  if (agentId) {
    if (await agentBelongsToCompany(db, companyId, agentId)) {
      return { agentId, userId: null };
    }
    throw new AppError(403, 'AGENT_NOT_IN_COMPANY', 'The specified agent does not belong to this company');
  }
  return { userId: req.user?.id ?? null, agentId: null };
}

export function meetingsRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });

  // POST /api/companies/:companyId/projects/:projectId/meetings — create
  router.post('/', validate(CreateMeetingBodySchema), async (req, res) => {
    const { companyId, projectId } = routeParams(req);
    const body = (req as any).validated.body;
    const row = await createMeeting(
      db,
      companyId,
      { ...body, projectId },
      await editor(db, companyId, req),
    );
    res.status(201).json({ data: row });
  });

  // GET /api/companies/:companyId/projects/:projectId/meetings — project-scoped list
  router.get('/', validate(MeetingListQuerySchema, 'query'), async (req, res) => {
    const { companyId, projectId } = routeParams(req);
    const query = (req as any).validated.query;
    const filters: any = {
      limit: query.limit,
      offset: query.offset,
      // Default to active meetings (exclude archived/deleted) unless an
      // explicit status filter is supplied.
      status: query.status ?? 'active',
    };
    if (query.unscoped === true || query.projectId === 'null') {
      filters.filterNullProject = true;
    } else if (query.projectId && query.projectId !== 'null') {
      filters.projectId = query.projectId;
    } else {
      filters.projectId = projectId;
    }
    const result = await listMeetings(db, companyId, filters);
    res.json({ data: result.rows, meta: { total: result.total, limit: query.limit, offset: query.offset } });
  });

  return router;
}

/**
 * Meeting-scoped router mounted at /api/companies/:companyId/meetings/:id.
 * Handles get/patch/delete/transcript/summarize/action-items/tasks for a
 * single meeting. The `id` path param is the meeting id; companyId is
 * inherited from the mount point.
 */
export function meetingItemRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });

  // GET .../meetings/:id — single meeting (project + company scoped)
  router.get('/:id', async (req, res) => {
    const { companyId } = routeParams(req);
    const { id } = routeParams(req);
    res.json({ data: await getMeeting(db, companyId, id) });
  });

  // GET .../meetings/:id/tasks — bidirectional linkage (tasks → meeting)
  router.get('/:id/tasks', async (req, res) => {
    const { companyId } = routeParams(req);
    const { id } = routeParams(req);
    res.json({ data: await getMeetingTasks(db, companyId, id) });
  });

  // PATCH .../meetings/:id — update meeting fields (title, transcript, etc.)
  router.patch('/:id', validate(UpdateMeetingBodySchema), async (req, res) => {
    const { companyId } = routeParams(req);
    const { id } = routeParams(req);
    const body = (req as any).validated.body;
    res.json({ data: await updateMeeting(db, companyId, id, body, await editor(db, companyId, req)) });
  });

  // POST .../meetings/:id/transcript — attach/replace transcript (paste text)
  router.post('/:id/transcript', validate(AttachTranscriptBodySchema), async (req, res) => {
    const { companyId } = routeParams(req);
    const { id } = routeParams(req);
    const body = (req as any).validated.body;
    res.json({ data: await attachTranscript(db, companyId, id, body.transcript, await editor(db, companyId, req)) });
  });

  // POST .../meetings/:id/summarize — generate transcript-grounded summary
  router.post('/:id/summarize', async (req, res) => {
    const { companyId } = routeParams(req);
    const { id } = routeParams(req);
    const result = await summarizeMeeting(db, companyId, id, await editor(db, companyId, req));
    res.json({ data: result });
  });

  // POST .../meetings/:id/action-items — extract action items as real tasks
  router.post('/:id/action-items', async (req, res) => {
    const { companyId } = routeParams(req);
    const { id } = routeParams(req);
    const result = await extractActionItems(db, companyId, id, await editor(db, companyId, req));
    res.json({ data: result });
  });

  // DELETE .../meetings/:id — soft-delete
  router.delete('/:id', async (req, res) => {
    const { companyId } = routeParams(req);
    const { id } = routeParams(req);
    res.json({ data: await setMeetingStatus(db, companyId, id, 'deleted', await editor(db, companyId, req)) });
  });

  // POST .../meetings/:id/archive — archive
  router.post('/:id/archive', async (req, res) => {
    const { companyId } = routeParams(req);
    const { id } = routeParams(req);
    res.json({ data: await setMeetingStatus(db, companyId, id, 'archived', await editor(db, companyId, req)) });
  });

  // POST .../meetings/:id/restore — restore from archived/deleted
  router.post('/:id/restore', async (req, res) => {
    const { companyId } = routeParams(req);
    const { id } = routeParams(req);
    res.json({ data: await setMeetingStatus(db, companyId, id, 'active', await editor(db, companyId, req)) });
  });

  return router;
}
