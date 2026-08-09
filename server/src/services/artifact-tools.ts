// ---------------------------------------------------------------------------
// Artifact Tool Service -- Built-in artifact tools for the agentic loop
// ---------------------------------------------------------------------------
//
// Provides artifact.create, artifact.update, artifact.get, artifact.list
// as built-in tools the agentic loop can invoke directly (no MCP transport
// needed). These tools enforce company scoping and schema validation, and
// track produced artifacts for thread-item linkage.
// ---------------------------------------------------------------------------

import { ArtifactTypeSchema } from '@eidolon/shared';
import {
  createArtifact,
  getArtifact,
  listArtifacts,
  updateArtifact,
} from './artifact-service.js';
import { resolveAccess, requireAccess, filterAccessibleArtifacts, type AccessLevel, type ResourceKind } from './permission-service.js';
import { AppError } from '../middleware/error-handler.js';
import { agentBelongsToCompany } from '../utils/agent-validation.js';
import type { DbInstance } from '../types.js';
import type { z } from 'zod';

type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export interface ProducedArtifact {
  artifactId: string;
  artifactType: string;
  action: 'created' | 'updated';
  version: number;
}

export interface ArtifactToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
  data?: Record<string, unknown>;
}

// Tool definitions for the system prompt
export const ARTIFACT_TOOL_DEFINITIONS = [
  {
    name: 'artifact.create',
    description:
      'Create a new typed artifact (document, sheet, board, etc.) as an outcome of the current task. ' +
      'The artifact will be linked back to the originating thread item. ' +
      'Content must match the type schema: document={format:"markdown",body:"<string>"}, ' +
      'sheet={columns:[{id,key}],rows:[{id,cells:{key:{value}}}]}, ' +
      'board={columns:[{id,title}],cards:[{id,columnId,title,order,payload?}]} where every ' +
      'card.columnId must equal one of the column ids, column/card ids must be unique, and ' +
      'order is a number ordering the cards within their column, or ' +
      'slide_deck={slides:[{id,layout,blocks:[{type,content}]}]} where slide ids must be ' +
      'unique, layout is a non-empty string, and each block has a non-empty type and a ' +
      'content object (e.g. {type:"text",content:{text:"hello"}}).',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['document', 'sheet', 'board', 'slide_deck', 'timeline', 'gallery', 'dashboard', 'app', 'code'],
          description: 'The artifact type',
        },
        title: { type: 'string', description: 'Artifact title (1-500 chars)' },
        content: { type: 'object', description: 'Type-specific content payload' },
        projectId: { type: 'string', description: 'Project ID to scope the artifact to (optional)' },
      },
      required: ['type', 'title', 'content'],
    },
  },
  {
    name: 'artifact.update',
    description:
      'Update an existing artifact\'s content or title. Increments version and records an agent revision. ' +
      'You must provide the current version (for optimistic concurrency). Use artifact.get first to ' +
      'retrieve the current version if needed.',
    inputSchema: {
      type: 'object',
      properties: {
        artifactId: { type: 'string', description: 'The artifact ID to update' },
        version: { type: 'number', description: 'Current version (for optimistic concurrency check)' },
        content: { type: 'object', description: 'New content payload (type-specific)' },
        title: { type: 'string', description: 'New title (optional)' },
        message: { type: 'string', description: 'Optional edit summary' },
      },
      required: ['artifactId', 'version'],
    },
  },
  {
    name: 'artifact.get',
    description:
      'Retrieve a single artifact by ID, including its current content, version, and metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        artifactId: { type: 'string', description: 'The artifact ID' },
      },
      required: ['artifactId'],
    },
  },
  {
    name: 'artifact.list',
    description:
      'List artifacts in the company, optionally filtered by project and/or type.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Filter by project ID (optional)' },
        type: {
          type: 'string',
          enum: ['document', 'sheet', 'board', 'slide_deck', 'timeline', 'gallery', 'dashboard', 'app', 'code'],
          description: 'Filter by artifact type (optional)',
        },
      },
    },
  },
];

export class ArtifactToolService {
  private producedArtifacts: ProducedArtifact[] = [];

  constructor(private db: DbInstance) {}

  getProducedArtifacts(): ProducedArtifact[] {
    return [...this.producedArtifacts];
  }

