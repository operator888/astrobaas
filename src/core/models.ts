/**
 * Core domain models for AstroBaaS.
 *
 * These are pure TypeScript types with NO storage/runtime dependency — the
 * database engine (currently lowdb via src/lib/localdb.ts) imports them, not the
 * other way around. Theme and plugin authors should import these from
 * `astrobaas/core` rather than reaching into the storage layer.
 *
 * @alpha — shapes may still change before 1.0; see STABILITY.md.
 */

/** User roles, from most to least privileged. */
/**
 * `manager` is SHOP STAFF: they run the catalogue and need to see orders and
 * customers to do it, but nothing that changes how the site is built, who can
 * log in, or where money goes. Capability predicates live in `lib/auth.ts`;
 * which admin SCREENS each role may open lives in `lib/admin-access.ts`.
 */
export type Role = 'admin' | 'editor' | 'author' | 'manager' | 'viewer';

/**
 * Every role, as VALUES, for the places that validate a role string.
 *
 * Adding `manager` to the union above compiled fine and then failed at runtime,
 * because three request validators and two admin `<select>`s each carried their
 * own hand-written copy of the list. `satisfies` ties this array to the union,
 * so the two cannot drift: dropping a role here, or adding one to the union and
 * forgetting it here, is a type error rather than a 422 nobody expected.
 */
export const ROLES = ['admin', 'editor', 'author', 'manager', 'viewer'] as const satisfies readonly Role[];

/** Post lifecycle states. */
export type PostStatus = 'draft' | 'review' | 'scheduled' | 'published' | 'trashed';

export interface Post {
  id: string;
  title: string;
  slug: string;
  content: string;
  excerpt?: string;
  featured_image?: string;
  status: PostStatus;
  /**
   * `'post'` (default) or `'page'`.
   *
   * A Page is the same record with a different route: `/about` instead of
   * `/blog/about`, and no date or author byline. Deliberately NOT a new
   * collection — a Post is one JSON document on all three storage drivers, so
   * this costs zero DDL and inherits revisions, autosave, i18n, sanitization,
   * the editor and the permission model for free.
   *
   * Optional, and absent means `'post'`, so every existing row keeps behaving
   * exactly as it does now.
   */
  kind?: 'post' | 'page';
  meta_title?: string;
  meta_description?: string;
  /**
   * Keep this one post or page out of search results.
   *
   * Absent means indexable, so every existing record keeps its behaviour —
   * the same convention `kind` uses. A noindexed post is ALSO dropped from
   * the sitemap and the feed: advertising a URL that then tells crawlers not
   * to index it is a contradictory signal, and search engines treat the
   * contradiction as a reason to trust the whole sitemap less.
   */
  noindex?: boolean;
  /**
   * Pin to the top of a listing.
   *
   * Absent means not pinned, like `kind` and `noindex` — so every row written
   * before this existed sorts exactly as it did, and the new ordering is
   * byte-identical to the old one until an editor actually pins something.
   * That is the only reason it is safe as the DEFAULT rather than an opt-in
   * `?sort=` that a headless storefront would never think to send.
   */
  /** The phrase this page is written to be found for. Drives the editor's analysis only. */
  focus_keyphrase?: string;
  pinned?: boolean;
  /**
   * Manual position within a listing, ascending. Absent sorts LAST.
   *
   * Named after the field WordPress uses, because an importer maps to it and a
   * migrating editor looks for it. Absent-last rather than absent-first: an
   * editor who orders three posts out of four hundred means "these three at the
   * front", not "these three, then chaos".
   */
  menu_order?: number;
  author_id: string;
  category_id?: string;
  tags?: string[];
  publish_date?: string;
  views: number;
  /**
   * BCP-47 locale this post is written in (schema v4). Absent on records written
   * before i18n existed — readers treat that as the default locale, so a
   * single-locale install behaves exactly as before.
   */
  locale?: string;
  /**
   * Groups translations together: every translation of the same content shares
   * one `translation_of` value (conventionally the id of the original post).
   * Absent means "not part of a translation group".
   */
  translation_of?: string;
  created_at: string;
  updated_at: string;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  description?: string;
  created_at: string;
  updated_at: string;
}

/**
 * Optional TOTP two-factor config on an account. Server-side only — the `secret`
 * and `backup_codes` MUST never be returned by any API (see the strip in
 * users routes + /api/auth/me). Absent = 2FA not set up.
 */
export interface TwoFactor {
  enabled: boolean; // false while a secret is generated but not yet confirmed
  secret: string; // base32 TOTP secret
  backup_codes: string[]; // SHA-256 hashes of single-use recovery codes
  enrolled_at?: string; // when 2FA was confirmed (enabled)
}

/**
 * One signed-out session token, remembered until it would have expired anyway.
 * Server-side only; stripped by `toPublicUser`.
 */
export interface RevokedSession {
  /** The token's own id (`jti`). */
  jti: string;
  /** The token's expiry (epoch ms), after which the note is pruned. */
  exp: number;
}

export interface User {
  id: string;
  name: string;
  email: string;
  role: Role;
  password_hash?: string;
  password_salt?: string;
  session_version?: number;
  /**
   * Session tokens this person signed out of before they expired (S3.11).
   * Bounded and self-pruning; see `revocationPatch` in lib/auth.ts.
   */
  revoked_sessions?: RevokedSession[];
  avatar?: string;
  status: 'active' | 'inactive';
  last_login?: string;
  posts_count: number;
  two_factor?: TwoFactor;
  created_at: string;
  updated_at: string;
  /**
   * Has this person agreed to a public archive of their posts? (C-153)
   *
   * Absent means NO. An archive publishes a staff member's display name at a
   * stable public URL, and on a shop the "authors" are staff rather than
   * bylined journalists — so the default that publishes nothing is the only
   * safe one.
   */
  public_archive?: boolean;
}

export interface MediaFile {
  id: string;
  filename: string;
  original_name: string;
  mime_type: string;
  size: number;
  url: string;
  alt_text?: string;
  uploaded_by: string;
  created_at: string;
  /**
   * The 400px WebP derivative, and the original's dimensions.
   *
   * These were generated on upload and then attached to the RESPONSE object
   * after the record was created — so the API returned them and the database
   * never held them. The library consequently rendered 1.4 MB originals as
   * 200px tiles, and the test suite passed because it asserted on the
   * response rather than on the stored record.
   *
   * Optional because rows written before this exist, and because the sharp
   * pipeline legitimately skips non-images.
   */
  thumb_url?: string;
  width?: number;
  height?: number;
  /**
   * A folder LABEL (C-61), not a directory. See lib/media/folders.ts.
   *
   * `PATCH /api/media/update` has stored this since it was written, and it was
   * absent from this interface — so it was invisible to every typed reader and
   * no filter could see it. A write-only phantom.
   */
  folder?: string;

  /**
   * The bytes exactly as they were uploaded.
   *
   * `url` points at a re-encoded WebP capped at the largest configured width,
   * because that is what a storefront should render. The original is kept
   * alongside it, untouched, so an operator can download what they put in — a
   * print-resolution product photo is an asset the shop owns, and a CMS that
   * silently replaces it with a 1600px WebP has thrown away the master copy.
   *
   * Optional: rows written before this existed had their original deleted after
   * re-encoding, and non-image uploads never had a separate one.
   */
  original_url?: string;

  /**
   * The fixed set of web-ready derivatives, ascending by width.
   *
   * Storefronts build a srcset from this instead of running their own image
   * optimizer — which is what put 31,349 generated files and a permanent
   * memory ceiling on one shop. Each entry carries its OWN width and height
   * rather than being looked up by position, so changing the configured widths
   * later cannot silently re-interpret rows already written.
   */
  variants?: MediaVariant[];

