/**
 * DigestService — accumulates lightweight activity metadata for channels
 * in "digest" group mode and periodically notifies the agent with a summary.
 *
 * Standalone service (does not extend GroupBatcher or CronService).
 * Each channel gets an independent timer chain:
 *   first message → start timer(intervalMin) → on fire, debounce(debounceMin) → flush
 *
 * Timers are per-channel setTimeout chains (not setInterval), so idle channels
 * have zero overhead.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import crypto from 'node:crypto';
import { buildDigestPrompt } from './prompts.js';
import type { InboundMessage, TriggerContext, ChannelId } from './types.js';
import { createLogger } from '../logger.js';
import { getDataDir } from '../utils/paths.js';

const log = createLogger('Digest');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DigestMessageMeta {
  userId: string;
  userName: string;
  timestamp: Date;
}

export interface DigestBuffer {
  messages: DigestMessageMeta[];
  config: {
    intervalMin: number;
    debounceMin: number;
  };
  channelMeta: {
    adapter: ChannelId;
    chatId: string;
    channelName?: string;
  };
  /** When the timer was first started for this accumulation window */
  timerStartedAt: number;
}

export type SendToAgentFn = (text: string, context?: TriggerContext) => Promise<string>;

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const PERSIST_FILENAME = 'digest-buffers.json';
const SAVE_DEBOUNCE_MS = 5_000; // debounce disk writes to at most every 5s

/** Serializable form of DigestBuffer (Dates become ISO strings) */
interface PersistedBuffer {
  messages: Array<{ userId: string; userName: string; timestamp: string }>;
  config: { intervalMin: number; debounceMin: number };
  channelMeta: { adapter: string; chatId: string; channelName?: string };
  timerStartedAt: number;
}

interface PersistedState {
  version: 1;
  buffers: Record<string, PersistedBuffer>;
}

function getPersistPath(): string {
  return resolve(getDataDir(), PERSIST_FILENAME);
}

// ---------------------------------------------------------------------------
// DigestService
// ---------------------------------------------------------------------------

export class DigestService {
  private buffers = new Map<string, DigestBuffer>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly sendToAgent: SendToAgentFn;
  private stopped = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private savePending = false;

  constructor(sendToAgent: SendToAgentFn) {
    this.sendToAgent = sendToAgent;
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Called by adapters for every non-mention message in a digest-mode channel.
   */
  addMessage(
    msg: InboundMessage,
    digestConfig: { intervalMin: number; debounceMin: number },
  ): void {
    if (this.stopped) return;

    const key = `${msg.channel}:${msg.chatId}`;
    let buffer = this.buffers.get(key);

    if (!buffer) {
      buffer = {
        messages: [],
        config: digestConfig,
        channelMeta: {
          adapter: msg.channel,
          chatId: msg.chatId,
          channelName: msg.groupName,
        },
        timerStartedAt: Date.now(),
      };
      this.buffers.set(key, buffer);
    }

    buffer.messages.push({
      userId: msg.userId,
      userName: msg.userName || msg.userId,
      timestamp: msg.timestamp,
    });

    // Start the timer chain if not already running
    if (!this.timers.has(key)) {
      buffer.timerStartedAt = Date.now();
      this.scheduleFlush(key, buffer.config.intervalMin * 60_000);
    }

    this.scheduleSave();
  }

  start(): void {
    this.stopped = false;
    this.restoreFromDisk();
    log.info('DigestService started');
  }

  stop(): void {
    this.stopped = true;
    for (const [key, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    // Flush pending save immediately
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.savePending) {
      this.saveToDiskSync();
    }
    log.info('DigestService stopped');
  }

  // =========================================================================
  // Timer lifecycle
  // =========================================================================

  private scheduleFlush(key: string, delayMs: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(key);
      this.onTimerFire(key).catch((err) => {
        log.error(`Digest flush error for ${key}:`, err);
      });
    }, delayMs);

    // Prevent timer from keeping the process alive
    if (timer.unref) timer.unref();

    this.timers.set(key, timer);
  }

  private async onTimerFire(key: string): Promise<void> {
    if (this.stopped) return;

    const buffer = this.buffers.get(key);
    if (!buffer || buffer.messages.length === 0) {
      // Buffer was emptied or cleared — don't reschedule
      this.buffers.delete(key);
      return;
    }

    const lastMessageTime = buffer.messages[buffer.messages.length - 1].timestamp.getTime();
    const quietMs = Date.now() - lastMessageTime;
    const debounceMs = buffer.config.debounceMin * 60_000;
    const elapsedSinceTimerStart = Date.now() - buffer.timerStartedAt;
    const maxWaitMs = buffer.config.intervalMin * 60_000 * 2; // 2x interval cap

    // Debounce: if last message is too recent, wait — unless we've exceeded the cap
    if (quietMs < debounceMs && elapsedSinceTimerStart < maxWaitMs) {
      const retryIn = debounceMs - quietMs;
      log.debug(`Digest debounce: ${key} not quiet yet, retrying in ${Math.round(retryIn / 1000)}s`);
      this.scheduleFlush(key, retryIn);
      return;
    }

    if (elapsedSinceTimerStart >= maxWaitMs) {
      log.info(`Digest debounce cap reached for ${key} (${Math.round(elapsedSinceTimerStart / 60_000)}min elapsed), flushing regardless`);
    }

    await this.flush(key);
  }

