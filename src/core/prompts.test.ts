import { describe, it, expect } from 'vitest';
import { buildDigestPrompt } from './prompts.js';

describe('buildDigestPrompt', () => {
  it('includes SILENT_MODE_PREFIX', () => {
    const prompt = buildDigestPrompt({
      channel: 'discord',
      channelName: 'general',
      chatId: '123456',
      intervalMin: 30,
      users: [{ name: 'Alice', count: 5 }],
      time: new Date('2026-03-12T16:30:00Z'),
    });
    expect(prompt).toContain('[SILENT MODE]');
    expect(prompt).toContain('lettabot-message send');
  });

  it('formats channel with name when provided', () => {
    const prompt = buildDigestPrompt({
      channel: 'discord',
      channelName: 'general',
      chatId: '123456',
      intervalMin: 30,
      users: [{ name: 'Alice', count: 1 }],
      time: new Date('2026-03-12T16:30:00Z'),
    });
    expect(prompt).toContain('discord #general (chat ID: 123456)');
  });

  it('formats channel without name as channel:chatId', () => {
    const prompt = buildDigestPrompt({
      channel: 'discord',
      chatId: '123456',
      intervalMin: 30,
      users: [{ name: 'Alice', count: 1 }],
      time: new Date('2026-03-12T16:30:00Z'),
    });
    expect(prompt).toContain('discord:123456');
    expect(prompt).not.toContain('#');
  });

  it('shows correct interval period', () => {
    const prompt = buildDigestPrompt({
      channel: 'discord',
      chatId: '123',
      intervalMin: 60,
      users: [{ name: 'Alice', count: 1 }],
      time: new Date(),
    });
    expect(prompt).toContain('last 60 minutes');
  });

  it('pluralizes message counts correctly', () => {
    const prompt = buildDigestPrompt({
      channel: 'discord',
      chatId: '123',
      intervalMin: 30,
      users: [
        { name: 'Alice', count: 5 },
        { name: 'Bob', count: 1 },
      ],
      time: new Date(),
    });
    expect(prompt).toContain('Alice: 5 messages');
    expect(prompt).toContain('Bob: 1 message');
    expect(prompt).not.toContain('Bob: 1 messages');
  });

  it('includes read_channel_messages instruction', () => {
    const prompt = buildDigestPrompt({
      channel: 'discord',
      chatId: '123456',
      intervalMin: 30,
      users: [{ name: 'Alice', count: 1 }],
      time: new Date(),
    });
    expect(prompt).toContain('read_channel_messages --channel discord --chat 123456');
  });
});
