/**
 * Log Stream Service (port 3004)
 *
 * WebSocket service that receives log/progress/event pushes from scraper-service
 * via HTTP and broadcasts them to connected clients via Socket.IO rooms.
 *
 * Endpoints:
 *   POST /push-log       → emit 'task-log' to task room + all-tasks room
 *   POST /push-progress  → emit 'task-progress' to task room + all-tasks room
 *   POST /push-event     → emit 'scrape-event' to all-tasks room
 *   GET  /stats          → connected clients, rooms, events/sec
 *
 * Client events:
 *   join-task  { taskId }  → join a task-specific room
 *   leave-task { taskId }  → leave a task-specific room
 *   join-all              → join the all-tasks broadcast room
 *   leave-all             → leave the all-tasks broadcast room
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { Server } from 'socket.io';

const PORT = 3004;

// ==================== HTTP + Socket.IO Server ====================
// Socket.IO with path: '/' intercepts all HTTP requests.
// We create the server, attach Socket.IO, then re-order listeners
// so our HTTP handler runs first and handles API routes before
// Socket.IO tries to process them.

const httpServer = createServer();

const io = new Server(httpServer, {
  path: '/',
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Re-order request listeners: our HTTP handler first, then Socket.IO
const ioRequestListeners = httpServer.listeners('request');
httpServer.removeAllListeners('request');

httpServer.on('request', (req: IncomingMessage, res: ServerResponse) => {
  // Try to handle as API route — if matched, we respond and stop
  if (handleHttpRoute(req, res)) return;
  // Not an API route — pass through to Socket.IO listeners
  for (const listener of ioRequestListeners) {
    (listener as (req: IncomingMessage, res: ServerResponse) => void)(req, res);
    if (res.writableEnded) break;
  }
});

// ==================== Rate Limiting ====================

const MAX_EVENTS_PER_SEC = 1000;
const eventTimestamps: number[] = [];

function checkRateLimit(): boolean {
  const now = Date.now();
  const oneSecAgo = now - 1000;
  while (eventTimestamps.length > 0 && eventTimestamps[0] < oneSecAgo) {
    eventTimestamps.shift();
  }
  if (eventTimestamps.length >= MAX_EVENTS_PER_SEC) return false;
  eventTimestamps.push(now);
  return true;
}

// ==================== Event Buffer (per task) ====================

const BUFFER_PER_TASK = 50;
const taskEventBuffers = new Map<string, Array<{ id: string; event: string; data: unknown }>>();

function addToTaskBuffer(taskId: string, event: string, data: unknown): void {
  let buffer = taskEventBuffers.get(taskId);
  if (!buffer) {
    buffer = [];
    taskEventBuffers.set(taskId, buffer);
  }
  buffer.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    event,
    data,
  });
  if (buffer.length > BUFFER_PER_TASK) {
    buffer.splice(0, buffer.length - BUFFER_PER_TASK);
  }
}

function getTaskBuffer(taskId: string): Array<{ id: string; event: string; data: unknown }> {
  return taskEventBuffers.get(taskId)?.slice() || [];
}

// Periodic cleanup of stale buffers (tasks inactive for 10 minutes)
const STALE_BUFFER_MS = 10 * 60 * 1000;
const lastTaskActivity = new Map<string, number>();

function recordTaskActivity(taskId: string): void {
  lastTaskActivity.set(taskId, Date.now());
}

setInterval(() => {
  const now = Date.now();
  for (const [taskId, lastActive] of lastTaskActivity) {
    if (now - lastActive > STALE_BUFFER_MS) {
      taskEventBuffers.delete(taskId);
      lastTaskActivity.delete(taskId);
    }
  }
}, 60 * 1000);

// ==================== Events Per Second Tracking ====================

const epsHistory: number[] = [];
const EPS_WINDOW_MS = 60_000;

function recordEventForEps(): void {
  epsHistory.push(Date.now());
}

function getEventsPerSecond(): number {
  const now = Date.now();
  const cutoff = now - EPS_WINDOW_MS;
  while (epsHistory.length > 0 && epsHistory[0] < cutoff) epsHistory.shift();
  if (epsHistory.length === 0) return 0;
  const oldest = epsHistory[0];
  const elapsed = (now - oldest) / 1000;
  return elapsed > 0 ? Math.round(epsHistory.length / elapsed) : 0;
}

// ==================== Socket.IO Client Handling ====================

io.on('connection', (socket) => {
  console.log(`[log-stream] Client connected: ${socket.id}`);

  socket.on('join-task', (data: { taskId: string }) => {
    if (!data?.taskId) return;
    const { taskId } = data;
    socket.join(taskId);
    console.log(`[log-stream] ${socket.id} joined task: ${taskId}`);

    // Send buffered events for late-joining clients
    const buffered = getTaskBuffer(taskId);
    if (buffered.length > 0) {
      socket.emit('task-history', { taskId, events: buffered });
    }
  });

  socket.on('leave-task', (data: { taskId: string }) => {
    if (!data?.taskId) return;
    socket.leave(data.taskId);
    console.log(`[log-stream] ${socket.id} left task: ${data.taskId}`);
  });

  socket.on('join-all', () => {
    socket.join('all-tasks');
    console.log(`[log-stream] ${socket.id} joined all-tasks`);
  });

  socket.on('leave-all', () => {
    socket.leave('all-tasks');
    console.log(`[log-stream] ${socket.id} left all-tasks`);
  });

  socket.on('disconnect', (reason) => {
    console.log(`[log-stream] Client disconnected: ${socket.id} (${reason})`);
  });

  socket.on('error', (err) => {
    console.error(`[log-stream] Socket error (${socket.id}):`, err);
  });
});

// ==================== HTTP Route Handler ====================

/**
 * Handle HTTP API routes. Returns true if the request was handled (response sent).
 * Returns false if the request should be passed through to Socket.IO.
 */
