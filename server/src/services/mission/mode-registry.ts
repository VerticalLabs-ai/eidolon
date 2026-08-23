import { and, eq, or, sql, asc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../middleware/error-handler.js';
import type { DbInstance } from '../../types.js';
import {
  toPublicProfile,
  type PublicModeProfile,
  type ParsedCreateProfileBody,
  type ParsedUpdateProfileBody,
} from './mode-profile-schema.js';

/**
 * Mode registry service for company-defined custom Mission mode profiles.
 *
 * Profiles are closed, bounded, tenant-scoped, disable-only, deterministic,
 * and never broaden policy. Administration is versioned (optimistic
 * concurrency), authorized (company.settings.update, owner/admin only), and
 * attributable (activity log entries). Profile deletion is not a Phase 1
 * operation; disabled (enabled=false) is the sole unavailable lifecycle.
 *
 * (VAL-MODEQ-016, VAL-MODEQ-017, VAL-MODEQ-020, VAL-MODEQ-124, VAL-MODEQ-152,
 *  VAL-MODEQ-153)
 */

export interface ListProfilesInput {
  companyId: string;
  limit: number;
  cursor?: string;
  includeDisabled?: boolean;
}

export interface ListProfilesResult {
  profiles: PublicModeProfile[];
  nextCursor: string | null;
}

export interface GetProfileInput {
  companyId: string;
  profileId: string;
}

export interface CreateProfileInput {
  companyId: string;
  body: ParsedCreateProfileBody;
  actorType: 'user' | 'agent' | 'system';
  actorId: string | null;
  traceId?: string | null;
}

export interface UpdateProfileInput {
  companyId: string;
  profileId: string;
  body: ParsedUpdateProfileBody;
  /** Expected current version from If-Match header (required for PATCH). */
  expectedVersion: number;
  actorType: 'user' | 'agent' | 'system';
  actorId: string | null;
  traceId?: string | null;
}

export interface ProfileResult {
  profile: PublicModeProfile;
}

/**
 * Decode an opaque keyset cursor for profile listing.
 * Cursor format: base64url(JSON({name, id}))
 * Throws AppError(400) on malformed cursor.
 */
function decodeProfileCursor(cursor: string): { name: string; id: string } {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(decoded) as { name: string; id: string };
    if (typeof parsed.name !== 'string' || typeof parsed.id !== 'string') {
      throw new Error('invalid shape');
    }
    return parsed;
  } catch {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid profile list cursor');
  }
}

/** Encode a keyset cursor from the last returned row. */
function encodeProfileCursor(name: string, id: string): string {
  return Buffer.from(JSON.stringify({ name, id }), 'utf8').toString('base64url');
}

export class ModeRegistryService {
  constructor(private db: DbInstance) {}

