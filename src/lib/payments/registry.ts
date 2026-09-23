/**
 * Payment provider registry.
 *
 * Adding a provider is meant to cost one file and one line here — that is the
 * whole point of the shape. What a new provider must NOT be able to do is opt
 * out of the guarantees in types.ts, so everything that could be centralised is:
 * credential loading, enablement, and the misconfiguration report.
 *
 * ## Enablement
 *
 * A provider is offered to buyers only when BOTH are true:
 *   1. it is listed in `PAYMENTS_ENABLED` (comma-separated), and
 *   2. every one of its `requiredEnv` vars is present and non-empty, and
 *   3. its optional `validateEnv` finds nothing wrong with what IS set.
 *
 * Three conditions rather than one because half-configured is the dangerous
 * state: a provider that appears at checkout and then throws mid-flow has
 * already taken the buyer's attention and, worse, already reserved stock.
 * `paymentConfigReport()` surfaces exactly that case to the admin instead of
 * letting it fail at the till.
 *
 * Manual methods (`bank-transfer`, `cod`) are deliberately NOT providers: they
 * take no money and need no credentials, so they stay in the order model as
 * plain `payment_method` values.
 */

import type { PaymentProvider, ProviderContext } from './types';
import { stripeProvider } from './stripe';
import { paypalProvider } from './paypal';
import { klarnaProvider } from './klarna';

/**
 * Every known provider. Order is the order shown at checkout.
 *
 * To add one: implement `PaymentProvider`, import it, append it here. No other
 * file needs to change — the API, admin, and webhook route are all driven off
 * this list.
 */
const BUILT_IN_PROVIDERS: readonly PaymentProvider[] = [
  stripeProvider,
  paypalProvider,
  klarnaProvider,
];

/**
 * Providers contributed by plugins, registered at bootstrap.
 *
 * A payment provider used to be addable only by editing the array above, which
 * meant every gateway had to live in this repository. That is wrong twice: a
 * Greek instant-payments provider is worth selling rather than giving away, and
 * a bank-specific gateway built for one client belongs to that engagement, not
 * in every install of the CMS.
 *
 * A module registers through `PLUGIN_HOOKS.PAYMENT_PROVIDERS`; the plugin
 * bootstrap calls `setPluginProviders()` once it has collected them.
 */
let pluginProviders: readonly PaymentProvider[] = [];

/**
 * Replace the plugin-contributed set. Called by the plugin bootstrap.
 *
 * Ids are checked against the built-ins and against each other: a plugin that
 * shadowed `stripe` would silently take over live card payments, which is the
 * kind of thing that must be refused loudly rather than resolved by array
 * order. A duplicate is dropped with an error and the original stands.
 */
export function setPluginProviders(providers: readonly PaymentProvider[]): void {
  const seen = new Set(BUILT_IN_PROVIDERS.map((p) => p.id));
  const kept: PaymentProvider[] = [];
  for (const p of providers) {
    if (!p?.id || typeof p.createSession !== 'function' || typeof p.verifyWebhook !== 'function') {
      console.error('[astrobaas] a plugin offered an invalid payment provider; ignoring it');
      continue;
    }
    if (seen.has(p.id)) {
      console.error(
        `[astrobaas] a plugin tried to register payment provider "${p.id}", which already exists. `
        + 'Ignoring it — a provider silently replacing another would reroute live payments.',
      );
      continue;
    }
    seen.add(p.id);
    kept.push(p);
  }
  pluginProviders = kept;
}

/**
 * Every known provider, built-in first.
 *
 * A getter rather than a constant because plugins register after this module is
 * imported. Call sites re-read it, so a provider added at bootstrap is visible
 * without anything having to be re-imported.
 */
export function allProviders(): readonly PaymentProvider[] {
  return [...BUILT_IN_PROVIDERS, ...pluginProviders];
}

/** @deprecated Use `allProviders()` — a constant cannot see plugin providers. */
export const ALL_PROVIDERS: readonly PaymentProvider[] = BUILT_IN_PROVIDERS;

/* ------------------------------------------------------------------ *
 * Manual methods
 * ------------------------------------------------------------------ */

/**
 * A method that takes no credentials and calls no API.
 *
 * The buyer is told what to do and does it somewhere else — a bank app, cash at
 * the door — and a human marks the order paid. No provider, no webhook, and
 * nothing to misconfigure.
 *
 * `instructions` is what makes this more than a label. Until now a shop could
 * offer "bank transfer" and the buyer was told **nothing** about where to send
 * the money: the storefront had to hard-code an IBAN, or the customer had to
 * ask. That is fine to live with for a niche method and useless for one a
 * regulator expects a shop to accept.
 */
