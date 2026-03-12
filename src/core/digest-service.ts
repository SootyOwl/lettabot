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

import { buildDigestPrompt } from './prompts.js';
import type { InboundMessage, TriggerContext, ChannelId } from './types.js';
import { createLogger } from '../logger.js';

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
// DigestService
// ---------------------------------------------------------------------------

export class DigestService {
  private buffers = new Map<string, DigestBuffer>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly sendToAgent: SendToAgentFn;
  private stopped = false;

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
  }

  start(): void {
    this.stopped = false;
    log.info('DigestService started');
  }

  stop(): void {
    this.stopped = true;
    for (const [key, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(key);
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
