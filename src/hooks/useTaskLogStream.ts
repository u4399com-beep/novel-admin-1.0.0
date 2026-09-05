'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';

// ==================== Types ====================

export interface LogEntry {
  id: string;
  taskId: string;
  level: string;
  message: string;
  url?: string;
  detail?: string;
  timestamp: string;
}

export interface ProgressUpdate {
  taskId: string;
  updates: Record<string, unknown>;
  timestamp: string;
}

export interface ScrapeEvent {
  type: string;
  data: unknown;
  timestamp: string;
}

export interface TaskLogStreamResult {
  logs: LogEntry[];
  progress: ProgressUpdate | null;
  connected: boolean;
  reconnecting: boolean;
}

// ==================== Singleton Manager ====================

/**
 * Singleton manager to ensure only one Socket.IO connection per taskId.
 * Multiple hook instances sharing the same taskId will share state.
 */

type Listener = () => void;

interface TaskStreamState {
  logs: LogEntry[];
  progress: ProgressUpdate | null;
  connected: boolean;
  reconnecting: boolean;
  listeners: Set<Listener>;
}

const MAX_LOGS = 500;

// Global state: one entry per active taskId
const taskStreams = new Map<string, TaskStreamState>();

// Shared socket connection (one per page, reused across taskIds)
let sharedSocket: Socket | null = null;
let socketRefCount = 0;
let reconnectAttempt = 0;
const MAX_RECONNECT_DELAY = 30000;
const BASE_RECONNECT_DELAY = 1000;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function getExponentialBackoff(): number {
  const delay = BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempt);
  const capped = Math.min(delay, MAX_RECONNECT_DELAY);
  // Add jitter ±20%
  const jitter = capped * 0.2 * (Math.random() * 2 - 1);
  return Math.max(100, capped + jitter);
}

function getOrCreateSocket(): Socket {
  if (sharedSocket?.connected) {
    return sharedSocket;
  }

  if (sharedSocket) {
    // Socket exists but disconnected — it will auto-reconnect
    return sharedSocket;
  }

  sharedSocket = io('/?XTransformPort=3004', {
    transports: ['websocket', 'polling'],
    reconnection: false, // We handle reconnection manually
    timeout: 10000,
  });

  sharedSocket.on('connect', () => {
    reconnectAttempt = 0;
    // Re-join all active task rooms
    for (const [taskId, state] of taskStreams) {
      state.connected = true;
      state.reconnecting = false;
      sharedSocket!.emit('join-task', { taskId });
      notifyListeners(taskId);
    }
  });

  sharedSocket.on('disconnect', (reason) => {
    for (const [, state] of taskStreams) {
      state.connected = false;
      if (reason !== 'io client disconnect') {
        state.reconnecting = true;
      }
      notifyAllListeners();
    }

    // Manual reconnect with exponential backoff
    if (reason !== 'io client disconnect') {
      scheduleReconnect();
    }
  });

  sharedSocket.on('connect_error', () => {
    for (const [, state] of taskStreams) {
      state.connected = false;
      state.reconnecting = true;
    }
    notifyAllListeners();
    scheduleReconnect();
  });

  // Listen for task-log events
  sharedSocket.on('task-log', (entry: LogEntry) => {
    const state = taskStreams.get(entry.taskId);
    if (!state) return;

    state.logs.push(entry);
    // FIFO: keep only last MAX_LOGS
    if (state.logs.length > MAX_LOGS) {
      state.logs.splice(0, state.logs.length - MAX_LOGS);
    }
    notifyListeners(entry.taskId);
  });

  // Listen for task-progress events
  sharedSocket.on('task-progress', (update: ProgressUpdate) => {
    const state = taskStreams.get(update.taskId);
    if (!state) return;

    state.progress = update;
    notifyListeners(update.taskId);
  });

  // Listen for task-history (buffered events on join)
  sharedSocket.on('task-history', (data: { taskId: string; events: Array<{ id: string; event: string; data: unknown }> }) => {
    const state = taskStreams.get(data.taskId);
    if (!state) return;

    for (const evt of data.events) {
      if (evt.event === 'task-log') {
        const logData = evt.data as LogEntry;
        // Avoid duplicates by checking id
        if (!state.logs.some(l => l.id === logData.id)) {
          state.logs.push(logData);
        }
      } else if (evt.event === 'task-progress') {
        const progData = evt.data as ProgressUpdate;
        state.progress = progData;
      }
    }

    // Trim logs
    if (state.logs.length > MAX_LOGS) {
      state.logs.splice(0, state.logs.length - MAX_LOGS);
    }

    notifyListeners(data.taskId);
  });

  return sharedSocket;
}

