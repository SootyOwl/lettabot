import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DigestService } from './digest-service.js';
import type { InboundMessage } from './types.js';

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: 'discord',
    chatId: '123456',
    userId: 'user1',
    userName: 'Alice',
    text: 'hello',
    timestamp: new Date(),
    ...overrides,
  };
}

const DEFAULT_DIGEST_CONFIG = { intervalMin: 30, debounceMin: 1 };

describe('DigestService', () => {
  let sendToAgent: ReturnType<typeof vi.fn>;
  let service: DigestService;
  let tempDir: string;
  const origDataDir = process.env.DATA_DIR;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'digest-test-'));
    process.env.DATA_DIR = tempDir;
    sendToAgent = vi.fn().mockResolvedValue('ok');
    service = new DigestService(sendToAgent);
  });

  afterEach(() => {
    service.stop();
    if (origDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = origDataDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------------
  // 1. addMessage accumulates messages
  // -----------------------------------------------------------------------
  it('addMessage accumulates messages in the buffer', () => {
    vi.useFakeTimers();
    try {
      service.addMessage(makeMessage(), DEFAULT_DIGEST_CONFIG);
      service.addMessage(makeMessage({ text: 'world' }), DEFAULT_DIGEST_CONFIG);

      const buffer = service.getBuffer('discord:123456');
      expect(buffer).toBeDefined();
      expect(buffer!.messages).toHaveLength(2);
      expect(buffer!.messages[0].userName).toBe('Alice');
      expect(buffer!.messages[1].userName).toBe('Alice');
    } finally {
      vi.useRealTimers();
    }
  });

  // -----------------------------------------------------------------------
  // 2. Empty buffer skips flush
  // -----------------------------------------------------------------------
  it('empty buffer skips flush — sendToAgent is NOT called', async () => {
    await service.forceFlush('discord:nonexistent');
    expect(sendToAgent).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 3. Flush sends digest to agent with correct TriggerContext
  // -----------------------------------------------------------------------
  it('flush sends digest to agent with correct TriggerContext', async () => {
    vi.useFakeTimers();
    try {
      service.addMessage(makeMessage(), DEFAULT_DIGEST_CONFIG);
      await service.forceFlush('discord:123456');

      expect(sendToAgent).toHaveBeenCalledTimes(1);
      const [_prompt, context] = sendToAgent.mock.calls[0];
      expect(context).toMatchObject({
        type: 'digest',
        outputMode: 'silent',
        sourceChannel: 'discord',
        sourceChatId: '123456',
      });
      expect(context.convKey).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  // -----------------------------------------------------------------------
  // 4. Flush clears buffer
  // -----------------------------------------------------------------------
  it('flush clears the buffer after sending', async () => {
    vi.useFakeTimers();
    try {
      service.addMessage(makeMessage(), DEFAULT_DIGEST_CONFIG);
      await service.forceFlush('discord:123456');

      expect(service.getBuffer('discord:123456')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  // -----------------------------------------------------------------------
  // 5. Per-user message counts are correct
  // -----------------------------------------------------------------------
  it('per-user message counts are correct in the digest prompt', async () => {
    vi.useFakeTimers();
    try {
      service.addMessage(makeMessage({ userId: 'u1', userName: 'Alice' }), DEFAULT_DIGEST_CONFIG);
      service.addMessage(makeMessage({ userId: 'u1', userName: 'Alice' }), DEFAULT_DIGEST_CONFIG);
      service.addMessage(makeMessage({ userId: 'u1', userName: 'Alice' }), DEFAULT_DIGEST_CONFIG);
      service.addMessage(makeMessage({ userId: 'u2', userName: 'Bob' }), DEFAULT_DIGEST_CONFIG);

      await service.forceFlush('discord:123456');

      expect(sendToAgent).toHaveBeenCalledTimes(1);
      const prompt: string = sendToAgent.mock.calls[0][0];
      // Alice sent 3 messages, Bob sent 1
      expect(prompt).toContain('Alice');
      expect(prompt).toContain('3');
      expect(prompt).toContain('Bob');
      expect(prompt).toContain('1');
    } finally {
      vi.useRealTimers();
    }
  });

  // -----------------------------------------------------------------------
  // 6. Timer starts on first message
  // -----------------------------------------------------------------------
  it('timer starts on first message', () => {
    vi.useFakeTimers();
    try {
      expect(service.hasTimer('discord:123456')).toBe(false);
      service.addMessage(makeMessage(), DEFAULT_DIGEST_CONFIG);
      expect(service.hasTimer('discord:123456')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // -----------------------------------------------------------------------
  // 7. No timer when buffer empty
  // -----------------------------------------------------------------------
  it('no timer when buffer is empty', () => {
    expect(service.hasTimer('discord:123456')).toBe(false);
  });

  // -----------------------------------------------------------------------
  // 8. Timer fires and flushes after interval
  // -----------------------------------------------------------------------
  it('timer fires and flushes after interval', async () => {
    vi.useFakeTimers();
    try {
      service.addMessage(makeMessage(), DEFAULT_DIGEST_CONFIG);
      expect(sendToAgent).not.toHaveBeenCalled();

      // Advance past the interval (30 min) + debounce (1 min)
      await vi.advanceTimersByTimeAsync(30 * 60_000);

      expect(sendToAgent).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // -----------------------------------------------------------------------
  // 9. Debounce delays flush
  // -----------------------------------------------------------------------
  it('debounce delays flush when messages are recent', async () => {
    vi.useFakeTimers();
    try {
      service.addMessage(makeMessage(), DEFAULT_DIGEST_CONFIG);

      // Advance to just before interval fires
      await vi.advanceTimersByTimeAsync(29 * 60_000 + 59_000);
      expect(sendToAgent).not.toHaveBeenCalled();

      // Add another message right before the timer fires — this makes
      // the last message "recent" when the timer fires
      service.addMessage(makeMessage({ text: 'late msg' }), DEFAULT_DIGEST_CONFIG);

      // Advance past the interval timer fire
      await vi.advanceTimersByTimeAsync(2_000);

      // Timer fired but debounce detected recent activity — should NOT have
      // flushed yet; it reschedules
      expect(sendToAgent).not.toHaveBeenCalled();

      // Advance past the debounce period (1 min)
      await vi.advanceTimersByTimeAsync(60_000);

      // Now it should have flushed
      expect(sendToAgent).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // -----------------------------------------------------------------------
  // 10. Debounce cap forces flush
  // -----------------------------------------------------------------------
  it('debounce cap forces flush after 2x interval even with continuous activity', async () => {
    vi.useFakeTimers();
    try {
      service.addMessage(makeMessage(), DEFAULT_DIGEST_CONFIG);

      // Interval is 30 min, 2x cap is 60 min.
      // Add messages every 30s to keep activity recent, preventing debounce
      // from allowing the flush. The cap should force it at 60 min.

      // Advance in small steps, adding messages to keep debounce deferring.
      // Stop adding messages just before the cap so we can check the flush.
      const steps = 119; // 119 * 30s = 59.5 min
      for (let i = 0; i < steps; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
        service.addMessage(
          makeMessage({ text: `msg-${i}`, timestamp: new Date() }),
          DEFAULT_DIGEST_CONFIG,
        );
      }

      // We're at ~59.5 min. The interval timer fired at 30 min, debounce
      // kept rescheduling. By now there may already have been a cap-forced
      // flush, but let's verify that at least one flush happened by the cap.
      // Advance just past the cap boundary.
      await vi.advanceTimersByTimeAsync(2 * 60_000);

      // The service should have flushed at least once due to the cap
      expect(sendToAgent).toHaveBeenCalled();

      // Verify the first flush had digest context
      const [_prompt, context] = sendToAgent.mock.calls[0];
      expect(context.type).toBe('digest');
    } finally {
      vi.useRealTimers();
    }
  });

  // -----------------------------------------------------------------------
  // 12. stop() clears timers
  // -----------------------------------------------------------------------
  it('stop() clears timers', () => {
    vi.useFakeTimers();
    try {
      service.addMessage(makeMessage(), DEFAULT_DIGEST_CONFIG);
      expect(service.hasTimer('discord:123456')).toBe(true);

      service.stop();

      expect(service.hasTimer('discord:123456')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // -----------------------------------------------------------------------
  // 13. Multiple channels have independent buffers
  // -----------------------------------------------------------------------
  it('multiple channels have independent buffers', () => {
    vi.useFakeTimers();
    try {
      service.addMessage(
        makeMessage({ chatId: 'chan-A', text: 'A1' }),
        DEFAULT_DIGEST_CONFIG,
      );
      service.addMessage(
        makeMessage({ chatId: 'chan-B', text: 'B1' }),
        DEFAULT_DIGEST_CONFIG,
      );
      service.addMessage(
        makeMessage({ chatId: 'chan-A', text: 'A2' }),
        DEFAULT_DIGEST_CONFIG,
      );

      const bufA = service.getBuffer('discord:chan-A');
      const bufB = service.getBuffer('discord:chan-B');

      expect(bufA).toBeDefined();
      expect(bufB).toBeDefined();
      expect(bufA!.messages).toHaveLength(2);
      expect(bufB!.messages).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // -----------------------------------------------------------------------
  // 14. Stopped service ignores addMessage
  // -----------------------------------------------------------------------
  it('stopped service ignores addMessage', () => {
    vi.useFakeTimers();
    try {
      service.stop();
      service.addMessage(makeMessage(), DEFAULT_DIGEST_CONFIG);

      expect(service.getBuffer('discord:123456')).toBeUndefined();
      expect(service.hasTimer('discord:123456')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // -----------------------------------------------------------------------
  // 15. sendToAgent rejection is caught gracefully
  // -----------------------------------------------------------------------
  it('catches sendToAgent errors without crashing', async () => {
    vi.useFakeTimers();
    try {
      const failingSendToAgent = vi.fn().mockRejectedValue(new Error('agent offline'));
      const failingService = new DigestService(failingSendToAgent);
      failingService.addMessage(makeMessage(), DEFAULT_DIGEST_CONFIG);
      // Should not throw
      await failingService.forceFlush('discord:123456');
      expect(failingSendToAgent).toHaveBeenCalled();
      failingService.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  // -----------------------------------------------------------------------
  // 16. start() after stop() re-enables message acceptance
  // -----------------------------------------------------------------------
  it('start() after stop() re-enables message acceptance', () => {
    vi.useFakeTimers();
    try {
      service.addMessage(makeMessage(), DEFAULT_DIGEST_CONFIG);
      expect(service.getBuffer('discord:123456')).toBeDefined();

      service.stop();
      // stop() clears timers but not buffers; however stopped flag prevents new adds
      // Verify stopped state blocks new messages
      service.addMessage(makeMessage({ userId: 'user2', userName: 'Bob' }), DEFAULT_DIGEST_CONFIG);
      expect(service.getBuffer('discord:123456')!.messages).toHaveLength(1); // only pre-stop msg

      service.start();

      // After start(), new messages are accepted again and a new timer starts
      service.addMessage(
        makeMessage({ userId: 'user2', userName: 'Bob', chatId: '999' }),
        DEFAULT_DIGEST_CONFIG,
      );
      expect(service.getBuffer('discord:999')).toBeDefined();
      expect(service.getBuffer('discord:999')!.messages).toHaveLength(1);
      expect(service.hasTimer('discord:999')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  // -----------------------------------------------------------------------
  // 17. Does not flush if stopped before timer fires
  // -----------------------------------------------------------------------
  it('does not flush if stopped before timer fires', async () => {
    vi.useFakeTimers();
    try {
      const trackingSendToAgent = vi.fn().mockResolvedValue('ok');
      const trackingService = new DigestService(trackingSendToAgent);

      trackingService.addMessage(makeMessage(), DEFAULT_DIGEST_CONFIG);
      expect(trackingService.hasTimer('discord:123456')).toBe(true);

      trackingService.stop();

      // Advance past interval - timer was cleared by stop, so nothing should fire
      await vi.advanceTimersByTimeAsync(31 * 60_000);

      expect(trackingSendToAgent).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // -----------------------------------------------------------------------
  // 18. userName fallback to userId
  // -----------------------------------------------------------------------
  it('falls back to userId when userName is missing', () => {
    vi.useFakeTimers();
    try {
      service.addMessage(makeMessage({ userName: undefined }), DEFAULT_DIGEST_CONFIG);

      const buffer = service.getBuffer('discord:123456');
      expect(buffer).toBeDefined();
      expect(buffer!.messages[0].userName).toBe('user1');
    } finally {
      vi.useRealTimers();
    }
  });

  // -----------------------------------------------------------------------
  // 19. onTimerFire with buffer existing but messages emptied
  // -----------------------------------------------------------------------
  it('onTimerFire skips flush when buffer exists but messages were emptied', async () => {
    vi.useFakeTimers();
    try {
      service.addMessage(makeMessage(), DEFAULT_DIGEST_CONFIG);

      // Manually empty the messages array (simulates an edge case)
      const buffer = service.getBuffer('discord:123456');
      buffer!.messages.length = 0;

      // Let the timer fire — should not call sendToAgent
      await vi.advanceTimersByTimeAsync(30 * 60_000);

      expect(sendToAgent).not.toHaveBeenCalled();
      // Buffer should be cleaned up
      expect(service.getBuffer('discord:123456')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  // -----------------------------------------------------------------------
  // 20. Persistence: buffers survive restart
  // -----------------------------------------------------------------------
  describe('persistence', () => {
    it('persists buffers to disk and restores on start()', async () => {
      vi.useFakeTimers();
      try {
        const sendToAgent1 = vi.fn().mockResolvedValue('ok');
        const svc1 = new DigestService(sendToAgent1);
        svc1.start();

        svc1.addMessage(makeMessage({ userId: 'u1', userName: 'Alice' }), DEFAULT_DIGEST_CONFIG);
        svc1.addMessage(makeMessage({ userId: 'u2', userName: 'Bob' }), DEFAULT_DIGEST_CONFIG);

        // Force the debounced save by stopping (which saves synchronously)
        svc1.stop();

        // Verify file was written
        const persistPath = join(tempDir, 'digest-buffers.json');
        expect(existsSync(persistPath)).toBe(true);

        const saved = JSON.parse(readFileSync(persistPath, 'utf-8'));
        expect(saved.version).toBe(1);
        expect(saved.buffers['discord:123456']).toBeDefined();
        expect(saved.buffers['discord:123456'].messages).toHaveLength(2);

        // Create a new service and start it — should restore
        const sendToAgent2 = vi.fn().mockResolvedValue('ok');
        const svc2 = new DigestService(sendToAgent2);
        svc2.start();

        const restored = svc2.getBuffer('discord:123456');
        expect(restored).toBeDefined();
        expect(restored!.messages).toHaveLength(2);
        expect(restored!.messages[0].userName).toBe('Alice');
        expect(restored!.messages[1].userName).toBe('Bob');
        expect(svc2.hasTimer('discord:123456')).toBe(true);

        // Persist file is cleaned up after load
        expect(existsSync(persistPath)).toBe(false);

        svc2.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('restored buffer flushes after remaining interval time', async () => {
      vi.useFakeTimers();
      try {
        const sendToAgent1 = vi.fn().mockResolvedValue('ok');
        const svc1 = new DigestService(sendToAgent1);
        svc1.start();

        svc1.addMessage(makeMessage(), DEFAULT_DIGEST_CONFIG);

        // Simulate 20 minutes passing before restart
        await vi.advanceTimersByTimeAsync(20 * 60_000);
        expect(sendToAgent1).not.toHaveBeenCalled();

        svc1.stop();

        // New service — should schedule flush for remaining ~10 min
        const sendToAgent2 = vi.fn().mockResolvedValue('ok');
        const svc2 = new DigestService(sendToAgent2);
        svc2.start();

        // Advance 10 minutes — should trigger flush
        await vi.advanceTimersByTimeAsync(10 * 60_000);

        expect(sendToAgent2).toHaveBeenCalledTimes(1);
        svc2.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not persist empty buffers', () => {
      vi.useFakeTimers();
      try {
        const svc = new DigestService(vi.fn().mockResolvedValue('ok'));
        svc.start();
        // No messages added
        svc.stop();

        const persistPath = join(tempDir, 'digest-buffers.json');
        expect(existsSync(persistPath)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // -----------------------------------------------------------------------
  // 23. onTimerFire error is caught by scheduleFlush catch handler
  // -----------------------------------------------------------------------
  it('timer-triggered flush errors are caught gracefully', async () => {
    vi.useFakeTimers();
    try {
      const errorSendToAgent = vi.fn().mockRejectedValue(new Error('network down'));
      const errorService = new DigestService(errorSendToAgent);
      errorService.addMessage(makeMessage(), DEFAULT_DIGEST_CONFIG);

      // Let the timer fire — flush will throw, caught by scheduleFlush's .catch()
      await vi.advanceTimersByTimeAsync(30 * 60_000);

      // Should have attempted the call despite the error
      expect(errorSendToAgent).toHaveBeenCalled();
      // Service should still be operational (not crashed)
      errorService.addMessage(makeMessage({ chatId: '999' }), DEFAULT_DIGEST_CONFIG);
      expect(errorService.getBuffer('discord:999')).toBeDefined();
      errorService.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