  // =========================================================================
  // Flush
  // =========================================================================

  private async flush(key: string): Promise<void> {
    const buffer = this.buffers.get(key);
    if (!buffer || buffer.messages.length === 0) {
      this.buffers.delete(key);
      return;
    }

    // Snapshot and clear
    const messages = buffer.messages.slice();
    const meta = buffer.channelMeta;
    const intervalMin = buffer.config.intervalMin;
    this.buffers.delete(key);
    this.scheduleSave();

    // Aggregate per-user counts
    const userCounts = new Map<string, { name: string; count: number }>();
    for (const msg of messages) {
      const entry = userCounts.get(msg.userId);
      if (entry) {
        entry.count++;
      } else {
        userCounts.set(msg.userId, { name: msg.userName, count: 1 });
      }
    }

    // Sort by count descending
    const sortedUsers = [...userCounts.values()].sort((a, b) => b.count - a.count);

    const prompt = buildDigestPrompt({
      channel: meta.adapter,
      channelName: meta.channelName,
      chatId: meta.chatId,
      intervalMin,
      users: sortedUsers,
      time: new Date(),
    });

    const convKey = `${meta.adapter}:${meta.chatId}`;

    const context: TriggerContext = {
      type: 'digest',
      outputMode: 'silent',
      sourceChannel: meta.adapter,
      sourceChatId: meta.chatId,
      convKey,
    };

    log.info(
      `Flushing digest for ${key}: ${messages.length} messages from ${userCounts.size} users`,
    );

    try {
      await this.sendToAgent(prompt, context);
    } catch (err) {
      log.error(`Failed to send digest for ${key}:`, err);
    }
  }

  // =========================================================================
  // Persistence
  // =========================================================================

  /** Schedule a debounced save to disk */
  private scheduleSave(): void {
    this.savePending = true;
    if (this.saveTimer) return; // already scheduled
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.savePending = false;
      this.saveToDiskSync();
    }, SAVE_DEBOUNCE_MS);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  /** Synchronously write current buffers to disk (atomic via tmp+rename) */
  private saveToDiskSync(): void {
    const persistPath = getPersistPath();
    try {
      const state: PersistedState = { version: 1, buffers: {} };
      for (const [key, buf] of this.buffers) {
        if (buf.messages.length === 0) continue;
        state.buffers[key] = {
          messages: buf.messages.map(m => ({
            userId: m.userId,
            userName: m.userName,
            timestamp: m.timestamp.toISOString(),
          })),
          config: buf.config,
          channelMeta: buf.channelMeta,
          timerStartedAt: buf.timerStartedAt,
        };
      }

      if (Object.keys(state.buffers).length === 0) {
        // Nothing to persist — remove stale file if it exists
        try { unlinkSync(persistPath); } catch { /* ignore */ }
        return;
      }

      mkdirSync(dirname(persistPath), { recursive: true });
      const tmp = `${persistPath}.${crypto.randomUUID()}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8');
      renameSync(tmp, persistPath);
    } catch (err) {
      log.error('Failed to persist digest buffers:', err);
    }
  }

  /** Restore buffers from disk and restart timers */
  private restoreFromDisk(): void {
    const persistPath = getPersistPath();
    if (!existsSync(persistPath)) return;

    try {
      const raw = readFileSync(persistPath, 'utf-8');
      const state = JSON.parse(raw) as PersistedState;
      if (state.version !== 1 || !state.buffers) return;

      let restoredCount = 0;
      const now = Date.now();

      for (const [key, pBuf] of Object.entries(state.buffers)) {
        if (!pBuf.messages.length) continue;

        const buffer: DigestBuffer = {
          messages: pBuf.messages.map(m => ({
            userId: m.userId,
            userName: m.userName,
            timestamp: new Date(m.timestamp),
          })),
          config: pBuf.config,
          channelMeta: {
            adapter: pBuf.channelMeta.adapter as ChannelId,
            chatId: pBuf.channelMeta.chatId,
            channelName: pBuf.channelMeta.channelName,
          },
          timerStartedAt: pBuf.timerStartedAt,
        };

        this.buffers.set(key, buffer);

        // Figure out how much time remains on the interval
        const intervalMs = buffer.config.intervalMin * 60_000;
        const elapsed = now - buffer.timerStartedAt;
        const remaining = Math.max(0, intervalMs - elapsed);

        // If interval already passed, flush soon (1s grace for startup)
        this.scheduleFlush(key, remaining > 0 ? remaining : 1_000);
        restoredCount++;
      }

      if (restoredCount > 0) {
        log.info(`Restored ${restoredCount} digest buffer(s) from disk`);
      }

      // Clean up the persist file now that we've loaded it
      try { unlinkSync(persistPath); } catch { /* ignore */ }
    } catch (err) {
      log.error('Failed to restore digest buffers from disk:', err);
    }
  }

  // =========================================================================
  // Testing helpers
  // =========================================================================

  /** @internal Visible for testing */
  getBuffer(key: string): DigestBuffer | undefined {
    return this.buffers.get(key);
  }

  /** @internal Visible for testing */
  hasTimer(key: string): boolean {
    return this.timers.has(key);
  }

  /** @internal Visible for testing — force-flush a channel */
  async forceFlush(key: string): Promise<void> {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    await this.flush(key);
  }
}
