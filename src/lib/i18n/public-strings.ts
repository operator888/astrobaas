/**
 * The handful of visitor-facing strings the CORE renders.
 *
 * ## Why this is separate from the admin catalogue
 *
 * A different question decides it. The admin catalogue is keyed on `uiLocale`
 * — the staff member's own preference, because the admin is their tool. A
 * public string is keyed on `locale`, the CONTENT locale from the URL, because
 * two visitors must get the same bytes for the same address or a CDN cannot
 * cache it and a shared link shows something different to whoever opens it.
 * `lib/i18n/resolve.ts` calls conflating those two "the classic i18n mistake",
 * and using `Astro.locals.t` on a public page is exactly that mistake.
 *
 * ## Deliberately tiny, and honest about it
 *
 * The bundled themes render their own English literals — "Our Blog", "Share
 * this article", "Back to Blog" — and always have; the middleware says so where
 * `uiLocale` is resolved. This module does NOT fix that, and pretending
 * otherwise by adding two translated strings to an English page would be worse
 * than the gap.
 *
 * What it covers is the text the CORE adds to somebody else's theme: the print
 * button and the embed facade. Those appear on every article whatever theme is
 * active, so an English sentence in the middle of a Greek page is the core's
 * fault rather than the theme's. A theme that wants the rest translated passes
 * its own strings — `PrintButton` takes a `label`.
 */


export interface PublicStrings {
  /** The print/PDF button. */
  print: string;
  /** "Load this from <host>" — `{host}` is substituted. */
  embedLoad: string;
  /** The reassurance under it. */
  embedNote: string;
  /** Fallback labels when an embed carries no title. */
  embedVideo: string;
  embedMap: string;
  /**
   * The inline PDF viewer.
   *
   * `pdfDownload` is not a convenience: an inline PDF renders only its first
   * page on iOS Safari, and a reader who needs page four needs a way out.
   * `pdfDocument` is the frame's accessible name when the link carried no text
   * — an iframe with no title is announced as "frame", which tells a screen
   * reader user nothing about what is in it.
   */
  pdfDownload: string;
  pdfDocument: string;
  /**
   * The receipt page (C-39).
   *
   * A whole core-rendered page rather than a phrase added to a theme, so it is
   * exactly what this module is for. `notInvoice` is the load-bearing one: the
   * disclaimer is the difference between a document a buyer may keep and a
   * document that claims a fiscal status it does not have.
   */
  receipt: {
    heading: string;
    notInvoice: string;
    orderNo: string;
    date: string;
    seller: string;
    billedTo: string;
    item: string;
    qty: string;
    vatRate: string;
    lineTotal: string;
    subtotal: string;
    discount: string;
    shipping: string;
    vat: string;
    vatIncluded: string;
    vatWithShipping: string;
    total: string;
    paidWith: string;
    unpaid: string;
    unavailable: string;
    unavailableNote: string;
    /** The link that downloads this receipt as a PDF file. */
    downloadPdf: string;
  };
}

const EN: PublicStrings = {
  print: 'Print / Save as PDF',
  embedLoad: 'Load from {host}',
  embedNote: 'Nothing is sent there until you press this.',
  embedVideo: 'Video',
  embedMap: 'Map',
  pdfDownload: 'Download PDF',
  pdfDocument: 'Document',
  receipt: {
    heading: 'Receipt',
    notInvoice: 'This is a record of your purchase for your own use. It is not a tax invoice.',
    orderNo: 'Order',
    date: 'Date',
    seller: 'Sold by',
    billedTo: 'Issued to',
    item: 'Item',
    qty: 'Qty',
    vatRate: 'VAT',
    lineTotal: 'Amount',
    subtotal: 'Subtotal',
    discount: 'Discount',
    shipping: 'Shipping',
    vat: 'VAT',
    vatIncluded: 'VAT is included in the prices shown.',
    vatWithShipping: 'The VAT figure covers the goods and the shipping.',
    total: 'Total',
    paidWith: 'Paid by',
    unpaid: 'Not yet paid',
    unavailable: 'This receipt is not available',
    unavailableNote: 'The link may have expired, or the order it points to is no longer available. Please contact the shop.',
    downloadPdf: 'Download PDF',
  },
};

/**
 * Greek and German, the two languages this project's own installs run.
 *
 * A locale with no entry falls back to English rather than to a key or a blank
 * — a missing translation should read slightly wrong, never look broken.
 */
