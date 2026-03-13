import { describe, it, expect, vi } from 'vitest';
import { createReadChannelMessagesTool } from './read-channel-messages.js';
import type { ChannelAdapter } from '../channels/types.js';
import type { InboundMessage } from '../core/types.js';
import type { GroupsConfig } from '../channels/group-mode.js';

function parseToolResult(result: { content: Array<{ type?: string; text?: string }> }): any {
  const meta = JSON.parse(result.content[0]?.text || '{}');
  // Collect all text content blocks after the metadata as the full transcript
  const textBlocks = result.content.slice(1).filter(c => c.type === 'text').map(c => c.text || '');
  meta.messages = textBlocks.join('\n');
  return meta;
}

function makeMockAdapter(messages: InboundMessage[] = []): ChannelAdapter {
  return {
    id: 'discord',
    name: 'Discord',
    start: vi.fn(),
    stop: vi.fn(),
    isRunning: vi.fn(() => true),
    sendMessage: vi.fn(),
    editMessage: vi.fn(),
    sendTypingIndicator: vi.fn(),
    getFormatterHints: () => ({ supportsReactions: true, supportsFiles: true }),
    readMessages: vi.fn(async (_chatId: string, _limit: number) => messages),
  } as unknown as ChannelAdapter;
}

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: 'discord',
    chatId: '123',
    userId: 'user-1',
    userName: 'Alice',
    text: 'Hello world',
    timestamp: new Date('2026-03-12T10:30:00Z'),
    ...overrides,
  };
}

describe('read_channel_messages tool', () => {
  it('returns error for unknown channel', async () => {
    const tool = createReadChannelMessagesTool(
      () => undefined,
      () => undefined,
    );

    const result = await tool.execute('call-1', { channel: 'unknown', chat: '123' });
    const parsed = parseToolResult(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('Unknown channel');
  });

  it('returns error when adapter does not support readMessages', async () => {
    const adapter = makeMockAdapter();
    delete (adapter as any).readMessages;

    const tool = createReadChannelMessagesTool(
      () => adapter,
      () => undefined,
    );

    const result = await tool.execute('call-1', { channel: 'discord', chat: '123' });
    const parsed = parseToolResult(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('not supported');
  });

  it('returns formatted messages', async () => {
    const messages: InboundMessage[] = [
      makeMessage({ userName: 'Alice', text: 'Hello' }),
      makeMessage({ userName: 'Bob', text: 'Hi there', attachments: [{ name: 'image.png', mimeType: 'image/png', url: 'http://example.com/img.png' }] }),
    ];
    const adapter = makeMockAdapter(messages);

    const tool = createReadChannelMessagesTool(
      () => adapter,
      () => undefined,
    );

    const result = await tool.execute('call-1', { channel: 'discord', chat: '123' });
    const parsed = parseToolResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(2);
    expect(parsed.channel).toBe('discord');
    expect(parsed.chatId).toBe('123');
    expect(parsed.messages).toContain('Alice: Hello');
    expect(parsed.messages).toContain('Bob: Hi there');
    expect(parsed.messages).toContain('[Attachment: image.png http://example.com/img.png]');
  });

  it('respects limit parameter (clamped to 1-50)', async () => {
    const adapter = makeMockAdapter();

    const tool = createReadChannelMessagesTool(
      () => adapter,
      () => undefined,
    );

    await tool.execute('call-1', { channel: 'discord', chat: '123', limit: 10 });

    expect(adapter.readMessages).toHaveBeenCalledWith('123', 10);
  });

  it('defaults limit to 20 when omitted', async () => {
    const adapter = makeMockAdapter();

    const tool = createReadChannelMessagesTool(
      () => adapter,
      () => undefined,
    );

    await tool.execute('call-1', { channel: 'discord', chat: '123' });

    expect(adapter.readMessages).toHaveBeenCalledWith('123', 20);
  });

  it('clamps max limit to 50', async () => {
    const adapter = makeMockAdapter();

    const tool = createReadChannelMessagesTool(
      () => adapter,
      () => undefined,
    );

    await tool.execute('call-1', { channel: 'discord', chat: '123', limit: 100 });

    expect(adapter.readMessages).toHaveBeenCalledWith('123', 50);
  });

  it('blocks disabled channels', async () => {
    const adapter = makeMockAdapter();
    const groups: GroupsConfig = {
      '123': { mode: 'disabled' },
    };

    const tool = createReadChannelMessagesTool(
      () => adapter,
      () => groups,
    );

    const result = await tool.execute('call-1', { channel: 'discord', chat: '123' });
    const parsed = parseToolResult(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('disabled');
  });

  it('allows non-disabled channels', async () => {
    const adapter = makeMockAdapter([makeMessage()]);
    const groups: GroupsConfig = {
      '123': { mode: 'open' },
    };

    const tool = createReadChannelMessagesTool(
      () => adapter,
      () => groups,
    );

    const result = await tool.execute('call-1', { channel: 'discord', chat: '123' });
    const parsed = parseToolResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.count).toBe(1);
  });

  it('handles adapter errors gracefully', async () => {
    const adapter = makeMockAdapter();
    (adapter.readMessages as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Connection timeout'),
    );

    const tool = createReadChannelMessagesTool(
      () => adapter,
      () => undefined,
    );

    const result = await tool.execute('call-1', { channel: 'discord', chat: '123' });
    const parsed = parseToolResult(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('Connection timeout');
  });

  it('falls back to userId when userName is missing', async () => {
    const messages = [makeMessage({ userName: undefined })];
    const adapter = makeMockAdapter(messages);

    const tool = createReadChannelMessagesTool(
      () => adapter,
      () => undefined,
    );

    const result = await tool.execute('call-1', { channel: 'discord', chat: '123' });
    const parsed = parseToolResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.messages).toContain('user-1: Hello world');
  });

  it('falls back to "attachment" when attachment has no name', async () => {
    const messages = [
      makeMessage({
        attachments: [{ mimeType: 'application/pdf', url: 'http://example.com/file' }],
      }),
    ];
    const adapter = makeMockAdapter(messages);

    const tool = createReadChannelMessagesTool(
      () => adapter,
      () => undefined,
    );

    const result = await tool.execute('call-1', { channel: 'discord', chat: '123' });
    const parsed = parseToolResult(result);

    expect(parsed.ok).toBe(true);
    expect(parsed.messages).toContain('[Attachment: attachment http://example.com/file]');
  });

  it('handles non-object args gracefully', async () => {
    const adapter = makeMockAdapter();

    const tool = createReadChannelMessagesTool(
      () => adapter,
      () => undefined,
    );

    // Pass null/string instead of object — should not crash
    // readStringParam with required:true will throw, which is expected SDK behavior
    await expect(tool.execute('call-1', null)).rejects.toThrow();
    await expect(tool.execute('call-1', 'bad')).rejects.toThrow();
  });

  it('handles non-Error thrown by adapter', async () => {
    const adapter = makeMockAdapter();
    (adapter.readMessages as ReturnType<typeof vi.fn>).mockRejectedValue('string error');

    const tool = createReadChannelMessagesTool(
      () => adapter,
      () => undefined,
    );

    const result = await tool.execute('call-1', { channel: 'discord', chat: '123' });
    const parsed = parseToolResult(result);

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('Unknown error');
  });

  it('clamps limit to minimum 1', async () => {
    const adapter = makeMockAdapter();

    const tool = createReadChannelMessagesTool(
      () => adapter,
      () => undefined,
    );

    await tool.execute('call-1', { channel: 'discord', chat: '123', limit: -5 });

    expect(adapter.readMessages).toHaveBeenCalledWith('123', 1);
  });
});