  resetTracking(): void {
    this.producedArtifacts = [];
  }

  // -------------------------------------------------------------------------
  // Check if a tool name is a built-in artifact tool
  // -------------------------------------------------------------------------

  static isArtifactTool(toolName: string): boolean {
    return toolName.startsWith('artifact.');
  }

  // -------------------------------------------------------------------------
  // Get tool definitions for the system prompt
  // -------------------------------------------------------------------------

  static getToolDefinitions() {
    return ARTIFACT_TOOL_DEFINITIONS;
  }

  // -------------------------------------------------------------------------
  // Execute a built-in artifact tool
  // -------------------------------------------------------------------------

  async executeTool(
    toolName: string,
    args: Record<string, unknown>,
    context: { companyId: string; agentId: string; projectId?: string | null },
  ): Promise<ArtifactToolResult> {
    // Agent editor context is only trusted when the agent actually belongs to
    // the company scope. This guards against a forged/out-of-company agent id
    // producing agent-authored artifacts; the loop constructs this context
    // server-side, but the ownership check is enforced here regardless.
    if (!(await agentBelongsToCompany(this.db, context.companyId, context.agentId))) {
      return {
        content: [{ type: 'text', text: 'Error (403): Agent does not belong to this company' }],
        isError: true,
      };
    }

    const editor = {
      agentId: context.agentId,
      editSource: 'agent' as const,
    };

    try {
      switch (toolName) {
        case 'artifact.create':
          return await this.handleCreate(args, context, editor);
        case 'artifact.update':
          return await this.handleUpdate(args, context, editor);
        case 'artifact.get':
          return await this.handleGet(args, context);
        case 'artifact.list':
          return await this.handleList(args, context);
        default:
          return {
            content: [{ type: 'text', text: `Error: Unknown artifact tool "${toolName}"` }],
            isError: true,
          };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof AppError ? err.status : 500;
      return {
        content: [{ type: 'text', text: `Error (${status}): ${message}` }],
        isError: true,
      };
    }
  }

  // -- artifact.create -----------------------------------------------------

  private async handleCreate(
    args: Record<string, unknown>,
    context: { companyId: string; agentId: string; projectId?: string | null },
    editor: { agentId: string; editSource: 'agent' },
  ): Promise<ArtifactToolResult> {
    const type = ArtifactTypeSchema.parse(args.type);
    const title = typeof args.title === 'string' ? args.title.trim() : '';
    if (!title) {
      return {
        content: [{ type: 'text', text: 'Error (400): Title is required' }],
        isError: true,
      };
    }
    const content = args.content ?? {};
    const projectId = (args.projectId as string | undefined) ?? context.projectId ?? null;

    // RBAC (VAL-TEAM-023): agents honor per-resource permissions. An agent
    // is treated as a member-level actor. If the target project is restricted
    // (has permission grants), the agent needs edit access. Unrestricted
    // projects allow member-level creation.
    if (projectId) {
      try {
        await requireAccess(
          this.db, context.companyId, context.agentId, 'member',
          'project', projectId, 'edit',
        );
      } catch (err) {
        const status = err instanceof AppError ? err.status : 500;
        const message = err instanceof AppError ? err.message : String(err);
        return {
          content: [{ type: 'text', text: `Error (${status}): ${message}` }],
          isError: true,
        };
      }
    }

    const artifact = await createArtifact(
      this.db,
      context.companyId,
      { type, title, content, projectId },
      editor,
    );

    this.producedArtifacts.push({
      artifactId: artifact.id,
      artifactType: artifact.type,
      action: 'created',
      version: artifact.version,
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          artifactId: artifact.id,
          type: artifact.type,
          title: artifact.title,
          version: artifact.version,
          projectId: artifact.projectId,
        }),
      }],
      data: {
        artifactId: artifact.id,
        type: artifact.type,
        title: artifact.title,
        version: artifact.version,
      },
    };
  }

  // -- artifact.update -----------------------------------------------------

  private async handleUpdate(
    args: Record<string, unknown>,
    context: { companyId: string; agentId: string; projectId?: string | null },
    editor: { agentId: string; editSource: 'agent' },
  ): Promise<ArtifactToolResult> {
    const artifactId = args.artifactId as string;
    if (!artifactId) {
      return {
        content: [{ type: 'text', text: 'Error (400): artifactId is required' }],
        isError: true,
      };
    }
    const version = args.version as number;
    if (typeof version !== 'number') {
      return {
        content: [{ type: 'text', text: 'Error (400): version is required' }],
        isError: true,
      };
    }

    const updateInput: Record<string, unknown> = { version };
    if (args.content !== undefined) updateInput.content = args.content;
    if (args.title !== undefined) updateInput.title = args.title;
    if (args.message !== undefined) updateInput.message = args.message;

    // RBAC (VAL-TEAM-023): agents honor per-resource permissions. Require
    // edit access on the artifact (agent treated as member-level).
    try {
      await requireAccess(
        this.db, context.companyId, context.agentId, 'member',
        'artifact', artifactId, 'edit',
      );
    } catch (err) {
      const status = err instanceof AppError ? err.status : 500;
      const message = err instanceof AppError ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Error (${status}): ${message}` }],
        isError: true,
      };
    }

    const updated = await updateArtifact(
      this.db,
      context.companyId,
      artifactId,
      updateInput as any,
      editor,
    );

    this.producedArtifacts.push({
      artifactId: updated.id,
      artifactType: updated.type,
      action: 'updated',
      version: updated.version,
    });

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          artifactId: updated.id,
          type: updated.type,
          title: updated.title,
          version: updated.version,
        }),
      }],
      data: {
        artifactId: updated.id,
        type: updated.type,
        title: updated.title,
        version: updated.version,
      },
    };
  }

  // -- artifact.get --------------------------------------------------------

  private async handleGet(
    args: Record<string, unknown>,
    context: { companyId: string; agentId: string; projectId?: string | null },
  ): Promise<ArtifactToolResult> {
    const artifactId = args.artifactId as string;
    if (!artifactId) {
      return {
        content: [{ type: 'text', text: 'Error (400): artifactId is required' }],
        isError: true,
      };
    }

    // RBAC (VAL-TEAM-023): agents honor per-resource permissions. Require
    // view access on the artifact (agent treated as member-level).
    try {
      await requireAccess(
        this.db, context.companyId, context.agentId, 'member',
        'artifact', artifactId, 'view',
      );
    } catch (err) {
      const status = err instanceof AppError ? err.status : 500;
      const message = err instanceof AppError ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Error (${status}): ${message}` }],
        isError: true,
      };
    }

    const artifact = await getArtifact(this.db, context.companyId, artifactId);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          artifactId: artifact.id,
          type: artifact.type,
          title: artifact.title,
          content: artifact.content,
          version: artifact.version,
          status: artifact.status,
          projectId: artifact.projectId,
        }),
      }],
      data: {
        artifactId: artifact.id,
        type: artifact.type,
        title: artifact.title,
        content: artifact.content,
        version: artifact.version,
      },
    };
  }

  // -- artifact.list -------------------------------------------------------

  private async handleList(
    args: Record<string, unknown>,
    context: { companyId: string; agentId: string; projectId?: string | null },
  ): Promise<ArtifactToolResult> {
    const projectId = (args.projectId as string | undefined) ?? context.projectId ?? undefined;
    const type = args.type as ArtifactType | undefined;

    const { rows, total } = await listArtifacts(this.db, context.companyId, {
      projectId,
      type,
      status: 'active',
      limit: 50,
      offset: 0,
    });

    // RBAC (VAL-TEAM-006/017): filter out restricted artifacts the agent
    // cannot view. Agents are treated as member-level actors, so restricted
    // artifacts without a grant for this agent are hidden from the list.
    const accessibleIds = await filterAccessibleArtifacts(
      this.db, context.companyId, context.agentId, 'member',
      rows.map((r) => r.id), 'view',
    );
    const accessibleSet = new Set(accessibleIds);
    const visibleRows = rows.filter((r) => accessibleSet.has(r.id));

    const summary = visibleRows.map((r) => ({
      artifactId: r.id,
      type: r.type,
      title: r.title,
      version: r.version,
    }));

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ artifacts: summary, total: summary.length }),
      }],
      data: { artifacts: summary, total: summary.length },
    };
  }
}
