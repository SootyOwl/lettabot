import type { AnyAgentTool } from '@letta-ai/letta-code-sdk';
import {
  jsonResult,
  readStringParam,
} from '@letta-ai/letta-code-sdk';
import type { ChannelAdapter } from '../channels/types.js';
import type { ChannelId, InboundMessage } from '../core/types.js';
import { resolveGroupMode, type GroupsConfig } from '../channels/group-mode.js';

/**
 * Format an InboundMessage into a human-readable line matching the batch format:
 *   [HH:MM] userName: text [Attachments: name1, name2]
 */
function formatMessage(msg: InboundMessage): string {
  const time = msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const name = msg.userName || msg.userId;
  let line = `[${time}] ${name}: ${msg.text}`;
  if (msg.attachments && msg.attachments.length > 0) {
    const names = msg.attachments.map((a) => a.name || 'attachment').join(', ');
    line += ` [Attachments: ${names}]`;
  }
  return line;
}

export type AdapterGetter = (channel: string) => ChannelAdapter | undefined;
export type GroupsGetter = (channel: string) => GroupsConfig | undefined;

/**
 * Create the read_channel_messages tool.
 *
 * @param getAdapter - Resolves a ChannelAdapter by channel ID (e.g. 'discord')
 * @param getGroups - Resolves the groups config for a channel (for access gating)
 */
export function createReadChannelMessagesTool(
  getAdapter: AdapterGetter,
  getGroups: GroupsGetter,
): AnyAgentTool {
  return {
    label: 'Read Channel Messages',
    name: 'read_channel_messages',
    description:
      'Read recent messages from a channel. Use this to review conversation history after receiving a digest notification.',
    parameters: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description:
            'Channel adapter ID (e.g. "discord", "telegram", "slack").',
        },
        chat: {
          type: 'string',
          description: 'Chat/channel ID to read from.',
        },
        limit: {
          type: 'number',
          description:
            'Number of recent messages to fetch (default: 20, max: 50).',
        },
      },
      required: ['channel', 'chat'],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, args: unknown) {
      const params =
        args && typeof args === 'object'
          ? (args as Record<string, unknown>)
          : {};

      const channel = readStringParam(params, 'channel', { required: true });
      const chatId = readStringParam(params, 'chat', { required: true });
      const rawLimit =
        typeof params.limit === 'number' ? params.limit : 20;
      const limit = Math.max(1, Math.min(50, rawLimit));

      // Resolve adapter
      const adapter = getAdapter(channel);
      if (!adapter) {
        return jsonResult({
          ok: false,
          error: `Unknown channel: ${channel}`,
        });
      }

      // Access gating: block disabled/unlisted channels
      const groups = getGroups(channel);
      if (groups) {
        const mode = resolveGroupMode(groups, [chatId], 'open');
        if (mode === 'disabled') {
          return jsonResult({
            ok: false,
            error: `Channel ${channel}:${chatId} is disabled.`,
          });
        }
      }

      // Check adapter capability
      if (typeof adapter.readMessages !== 'function') {
        return jsonResult({
          ok: false,
          error: `Reading messages is not supported for the ${channel} channel.`,
        });
      }

      try {
        const messages = await adapter.readMessages(chatId, limit);
        const formatted = messages.map(formatMessage).join('\n');
        return jsonResult({
          ok: true,
          channel,
          chatId,
          count: messages.length,
          messages: formatted,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Unknown error';
        return jsonResult({
          ok: false,
          error: `Failed to read messages: ${message}`,
        });
      }
    },
  };
}
