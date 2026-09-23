/**
 * AstroBaaS public core API.
 *
 * This barrel is the stable front door for theme and plugin authors. Import
 * from `astrobaas/core` (mapped in package.json `exports`) rather than reaching
 * into `src/lib/*` — internal modules may move between releases, but the
 * surface re-exported here is what STABILITY.md covers.
 *
 * @alpha — covered by semver once the project hits 1.0; until then, breaking
 * changes are possible but will be called out in the CHANGELOG.
 */

// ---- Domain models (pure types) ----
export type {
  Role,
  PostStatus,
  Post,
  Category,
  User,
  MediaFile,
  Theme,
  ThemeConfig,
  Setting,
  ThemeSettings,
  EntityType,
  ContentChange,
  PluginRecord,
  ContactMessage,
  Subscriber,
  CustomEntity,
  ApiKey,
  Webhook,
  // What the API hands back and STABILITY.md promises: a caller typing the
  // result of baas.webhooks.deliveries(), GET /api/audit or a revision list
  // needs these names, and importing them used to fail to compile.
  WebhookDelivery,
  AuditEvent,
  PostRevision,
  TwoFactor,
  DatabaseSchema,
  // Commerce
  Product,
  ProductImage,
  Brand,
  ProductCategory,
  Order,
  OrderItem,
  OrderStatus,
  Customer,
} from './models';

// ---- Storage contract ----
export type { Storage } from './storage';

// ---- Plugin system ----
export type { Plugin, FilterFn, ActionFn, PluginSettings, OrderLineExtras } from '../lib/plugin-system';
export { PluginManager, pluginManager, PLUGIN_HOOKS } from '../lib/plugin-system';

// ---- Author helpers (define* identity functions for type inference) ----
export { definePlugin, defineTheme } from './define';
export type { ThemeDefinition } from './define';

// ---- Theme slots (template override contract) ----
export { THEME_SLOTS, isThemeSlot, overriddenSlots } from './theme-slots';
export type {
  ThemeSlotName,
  ThemeSlotProps,
  ThemeComponents,
  HeaderProps,
  FooterProps,
  PostCardProps,
  PostCardData,
  PostArticleProps,
  SidebarProps,
  // These were missing, so a theme author importing from 'astrobaas/core'
  // could not type the very slots v2 and v3 added — the override compiled as
  // `any` and every prop typo went unnoticed until it rendered blank.
  HomeProps,
  PageArticleProps,
  BreadcrumbsProps,
  // …and the same for v4's TableOfContents, for the same reason.
  TableOfContentsProps,
  TocItem,
  BreadcrumbItem,
} from './theme-slots';

// ---- Structured data (schema.org builders) ----
//
// Exported because themes and decoupled storefronts are the consumers: a
// storefront that renders product pages needs the Product node, and a theme
// overriding a slot may want to add its own. Pure functions, no I/O.
export {
  organizationNode, webSiteNode, articleNode, webPageNode,
  collectionPageNode, productNode, siteIdentityNodes, structuredData,
} from '../lib/structured-data';
export type { SdContext, ArticleInput, ProductInput } from '../lib/structured-data';

// ---- Custom content types ----
export {
  registerContentType,
  getContentTypes,
  getContentType,
  schemaForContentType,
} from './content-types';
export type { ContentTypeDefinition, ContentTypeField } from './content-types';

// ---- Declarative plugin manifests (runtime-installable tier) ----
export {
  validateManifest,
  renderHeadTags,
  manifestContentTypes,
  apiRangeSatisfied,
  MANIFEST_API_VERSION,
  MANIFEST_LIMITS,
} from './manifest';
export type {
  PluginManifest,
  ManifestCapabilities,
  ManifestHeadTag,
  ManifestWebhook,
  ManifestValidationResult,
} from './manifest';

// ---- HTML sanitizer (use on any author-supplied HTML before set:html) ----
export { sanitizeHtml } from '../lib/sanitize';
// Text extraction, so a plugin computing a read time or an excerpt uses the
// SAME stripper the byline and the editor's analysis panel use. Five private
// copies existed and two of them disagreed about whether a tag boundary is a
// word boundary.
export { plainText, countWords, sentences, decodeEntities, truncateWords } from '../lib/html-text';

// ---- Input validation ----
export { validate, slugify } from '../lib/validate';
export type { Schema, FieldRule, ValidateOk, ValidateErr } from '../lib/validate';

// ---- API response contract (for custom endpoints that want the house shape) ----
export { ApiResponseBuilder } from '../lib/api-response';
export type { ApiResponse, ApiSuccessResponse, ApiErrorResponse } from '../lib/api-response';

// ---- Browser API client (CSRF-aware fetch helper; configurable token source) ----
export { api, apiFetch, configureApiClient } from '../lib/apiClient';
export type { ApiResult, ApiFetchOptions } from '../lib/apiClient';

// ---- Outbound webhooks (fire custom events; verify with signWebhook) ----
//
// `redeliver` is deliberately NOT here. Re-sending a logged delivery is an
// operator action, not a plugin one: it already has an authenticated route
// (POST /api/webhooks/deliveries/{id}/redeliver) and a client method
// (`baas.webhooks.redeliver(id)`), both of which check the caller's role. An
// export on the core barrel would be a promise to keep a signature stable for
// a caller that should be going through the API.
export { fireEvent, webhookMatches, webhookBody, WEBHOOK_EVENTS } from '../lib/webhooks';
export { signWebhook, newWebhookSecret } from '../lib/auth';

// ---- Email (pluggable transport; send notifications, provide a transport) ----
export { sendEmail, getEmailTransport, setEmailTransport, consoleTransport, webhookTransport } from '../lib/email';
export type { EmailMessage, EmailTransport } from '../lib/email';

// ---- Security audit log (record sensitive actions from plugins/custom routes) ----
export { recordAudit, AUDIT } from '../lib/audit';
export type { AuditDetails } from '../lib/audit';

// ---- Observability (structured error reporting from plugins/custom routes) ----
export { reportError } from '../lib/observability';
// Plugin storage, for use OUTSIDE route handlers (filters, actions, cron-like
// work). Inside a route handler prefer `ctx.store`, which is already bound to
// the owning plugin. `LocalDB` is exported as the backend argument only — its
// wider surface is not part of the stable API.
export { createPluginStore } from '../lib/plugin-platform/store';
// A plugin's own settings — the record the admin edits. Scoped to an id, so
// a plugin cannot read its neighbour's by reaching for LocalDB.getPlugins().
export { getPluginSettings, getPluginSetting } from '../lib/plugin-platform/settings';
export type { PluginStore } from '../lib/plugin-platform/store';
export { LocalDB } from '../lib/localdb';

// Payment gateways from plugins. A gateway author needs the provider contract
// and the webhook-refusal convention WITHOUT reading src/lib/payments/* — that
// is the difference between "the platform supports payment plugins" and "a
// stranger can ship one". `WebhookVerificationError` is exported as the model
// to copy: a plugin's own error class must merely END in "VerificationError"
// for the platform to answer 401 instead of 500 (see isWebhookVerificationError).
export type { PaymentProvider, PaymentOutcome, PaymentStatus } from '../lib/payments/types';
export { WebhookVerificationError } from '../lib/payments/types';
export type { ManualMethodDef } from '../lib/payments/registry';