  /**
   * What the image pipeline managed to do, when it did not manage everything.
   *
   * Absent on a healthy upload. Present — and surfaced by the deep health
   * check — when sharp was missing or a width failed, because "the upload
   * succeeded and quietly optimised nothing" is the exact failure that served
   * full-size originals on a live shop for weeks.
   */
  pipeline?: MediaPipelineReport;
}

/** One generated derivative of an uploaded image. */
export interface MediaVariant {
  width: number;
  height: number;
  /** Site-root-relative, like every other stored media url. */
  url: string;
  size: number;
  format: 'webp';
}

export interface MediaPipelineReport {
  /** `ok` when every planned derivative was written. */
  status: 'ok' | 'degraded' | 'unavailable';
  /** Why, in a sentence an operator can act on. */
  reason?: string;
  /** Widths that were planned and did not land. */
  failed_widths?: number[];
}

export interface ThemeConfig {
  colors: {
    primary: string;
    secondary: string;
    accent: string;
    background: string;
    text: string;
    /**
     * Semantic colours. Optional so every existing stored theme stays valid —
     * absent values fall back to the :root defaults in global.css, which is why
     * a theme customized before this existed looks identical after it.
     */
    surface?: string;
    muted?: string;
    border?: string;
    /** Text on a primary-coloured background. Derived from `primary` when absent. */
    onPrimary?: string;
    success?: string;
    warning?: string;
    danger?: string;
  };
  typography: {
    headingFont: string;
    bodyFont: string;
    fontSize: string;
    /** Enum keys — see src/lib/theme-tokens.ts. */
    scale?: string;
    headingWeight?: string;
    letterSpacing?: string;
  };
  /**
   * Shape, spacing and layout. Every value is an ENUM KEY, never CSS: the key
   * selects a pre-authored declaration block in src/lib/theme-tokens.ts, so a
   * stored value can choose a look but can never *be* CSS.
   */
  style?: {
    radius?: string;
    density?: string;
    shadow?: string;
    containerWidth?: string;
    buttonStyle?: string;
    headerStyle?: string;
  };
  /**
   * 'light' | 'dark' | 'auto'. `auto` follows the visitor's OS preference and
   * can be overridden by the on-site toggle, which persists in a cookie so the
   * server can render the right scheme directly — no inline script, no flash.
   */
  colorScheme?: string;
  /**
   * A theme may author its own dark colours. When absent, a conservative dark
   * palette is derived from the light one.
   */
  darkColors?: {
    primary?: string;
    secondary?: string;
    accent?: string;
    background?: string;
    surface?: string;
    text?: string;
    muted?: string;
    border?: string;
  };
  /**
   * Operator-authored CSS, appended to the generated token stylesheet at
   * /theme.css. Served same-origin (never inlined) so it works under the
   * hash-based CSP. Sanitized on write and on render.
   *
   * NOTE: there is deliberately no `layout` field. It previously carried
   * headerStyle/footerStyle/sidebarPosition, which nothing ever rendered —
   * removed in schema v3 rather than left as config that implies capability
   * the templates don't have. Real template-level theming is roadmapped.
   */
  customCSS?: string;
}

export interface Theme {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  status: 'active' | 'inactive';
  screenshot?: string;
  settings: ThemeConfig;
  created_at: string;
  /**
   * Present only on themes INSTALLED from a manifest rather than compiled in.
   *
   * Its presence is what distinguishes the two tiers: a bundled theme resolves
   * its CSS, patterns and slot components from `src/themes/`, a declarative one
   * carries them here. Optional, so every theme row written before declarative
   * themes existed stays valid and keeps resolving as bundled.
   *
   * Themes are persisted as whole JSON documents on all three storage drivers,
   * so this needs no DDL and no migration.
   */
  manifest?: import('./theme-manifest').ThemeManifest;
  /** "upload" or "registry:<name>". */
  installed_from?: string;
}

export interface Setting {
  id: string;
  key: string;
  value: any;
  category: string;
  created_at: string;
  updated_at: string;
}

export interface ThemeSettings {
  id: string;
  theme_id: string;
  settings: any;
  created_at: string;
  updated_at: string;
}

/** Built-in entity kinds; custom content types register additional string ids. */
export type EntityType =
  | 'post' | 'theme' | 'setting' | 'category' | 'user' | 'plugin'
  | 'product' | 'brand' | 'product-category' | 'order' | 'customer'
  | (string & {});

export interface ContentChange {
  id: string;
  entity_type: EntityType;
  entity_id: string;
  action: 'create' | 'update' | 'delete';
  changes: any;
  timestamp: string;
  /**
   * The names of the fields an UPDATE touched, recorded by the write path that
   * knew the patch. Absent on creates and deletes, on entries written before it
   * existed, and wherever the writer could not say — absent means "unknown,
   * assume everything", never "nothing". This is what a public caller gets in
   * place of the snapshot: enough to decide what to revalidate, nothing of what
   * the record said. See core/change-feed.ts.
   */
  fields?: string[];
}

export interface PluginRecord {
  id: string;
  active: boolean;
  settings: Record<string, any>;
  installed_at: string;
  updated_at: string;
}

export interface ContactMessage {
  id: string;
  name: string;
  email: string;
  subject?: string;
  message: string;
  read: boolean;
  created_at: string;
  /**
   * The structural spam score (C-79), written ONLY when a message was flagged.
   *
   * Absent on an ordinary message on purpose: a `spam_score: 0` on every row is
   * a column of zeroes that makes the flagged ones no easier to find.
   *
   * Nothing is rejected on this — a flagged message is stored and shown to a
   * person, because rejecting on a heuristic means the one enquiry that
   * mattered is the one that vanished, and the sender was told it went through.
   */
  spam_score?: number;
  spam_flagged?: boolean;
  /** One sentence per signal, so the admin can say WHY without re-scoring. */
  spam_reasons?: string[];
}

/**
 * Proof that a consent decision was made, holding nothing about who made it.
 *
 * Article 7(1) requires the controller to be able to DEMONSTRATE that consent
 * was given. The obvious way — log the IP and the user agent with every
 * decision — answers a privacy obligation by collecting more personal data,
 * and every one of those rows is then itself subject to access and erasure
 * requests.
 *
 * So a receipt carries only the decision: which categories, under which
 * version of the policy, at what time, under an opaque id. That id is written
 * into the visitor's own consent cookie, so the person who made the decision
 * holds the reference to it and nobody else can be linked to it at all. In a
 * dispute the operator can show the record exists and what it says; the
 * visitor can point at the receipt in their own browser.
 */
export interface ConsentReceipt {
  /** Opaque, generated by the visitor's browser. Not derived from anything. */
  id: string;
  /** The categories granted. `necessary` is always among them. */
  granted: string[];
  /** Which version of the consent text this decision was made against. */
  version: number;
  created_at: string;
}

/**
 * One outbound email, as it went out.
 *
 * "Did the order confirmation reach them?" is the single most common support
 * question a shop gets, and until now the only answer was a Node process's
 * memory of its most recent send. This is the log that answers it.
 *
 * The BODY is deliberately not here. A password-reset link, a magic sign-in
 * link and an invoice all go through the same sender, and a log that kept
 * their contents would be a store of live credentials that every admin can
 * read. The subject line and the outcome answer the question; the body never
 * needed to.
 *
 * The recipient IS here, because without it the log answers nothing — which
 * makes this personal data, which is why `lib/gdpr.ts` searches and erases it
 * along with everything else.
 */