export interface ManualMethodDef {
  id: string;
  label: string;
  /**
   * Locale code → text shown to the buyer. Free-form so core stays out of the
   * business of knowing what any given method needs said.
   *
   * PUBLIC: served unauthenticated at `/api/payments`, because the buyer is who
   * needs it. It must therefore hold only things a shop already publishes — an
   * IBAN, a VAT number, the phone number on the contact page — and never a
   * credential.
   */
  instructions?: Record<string, string>;
}

const BUILT_IN_MANUAL: readonly ManualMethodDef[] = [
  { id: 'bank-transfer', label: 'Bank transfer' },
  { id: 'cod', label: 'Cash on delivery' },
];

/**
 * Settings that hold the instructions for the built-in manual methods.
 *
 * `ManualMethodDef.instructions` was reachable only by a PLUGIN, so on a core
 * install the built-in bank-transfer method could never carry an IBAN — and the
 * order confirmation email promised details that had nowhere to come from. A
 * shop taking bank transfers with no plugin installed is the ordinary case, and
 * both live shops are it.
 *
 * One key per method, so a shop can explain its transfer and its
 * cash-on-delivery differently, and neither is invented.
 */
export const MANUAL_INSTRUCTION_KEYS: Readonly<Record<string, string>> = {
  'bank-transfer': 'payment_instructions_bank_transfer',
  cod: 'payment_instructions_cod',
};

/**
 * Instructions for a manual method, settings first.
 *
 * Takes the settings MAP rather than reading it, so this stays synchronous and
 * usable from the same places the rest of the registry is. A plugin-declared
 * method still supplies its own; the settings only fill the built-ins, which
 * had no other source.
 */
export function manualInstructions(
  methodId: string,
  settings: Record<string, unknown>,
  locale?: string,
): string | undefined {
  const key = MANUAL_INSTRUCTION_KEYS[methodId];
  if (key) {
    const raw = settings[key];
    if (typeof raw === 'string' && raw.trim() !== '') return raw.trim();
  }
  const def = allManualMethods().find((m) => m.id === methodId);
  if (!def?.instructions) return undefined;
  // The site's locale, then whatever single text exists: a shop that wrote its
  // IBAN in one language only should still send it rather than sending nothing.
  return (locale ? def.instructions[locale] : undefined)
    ?? Object.values(def.instructions)[0];
}

/** Manual methods contributed by plugins, registered at bootstrap. */
let pluginManual: readonly ManualMethodDef[] = [];

/**
 * Replace the plugin-contributed manual methods. Called by the plugin bootstrap.
 *
 * Refuses an id that already belongs to a built-in manual method or to any
 * PROVIDER. The second check is the one that matters: `isAcceptedMethod` asks
 * about manual methods first, so a manual method shadowing a gateway id would
 * make checkout accept an order as "pay us later" that the shop believed had
 * gone through a gateway.
 */
export function setPluginManualMethods(defs: readonly ManualMethodDef[]): void {
  const taken = new Set([
    ...BUILT_IN_MANUAL.map((m) => m.id),
    ...allProviders().map((p) => p.id),
  ]);
  const kept: ManualMethodDef[] = [];
  for (const m of defs) {
    if (!m?.id || typeof m.label !== 'string' || !m.label) {
      console.error('[astrobaas] a plugin offered an invalid manual payment method; ignoring it');
      continue;
    }
    if (taken.has(m.id)) {
      console.error(
        `[astrobaas] a plugin tried to register manual payment method "${m.id}", `
        + 'which already exists. Ignoring it — a manual method shadowing a gateway would '
        + 'accept orders as unpaid that the shop believes were charged.',
      );
      continue;
    }
    taken.add(m.id);
    kept.push(m);
  }
  pluginManual = kept;
}

/** Every manual method, built-in first. A getter, for the same reason as providers. */
export function allManualMethods(): readonly ManualMethodDef[] {
  return [...BUILT_IN_MANUAL, ...pluginManual];
}

/**
 * Is this an offered manual method?
 *
 * `MANUAL_METHODS`, the hardcoded pair this replaces, is gone rather than
 * deprecated: it was internal to this repository, had exactly one caller, and
 * leaving it would have meant two answers to "what methods exist" — with the
 * stale one being the shorter to reach for.
 */