function scheduleReconnect(): void {
  if (reconnectTimer) return; // Already scheduled
  const delay = getExponentialBackoff();
  reconnectAttempt++;
  console.debug(`[useTaskLogStream] Reconnecting in ${Math.round(delay)}ms (attempt ${reconnectAttempt})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (sharedSocket && !sharedSocket.connected) {
      sharedSocket.connect();
    }
  }, delay);
}

function notifyListeners(taskId: string): void {
  const state = taskStreams.get(taskId);
  if (!state) return;
  for (const listener of state.listeners) {
    try { listener(); } catch { /* ignore */ }
  }
}

function notifyAllListeners(): void {
  for (const taskId of taskStreams.keys()) {
    notifyListeners(taskId);
  }
}

function ensureTaskState(taskId: string): TaskStreamState {
  let state = taskStreams.get(taskId);
  if (!state) {
    state = {
      logs: [],
      progress: null,
      connected: false,
      reconnecting: false,
      listeners: new Set(),
    };
    taskStreams.set(taskId, state);
  }
  return state;
}

// ==================== Hook ====================

/**
 * React hook for real-time task log streaming via WebSocket.
 *
 * - Connects to log-stream-service on port 3004 via Socket.IO.
 * - Joins a room for the given taskId to receive task-specific logs.
 * - Returns logs, progress, connection status.
 * - Singleton per taskId (multiple hook instances share state).
 * - Auto-reconnects with exponential backoff.
 * - Max 500 logs in memory (FIFO).
 */
export function useTaskLogStream(taskId: string | null): TaskLogStreamResult {
  const [state, setState] = useState<TaskLogStreamResult>({
    logs: [],
    progress: null,
    connected: false,
    reconnecting: false,
  });

  const prevTaskIdRef = useRef<string | null>(null);
  const listenerRef = useRef<Listener | null>(null);

  // Stable callback for state updates
  const updateState = useCallback((taskId: string) => {
    const s = taskStreams.get(taskId);
    if (!s) return;
    setState({
      logs: [...s.logs],
      progress: s.progress ? { ...s.progress } : null,
      connected: s.connected,
      reconnecting: s.reconnecting,
    });
  }, []);

  useEffect(() => {
    if (!taskId) return;

    const socket = getOrCreateSocket();
    socketRefCount++;

    const streamState = ensureTaskState(taskId);

    // If this is a new taskId (different from previous), leave old room and join new
    if (prevTaskIdRef.current && prevTaskIdRef.current !== taskId) {
      socket.emit('leave-task', { taskId: prevTaskIdRef.current });
      // Clean up old state if no more listeners
      const oldState = taskStreams.get(prevTaskIdRef.current);
      if (oldState && oldState.listeners.size === 0) {
        taskStreams.delete(prevTaskIdRef.current);
      }
    }

    prevTaskIdRef.current = taskId;

    // Join the task room
    if (socket.connected) {
      socket.emit('join-task', { taskId });
      streamState.connected = true;
      streamState.reconnecting = false;
    }

    // Register listener
    const listener: Listener = () => updateState(taskId);
    listenerRef.current = listener;
    streamState.listeners.add(listener);

    // Initial state sync
    updateState(taskId);

    return () => {
      // Remove listener
      streamState.listeners.delete(listener);
      listenerRef.current = null;

      socketRefCount--;
      if (socketRefCount <= 0) {
        socketRefCount = 0;
        // Leave task rooms
        for (const tid of taskStreams.keys()) {
          if (socket.connected) {
            socket.emit('leave-task', { taskId: tid });
          }
        }
        taskStreams.clear();

        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        reconnectAttempt = 0;

        if (sharedSocket) {
          sharedSocket.disconnect();
          sharedSocket = null;
        }
      }
    };
  }, [taskId, updateState]);

  return state;
}