export interface EmailLogEntry {
  id: string;
  /** The recipient address. */
  to: string;
  subject: string;
  /** Which transport carried it — smtp2go, webhook, console… */
  transport: string;
  ok: boolean;
  /** Present on failure. The message only, never the recipient or the body. */
  error?: string;
  /**
   * The server's final reply on success, when the transport has one — SMTP's
   * `250 2.0.0 Ok: queued as 4ab1`. The queue id is what a mail host needs to
   * trace a message a customer says never arrived.
   */
  response?: string;
  /**
   * `unknown` (with `ok: false`): the whole message was sent and the server
   * never answered, so it may have been delivered — and it was not sent again.
   * Absent for a message that went and for one that plainly failed.
   */
  outcome?: 'unknown';
  created_at: string;
}

export interface Subscriber {
  id: string;
  email: string;
  created_at: string;
}

/** A record stored in a custom (plugin-registered) content collection. */
export interface CustomEntity {
  id: string;
  type: string;
  data: Record<string, any>;
  created_at: string;
  updated_at: string;
}

/**
 * An API key for cross-origin / headless / agent access. The secret is hashed
 * at rest (only `prefix` is stored in clear, for display); the full key is shown
 * once at creation. `role` is the privilege the key acts as.
 */
export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  key_hash: string;
  role: Role;
  /**
   * Optional least-privilege scopes (`resource:action`, e.g. `["posts:write"]`).
   * Empty/absent = unrestricted (governed only by `role`). Enforced centrally.
   */
  scopes?: string[];
  /** Optional ISO expiry. Absent = never expires. */
  expires_at?: string;
  /**
   * Trust this key's `X-AstroBaaS-Client-IP` header as the shopper's address
   * (S3.6). For a storefront SERVER (a BFF) that calls the API on a shopper's
   * behalf: without it, every shopper shares the server's one address. Absent
   * or false = the header is ignored. Only an admin can set it.
   */
  forward_client_ip?: boolean;
  last_used?: string;
  created_at: string;
}

/** A registered outbound webhook fired on content events. */
export interface Webhook {
  id: string;
  url: string;
  /** Event names this endpoint subscribes to, e.g. ["post.created"]. '*' = all. */
  events: string[];
  /** HMAC secret used to sign deliveries (X-AstroBaaS-Signature). */
  secret: string;
  active: boolean;
  /**
   * Provenance. Absent for operator-created webhooks; `plugin:<id>` for ones a
   * declarative plugin manifest declared, so uninstalling that plugin can remove
   * exactly its own subscriptions and nothing else.
   */
  source?: string;
  created_at: string;
}

/**
 * A single attempt-tracked delivery of an event to a webhook. Persisted so the
 * dispatcher can retry with backoff, operators can inspect failures, and a
 * delivery can be manually re-sent. `payload` is the exact signed request body.
 */
export interface WebhookDelivery {
  id: string;
  webhook_id: string;
  url: string;
  event: string;
  payload: string;
  status: 'pending' | 'success' | 'failed';
  attempts: number;
  /** HTTP status of the last attempt (absent if it never got a response). */
  last_status?: number;
  /** Error message of the last attempt (absent on success). */
  last_error?: string;
  created_at: string;
  updated_at: string;
}

/**
 * A security-relevant action recorded in the audit log (logins, API-key and
 * webhook lifecycle, role/status changes, password resets). Distinct from
 * `ContentChange` (content mutations) — this is the who-did-what security trail.
 */
/**
 * A point-in-time snapshot of a post's editable content.
 *
 * Deliberately stored in its OWN collection rather than as a `CustomEntity`:
 * revisions contain unpublished draft text, and the generic
 * `GET /api/content/<type>` route is public. Keeping them in a dedicated store
 * means no route can reach them by accident — the same reasoning that gave
 * AuditEvent and WebhookDelivery their own collections.
 */
export interface PostRevision {
  id: string;
  post_id: string;
  title: string;
  content: string;
  excerpt?: string;
  /** Who produced this snapshot. */
  author_id: string;
  /**
   * `edit` — captured automatically before an update overwrote the post.
   * `autosave` — captured from the editor while drafting.
   * `restore` — the snapshot taken just before a restore, so restoring is undoable.
   */
  kind: 'edit' | 'autosave' | 'restore';
  created_at: string;
}

export interface AuditEvent {
  id: string;
  /** Dotted action name, e.g. 'auth.login.success', 'apikey.create'. */
  action: string;
  /** Who performed it: a user id, `apikey:<id>`, an email, or 'anonymous'. */
  actor: string;
  /** What was acted on (an id/name), when applicable. */
  target?: string;
  /** Client IP, when known. */
  ip?: string;
  /** Extra non-secret context (never store secrets/tokens here). */
  metadata?: Record<string, any>;
  created_at: string;
}

/* ── Commerce (first-class since the commerce module) ──────────────── */

/**
 * A postal address.
 *
 * EVERY FIELD IS OPTIONAL, and that is a decision rather than laziness: a phone
 * order taken at the counter is a partial address, an order placed before this
 * existed has none at all, and one interface has to describe both without
 * lying. Completeness is a question the WRITE PATH asks (`isCompleteAddress`),
 * where it can be answered differently for a parcel and for a draft.
 *
 * Stored as a COPY wherever it is used on an order — see the note on
 * `Order.shipping_address`.
 */
export interface Address {
  /**
   * Who receives it — deliberately separate from `Order.name`. A gift, a
   * parcel to a workplace, a spouse who collects: the label's first line is
   * not always the buyer's name.
   */
  name?: string;
  /** Needed to invoice a legal entity, and a doorman routes by it. */
  company?: string;
  /** Street and number. The one line an address cannot do without. */
  line1?: string;
  /** Floor, doorbell, care-of. Routine in Greece, and a courier without it
   *  leaves a card instead of a parcel. */
  line2?: string;
  city?: string;
  /** State / province / prefecture. Meaningless for a Greek delivery and
   *  mandatory for a US or Canadian carrier label. Never validated against a
   *  list here: core does not ship a subdivision dataset. */
  region?: string;
  postcode?: string;
  /** ISO 3166-1 alpha-2, upper case — the same vocabulary as
   *  `ShippingZone.countries` and `Order.shipping_country`, so a country that
   *  can be shipped to and one that can be stored are the same set. */
  country?: string;
  /** A delivery phone, which is not always the account phone. */
  phone?: string;
  /**
   * ΑΦΜ / VAT identifier, for a business buyer who needs an invoice rather
   * than a receipt.
   *
   * **CAPTURE, not compliance.** Owner decision, 2026-09-04: AstroBaaS is not a
   * fiscal device and will not become one. The shop issues its receipts and
   * τιμολόγια from its own certified equipment (ΦΗΜ), which is what numbers
   * them, signs them and reports them. What this system owes is the correct
   * ΦΠΑ on the line and the counterparty's ΑΦΜ recorded beside the order, so
   * whoever operates that equipment has both without retyping them.
   *
   * That is also why nothing here validates a checksum or a VIES registration:
   * a refusal on this field would block an order over a number this system
   * never acts on. Optional costs a receipts-only shop nothing, and means the
   * shop that starts issuing τιμολόγια needs no second migration.
   */
  tax_id?: string;
}

/**
 * An address in a customer's own address book.
 *
 * `id` is stable and local to the customer, so the account UI can edit one
 * entry without rewriting the array.
 */
