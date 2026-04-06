import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { URL } from 'node:url';
import logger from '../utils/logger.js';
import { eventBus, type EidolonEvent } from './events.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TrackedClient {
  ws: WebSocket;
  subscribedCompanies: Set<string>;
  isAlive: boolean;
  connectedAt: Date;
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

export function setupWebSocketServer(server: HttpServer): WebSocketServer {
  wss = new WebSocketServer({ noServer: true });

  // Upgrade only for /ws path
  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    const pathname = new URL(request.url ?? '/', `http://${request.headers.host}`).pathname;
    if (pathname === '/ws') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (ws: WebSocket) => {
    const tracked: TrackedClient = {
      ws,
      subscribedCompanies: new Set(),
      isAlive: true,
      connectedAt: new Date(),
    };
    clients.set(ws, tracked);

    logger.debug({ total: clients.size }, 'WebSocket client connected');

    ws.on('pong', () => {
      tracked.isAlive = true;
    });

    ws.on('message', (raw) => {
      try {
        const msg: InboundMessage = JSON.parse(raw.toString());
        handleClientMessage(tracked, msg);
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      }
    });

    ws.on('close', () => {
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
