/**
 * Administrator alerting.
 *
 * Used for the events an operator must not miss: an unapproved guild adding the bot, a
 * job pausing on the safety threshold, a mapping validation sweep finding broken roles.
 *
 * Delivery is best effort by design - an alerting failure must never abort the security
 * action it is reporting on. The audit record is the durable trail; the webhook is the
 * notification.
 */
import { createLogger, serializeError } from '@frm/logging';
import { getEnv } from '@frm/shared';

const log = createLogger('core.notify');

/**
 * @param {object} alert
 * @param {string} alert.title
 * @param {string} alert.description
 * @param {Array<{name: string, value: string}>} [alert.fields]
 * @param {'info'|'warning'|'critical'} [alert.severity]
 */
export async function notifyGlobalAdmins(alert) {
  const env = getEnv();
  const { title, description, fields = [], severity = 'warning' } = alert;

  log[severity === 'critical' ? 'error' : 'warn']({ alert: title, fields }, 'administrator alert');

  if (!env.ADMIN_ALERT_WEBHOOK_URL) return { delivered: false, reason: 'no webhook configured' };

  const colours = { info: 0x3498db, warning: 0xe67e22, critical: 0xe74c3c };

  try {
    const response = await fetch(env.ADMIN_ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        username: 'Florida Roleplay Manager',
        embeds: [
          {
            title: title.slice(0, 256),
            description: description.slice(0, 4000),
            color: colours[severity] ?? colours.warning,
            fields: fields.slice(0, 25).map((field) => ({
              name: String(field.name).slice(0, 256),
              value: String(field.value).slice(0, 1024),
              inline: true,
            })),
            timestamp: new Date().toISOString(),
          },
        ],
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      log.warn({ status: response.status }, 'admin alert webhook rejected the message');
      return { delivered: false, reason: `status ${response.status}` };
    }
    return { delivered: true };
  } catch (error) {
    // The URL itself is a secret and is redacted by the logger's configuration.
    log.error({ err: serializeError(error) }, 'admin alert webhook failed');
    return { delivered: false, reason: 'request failed' };
  }
}