export interface SavedAddress extends Address {
  id: string;
  /** The customer's own word for it — "Home", "Δουλειά". Never shown to staff
   *  as a category; it is a label, not a type. */
  label?: string;
  /**
   * At most one of each may be true across the book, enforced when the book is
   * WRITTEN (see normalizeSavedAddresses). Two independent booleans rather
   * than one 'billing' | 'shipping' | 'both' enum: "both" is not a third kind
   * of address, it is two answers to two questions.
   */
  default_shipping?: boolean;
  default_billing?: boolean;
}


/**
 * One item in a product's media gallery; `src` may be a local /media path or
 * an absolute URL.
 *
 * Still called ProductImage, and the field is still `images`, because renaming
 * both would rewrite every stored row and every headless storefront reading
 * them for a gain that is entirely cosmetic.
 *
 * `kind` is ABSENT for an image rather than set to `'image'`. Every row written
 * before video existed has no kind and must keep meaning what it meant, so
 * absent has to be the image case; writing it out explicitly would also add a
 * field to thirty gallery entries per product to say the default. A consumer
 * asks `kind === 'video'`, never `kind === 'image'`.
 */
export interface ProductImage {
  src: string;
  alt?: string;
  /**
   * Absent means image IN STORAGE. On the wire it is always present — the
   * product API derives it on read, so a client never has to infer it from a
   * filename. See `withMediaKind`.
   */
  kind?: 'image' | 'video';
  /**
   * The media library's own `mime_type`, attached on READ when the src resolves
   * to a media record. Never stored — it would be a second copy of a fact the
   * media table owns, and the two would drift the first time a file was
   * replaced.
   */
  mime_type?: string;
  /**
   * A still to show before a video plays — `<video poster="…">`.
   *
   * MEANINGLESS on an image entry, and only ever set on a video one.
   *
   * No frame is extracted from the video: that needs ffmpeg, which is a large
   * native dependency to add to a CMS so that one field can be filled in
   * automatically, and it fails in exactly the environments least able to debug
   * it. An editor nominating an existing photograph is enough, and a shop
   * choosing its own poster gets a better one than a decoder picking frame
   * zero — which on a product video is very often black.
   *
   * STORED when an editor nominates one. Absent on the wire means the reader
   * fell back to the product's first photograph, which is what a gallery
   * showing a video alongside its photos wants anyway.
   */
  poster?: string;
}

/**
 * One buyable variation of a product — a specific colour/size combination.
 *
 * Eyewear made this non-optional: every frame ships in several colours and
 * often several sizes, and modelling those as separate products breaks
 * inventory (each colour has its own count), search (five near-identical rows),
 * and the product page (no colour picker).
 *
 * A variant carries its own stock and may override price, SKU, barcode, weight
 * and image. Anything it does NOT set falls back to the parent, so a shop that
 * varies only colour does not restate the price five times.
 */
export interface ProductVariant {
  id: string;
  /**
   * Chosen value per attribute, e.g. `{ "Colour": "Black", "Size": "52" }`.
   * Keys match `ProductAttribute.name` on the parent.
   */
  options: Record<string, string>;
  sku?: string;
  gtin?: string;
  /** Overrides the parent price. Absent = inherit. */
  price_cents?: number | null;
  regular_price_cents?: number | null;
  sale_price_cents?: number | null;
  /** null = untracked, like the parent. */
  stock: number | null;
  in_stock: boolean;
  weight_grams?: number | null;
  /** Image src, normally one of the parent's. */
  image?: string;
  enabled: boolean;
}

/** A product attribute, e.g. { name: "Colour", values: ["Black", "Tortoise"] }. */
export interface ProductAttribute {
  name: string;
  values: string[];
  /** Show on the product page. Attributes used only for filtering can be hidden. */
  visible: boolean;
}

/** A downloadable file granted after purchase. */
export interface ProductDownload {
  name: string;
  url: string;
}

/**
 * Physical dimensions in MILLIMETRES, as integers.
 *
 * Same reason money is in cents: floats drift, and a shipping calculator that
 * disagrees with the warehouse by 0.30000000000000004 mm is a support ticket.
 * The admin shows cm/inches; storage stays integral.
 */
export interface ProductDimensions {
  length_mm: number;
  width_mm: number;
  height_mm: number;
}

/** What happens when a tracked product runs out. */
export type BackorderPolicy =
  /** Refuse the sale. The default, and the only one that cannot oversell. */
  | 'no'
  /** Allow, and flag it to staff. */
  | 'notify'
  /** Allow silently. */
  | 'yes';

/** Where a product appears. Mirrors WooCommerce's catalog visibility. */
export type CatalogVisibility = 'visible' | 'catalog' | 'search' | 'hidden';

/** Whether a product is taxed, and how. */
export type TaxStatus = 'taxable' | 'shipping' | 'none';

/**
 * Per-locale overrides for a record's textual fields.
 *
 * `{ de: { name: 'Fassung X' } }` — only the fields that differ. Absent means
 * the record exists in one language, which is true of every record written
 * before this and is why adding it needed no migration.
 *
 * NOT the model posts use. A post is a document, so each language is its own
 * record (`locale` + `translation_of`). A product is one physical object with
 * one stock count and one SKU that needs labels in three languages — cloning it
 * per locale would fork inventory identity and leave `OrderItem.product_id`
 * pointing at whichever clone the buyer happened to use.
 *
 * See lib/i18n/catalogue-translations.ts for the rule and the projection.
 */
export type TranslationMap = Record<string, Record<string, string>>;

export interface Product {
  /** Per-locale text, projected into the scalar fields on read. */
  i18n?: TranslationMap;

  id: string;
  name: string;
  slug: string;
  sku?: string;
  description?: string;
  short_description?: string;
  /** Integer minor units (cents). The house rule: never floats for money. */
  price_cents: number;
  regular_price_cents?: number;
  sale_price_cents?: number | null;
  on_sale: boolean;
  /** null = not tracked */
  stock: number | null;
  in_stock: boolean;
  /** product-category slugs */
  categories: string[];
  /** brand slug */
  brand?: string;
  images: ProductImage[];
  /** Optional GLB/GLTF model for 3D viewers. */
  model_url?: string;
  /** Curated homepage/featured flag. */
  featured?: boolean;
  /** Manual sort order in listings (lower = earlier). */
  position?: number;
  status: 'active' | 'draft' | 'archived';

  /* ---------------- catalogue identity ---------------- */
  /**
   * GTIN / UPC / EAN / ISBN. One field rather than four, matching how
   * WooCommerce settled the question: they are all the same barcode slot and
   * splitting them only produces four columns of which three are always empty.
   */
  gtin?: string;
  /** Free-form tags for filtering and merchandising. */
  tags?: string[];
  catalog_visibility?: CatalogVisibility;

  /* ---------------- pricing ---------------- */
  /**
   * Sale window, ISO dates. `on_sale` is still the stored truth for what is
   * charged; these bound WHEN it may be true.
   *
   * **Evaluated on WRITE, not on a timer.** An earlier version of this comment
   * said a scheduler flipped the flag. There is no such scheduler — the one
   * that exists publishes due posts and sweeps abandoned orders — and
   * `saleActiveAt()` had no production caller at all, so these two fields were
   * stored, validated, unit-tested, and read by nothing.
   *
   * They are now honoured by `deriveSaleState()`, which every write path goes
   * through: a window that has not opened, or has closed, holds `on_sale` at
   * false and leaves `price_cents` at the regular price. A sale that becomes
   * due tomorrow therefore goes live the next time the product is saved, NOT at
   * midnight. Queue a sale in advance and it will not fire on its own.
   */
  sale_starts_at?: string | null;
  sale_ends_at?: string | null;
  /**
   * What this product has cost, oldest first — the EU Omnibus evidence.
   *
   * Appended only when the EFFECTIVE price moves, pruned to the window the rule
   * looks back over, and hard-capped. Derived, never accepted from a client:
   * a shop that could post its own price history could evidence a reference
   * price it never charged, which is the exact claim the rule forbids.
   *
   * See `lib/commerce/price-history.ts` for why it lives here rather than in a
   * collection of its own.
   */
  price_history?: { p: number; at: string }[];