export function isManualMethod(value: string): boolean {
  return allManualMethods().some((m) => m.id === value);
}

export function getProvider(id: string): PaymentProvider | undefined {
  return allProviders().find((p) => p.id === id);
}

/** Reader for the process environment. Injectable so tests need no globals. */
export type EnvMap = Record<string, string | undefined>;

function envList(env: EnvMap): string[] {
  return String(env.PAYMENTS_ENABLED ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function missingEnvFor(provider: PaymentProvider, env: EnvMap): string[] {
  return provider.requiredEnv.filter((name) => {
    const v = env[name];
    return typeof v !== 'string' || v.trim() === '';
  });
}

export interface ProviderReport {
  id: string;
  label: string;
  /** Listed in PAYMENTS_ENABLED. */
  requested: boolean;
  /** Requested AND fully configured — the only state offered to buyers. */
  enabled: boolean;
  /** Names only. Values are never read into this report. */
  missingEnv: string[];
  /**
   * Faults in variables that ARE set — from the provider's `validateEnv`.
   *
   * Separate from `missingEnv` because the fix is different: one is "go and set
   * this", the other is "what you set is wrong". Telling an admin a variable is
   * missing when it is sitting in their `.env` sends them looking in the wrong
   * place.
   */
  problems: string[];
}

/**
 * Status of every provider, for the admin screen and boot diagnostics.
 *
 * Returns variable NAMES for anything missing, never values — this object is
 * rendered in the admin and would otherwise be a neat way to exfiltrate a
 * secret through a screenshot.
 */
export function paymentConfigReport(env: EnvMap): ProviderReport[] {
  const requestedIds = envList(env);
  return allProviders().map((p) => {
    const requested = requestedIds.includes(p.id);
    const missingEnv = missingEnvFor(p, env);
    // Only worth asking about values that are actually there — a provider
    // should not have to re-state "unset" as a problem too.
    let problems: string[] = [];
    if (missingEnv.length === 0 && typeof p.validateEnv === 'function') {
      try {
        problems = p.validateEnv(env).filter((s) => typeof s === 'string' && s.trim() !== '');
      } catch (err) {
        // A provider whose own check throws is not a provider to take money
        // with. Fail closed and say so, rather than letting the exception
        // escape and take the whole admin screen down with it.
        console.error(`[payments] ${p.id}.validateEnv threw:`, err);
        problems = ['its configuration check failed — see the server log'];
      }
    }
    return {
      id: p.id,
      label: p.label,
      requested,
      enabled: requested && missingEnv.length === 0 && problems.length === 0,
      missingEnv,
      problems,
    };
  });
}

/**
 * Ids of every ONLINE payment method — every provider, built-in or plugin,
 * whether or not it is enabled right now. The payment hold asks this rather
 * than keeping its own list, so a gateway a plugin adds is held like Stripe
 * is, and one switched off after an order was placed still is.
 */
export function onlineMethodIds(): string[] {
  return allProviders().map((p) => p.id);
}

/** Providers a buyer may actually choose. */
export function enabledProviders(env: EnvMap): PaymentProvider[] {
  const report = paymentConfigReport(env);
  return allProviders().filter((p) => report.find((r) => r.id === p.id)?.enabled);
}

/** Is this a payment method the checkout endpoint should accept right now? */
export function isAcceptedMethod(value: string, env: EnvMap): boolean {
  if (isManualMethod(value)) return true;
  return enabledProviders(env).some((p) => p.id === value);
}

/**
 * Build a provider context from the real environment.
 *
 * `env()` throws on a missing or blank variable rather than returning ''. A
 * blank credential would otherwise be sent to the provider and produce a
 * confusing auth error at the worst moment; failing here names the variable.
 */
export function providerContext(opts: {
  env: EnvMap;
  siteUrl: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  /** See ProviderContext.holdUntil. */
  holdUntil?: number;
}): ProviderContext {
  return {
    fetch: opts.fetch ?? globalThis.fetch,
    now: opts.now ?? (() => Date.now()),
    siteUrl: opts.siteUrl.replace(/\/+$/, ''),
    ...(opts.holdUntil !== undefined ? { holdUntil: opts.holdUntil } : {}),
    env: (name: string) => {
      const v = opts.env[name];
      if (typeof v !== 'string' || v.trim() === '') {
        throw new Error(`Payment provider misconfigured: ${name} is not set`);
      }
      return v;
    },
  };
}
