import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { AppError } from '../middleware/error-handler.js';
import { MCPClientService } from '../services/mcp-client.js';
import eventBus from '../realtime/events.js';
import type { DbInstance } from '../types.js';
import { routeParams } from '../utils/route-params.js';

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const RegisterServerBody = z.object({
  name: z.string().min(1).max(255),
  transport: z.enum(['stdio', 'sse', 'streamable-http']).default('stdio'),
  command: z.string().max(1000).optional(),
  args: z.array(z.string().max(500)).default([]),
  env: z.record(z.string().max(5000)).default({}),
  url: z.string().url().max(2000).optional(),
});

const CallToolBody = z.object({
  serverId: z.string().uuid(),
  args: z.record(z.unknown()).default({}),
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function mcpRouter(db: DbInstance): Router {
  const router = Router({ mergeParams: true });
  const mcpService = new MCPClientService(db);

  // GET /api/companies/:companyId/mcp/servers -- list all MCP servers
  router.get('/servers', async (req, res) => {
    const { companyId } = routeParams(req);
    const servers = await mcpService.listServers(companyId);
    res.json({ data: servers });
  });

  // POST /api/companies/:companyId/mcp/servers -- register a new MCP server
  router.post('/servers', validate(RegisterServerBody), async (req, res) => {
    const body = req.body as z.infer<typeof RegisterServerBody>;
    const { companyId } = routeParams(req);

    const server = await mcpService.registerServer(companyId, {
      name: body.name,
      transport: body.transport,
      command: body.command,
      args: body.args,
      env: body.env,
      url: body.url,
    });

    eventBus.emitEvent({
      type: 'activity.logged' as any,
      companyId,
      payload: {
        action: 'mcp.server.registered',
        entityType: 'mcp_server',
        entityId: server.id,
        description: `MCP server "${body.name}" registered (${body.transport})`,
      },
      timestamp: new Date().toISOString(),
    });

    res.status(201).json({ data: server });
  });

  // DELETE /api/companies/:companyId/mcp/servers/:id -- remove a server
  router.delete('/servers/:id', async (req, res) => {
    const { companyId, id } = routeParams(req);

    const server = await mcpService.getServer(id);
    if (!server || server.companyId !== companyId) {
      throw new AppError(404, 'MCP_SERVER_NOT_FOUND', `MCP server ${id} not found`);
    }

    await mcpService.deleteServer(id, companyId);

    eventBus.emitEvent({
      type: 'activity.logged' as any,
      companyId,
      payload: {
        action: 'mcp.server.deleted',
        entityType: 'mcp_server',
        entityId: id,
        description: `MCP server "${server.name}" removed`,
      },
      timestamp: new Date().toISOString(),
    });

    res.status(204).end();
  });

  // GET /api/companies/:companyId/mcp/tools -- list all available tools across servers
  router.get('/tools', async (req, res) => {
    const { companyId } = routeParams(req);
    const tools = await mcpService.getAvailableTools(companyId);
    res.json({ data: tools });
  });

  // POST /api/companies/:companyId/mcp/tools/:toolName/call -- call a specific tool
  router.post('/tools/:toolName/call', validate(CallToolBody), async (req, res) => {
    const body = req.body as z.infer<typeof CallToolBody>;
    const { companyId, toolName } = routeParams(req);

    // Verify the server belongs to this company
    const server = await mcpService.getServer(body.serverId);
    if (!server || server.companyId !== companyId) {
      throw new AppError(404, 'MCP_SERVER_NOT_FOUND', `MCP server ${body.serverId} not found`);
    }

    const result = await mcpService.callTool(body.serverId, toolName, body.args);

    res.json({ data: result });
  });

  return router;
}