  /**
   * GPSR — Regulation (EU) 2023/988, in force since 13 December 2024.
   *
   * An online listing must identify the manufacturer and, where the
   * manufacturer is outside the EU, a person INSIDE the EU responsible for the
   * product; must carry warnings and safety information in the consumer's
   * language; and must let the product be traced (type, batch or serial).
   *
   * Free and in the core, because a listing that cannot carry the data cannot
   * lawfully be sold from — and a merchant must never be unable to comply
   * because they did not pay. What a pack could sell on top is the checking:
   * "which of my 400 products are missing a responsible person", per-market
   * warning translations, and the recall workflow.
   *
   * Stored as plain fields rather than a sub-object so a feed importer, a CSV
   * and the admin form all write the same shape.
   */
  gpsr_manufacturer?: string;
  /** Name and contact of the EU-responsible person, when the maker is outside the EU. */
  gpsr_eu_responsible?: string;
  /** Type, batch or serial — whatever identifies THIS unit for a recall. */
  gpsr_identifier?: string;
  /** Warnings and safety information, shown to the buyer before purchase. */
  gpsr_warnings?: string;
  /** Care and use instructions, where safety depends on them. */
  gpsr_instructions?: string;
  tax_status?: TaxStatus;
  /** Tax class slug ("standard", "reduced-rate", …). Interpreted by the operator. */
  tax_class?: string;

  /* ---------------- inventory ---------------- */
  /**
   * Whether `stock` is authoritative. Redundant with `stock === null` on
   * purpose: an operator who turns tracking off and back on keeps their count
   * instead of losing it to a null.
   */
  manage_stock?: boolean;
  /** Warn staff at or below this. Null = no warning. */
  low_stock_threshold?: number | null;
  backorders?: BackorderPolicy;
  /** At most one per order, whatever the order limits say. */
  sold_individually?: boolean;

  /* ---------------- shipping ---------------- */
  /** Integer grams. See ProductDimensions for why not floats. */
  weight_grams?: number | null;
  dimensions_mm?: ProductDimensions | null;
  /** Shipping class slug, interpreted by the operator's rates. */
  shipping_class?: string;
  /** False for virtual goods; suppresses address/shipping steps. */
  requires_shipping?: boolean;

  /* ---------------- nature ---------------- */
  virtual?: boolean;
  downloadable?: boolean;
  downloads?: ProductDownload[];

  /* ---------------- merchandising ---------------- */
  /** Product ids suggested as an upgrade. */
  upsell_ids?: string[];
  /** Product ids suggested at checkout. */
  cross_sell_ids?: string[];
  attributes?: ProductAttribute[];
  /**
   * Values for the fields THIS MERCHANT declared — see core/product-fields-def.ts.
   *
   * Keys are declared field names. A key whose definition was later deleted is
   * carried through untouched rather than dropped: removing a definition is how
   * a merchant hides a field, and it must not also destroy an afternoon of data
   * entry. What the public sees is decided at READ time by
   * `publicCustomFields`, so flipping a field from public to staff hides it on
   * the very next request instead of waiting for every product to be re-saved.
   *
   * Deliberately NOT `attributes` above: those are variant AXES that
   * `ProductVariant.options` keys into and `OrderItem.variant_options` freezes
   * at purchase. Merchant metadata stored there would invent phantom axes and
   * break every variable product.
   */
  custom?: Record<string, unknown>;
  /**
   * `variable` products are bought through a variant; `simple` ones directly.
   * Derived from whether `variants` is non-empty, and stored so a listing can
   * filter without loading every variant.
   */
  type?: 'simple' | 'variable';
  /**
   * Buyable variations. When present, checkout REQUIRES a variant_id — an
   * order for "the frame" without saying which colour is not fulfillable.
   */
  variants?: ProductVariant[];
  /**
   * This product cannot be made without a prescription — spectacle lenses,
   * contact lenses. The optical module refuses a line for it without a valid Rx; core stores the flag and enforces nothing, because
   * an order the lab cannot fill is worse than no order.
   */
  requires_prescription?: boolean;
  /** Which Rx form to collect. Contacts need base curve and diameter. */
  prescription_type?: 'spectacles' | 'contacts';
  /** Shown to the buyer after purchase (care instructions, licence keys…). */
  purchase_note?: string;
  reviews_enabled?: boolean;

  created_at: string;
  updated_at: string;
}

/**
 * Persisted shipping method / coupon.
 *
 * The behavioural shape lives in lib/commerce/{shipping,coupons}.ts, which are
 * pure; these aliases keep DatabaseSchema the single description of what is
 * stored without duplicating the field lists.
 */
import type { ShippingMethod as ShippingMethodRecord } from '../lib/commerce/shipping';
import type { Coupon as CouponRecord } from '../lib/commerce/coupons';
export type { ShippingMethodRecord, CouponRecord };

export interface Brand {
  /** Per-locale text. See TranslationMap. */
  i18n?: TranslationMap;

  id: string;
  name: string;
  slug: string;
  logo?: string;
  created_at: string;
  updated_at: string;
}

export interface ProductCategory {
  /** Per-locale text. See TranslationMap. */
  i18n?: TranslationMap;

  id: string;
  name: string;
  slug: string;
  parent_slug?: string;
  /** Menu/listing order (lower = earlier). */
  position?: number;
  /**
   * An AUTOMATIC collection: membership decided by a rule rather than by hand.
   *
   * Absent = an ordinary manual category, which is every row today.
   *
   * Membership is derived at READ time and never written into
   * `Product.categories`. Two stored answers would disagree the moment a price
   * changed and nobody re-ran a sweep, and the stored one would not carry the
   * reason — so "why is this product here?" would have no answer.
   *
   * Typed loosely here to keep core/models free of a commerce import; the real
   * shape and its validator live in lib/commerce/collections.ts.
   */
  rule?: unknown;
  /**
   * `'add'` (or absent) — the rule ADDS to what was filed by hand, so an
   * automatic collection never removes a product a human deliberately placed.
   * `'only'` — the rule alone decides, and a hand-filed product is dropped.
   * Never the default, because it silently un-files somebody's work.
   */
  rule_mode?: 'add' | 'only';
  created_at: string;
  updated_at: string;
}

export interface OrderItem {
  product_id?: string;
  /** Which variation was bought. Absent for simple products. */
  variant_id?: string;
  /**
   * The chosen options, FROZEN at purchase.
   *
   * Copied rather than referenced on purpose: an operator who renames "Black"
   * to "Matte Black" next year must not retroactively change what a customer
   * ordered, and a deleted variant must not make an old order unreadable.
   */
  variant_options?: Record<string, string>;
  name: string;
  qty: number;
  /** line total in cents */
  total_cents: number;
  /**
   * The prescription this line was ordered with, FROZEN at purchase.
   *
   * Stored on the line rather than referenced, for the same reason variant
   * options are: the lab works from what the customer submitted, and a later
   * edit to anything must not change what was ordered. It is also the record
   * that settles a dispute about a remake.
   */
  prescription?: Prescription;
}

export type OrderStatus =
  | 'pending' | 'processing' | 'on-hold' | 'completed'
  | 'cancelled' | 'refunded' | 'failed';

/** Lifecycle of the money. Mirrors lib/payments/types.ts (kept here so the
 * Order model has no import cycle with the payments layer). */
