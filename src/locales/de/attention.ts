/**
 * de — admin.attention.*
 *
 * The dashboard's attention feed. Every string here frames something the
 * operator is being asked to act on, so an untranslated one is an instruction
 * in the wrong language on the screen opened most.
 *
 * Three keys per check, named after the check's own id: `.title`, `.body` and
 * `.action`. The card carries only that id and its params — there is nowhere in
 * an AttentionCard to put a sentence, which is what stops a check being written
 * with English text and no translation. tests/attention.test.mjs asserts all
 * three exist here for every registered check.
 */
export const attention = {
  'admin.attention.heading': 'Was Ihre Aufmerksamkeit braucht',
  'admin.attention.allClear': 'Nichts erfordert Ihre Aufmerksamkeit.',
  'admin.attention.broken': 'Muss behoben werden',
  'admin.attention.unfinished': 'Unvollständig',
  'admin.attention.worthKnowing': 'Gut zu wissen',

  'admin.attention.site-url-unset.title': 'Diese Website kennt ihre eigene Adresse nicht',
  'admin.attention.site-url-unset.body': 'Kanonische Links, die Sitemap und jeder Link in einer E-Mail werden daraus gebildet. Solange sie fehlt, werden sie aus dem Host der Anfrage geraten.',
  'admin.attention.site-url-unset.action': 'Adresse festlegen',

  'admin.attention.tax-origin-unset.title': 'Die Steuer ist aktiv, aber der Shop hat kein Land',
  'admin.attention.tax-origin-unset.body': 'Aus welchem Land ein Shop verkauft, bestimmt jeden Satz, den er berechnet — und wird nie geraten. Bestellungen werden ohne diese Angabe berechnet.',
  'admin.attention.tax-origin-unset.action': 'Herkunftsland festlegen',

  'admin.attention.schema-behind.title': 'Das Datenbankschema steht auf v{current}, dieser Build erwartet v{latest}',
  'admin.attention.schema-behind.body': 'Migrationen laufen beim Start, das bedeutet meist, dass eine fehlgeschlagen ist. Daten werden womöglich von Code gelesen, der eine andere Form erwartet.',
  'admin.attention.schema-behind.action': 'Hintergrundjobs prüfen',

  'admin.attention.flagged-orders.title': '{count} Bestellungen sind zur Prüfung markiert',
  'admin.attention.flagged-orders.body': 'Die Risikosignale lehnen nie eine Bestellung ab — sie bitten nur um einen Menschen. Diese sind noch offen.',
  'admin.attention.flagged-orders.action': 'Jetzt prüfen',

  'admin.attention.active-out-of-stock.title': '{count} Produkte sind gelistet, aber nicht vorrätig',
  'admin.attention.active-out-of-stock.body': 'Kundinnen und Kunden finden sie und können sie nicht kaufen. Gewollt bei Nachbestellungen, sonst Sackgassen im Katalog.',
  'admin.attention.active-out-of-stock.action': 'Katalog öffnen',

  'admin.attention.overdue-scheduled-posts.title': '{count} geplante Beiträge wurden nicht veröffentlicht',
  'admin.attention.overdue-scheduled-posts.body': 'Ihr Veröffentlichungsdatum ist vorbei und sie sind weiterhin geplant. Wer sie geschrieben hat, hält sie für live.',
  'admin.attention.overdue-scheduled-posts.action': 'Beiträge öffnen',

  'admin.attention.brand-spellings.title': 'Bei {count} Marken ist eine Entscheidung zur Schreibweise nötig',
  'admin.attention.brand-spellings.body': 'Für Kundinnen und Kunden ändert sich nichts — die Filterung behandelt sie bereits als eine Marke. Dies sind die Fälle, die keine Regel sicher entscheiden konnte.',
  'admin.attention.brand-spellings.action': 'Katalog öffnen',

  'admin.attention.assistant-error.title': 'Der KI-Assistent hat zuletzt einen Fehler zurückgegeben',
  'admin.attention.assistant-error.body': 'Ein Schlüssel ist möglicherweise abgelaufen, widerrufen oder aufgebraucht. {provider} meldete: „{detail}“',
  'admin.attention.assistant-error.action': 'Einstellungen prüfen',

  'admin.attention.orders-need-refund.title': '{count} Bestellungen wurden nach ihrer Stornierung bezahlt',
  'admin.attention.orders-need-refund.body': 'Die Zahlung kam an, nachdem die Bestellung storniert und ihre Artikel verkauft waren – es wird nichts versendet. Erstatten Sie den Betrag oder füllen Sie den Bestand auf und öffnen Sie die Bestellungen wieder.',
  'admin.attention.orders-need-refund.action': 'Bestellungen öffnen',

  'admin.attention.payment-return-urls.title': 'Zahlende Kunden würden auf eine Seite zurückgeleitet, die es nicht gibt',
  'admin.attention.payment-return-urls.body': 'Nach der Zahlung per Karte, PayPal oder Klarna kehren Käufer zur Website-URL zurück – die leer ist oder die Adresse dieses CMS statt Ihres Shops.',
  'admin.attention.payment-return-urls.action': 'Website-URL festlegen',
};
