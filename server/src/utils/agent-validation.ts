import { eq, and } from 'drizzle-orm';
import type { DbInstance } from '../types.js';

/**
 * Return true when `agentId` names an agent that belongs to `companyId`.
 *
 * Used to gate agent attribution: a caller-supplied agent id (e.g. the
 * `X-Eidolon-Agent-Id` header, or an agentic-loop tool context) must be
 * verified against company membership before it is trusted as an editor,
 * otherwise attribution is forgeable across company boundaries.
 */
export async function agentBelongsToCompany(
  db: DbInstance,
  companyId: string,
  agentId: string | null | undefined,
): Promise<boolean> {
  if (!agentId) return false;

  const { agents } = db.schema;
  const [agent] = await db.drizzle
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)))
    .limit(1);

  return Boolean(agent);
}
