/**
 * `/requestinterview` — file an interview request in this guild's request channel.
 *
 * Posts the request embed, opens a week-long thread off it named for the applicant, and pings
 * this guild's configured roles inside the thread so they are added. Works in the main guild
 * (staff) and every department guild (its training program); see lib/requestThreads.js.
 */
import { SlashCommandBuilder } from 'discord.js';
import { addRequestOptions, runRequest } from '../lib/requestThreads.js';

// The request channel's own visibility is the gate (like SSRP), so no linked actor is needed.
export const actorExempt = true;

export const data = addRequestOptions(
  new SlashCommandBuilder().setName('requestinterview').setDescription('Request an interview — opens a thread and pings the interviewers').setDMPermission(false),
  'interview',
);

export async function execute(interaction) {
  return runRequest(interaction, 'interview');
}
