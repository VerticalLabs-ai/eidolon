import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { URL } from 'node:url';
import logger from '../utils/logger.js';
import { eventBus, type EidolonEvent } from './events.js';
import type { DbInstance } from '../types.js';
import type { CoEditClientMsg } from '@eidolon/shared';
import { authenticateRequest } from '../auth.js';
import { requireAccess } from '../services/permission-service.js';
import {
  initCoEditManager,
  joinSession,
  leaveSession,
  leaveSessionByWs,
  applyOperation,
  broadcastCursor,
  broadcastSelection,
  flushSession,
} from './coedit-session.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TrackedClient {
  ws: WebSocket;
  /** Identity established during the HTTP upgrade; never client supplied. */
  userId: string;
  orgRole: string;
  allowedCompanyIds: Set<string>;
  subscribedCompanies: Set<string>;
  isAlive: boolean;
  connectedAt: Date;
  /** Artifact IDs this client has joined a co-edit session for. */
  coeditArtifacts: Set<string>;
}

interface InboundMessage {
  type: 'subscribe' | 'unsubscribe' | 'ping';
  companyId?: string;
}

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

const HEARTBEAT_INTERVAL_MS = 30_000;
const clients = new Map<WebSocket, TrackedClient>();

let wss: WebSocketServer;
let wsDb: DbInstance | undefined;

