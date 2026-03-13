import type { AnyAgentTool, AgentToolResultContent } from '@letta-ai/letta-code-sdk';
import {
  jsonResult,
  readStringParam,
} from '@letta-ai/letta-code-sdk';
import type { ChannelAdapter } from '../channels/types.js';
import type { InboundMessage, InboundAttachment } from '../core/types.js';
import { resolveGroupMode, type GroupsConfig } from '../channels/group-mode.js';
import { createLogger } from '../logger.js';

const log = createLogger('ReadChannelMessages');

const IMAGE_MIME_PREFIXES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

function isImageAttachment(a: InboundAttachment): boolean {
  return a.kind === 'image' || IMAGE_MIME_PREFIXES.some(p => a.mimeType?.startsWith(p));
}

async function fetchImageAsBase64(url: string): Promise<{ data: string; mimeType: string } | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      log.warn(`Failed to fetch image (${response.status}): ${url}`);
      return null;
    }
    const buffer = await response.arrayBuffer();
    const data = Buffer.from(buffer).toString('base64');
    const mimeType = response.headers.get('content-type') || 'image/png';
    log.info(`Fetched image: ${url} (${Math.round(buffer.byteLength / 1024)}KB, ${mimeType})`);
    return { data, mimeType };
  } catch (err) {
    log.warn(`Failed to fetch image: ${url}`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Format an InboundMessage into a human-readable line matching the batch format:
 *   [HH:MM] userName: text [Attachments: name1, name2]
 */
function formatMessage(msg: InboundMessage): string {
  const time = msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const name = msg.userName || msg.userId;
  let line = `[${time}] ${name}: ${msg.text}`;
  if (msg.attachments && msg.attachments.length > 0) {
    for (const a of msg.attachments) {
      const label = a.name || 'attachment';
      line += a.url ? ` [Attachment: ${label} ${a.url}]` : ` [Attachment: ${label}]`;
    }
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

        // Collect all image URLs to fetch in parallel (cap at 10)
        const imageSlots: Array<{ msgIndex: number; attIndex: number; url: string }> = [];
        for (let mi = 0; mi < messages.length; mi++) {
          const msg = messages[mi];
          if (!msg.attachments) continue;
          for (let ai = 0; ai < msg.attachments.length; ai++) {
            const a = msg.attachments[ai];
            if (isImageAttachment(a) && a.url && imageSlots.length < 10) {
              imageSlots.push({ msgIndex: mi, attIndex: ai, url: a.url });
            }
          }
        }

        // Fetch all images in parallel
        log.info(`Found ${imageSlots.length} image attachment(s) to fetch`);
        const fetched = await Promise.all(
          imageSlots.map(async (slot) => {
            const img = await fetchImageAsBase64(slot.url);
            return { ...slot, img };
          }),
        );

        // Index fetched images by msgIndex for fast lookup
        const imagesByMsg = new Map<number, Array<{ attIndex: number; data: string; mimeType: string }>>();
        for (const f of fetched) {
          if (!f.img) continue;
          let list = imagesByMsg.get(f.msgIndex);
          if (!list) { list = []; imagesByMsg.set(f.msgIndex, list); }
          list.push({ attIndex: f.attIndex, ...f.img });
        }

        // Build interleaved content: each message's text line, then its images
        const content: AgentToolResultContent[] = [
          { type: 'text', text: JSON.stringify({ ok: true, channel, chatId, count: messages.length }) },
        ];

        for (let mi = 0; mi < messages.length; mi++) {
          content.push({ type: 'text', text: formatMessage(messages[mi]) });
          const imgs = imagesByMsg.get(mi);
          if (imgs) {
            for (const img of imgs) {
              const att = messages[mi].attachments![img.attIndex];
              content.push({ type: 'text', text: `[Image: ${att.name || 'attachment'}]` });
              content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
            }
          }
        }

        return { content };
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
