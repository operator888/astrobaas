/**
 * Suggest which open invoice or expense a bank transaction pays.
 *
 * Scored, not decided: the strongest signal (the invoice number in the
 * purpose line) is near-certain, the weakest (same amount, nothing else) is a
 * guess. Only a score at or above AUTO_MATCH_SCORE is applied without a
 * person — and only when exactly one candidate reaches it, because two
 * invoices of €1,190.00 to the same customer are common for a retainer.
 */
import type { BankTransaction, MatchSuggestion } from './types';

export interface OpenItem {
  kind: 'document' | 'expense';
  id: string;
  number?: string;
  /** Supplier/customer name. */
  name: string;
  iban?: string;
  open_cents: number; // positive
  date: string;
}

export const AUTO_MATCH_SCORE = 90;

function norm(s: string | undefined): string {
  return (s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
}

const STOP = new Set(['gmbh', 'ug', 'haftungsbeschrankt', 'ag', 'kg', 'ohg', 'gbr', 'ltd', 'limited', 'inc', 'llc', 'sarl', 'sa', 'bv', 'co', 'und', 'and', 'the', 'der', 'die', 'das', 'mbh', 'ek']);

function tokens(s: string | undefined): string[] {
  return (s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t));
}

/** Share of the item's name tokens found in the counterparty name / purpose. */
function nameSimilarity(item: string, against: string): number {
  const a = tokens(item);
  if (!a.length) return 0;
  const hay = new Set(tokens(against));
  return a.filter((t) => hay.has(t)).length / a.length;
}

export function suggestMatches(tx: Pick<BankTransaction, 'amount_cents' | 'purpose' | 'counterparty_name' | 'counterparty_iban' | 'booking_date'>, items: readonly OpenItem[]): MatchSuggestion[] {
  const incoming = tx.amount_cents > 0;
  const amount = Math.abs(tx.amount_cents);
  const purposeNorm = norm(tx.purpose);
  const out: MatchSuggestion[] = [];
  for (const it of items) {
    // Money in pays invoices; money out pays expenses (and refunds credit notes,
    // which the caller presents as documents with their own sign handling).
    if (incoming !== (it.kind === 'document')) continue;
    let score = 0;
    const reasons: string[] = [];
    if (it.number) {
      const n = norm(it.number);
      if (n.length >= 3 && purposeNorm.includes(n)) {
        score += 70;
        reasons.push(`number ${it.number} in purpose`);
      } else {
        // "RE 2026 42" vs "RE-2026-0042": compare the digit run at the end.
        const tail = it.number.match(/(\d+)\D*$/)?.[1]?.replace(/^0+/, '');
        const year = it.number.match(/(20\d{2})/)?.[1];
        if (tail && tail.length >= 2 && year && new RegExp(`${year}\\D{0,3}0*${tail}(?!\\d)`).test(tx.purpose)) {
          score += 55;
          reasons.push(`number ${it.number} (loosely) in purpose`);
        }
      }
    }
    if (amount === it.open_cents) {
      score += 30;
      reasons.push('exact open amount');
    } else if (amount < it.open_cents && amount > 0) {
      score += 5;
      reasons.push('partial amount');
    } else {
      // Paying more than is open is rare and usually a different invoice.
      score -= 20;
    }
    if (it.iban && tx.counterparty_iban && norm(it.iban) === norm(tx.counterparty_iban)) {
      score += 25;
      reasons.push('same IBAN');
    }
    const sim = Math.max(nameSimilarity(it.name, tx.counterparty_name ?? ''), nameSimilarity(it.name, tx.purpose) * 0.8);
    if (sim >= 0.5) {
      score += Math.round(20 * sim);
      reasons.push('name matches');
    }
    // A payment before the invoice existed is suspicious, not impossible (prepayment).
    if (tx.booking_date < it.date) score -= 10;
    if (score >= 30) {
      out.push({
        kind: it.kind, id: it.id, label: `${it.number ?? ''} ${it.name}`.trim(),
        open_cents: it.open_cents, score: Math.min(100, score), reasons,
      });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}

/** The single suggestion safe to apply automatically, if there is one. */
export function autoMatch(suggestions: readonly MatchSuggestion[]): MatchSuggestion | null {
  const strong = suggestions.filter((s) => s.score >= AUTO_MATCH_SCORE);
  return strong.length === 1 ? strong[0] : null;
}