export function setupWebSocketServer(server: HttpServer, options?: { db?: DbInstance }): WebSocketServer {
  // Initialize the co-edit session manager with the DB instance so WS
  // co-edit messages can load/save artifact content.
  wsDb = options?.db;
  if (options?.db) {
    initCoEditManager(options.db);
  }

  wss = new WebSocketServer({ noServer: true });

  // Upgrade only for /ws path
  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    const pathname = new URL(request.url ?? '/', `http://${request.headers.host}`).pathname;
    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }
    // Authenticate before completing the upgrade.  The identity is then bound
    // to the connection rather than accepted from co-edit messages.
    void authenticateRequest(request as unknown as Request).then((session) => {
      const localTrusted = process.env.AUTH_MODE === 'local_trusted';
      if (!session && !localTrusted) {
        socket.write('HTTP/1.1 401 Unauthorized\\r\\n\\r\\n');
        socket.destroy();
        return;
      }
      const userId = session?.user.id ?? 'dev-user-000';
      const orgRole = session?.session.activeOrganizationRole ?? 'owner';
      const companyId = session?.session.activeOrganizationId;
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, { userId, orgRole, allowedCompanyIds: companyId ? new Set([companyId]) : new Set<string>() });
      });
    }).catch(() => socket.destroy());
  });

  wss.on('connection', (ws: WebSocket, identity: { userId: string; orgRole: string; allowedCompanyIds: Set<string> }) => {
    const tracked: TrackedClient = {
      ws,
      ...identity,
      subscribedCompanies: new Set(),
      isAlive: true,
      connectedAt: new Date(),
      coeditArtifacts: new Set(),
    };
    clients.set(ws, tracked);

    logger.debug({ total: clients.size }, 'WebSocket client connected');

    ws.on('pong', () => {
      tracked.isAlive = true;
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        const type = msg.type as string;
        if (type && type.startsWith('coedit.')) {
          handleCoEditMessage(tracked, msg as unknown as CoEditClientMsg);
        } else {
          handleClientMessage(tracked, msg as unknown as InboundMessage);
        }
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      }
    });

    ws.on('close', () => {
      // Leave all co-edit sessions this client was part of
      for (const artifactId of tracked.coeditArtifacts) {
        void leaveSessionByWs(artifactId, ws);
      }
      clients.delete(ws);
      logger.debug({ total: clients.size }, 'WebSocket client disconnected');
    });

    ws.on('error', (err) => {
      logger.warn({ err }, 'WebSocket client error');
      clients.delete(ws);
    });

    // Acknowledge connection
    ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
  });

  // Heartbeat interval to detect stale connections
  const heartbeatTimer = setInterval(() => {
    for (const [ws, tracked] of clients) {
      if (!tracked.isAlive) {
        logger.debug('Terminating stale WebSocket connection');
        clients.delete(ws);
        ws.terminate();
        continue;
      }
      tracked.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  wss.on('close', () => {
    clearInterval(heartbeatTimer);
  });

  // Bridge EventBus -> WebSocket
  eventBus.onEvent((event: EidolonEvent) => {
    broadcast(event.companyId, event);
  });

  logger.info('WebSocket server ready on /ws');
  return wss;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleClientMessage(client: TrackedClient, msg: InboundMessage): void {
  switch (msg.type) {
    case 'subscribe':
      if (msg.companyId) {
        client.subscribedCompanies.add(msg.companyId);
        client.ws.send(
          JSON.stringify({ type: 'subscribed', companyId: msg.companyId }),
        );
        logger.debug({ companyId: msg.companyId }, 'Client subscribed to company');
      }
      break;

    case 'unsubscribe':
      if (msg.companyId) {
        client.subscribedCompanies.delete(msg.companyId);
        client.ws.send(
          JSON.stringify({ type: 'unsubscribed', companyId: msg.companyId }),
        );
      }
      break;

    case 'ping':
      client.ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
      break;

    default:
      client.ws.send(JSON.stringify({ type: 'error', message: `Unknown message type` }));
  }
}

// ---------------------------------------------------------------------------
// Co-edit message handler
// ---------------------------------------------------------------------------

async function authorizeCoEdit(client: TrackedClient, companyId: string, artifactId: string, level: 'view' | 'edit'): Promise<void> {
  if (process.env.AUTH_MODE !== 'local_trusted' && !client.allowedCompanyIds.has(companyId)) {
    throw new Error('Company access denied');
  }
  if (wsDb && process.env.AUTH_MODE !== 'local_trusted') {
    await requireAccess(wsDb, companyId, client.userId, client.orgRole, 'artifact', artifactId, level);
  }
}

function handleCoEditMessage(client: TrackedClient, msg: CoEditClientMsg): void {
  switch (msg.type) {
    case 'coedit.join': {
      void authorizeCoEdit(client, msg.companyId, msg.artifactId, 'edit').then(() => {
        client.coeditArtifacts.add(msg.artifactId);
        return joinSession(msg.artifactId, msg.companyId, client.userId, msg.name, client.ws);
      })
        .catch((err) => {
          client.ws.send(JSON.stringify({
            type: 'coedit.error',
            artifactId: msg.artifactId,
            message: err instanceof Error ? err.message : 'Join failed',
          }));
        });
      break;
    }
    case 'coedit.op': {
      try {
        if (!client.coeditArtifacts.has(msg.artifactId)) throw new Error('Not a co-edit participant');
        applyOperation(msg.artifactId, msg.op, client.userId);
      } catch (err) {
        client.ws.send(JSON.stringify({
          type: 'coedit.error',
          artifactId: msg.artifactId,
          message: err instanceof Error ? err.message : 'Op failed',
        }));
      }
      break;
    }
    case 'coedit.cursor': {
      broadcastCursor(
        msg.artifactId,
        client.userId,
        msg.name,
        msg.color ?? '',
        msg.position,
      );
      break;
    }
    case 'coedit.selection': {
      broadcastSelection(
        msg.artifactId,
        client.userId,
        msg.name,
        msg.color ?? '',
        msg.range,
      );
      break;
    }
    case 'coedit.save': {
      void (client.coeditArtifacts.has(msg.artifactId)
        ? flushSession(msg.artifactId, { userId: client.userId, editSource: 'user' }, msg.title)
        : Promise.reject(new Error('Not a co-edit participant')))
        .catch((err) => {
          client.ws.send(JSON.stringify({
            type: 'coedit.error',
            artifactId: msg.artifactId,
            message: err instanceof Error ? err.message : 'Save failed',
          }));
        });
      break;
    }
    case 'coedit.leave': {
      client.coeditArtifacts.delete(msg.artifactId);
      void leaveSession(msg.artifactId, client.userId);
      break;
    }
    default:
      client.ws.send(JSON.stringify({ type: 'error', message: 'Unknown coedit message type' }));
  }
}

// ---------------------------------------------------------------------------
// Broadcast
// ---------------------------------------------------------------------------

/**
 * Broadcast an event to all clients subscribed to the given company.
 */
export function broadcast(companyId: string, event: EidolonEvent): void {
  const payload = JSON.stringify(event);
  let sent = 0;

  for (const [, tracked] of clients) {
    if (
      tracked.subscribedCompanies.has(companyId) &&
      tracked.ws.readyState === WebSocket.OPEN
    ) {
      tracked.ws.send(payload);
      sent++;
    }
  }

  if (sent > 0) {
    logger.debug({ companyId, type: event.type, recipients: sent }, 'Broadcast event');
  }
}

/**
 * Get count of connected clients.
 */
export function getConnectedClientCount(): number {
  return clients.size;
}