const CATALOGUE: Record<string, PublicStrings> = {
  en: EN,
  el: {
    print: 'Εκτύπωση / Αποθήκευση ως PDF',
    embedLoad: 'Φόρτωση από {host}',
    embedNote: 'Δεν στέλνεται τίποτα εκεί μέχρι να το πατήσετε.',
    embedVideo: 'Βίντεο',
    embedMap: 'Χάρτης',
    pdfDownload: 'Λήψη PDF',
    pdfDocument: 'Έγγραφο',
    receipt: {
      heading: 'Απόδειξη',
      // NOT "απόδειξη λιανικής": that names a fiscal document, which this is
      // not. The sentence says plainly that it carries no tax status.
      notInvoice: 'Αποτελεί ενημερωτικό παραστατικό της αγοράς σας για δική σας χρήση. Δεν είναι φορολογικό παραστατικό.',
      orderNo: 'Παραγγελία',
      date: 'Ημερομηνία',
      seller: 'Πωλητής',
      billedTo: 'Στοιχεία πελάτη',
      item: 'Είδος',
      qty: 'Ποσ.',
      vatRate: 'ΦΠΑ',
      lineTotal: 'Αξία',
      subtotal: 'Μερικό σύνολο',
      discount: 'Έκπτωση',
      shipping: 'Μεταφορικά',
      vat: 'ΦΠΑ',
      vatIncluded: 'Ο ΦΠΑ περιλαμβάνεται στις αναγραφόμενες τιμές.',
      vatWithShipping: 'Το ποσό ΦΠΑ αφορά τα είδη και τα μεταφορικά.',
      total: 'Σύνολο',
      paidWith: 'Τρόπος πληρωμής',
      unpaid: 'Δεν έχει εξοφληθεί',
      unavailable: 'Η απόδειξη δεν είναι διαθέσιμη',
      unavailableNote: 'Ο σύνδεσμος μπορεί να έχει λήξει ή η παραγγελία δεν είναι πλέον διαθέσιμη. Επικοινωνήστε με το κατάστημα.',
      downloadPdf: 'Λήψη PDF',
    },
  },
  de: {
    print: 'Drucken / Als PDF speichern',
    embedLoad: 'Von {host} laden',
    embedNote: 'Bis Sie hier klicken, wird nichts dorthin gesendet.',
    embedVideo: 'Video',
    embedMap: 'Karte',
    pdfDownload: 'PDF herunterladen',
    pdfDocument: 'Dokument',
    receipt: {
      heading: 'Beleg',
      notInvoice: 'Dies ist ein Nachweis Ihres Kaufs für Ihre Unterlagen. Es ist keine Rechnung im steuerlichen Sinne.',
      orderNo: 'Bestellung',
      date: 'Datum',
      seller: 'Verkauft von',
      billedTo: 'Ausgestellt an',
      item: 'Artikel',
      qty: 'Menge',
      vatRate: 'MwSt.',
      lineTotal: 'Betrag',
      subtotal: 'Zwischensumme',
      discount: 'Rabatt',
      shipping: 'Versand',
      vat: 'MwSt.',
      vatIncluded: 'Die MwSt. ist in den angegebenen Preisen enthalten.',
      vatWithShipping: 'Der MwSt.-Betrag umfasst Waren und Versand.',
      total: 'Gesamt',
      paidWith: 'Bezahlt per',
      unpaid: 'Noch nicht bezahlt',
      unavailable: 'Dieser Beleg ist nicht verfügbar',
      unavailableNote: 'Der Link ist möglicherweise abgelaufen, oder die Bestellung ist nicht mehr verfügbar. Bitte wenden Sie sich an den Shop.',
      downloadPdf: 'PDF herunterladen',
    },
  },
};

export function publicStrings(locale: unknown): PublicStrings {
  // The LANGUAGE SUBTAG, taken directly — the same rule `directionFor` uses,
  // and deliberately NOT `normalizeLocale`.
  //
  // `normalizeLocale` answers a different question: "is this one of the locales
  // this install serves?", collapsing anything else to the default. Routing it
  // through that made every string English in any process where SITE_LOCALES
  // was unset — which is every test, and any install that had not configured
  // the locale a caller nonetheless handed in. A caller passing `el` means
  // Greek; whether `el` is configured is somebody else's decision, made
  // earlier.
  const tag = typeof locale === 'string' ? locale : '';
  const language = tag.trim().replace('_', '-').split('-')[0].toLowerCase();
  return CATALOGUE[language] ?? EN;
}

/** `{host}`-style substitution. One placeholder, so one function. */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
}