export type PaymentStatus = 'unpaid' | 'pending' | 'paid' | 'failed' | 'refunded';

/* ---------------- optical prescription ----------------
 *
 * The SHAPE lives in core; the RULES live in the optical module.
 *
 * That split is deliberate. A prescription is frozen onto an order line at
 * purchase, and that stored value has to keep meaning something after the
 * module is deactivated, uninstalled, or never bought — an order is a record of
 * what a customer actually paid for, and removing a plugin must never rewrite
 * it. Data outlives the code that understood it.
 *
 * What is NOT here is every judgement: that a cylinder needs an axis, that a
 * power must sit on the 0.25-dioptre grid a lab can grind, that a base curve is
 * millimetres rather than dioptres. Those are optical knowledge and they live in
 * @astrobaas/optical, which is what makes the vertical separable.
 *
 * Units are integers throughout, for the same reason money is: hundredths of a
 * dioptre, tenths of a millimetre for PD.
 */
export type PrescriptionType = 'spectacles' | 'contacts';

export interface EyeRx {
  /** Sphere, hundredths of a dioptre. −225 = −2.25 D. */
  sph: number;
  /** Cylinder, hundredths. 0 = no astigmatic correction. */
  cyl: number;
  /** Axis in degrees, 0–180. Required when `cyl !== 0`. */
  axis: number | null;
  /** Reading addition, hundredths. Positive. Null when not a multifocal. */
  add: number | null;
  /** Contact lenses only: base curve, hundredths of a millimetre (860 = 8.60). */
  bc?: number | null;
  /** Contact lenses only: diameter, hundredths of a millimetre. */
  dia?: number | null;
}

export interface Prescription {
  type: PrescriptionType;
  od: EyeRx;
  os: EyeRx;
  /**
   * Pupillary distance in tenths of a millimetre (630 = 63.0 mm).
   * Single PD, or `pd_od`/`pd_os` for a monocular measurement.
   */
  pd?: number | null;
  pd_od?: number | null;
  pd_os?: number | null;
  /** Who issued it — free text, kept for the lab and for records. */
  issued_by?: string;
  /** ISO date the Rx was written. Optometrists' Rx expire. */
  issued_on?: string;
  notes?: string;
}

/**
 * One-line summary of a stored prescription, for the admin order screen.
 *
 * In core rather than in the module because the ADMIN MUST STILL RENDER a
 * prescription that a past order carries, on an install where the optical
 * module is absent. This formats data; it decides nothing clinical.
 */
