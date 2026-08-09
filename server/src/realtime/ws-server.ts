import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { URL } from 'node:url';
import logger from '../utils/logger.js';
import { eventBus, type EidolonEvent } from './events.js';
import type { DbInstance } from '../types.js';
import type { CoEditClientMsg } from '@eidolon/shared';
import { authenticateRequest } from '../auth.js';
import { requireAccess } from '../services/permission-service.js';
import type { AuthSession } from '../auth.js';
import { AppError } from '../middleware/error-handler.js';

interface WsIdentity {
  userId: string;
  orgRole: string;
  companyId: string | null;
}

function authFromRequest(request: IncomingMessage): Promise<AuthSession | null> {
  if (process.env.AUTH_MODE === 'local_trusted') {
    return Promise.resolve({
      user: { id: 'dev-user-000', name: 'Dev User', email: 'dev@localhost', role: 'admin' },
      session: { id: 'dev-session-000', userId: 'dev-user-000', activeOrganizationId: null },
    });
  }
  return authenticateRequest({ method: 'GET', url: request.url ?? '/ws', headers: request.headers });
}

function rejectUpgrade(socket: import('node:net').Socket, status: number, message: string): void {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

function appErrorMessage(err: unknown): string {
  return err instanceof AppError ? err.message : 'Not authorized';
}

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
  subscribedCompanies: Set<string>;
  isAlive: boolean;
  connectedAt: Date;
  /** Artifact IDs this client has joined a co-edit session for. */
  coeditArtifacts: Set<string>;
  identity: WsIdentity;
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
let optionsDb: DbInstance | null = null;

export function setupWebSocketServer(server: HttpServer, options?: { db?: DbInstance }): WebSocketServer {
  // Initialize the co-edit session manager with the DB instance so WS
  // co-edit messages can load/save artifact content.
  if (options?.db) {
    optionsDb = options.db;
    initCoEditManager(options.db);
  }

  wss = new WebSocketServer({ noServer: true });

  // Upgrade only for /ws path
  server.on('upgrade', async (request: IncomingMessage, socket, head) => {
    const pathname = new URL(request.url ?? '/', `http://${request.headers.host}`).pathname;
    if (pathname === '/ws') {
      const auth = await authFromRequest(request).catch(() => null);
      if (!auth) return rejectUpgrade(socket, 401, 'Unauthorized');
      const identity: WsIdentity = {
        userId: auth.user.id,
        orgRole: auth.user.role === 'admin' ? 'owner' : (auth.session.activeOrganizationRole ?? 'member'),
        companyId: auth.session.activeOrganizationId ?? null,
      };
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request, identity);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket, _request: IncomingMessage, identity: WsIdentity) => {
    const tracked: TrackedClient = {
      ws,
      subscribedCompanies: new Set(),
      isAlive: true,
      connectedAt: new Date(),
      coeditArtifacts: new Set(),
      identity,
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

function handleCoEditMessage(client: TrackedClient, msg: CoEditClientMsg): void {
  const userId = client.identity.userId;
  const companyId = client.identity.companyId;
  if (!companyId || !optionsDb || (msg.type !== 'coedit.join' && !client.coeditArtifacts.has(msg.artifactId))) {
    client.ws.send(JSON.stringify({ type: 'coedit.error', artifactId: msg.artifactId, message: 'Not authorized' }));
    return;
  }
  switch (msg.type) {
    case 'coedit.join': {
      void requireAccess(optionsDb!, companyId, userId, client.identity.orgRole, 'artifact', msg.artifactId, 'edit')
        .then(() => {
          client.coeditArtifacts.add(msg.artifactId);
          return joinSession(msg.artifactId, companyId, userId, msg.name, client.ws);
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
        applyOperation(msg.artifactId, msg.op, userId);
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
        userId,
        msg.name,
        msg.color ?? '',
        msg.position,
      );
      break;
    }
    case 'coedit.selection': {
      broadcastSelection(
        msg.artifactId,
        userId,
        msg.name,
        msg.color ?? '',
        msg.range,
      );
      break;
    }
    case 'coedit.save': {
      void flushSession(msg.artifactId, { userId, editSource: 'user' }, msg.title)
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
      void leaveSession(msg.artifactId, userId);
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
