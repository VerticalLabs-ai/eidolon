// ---------------------------------------------------------------------------
// Subject-data export and erasure
// ---------------------------------------------------------------------------
//
// GET  /api/companies/:companyId/privacy/subjects/:userId/export
// POST /api/companies/:companyId/privacy/subjects/:userId/erase
//
// Auth: requireAuth + requirePermission('privacy.manage'), which is owner-only.
// Both operations are mounted company-scoped, so a caller can only act inside a
// company it owns, and the subject must be a member of that company: without
// that check, an owner could name any user id and read or destroy data in
// another company.
//
// Neither handler logs the payload. An export is the one response in the API
// that is guaranteed to be personal data, so it must not end up in request logs
// or an error report.
// ---------------------------------------------------------------------------

import { Router } from 'express';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { AppError } from '../middleware/error-handler.js';
import { routeParams } from '../utils/route-params.js';
import { eraseSubjectData, exportSubjectData, subjectPseudonym } from '../services/privacy.js';
import type { DbInstance } from '../types.js';

const eraseSchema = z.object({
  // Requiring the subject id in the body as well as the path makes an erasure
  // hard to trigger by mistake, which matters because it cannot be undone.
  confirmSubject: z.string().min(1),
  // Optional, because a pending invitation is keyed by email and this database
  // has no email-to-user-id link until the invitation is accepted.
  email: z.string().email().optional(),
});

export function privacyRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });

  async function requireMembership(companyId: string, userId: string): Promise<void> {
    const [membership] = await db.drizzle
      .select({ id: db.schema.companyMembers.id })
      .from(db.schema.companyMembers)
      .where(
        and(
          eq(db.schema.companyMembers.companyId, companyId),
          eq(db.schema.companyMembers.userId, userId),
        ),
      )
      .limit(1);

    if (!membership) {
      // Deliberately indistinguishable from a nonexistent user: an owner must
      // not be able to probe for membership in companies they do not own.
      throw new AppError(404, 'SUBJECT_NOT_FOUND', 'No such subject in this company');
    }
  }

  async function recordAudit(
    companyId: string,
    actorId: string,
    action: string,
    pseudonym: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await db.drizzle.insert(db.schema.activityLog).values({
      companyId,
      actorType: 'user',
      actorId,
      action,
      entityType: 'privacy_subject',
      // The audit row identifies the subject by pseudonym. Writing the raw id
      // here would put back what the erasure just removed.
      entityId: pseudonym,
      description:
        action === 'privacy.subject_exported'
          ? 'Exported personal data for a subject'
          : 'Erased personal data for a subject',
      metadata,
      createdAt: new Date(),
    });
  }

  router.get('/subjects/:userId/export', async (req, res) => {
    const { companyId } = routeParams(req);
    const userId = String(req.params.userId ?? '');
    if (!userId) {
      throw new AppError(400, 'VALIDATION_ERROR', 'A subject id is required');
    }

    await requireMembership(companyId, userId);
    const data = await exportSubjectData(db, companyId, userId);

    await recordAudit(
      companyId,
      String(req.user?.id ?? 'unknown'),
      'privacy.subject_exported',
      subjectPseudonym(companyId, userId),
      { tables: data.tables.length, totalRows: data.totalRows },
    );

    res
      .status(200)
      .type('application/json')
      // Personal data should not sit in a shared cache.
      .set('Cache-Control', 'no-store')
      .json({ data });
  });

  router.post('/subjects/:userId/erase', async (req, res) => {
    const { companyId } = routeParams(req);
    const userId = String(req.params.userId ?? '');
    const parsed = eraseSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, 'VALIDATION_ERROR', 'confirmSubject is required');
    }
    if (parsed.data.confirmSubject !== userId) {
      throw new AppError(400, 'VALIDATION_ERROR', 'confirmSubject must match the subject id');
    }

    await requireMembership(companyId, userId);

    const actorId = String(req.user?.id ?? 'unknown');
    if (actorId === userId) {
      // An owner erasing themselves would delete the membership row that
      // authorises the request and could leave the company with no owner.
      throw new AppError(
        409,
        'SELF_ERASURE_REFUSED',
        'An owner cannot erase their own subject data; transfer ownership first',
      );
    }

    const report = await eraseSubjectData(db, companyId, userId, { email: parsed.data.email });

    await recordAudit(companyId, actorId, 'privacy.subject_erased', report.pseudonym, {
      rowsAffected: report.rowsAffected,
      remainingReferences: report.remainingReferences,
      actions: report.actions,
    });

    res.status(200).set('Cache-Control', 'no-store').json({ data: report });
  });

  return router;
}