export function summarisePrescription(rx: Prescription): string {
  const d = (hundredths: number) => {
    const v = hundredths / 100;
    return `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
  };
  const eye = (e: EyeRx) => {
    const parts = [d(e.sph)];
    if (e.cyl !== 0) parts.push(`${d(e.cyl)} x ${e.axis}°`);
    if (e.add) parts.push(`ADD ${d(e.add)}`);
    return parts.join(' ');
  };
  const pd = rx.pd ? ` PD ${(rx.pd / 10).toFixed(1)}` : '';
  return `R: ${eye(rx.od)} | L: ${eye(rx.os)}${pd}`;
}

/** Per-line money breakdown, frozen on the order for invoicing. */
export interface OrderLineBreakdown {
  product_id: string;
  name: string;
  qty: number;
  unit_price_cents: number;
  line_subtotal_cents: number;
  discount_cents: number;
  net_cents: number;
  tax_cents: number;
  /** Basis points, e.g. 2400 for 24%. */
  tax_rate_bp: number;
  total_cents: number;
  /**
   * WHY that rate. All three absent = the domestic engine answer, which is
   * every line written before destination resolution existed. Never backfilled.
   */
  tax_treatment?: 'domestic' | 'destination' | 'reverse-charge' | 'export';
  /** ISO country whose table was consulted. Absent = the shop's own. */
  tax_jurisdiction?: string;
  /** Absent = the engine chose it. 'override' = a human did. */
  tax_rate_source?: 'engine' | 'override';
}

/** One executed refund. See lib/payments/refunds.ts for the bounding rules. */
export interface RefundRecord {
  /** Provider's refund id. */
  id: string;
  amount_cents: number;
  at: string;
  /** User id that initiated it, or 'provider' when it arrived by webhook. */
  actor: string;
}

/**
 * A human's deliberate departure from what the tax engine computed.
 *
 * APPEND-ONLY. An override is never edited and never deleted — the point of
 * recording one is that somebody can later ask "why is this order's VAT not
 * what the rules say?" and get an answer, and an editable record answers that
 * question differently depending on when you ask it.
 */
export interface TaxOverride {
  /** 'order' covers the shipping line too, because shipping follows the goods. */
  scope: 'order' | 'line';
  /** Index into `line_totals`. An INDEX and not a product id: the same product
   *  can legitimately appear on two lines at different prices. */
  line_index?: number;
  /** EXACTLY ONE of these two. Deliberately not an amount — a human may choose
   *  a different RULE, never a different number, or the stored total stops
   *  being explicable from the rate. */
  tax_class?: string;
  exempt?: true;
  /**
   * REQUIRED and non-empty. "ΑΦΜ verified in VIES", "charity, letter on file".
   *
   * An override with no reason is indistinguishable from a mistake, which
   * defeats the entire purpose of recording it.
   */
  reason: string;
  /** User id, never a display name — names change, ids do not. */
  actor: string;
  at: string;
  /** What the ENGINE said, frozen, so the delta stays legible years later
   *  without re-running an engine whose settings have since changed. */
  was_rate_bp: number;
  now_rate_bp: number;
}

export interface Order {
  id: string;
  /** Human-facing sequential-ish number, e.g. "OG-1042". */
  number: string;
  status: OrderStatus;
  currency: string;
  total_cents: number;
  customer_id?: string;
  email: string;
  name?: string;
  phone?: string;
  /**
   * LEGACY, and kept forever.
   *
   * On an order placed before structured addresses existed this is what the
   * buyer typed into one box. On a newer one it is a one-line RENDERING of
   * `shipping_address`, written by the server at checkout so that a storefront
   * reading this field keeps working with no coordinated deploy — both live
   * storefronts read it today.
   *
   * NEVER PARSE IT. It is a display string, and turning it back into fields is
   * a guess about somebody's postcode.
   */
  address?: string;
  /**
   * Where it goes, structured.
   *
   * A frozen COPY, never a reference into the customer's address book. An
   * order is an accounting record: a customer who moves house and edits their
   * saved address must not retroactively change where a parcel was delivered
   * two years ago, and an invoice must keep saying what was invoiced. This
   * order already freezes `line_totals`, `currency` and `variant_options` for
   * exactly the same reason.
   *
   * Absent means "we do not know" — either the order predates this, or nothing
   * was captured. It never means "same as something else".
   */
  /* ---------------- presentment vs base currency ---------------- *
   * `currency` above is the PRESENTMENT currency: what the buyer was quoted,
   * agreed to, was charged in, and will be refunded in. Every *_cents field on
   * this order, and inside `line_totals`, is minor units OF THAT CURRENCY.
   *
   * The fields below exist only when the buyer was quoted in something other
   * than the shop's base currency. ABSENT MEANS presentment == base, and the
   * fallbacks are exact:
   *     base_currency    ?? currency
   *     base_total_cents ?? total_cents
   *     fx_rate_ppm      ?? 1_000_000
   * That is also why this needed no migration: absence is not missing data, it
   * is the single-currency case stated by omission.
   *
   * NOTHING MAY EVER RE-CONVERT THESE. The rate is frozen because the order is
   * a record of what a person was actually charged, and recomputing it when the
   * operator edits a rate would rewrite history — the one bug this whole
   * feature exists to make impossible.
   */
  /** The shop's base currency at the time of the order. */
  /**
   * Overrides applied to this order, newest last. Absent = never overridden.
   *
   * `line_totals` remains THE current truth, so the receipt, both storefronts,
   * CSV and webhooks keep reading one field. `line_totals_original` is the
   * second copy, and it is the one nobody has to read.
   */
  /* ---------------- local risk signals ---------------- *
   * Written ONLY when an order is flagged, so an ordinary record does not grow
   * a column of zeroes and "flagged" reads as the exception it is — the same
   * discipline `spamFields()` uses on a public submission.
   *
   * NOTHING is ever rejected on these. A flagged order is placed and flagged
   * for a person to look at: the signals are structural correlations, not
   * evidence, and an unusually large order from a new email is what a fraudster
   * does and also what a delighted customer does.
   */
  risk_score?: number;
  risk_flagged?: boolean;
  /** Sentences an operator can act on, not codes to look up. */
  risk_reasons?: string[];
  /** Stable codes, for filtering. */
  risk_signals?: string[];
  /**
   * HMAC of the ordering IP, keyed with the install's own secret.
   *
   * NEVER the raw address. `ConsentReceipt` deliberately stores no IP at all,
   * and an order record that stored one would be less careful than the consent
   * record in the same database. A hash is equality-comparable — so "three
   * orders from one network" still works — and is not reversible into an
   * address. Absent means UNKNOWN, never "no match".
   */
  ip_hash?: string;
  tax_overrides?: TaxOverride[];
  /** The engine's own breakdown, written ONCE when the first override lands and
   *  never rewritten. Absent = `line_totals` IS the engine's answer. */
  line_totals_original?: OrderLineBreakdown[];
  /**
   * Shipping tax, in presentment minor units.
   *
   * ABSENT MEANS UNKNOWN — an order placed before this was stored — and never
   * zero. Without it a stored order cannot be reconciled at all, and the
   * receipt cannot state its own VAT line; both were known holes.
   */
  shipping_tax_cents?: number;
  base_currency?: string;
  /**
   * Base minor units. An indicative accounting value at the frozen rate, and
   * NOT what settled: the acquirer converts at its own rate, which this system
   * never sees and must not pretend to know.
   */
  base_total_cents?: number;
  /** Base minor units. An invoice in a foreign currency must still state the
   *  VAT in the local one. */
  base_tax_cents?: number;
  /** Base minor units, goods before discount. */
  base_subtotal_cents?: number;
  /** Base→presentment rate in millionths. Integer: a float rate reintroduces
   *  the error integer cents exist to prevent. */
  fx_rate_ppm?: number;
  /** When the OPERATOR last saved that rate — the rate's as-of date, not the
   *  order's. What makes "was this priced on a stale rate?" answerable later. */
  fx_rate_at?: string;
  /** True when the rate was already past its age limit at checkout. Frozen, so
   *  the fact survives the operator fixing the rate afterwards. */
  fx_rate_stale?: boolean;
  shipping_address?: Address;
  /**
   * Who is invoiced. When the buyer says "same as delivery", the server copies
   * `shipping_address` here rather than storing a flag.
   *
   * There is deliberately no `billing_same_as_shipping` boolean: a stored flag
   * can drift from the data it claims to describe, and every reader would have
   * to implement the fallback — receipt, admin, invoices, carrier packs, CSV,
   * webhooks, two storefronts — where exactly one of them will forget.
   * `addressesEqual()` answers the question from the data itself.
   */
  billing_address?: Address;
  items: OrderItem[];
  note?: string;
  /**
   * The SHOP's note, never the buyer's.
   *
   * `note` above is what the customer typed at checkout and belongs to them —
   * it is cleared by a data-subject erasure. This one is the shop's own record
   * ("called, collecting Tuesday", "lens supplier delayed"), so staff had
   * nowhere to write that without editing the customer's words.
   *
   * Staff-only: never returned to an anonymous order lookup, and not touched by
   * erasure, because it is the shop's record of its own handling rather than
   * personal data the subject supplied.
   */
  staff_note?: string;
  /**
   * Fulfilment, deliberately BESIDE `status` rather than inside it.
   *
   * Adding a `shipped` status would put fulfilment into the state machine that
   * also governs stock and refunds, where "shipped" is not a payment state and
   * a partially shipped order has no single answer. An order can be
   * `processing` and dispatched, or `completed` and collected in person.
   */
  tracking_number?: string;
  /** Free text — "ELTA Courier", "Speedex". Not an enum: a carrier pack owns those. */
  tracking_carrier?: string;
  /** Where the customer can follow it. Validated as http(s) before it is stored. */
  tracking_url?: string;
  /** Set when tracking is first recorded; what makes the shipped email send once. */
  shipped_at?: string;
  /**
   * How the buyer pays: a manual method ('bank-transfer', 'cod') or the id of a
   * payment provider ('stripe', 'paypal', 'klarna', …). See lib/payments/.
   */
  payment_method?: string;
  /**
   * Where the money is, tracked SEPARATELY from `status` (fulfilment).
   * Conflating the two is how orders get shipped unpaid: 'processing' answers
   * "are we working on it", 'paid' answers "did the money arrive".
   */
  payment_status?: PaymentStatus;
  /** Provider that owns the payment, when not a manual method. */
  payment_provider?: string;
  /** Provider's session/intent id. Opaque; used to correlate webhooks. */
  payment_reference?: string;
  /**
   * Ids of provider events already applied — the idempotency ledger. Webhook
   * delivery is at-least-once, so replays must be recognisable. Bounded.
   */
  payment_events?: string[];
  /* ---------------- money breakdown (schema v7) ---------------- *
   * `total_cents` remains THE authoritative charge; these explain it. An
   * invoice must be reproducible from a stored order years later, so the
   * breakdown is persisted rather than recomputed against a rate table that
   * will have changed by then. */
  /** Goods before discount, in the install's tax convention. */
  subtotal_cents?: number;
  discount_cents?: number;
  /** Shipping excluding its tax. */
  shipping_cents?: number;
  /** All tax on the order: goods + shipping. */
  tax_cents?: number;
  /** Whether the stored figures came from tax-inclusive prices. */
  prices_include_tax?: boolean;
  /** Per-line tax + discount breakdown, for invoicing. */
  line_totals?: OrderLineBreakdown[];
  /** Chosen shipping method id + name, frozen at checkout. */
  shipping_method_id?: string;
  shipping_method_name?: string;
  /** Coupon applied, if any. */
  coupon_code?: string;
  /** Destination used to price shipping and tax. */
  shipping_country?: string;
  shipping_postcode?: string;
  /**
   * Why an order was cancelled, when it was not a human doing it.
   * `abandoned` = never paid within the configured window; its stock was
   * returned to the catalogue.
   */
  cancelled_reason?: 'abandoned' | 'hold-expired';
  /** When the abandonment sweep cancelled it. */
  abandoned_at?: string;
  /**
   * When the PAYMENT HOLD ran out — an online-payment order nobody paid within
   * `orders_payment_hold_minutes` — and the hold sweep cancelled it
   * (`cancelled_reason: 'hold-expired'`). See commerce/payment-hold.ts.
   */
  hold_expired_at?: string;
  /**
   * When the provider session opened for this order stops taking payment, as
   * far as this install knows (Stripe: the `expires_at` it was created with).
   * The hold sweep never cancels an order before this, plus a grace for the
   * provider's last webhook. Absent = unknown, and the hold alone decides.
   */
  payment_expires_at?: string;
  /**
   * When a provider payment was FIRST started for this order. Written once.
   * The hold clock of an order placed with a manual method and then sent to a
   * provider starts here (see holdStartMs in commerce/payment-hold.ts).
   */
  payment_started_at?: string;
  /**
   * When this install last started CAPTURING an approved payment (PayPal).
   * A short lease: the hold sweep leaves the order alone until a few minutes
   * after it, so an order is not cancelled while its money is being taken.
   */
  payment_capture_started_at?: string;
  /**
   * Card attempts the provider DECLINED while the session stayed open
   * (Stripe `payment_intent.payment_failed`). A decline is not the end of an
   * order — the buyer can try another card on the same page — so it no longer
   * cancels anything; it is counted instead, because a pile of declines on one
   * order is what card testing looks like. Absent = none.
   */
  payment_declines?: number;
  /** When the last declined attempt arrived. */
  payment_declined_at?: string;
  /**
   * The provider says this order is PAID, but it had already been cancelled
   * and its stock could not be taken again. Money arrived for goods the shop
   * can no longer send: staff must refund it (or restock and reopen it). Set
   * by the payment path, shown in the admin, cleared by a full refund.
   */
  needs_refund?: boolean;
  /** When `needs_refund` was set. */
  needs_refund_at?: string;
  /**
   * Placed ON HOLD by the opt-in risk hold (`orders_risk_hold_enabled`)
   * rather than as pending. A payment does not move it on: the whole point is
   * that a person looks first. Unpaid, it expires like any unpaid order.
   */
  risk_held?: boolean;
  /**
   * When the one recovery reminder went out. The once-only guard.
   *
   * Set even when the SEND fails, so a mail transport that is down does not
   * turn one reminder into a nightly one.
   */
  recovery_sent_at?: string;
  /**
   * Receipt / invoice number issued OUTSIDE AstroBaaS — typically on the shop's
   * POS, whose certified fiscal mechanism is what actually transmits to AADE.
   *
   * AstroBaaS deliberately does NOT talk to myDATA: that is a legal obligation
   * with real consequences, and an integration nobody has round-tripped against
   * AADE's own sandbox has no business claiming compliance. Recording the POS
   * document number here is what makes the manual path reconcilable.
   */
  external_receipt_no?: string;

  /**
   * Refunds actually executed against this order, newest last. The SUM bounds
   * any further refund — a single "refunded" flag cannot express partials, and
   * without the running total each partial refund looks individually valid
   * while the aggregate quietly exceeds what was charged.
   */
  refunds?: RefundRecord[];
  created_at: string;
  updated_at: string;
  /**
   * The DATE a data-subject erasure removed the identifying fields (C-105).
   *
   * Absent on every order that has not been through one, so an install that has
   * never had a request is byte-identical to before this existed.
   *
   * A DATE, not a timestamp, and that is the point: an exact time makes every
   * order belonging to one subject share a second, which re-links the set the
   * erasure just unlinked. A day is enough for an operator to answer "when was
   * this done" and is a far weaker handle. The precise time lives in the audit
   * log, where access is controlled.
   *
   * Its real job is as a GATE: `commerce/order-lookup.ts` refuses any order
   * carrying it, so no public path can reach one.
   */
  erased_at?: string;
}

export interface Customer {
  id: string;
  email: string;
  name?: string;
  phone?: string;
  /**
   * The original flat fields. KEPT — the Woo importer writes them and the
   * customers admin reads them, and dropping a field two live systems use in
   * order to tidy a model is data loss dressed as a refactor. Migration v13
   * LIFTS them into `addresses` without removing them.
   */
  address?: string;
  city?: string;
  postcode?: string;
  country?: string;
  /**
   * The address book.
   *
   * MANY, not one: a repeat buyer at an optical shop sends contact lenses to
   * work and glasses home, and a single-address model makes every deviation an
   * overwrite — destroying the reuse the book exists for.
   *
   * Bounded (MAX_SAVED_ADDRESSES). A customer-account endpoint will let a
   * stranger write this, and an unbounded array inside a JSON document is a
   * growth vector, the same reason `payment_events` is capped.
   */
  addresses?: SavedAddress[];
  created_at: string;
  updated_at: string;
}

/** The full persisted document shape. */
/**
 * A record owned by a plugin.
 *
 * Plugins need somewhere to keep their own data, and every alternative was
 * worse. The settings table is a flat key/value bucket read wholesale on every
 * request. `custom_entities` looked ideal — same shape, already implemented on
 * every driver — until you notice `createCustomEntity` writes into the content
 * CHANGE FEED, which is served publicly at `/api/content/changes`: a plugin's
 * records would have been published.
 *
 * So plugin data gets its own collection, touched by nothing else. It is not
 * fed to the change feed, not exposed by any core route, and not readable by a
 * plugin other than its owner.
 *
 * `ns` is `"<plugin-id>:<collection>"` — one string rather than two columns,
 * because that is the shape `custom_entities` already uses on all three drivers
 * and matching it means no new query patterns to get wrong.
 */
export interface PluginDataRecord {
  /** `<plugin-id>:<collection>`. Namespaced so one plugin cannot read another's. */
  ns: string;
  id: string;
  data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type { RedirectRule } from '../lib/legacy/redirects';
export type { NotFoundRecord } from '../lib/legacy/not-found-log';

export interface DatabaseSchema {
  posts: Post[];
  categories: Category[];
  users: User[];
  media: MediaFile[];
  themes: Theme[];
  settings: Setting[];
  themeSettings: ThemeSettings[];
  contentChanges: ContentChange[];
  /**
   * Per entity type, the newest `timestamp` the change feed's retention has
   * evicted — what `meta.truncated` on the public feed is computed from. See
   * recordPrunedChanges in core/change-feed.ts. Absent on a document written
   * before it existed, which reads as "nothing evicted yet".
   */
  contentChangesPruned?: Record<string, string>;
  messages: ContactMessage[];
  subscribers: Subscriber[];
  plugins: PluginRecord[];
  /**
   * Legacy-URL redirects, owned by the admin rather than by nginx. See
   * lib/legacy/redirects.ts for why this is per-site data.
   */
  redirects?: import('../lib/legacy/redirects').RedirectRule[];
  /** Aggregated 404s, bounded — see lib/legacy/not-found-log.ts. */
  notFound?: import('../lib/legacy/not-found-log').NotFoundRecord[];
  /** Storage for plugin-registered custom content types, keyed by type name. */
  custom?: Record<string, CustomEntity[]>;
  /** Plugin-owned records. See PluginDataRecord for why this is separate. */
  pluginData?: PluginDataRecord[];
  apiKeys?: ApiKey[];
  webhooks?: Webhook[];
  webhookDeliveries?: WebhookDelivery[];
  auditEvents?: AuditEvent[];
  consentReceipts?: ConsentReceipt[];
  emailLog?: EmailLogEntry[];
  postRevisions?: PostRevision[];
  /** Commerce collections (optional so legacy DBs parse; backfilled on init). */
  products?: Product[];
  brands?: Brand[];
  productCategories?: ProductCategory[];
  shippingMethods?: ShippingMethodRecord[];
  coupons?: CouponRecord[];
  /** Monotonic counters (order numbers). See Storage.nextSequence(). */
  counters?: Record<string, number>;
  orders?: Order[];
  customers?: Customer[];
  /**
   * Applied schema version — advanced by the migration runner (src/lib/
   * migrations.ts). Absent (→ 0) on databases that predate the migration system;
   * a fresh install is stamped at the latest version so no migrations run.
   */
  schemaVersion?: number;
}