function handleHttpRoute(req: IncomingMessage, res: ServerResponse): boolean {
  let url: URL;
  try {
    url = new URL(req.url || '/', `http://localhost:${PORT}`);
  } catch {
    return false;
  }

  if (req.method === 'POST' && url.pathname === '/push-log') {
    handlePushLog(req, res);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/push-progress') {
    handlePushProgress(req, res);
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/push-event') {
    handlePushEvent(req, res);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/stats') {
    handleGetStats(res);
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'log-stream-service', port: PORT }));
    return true;
  }

  // Not an API route — let Socket.IO handle it
  return false;
}

// ==================== HTTP Endpoint Handlers ====================

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > 64 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

async function handlePushLog(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!checkRateLimit()) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Rate limited' }));
    return;
  }

  try {
    const body = await readBody(req);
    const { taskId, level, message, url, detail, timestamp } = JSON.parse(body);

    if (!taskId || !level || !message) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing taskId, level, or message' }));
      return;
    }

    const logEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      taskId,
      level,
      message: String(message).slice(0, 500),
      url: url ? String(url).slice(0, 2048) : undefined,
      detail: detail ? String(detail).slice(0, 1000) : undefined,
      timestamp: timestamp || new Date().toISOString(),
    };

    addToTaskBuffer(taskId, 'task-log', logEntry);
    recordTaskActivity(taskId);
    recordEventForEps();

    io.to(taskId).emit('task-log', logEntry);
    io.to('all-tasks').emit('task-log', logEntry);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
  }
}

async function handlePushProgress(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!checkRateLimit()) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Rate limited' }));
    return;
  }

  try {
    const body = await readBody(req);
    const { taskId, updates } = JSON.parse(body);

    if (!taskId || !updates) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing taskId or updates' }));
      return;
    }

    const progressEvent = { taskId, updates, timestamp: new Date().toISOString() };

    addToTaskBuffer(taskId, 'task-progress', progressEvent);
    recordTaskActivity(taskId);
    recordEventForEps();

    io.to(taskId).emit('task-progress', progressEvent);
    io.to('all-tasks').emit('task-progress', progressEvent);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
  }
}

async function handlePushEvent(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!checkRateLimit()) {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Rate limited' }));
    return;
  }

  try {
    const body = await readBody(req);
    const { type, data } = JSON.parse(body);

    if (!type) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing type' }));
      return;
    }

    const event = { type, data, timestamp: new Date().toISOString() };

    recordEventForEps();
    io.to('all-tasks').emit('scrape-event', event);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
  }
}

function handleGetStats(res: ServerResponse): void {
  const eps = getEventsPerSecond();
  const rooms = new Map<string, number>();

  for (const [roomName, sockets] of io.sockets.adapter.rooms) {
    if (!io.sockets.sockets.has(roomName as any)) {
      rooms.set(roomName, sockets.size);
    }
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    connectedClients: io.sockets.sockets.size,
    rooms: Object.fromEntries(rooms),
    eventsPerSecond: eps,
  }));
}

// ==================== Start Server ====================

httpServer.listen(PORT, () => {
  console.log(`[log-stream] Service running on port ${PORT}`);
  console.log(`[log-stream] Endpoints: POST /push-log, POST /push-progress, POST /push-event, GET /stats`);
});

// ==================== Graceful Shutdown ====================

function gracefulShutdown(signal: string): void {
  console.log(`[log-stream] Received ${signal}, shutting down...`);
  io.close();
  httpServer.close(() => {
    console.log('[log-stream] Server closed');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
