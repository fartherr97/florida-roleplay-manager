/**
 * Posting and editing plain channel messages over Discord's REST API.
 *
 * Like the role catalogue, this needs none of the gateway machinery: sending a message
 * is a single authenticated REST call. It is deliberately narrow — it posts the
 * soft-whitelist review notification (with its Approve/Deny buttons) and later edits that
 * same message to record the outcome. Because the message is sent with the bot's own
 * token, it is authored by the application, so the buttons' interactions are delivered to
 * the bot's gateway — which is what lets a plain notification carry working buttons.
 *
 * Role writes still never happen here; those remain the worker's and the bot's job.
 */
import { REST, Routes } from 'discord.js';
import { createLogger, serializeError } from '@frm/logging';

const log = createLogger('discord.rest-messages');

let cachedRest = null;
let cachedToken = null;

function restFor(token) {
  if (!cachedRest || cachedToken !== token) {
    // Bounded timeout so a hanging post/edit fails fast rather than stalling the request.
    cachedRest = new REST({ version: '10', timeout: 10_000 }).setToken(token);
    cachedToken = token;
  }
  return cachedRest;
}

/**
 * Posts a message to a channel. Returns the created message (with its id).
 * @param {object} params
 * @param {string} params.token bot token
 * @param {string} params.channelId
 * @param {object} params.body Discord message payload (content/embeds/components)
 */
export async function postChannelMessage({ token, channelId, body }) {
  try {
    return await restFor(token).post(Routes.channelMessages(channelId), { body });
  } catch (error) {
    log.error({ channelId, err: serializeError(error) }, 'failed to post channel message');
    throw error;
  }
}

/**
 * Edits a previously posted message (e.g. to disable the buttons and record the outcome).
 * @param {object} params
 * @param {string} params.token bot token
 * @param {string} params.channelId
 * @param {string} params.messageId
 * @param {object} params.body Discord message payload
 */
export async function editChannelMessage({ token, channelId, messageId, body }) {
  try {
    return await restFor(token).patch(Routes.channelMessage(channelId, messageId), { body });
  } catch (error) {
    log.error({ channelId, messageId, err: serializeError(error) }, 'failed to edit channel message');
    throw error;
  }
}
