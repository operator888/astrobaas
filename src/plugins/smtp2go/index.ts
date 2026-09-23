import { definePlugin } from 'astrobaas/core';
import { setEmailTransport } from '../../lib/email';
import { smtp2goFromEnv, SMTP2GO_ENV } from '../../lib/email-smtp2go';

/**
 * SMTP2GO — sends AstroBaaS mail (password resets, contact forms, order
 * notifications) through SMTP2GO's HTTP API.
 *
 * This is the reference example for the `activate`/`deactivate` lifecycle and
 * for a *connector* plugin: one that swaps a core service implementation rather
 * than filtering content.
 *
 * Configure with environment variables, then activate the plugin:
 *
 *   SMTP2GO_API_KEY=api-XXXXXXXXXXXX
 *   SMTP2GO_SENDER="My Shop <no-reply@example.com>"
 *
 * The key is read from the environment on purpose. A connector that stored its
 * credential in plugin settings would put it in the database next to the
 * settings table's public read path, which is exactly the mistake this codebase
 * already fixed once.
 *
 * If the variables are missing, activation logs what is needed and leaves the
 * previous transport in place — a half-configured mail connector must not
 * silently swallow password-reset emails.
 */
export default definePlugin({
  id: 'smtp2go',
  name: 'SMTP2GO',
  version: '1.0.0',
  description: 'Send transactional email through SMTP2GO’s HTTP API.',
  author: 'AstroBaaS',

  activate() {
    const result = smtp2goFromEnv();
    if (!result.ok) {
      console.warn(
        `[smtp2go] not activated — missing ${result.missing.join(', ')}. ` +
          `Set ${SMTP2GO_ENV.join(' and ')}, then restart.`,
      );
      return;
    }
    setEmailTransport(result.transport);
    console.log('[smtp2go] email transport active');
  },

  deactivate() {
    // Revert to whatever EMAIL_TRANSPORT says. Passing null restores the
    // env-derived default rather than pinning the console transport, so
    // deactivating this plugin cannot quietly disable a configured fallback.
    setEmailTransport(null);
    console.log('[smtp2go] email transport reverted to the configured default');
  },
});