  /**
   * List company profiles ordered by normalized display-name then profile-ID.
   * At most 100 per page with opaque keyset cursors. Disabled profiles are
   * excluded unless includeDisabled is true (admin only).
   *
   * (VAL-MODEQ-153: list pages at most 100 in normalized name/profile-ID
   * order with opaque cursors; disabled IDs absent from selectable results.)
   */
  async listProfiles(input: ListProfilesInput): Promise<ListProfilesResult> {
    const { companyId, limit, cursor, includeDisabled } = input;
    const schema = this.db.schema;

    // Decode cursor early so malformed cursor is a 400.
    let cursorEntry: { name: string; id: string } | null = null;
    if (cursor) {
      cursorEntry = decodeProfileCursor(cursor);
    }

    // Build conditions: company-scoped, optionally enabled-only, keyset filter.
    const conditions = [eq(schema.modeProfiles.companyId, companyId)];
    if (!includeDisabled) {
      conditions.push(eq(schema.modeProfiles.enabled, true));
    }

    // Keyset pagination: (name, id) > (cursor.name, cursor.id) using
    // row-wise comparison via OR for stable ordering without duplicates.
    if (cursorEntry) {
      conditions.push(
        or(
          sql`(${schema.modeProfiles.name}, ${schema.modeProfiles.id}) > (${cursorEntry.name}, ${cursorEntry.id})`,
        )!,
      );
    }

    const rows = await this.db.drizzle
      .select()
      .from(schema.modeProfiles)
      .where(and(...conditions))
      .orderBy(asc(schema.modeProfiles.name), asc(schema.modeProfiles.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor =
      hasMore && pageRows.length > 0
        ? encodeProfileCursor(pageRows[pageRows.length - 1].name, pageRows[pageRows.length - 1].id)
        : null;

    return {
      profiles: pageRows.map((r) => toPublicProfile(r)),
      nextCursor,
    };
  }

  /**
   * Get a single profile by ID, company-scoped. Returns null if not found
   * or if the profile belongs to another company (non-enumerating 404).
   */
  async getProfile(input: GetProfileInput): Promise<PublicModeProfile | null> {
    const { companyId, profileId } = input;
    const schema = this.db.schema;
    const [row] = await this.db.drizzle
      .select()
      .from(schema.modeProfiles)
      .where(
        and(eq(schema.modeProfiles.id, profileId), eq(schema.modeProfiles.companyId, companyId)),
      )
      .limit(1);
    return row ? toPublicProfile(row) : null;
  }

  /**
   * Create a new custom profile. Validates slug uniqueness within the
   * company, stores the closed/bounded config, and creates an attributable
   * activity log entry. Version starts at 1.
   *
   * (VAL-MODEQ-124: versioned, authorized, attributable; VAL-MODEQ-152:
   * closed/bounded/inert payload; VAL-MODEQ-020: never weaken higher policy.)
   */
  async createProfile(input: CreateProfileInput): Promise<ProfileResult> {
    const { companyId, body, actorType, actorId, traceId } = input;
    const schema = this.db.schema;
    const now = new Date();
    const profileId = randomUUID();

    // Check slug uniqueness within the company.
    const [existing] = await this.db.drizzle
      .select({ id: schema.modeProfiles.id })
      .from(schema.modeProfiles)
      .where(
        and(eq(schema.modeProfiles.companyId, companyId), eq(schema.modeProfiles.slug, body.slug)),
      )
      .limit(1);
    if (existing) {
      throw new AppError(409, 'PROFILE_SLUG_CONFLICT', 'A profile with this slug already exists');
    }

    const [row] = await this.db.drizzle
      .insert(schema.modeProfiles)
      .values({
        id: profileId,
        companyId,
        slug: body.slug,
        name: body.name,
        description: body.description ?? null,
        enabled: body.enabled,
        config: body.config as Record<string, unknown>,
        version: 1,
        createdBy: actorId,
        updatedBy: actorId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    // Attributable activity log entry.
    await this.db.drizzle.insert(schema.activityLog).values({
      companyId,
      actorType: actorType === 'user' ? 'user' : actorType === 'agent' ? 'agent' : 'system',
      actorId: actorId,
      action: 'mission.profile.created',
      entityType: 'mission_mode_profile',
      entityId: profileId,
      description: `Created custom mode profile "${body.name}" (slug: ${body.slug})`,
      metadata: { slug: body.slug, version: 1, traceId: traceId ?? null },
      createdAt: now,
    });

    return { profile: toPublicProfile(row) };
  }

  /**
   * Update (PATCH) a profile. Requires If-Match version for optimistic
   * concurrency. Can update name, description, config, and enabled.
   * Version increments on every successful update. Stale version →
   * 412 PROFILE_VERSION_MISMATCH.
   *
   * (VAL-MODEQ-124: versioned, reject stale writes; VAL-MODEQ-020: never
   * weaken higher policy — config is validated at write time; VAL-MODEQ-153:
   * PATCH requires If-Match row version.)
   */
  async updateProfile(input: UpdateProfileInput): Promise<ProfileResult> {
    const { companyId, profileId, body, expectedVersion, actorType, actorId, traceId } = input;
    const schema = this.db.schema;
    const now = new Date();

    // Lock the row and check version. Company-scoped so a foreign profile
    // returns null → 404 (non-enumerating).
    const [existing] = await this.db.drizzle
      .select()
      .from(schema.modeProfiles)
      .where(
        and(eq(schema.modeProfiles.id, profileId), eq(schema.modeProfiles.companyId, companyId)),
      )
      .limit(1);

    if (!existing) {
      throw new AppError(404, 'PROFILE_NOT_FOUND', 'Profile not found');
    }

    if (existing.version !== expectedVersion) {
      throw new AppError(
        412,
        'PROFILE_VERSION_MISMATCH',
        `Profile version ${expectedVersion} does not match current version ${existing.version}`,
      );
    }

    // Build the update set from provided fields.
    const updates: Record<string, unknown> = {
      version: existing.version + 1,
      updatedBy: actorId,
      updatedAt: now,
    };
    if (body.name !== undefined) {
      updates.name = body.name;
    }
    if (body.description !== undefined) {
      updates.description = body.description;
    }
    if (body.config !== undefined) {
      updates.config = body.config as Record<string, unknown>;
    }
    if (body.enabled !== undefined) {
      updates.enabled = body.enabled;
    }

    const [row] = await this.db.drizzle
      .update(schema.modeProfiles)
      .set(updates)
      .where(
        and(
          eq(schema.modeProfiles.id, profileId),
          eq(schema.modeProfiles.companyId, companyId),
          eq(schema.modeProfiles.version, expectedVersion),
        ),
      )
      .returning();

    if (!row) {
      // Concurrent update won the race; re-read to check if it still exists.
      const [recheck] = await this.db.drizzle
        .select({ id: schema.modeProfiles.id, version: schema.modeProfiles.version })
        .from(schema.modeProfiles)
        .where(
          and(eq(schema.modeProfiles.id, profileId), eq(schema.modeProfiles.companyId, companyId)),
        )
        .limit(1);
      if (!recheck) {
        throw new AppError(404, 'PROFILE_NOT_FOUND', 'Profile not found');
      }
      throw new AppError(
        412,
        'PROFILE_VERSION_MISMATCH',
        `Profile version ${expectedVersion} does not match current version ${recheck.version}`,
      );
    }

    // Determine action for activity log.
    let action = 'mission.profile.updated';
    if (body.enabled === true && !existing.enabled) {
      action = 'mission.profile.enabled';
    } else if (body.enabled === false && existing.enabled) {
      action = 'mission.profile.disabled';
    }

    await this.db.drizzle.insert(schema.activityLog).values({
      companyId,
      actorType: actorType === 'user' ? 'user' : actorType === 'agent' ? 'agent' : 'system',
      actorId: actorId,
      action,
      entityType: 'mission_mode_profile',
      entityId: profileId,
      description: `Updated custom mode profile "${row.name}" (version ${row.version})`,
      metadata: { slug: row.slug, version: row.version, traceId: traceId ?? null },
      createdAt: now,
    });

    return { profile: toPublicProfile(row) };
  }

  /**
   * Resolve a custom profile for Mission start. Returns the profile row
   * (not the public representation) with the full config for policy
   * resolution. Throws if the profile is not found, is disabled, or
   * belongs to another company.
   *
   * (VAL-MODEQ-016: cross-company IDs rejected without revealing existence;
   *  VAL-MODEQ-017/018: disabled profiles cannot start.)
   */
  async resolveProfileForStart(
    companyId: string,
    profileId: string,
  ): Promise<{
    id: string;
    slug: string;
    name: string;
    config: Record<string, unknown>;
    version: number;
    enabled: boolean;
  }> {
    const schema = this.db.schema;
    const [row] = await this.db.drizzle
      .select({
        id: schema.modeProfiles.id,
        slug: schema.modeProfiles.slug,
        name: schema.modeProfiles.name,
        config: schema.modeProfiles.config,
        version: schema.modeProfiles.version,
        enabled: schema.modeProfiles.enabled,
        companyId: schema.modeProfiles.companyId,
      })
      .from(schema.modeProfiles)
      .where(eq(schema.modeProfiles.id, profileId))
      .limit(1);

    if (!row || row.companyId !== companyId) {
      // Non-enumerating 404: cross-company or nonexistent look the same.
      throw new AppError(404, 'PROFILE_NOT_FOUND', 'Profile not found');
    }

    if (!row.enabled) {
      throw new AppError(
        409,
        'PROFILE_DISABLED',
        'This custom mode profile has been disabled. Please refresh and select an available mode.',
      );
    }

    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      config: row.config ?? {},
      version: row.version,
      enabled: row.enabled,
    };
  }
}
