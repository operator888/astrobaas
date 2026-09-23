import { escapeHtml as esc } from '../escape-html';
/**
 * Ready-to-activate legal page templates, in every locale the sites serve.
 *
 * What this is: a library of STARTING TEXTS. Activation creates a normal CMS
 * Page — as a DRAFT, deliberately — with the operator's own trader details
 * substituted in; the operator reviews, adapts, and publishes. The page then
 * renders through the active theme's PageArticle slot like any other page,
 * so every theme gets correctly-styled legal pages for free.
 *
 * What this is NOT: legal advice, or the statutory withdrawal notice. The
 * EU right-of-withdrawal machinery in `src/lib/withdrawal.ts` generates the
 * Directive's own model texts under a verified-locale gate and must not be
 * duplicated or paraphrased here — the `returns` template LINKS to it.
 *
 * Placeholders are `{{key}}`, filled from settings the admin screen already
 * collects (the trader fields, site title/url). A missing value becomes a
 * VISIBLE localized `[fill in: …]` marker inside <mark>, never silently
 * blank: a compliant-looking notice with invisible gaps is worse than an
 * obvious draft (for withdrawal notices specifically, Art. 10 extends the
 * withdrawal period 12 months as the price of that mistake).
 */

export const LEGAL_TEMPLATE_LOCALES = ['en', 'el', 'de'] as const;
export type LegalTemplateLocale = (typeof LEGAL_TEMPLATE_LOCALES)[number];

export interface LegalTemplateText {
  title: string;
  slug: string;
  body: string;
}

export interface LegalTemplate {
  id: string;
  /** Shown in the admin list. English, like the rest of the admin chrome keys' fallbacks. */
  label: string;
  /** Only offered when the commerce switch is on. */
  commerceOnly?: boolean;
  locales: Record<LegalTemplateLocale, LegalTemplateText>;
}

/** The settings keys a template may reference. Same keys the settings screen collects. */
export const TEMPLATE_PLACEHOLDER_KEYS = [
  'site_title', 'site_url',
  'trader_legal_name', 'trader_address', 'trader_email', 'trader_phone',
] as const;

const FILL_MARKER: Record<LegalTemplateLocale, string> = {
  en: 'fill in',
  el: 'συμπληρώστε',
  de: 'bitte ergänzen',
};

export const LEGAL_TEMPLATES: readonly LegalTemplate[] = [
  {
    id: 'privacy',
    label: 'Privacy policy',
    locales: {
      en: {
        title: 'Privacy Policy',
        slug: 'privacy-policy',
        body: `
<p>This page explains what personal data <strong>{{site_title}}</strong> ({{trader_legal_name}}) processes, why, and what rights you have. Controller: {{trader_legal_name}}, {{trader_address}} — contact: {{trader_email}}.</p>
<h2>What we process, and why</h2>
<ul>
<li><strong>Strictly necessary data.</strong> A session cookie and a security (CSRF) token are set for signed-in users; they are required to deliver the service and are not used for tracking (legal basis: legitimate interest / contract).</li>
<li><strong>Contact form.</strong> The name, email address and message you send us, kept for as long as handling your request takes (legal basis: our legitimate interest in answering you).</li>
<li><strong>Newsletter.</strong> Your email address, only after you subscribe. You can unsubscribe at any time (legal basis: consent).</li>
<li><strong>Analytics and marketing.</strong> Only with your consent, given through the cookie banner, and withdrawable at any time from “Cookie settings”. Without consent, no analytics or marketing scripts load at all.</li>
<li><strong>Orders</strong> (if this site sells products). Name, address, email and order details, processed to fulfil the contract and kept as long as tax law requires.</li>
</ul>
<h2>Recipients</h2>
<p>Data stays on our systems, except where named services are needed to deliver it (for example an email delivery provider for transactional mail, or a payment provider during checkout — payment card data never touches this site).</p>
<h2>Your rights</h2>
<p>You can request access to, correction of, or deletion of your personal data, restriction of processing, data portability, and you can object to processing based on legitimate interest. Write to {{trader_email}}. You also have the right to lodge a complaint with your supervisory authority.</p>
<h2>Storage periods</h2>
<p>We keep personal data only as long as the purpose above requires, or as long as statutory retention duties (for example tax law for order records) demand.</p>
`,
      },
      el: {
        title: 'Πολιτική Απορρήτου',
        slug: 'politiki-aporritou',
        body: `
<p>Η σελίδα αυτή εξηγεί ποια προσωπικά δεδομένα επεξεργάζεται το <strong>{{site_title}}</strong> ({{trader_legal_name}}), γιατί, και ποια δικαιώματα έχετε. Υπεύθυνος επεξεργασίας: {{trader_legal_name}}, {{trader_address}} — επικοινωνία: {{trader_email}}.</p>
<h2>Τι επεξεργαζόμαστε και γιατί</h2>
<ul>
<li><strong>Απολύτως απαραίτητα δεδομένα.</strong> Ένα cookie συνεδρίας και ένα διακριτικό ασφαλείας (CSRF) ορίζονται για συνδεδεμένους χρήστες· απαιτούνται για τη λειτουργία της υπηρεσίας και δεν χρησιμοποιούνται για παρακολούθηση (νομική βάση: έννομο συμφέρον / σύμβαση).</li>
<li><strong>Φόρμα επικοινωνίας.</strong> Το όνομα, η διεύθυνση email και το μήνυμά σας, για όσο διαρκεί η διεκπεραίωση του αιτήματός σας (νομική βάση: το έννομο συμφέρον μας να σας απαντήσουμε).</li>
<li><strong>Newsletter.</strong> Η διεύθυνση email σας, μόνο μετά την εγγραφή σας. Μπορείτε να διαγραφείτε οποτεδήποτε (νομική βάση: συγκατάθεση).</li>
<li><strong>Στατιστικά και μάρκετινγκ.</strong> Μόνο με τη συγκατάθεσή σας μέσω του banner cookies, ανακλητή οποτεδήποτε από τις «Ρυθμίσεις cookies». Χωρίς συγκατάθεση, κανένα σχετικό script δεν φορτώνεται.</li>
<li><strong>Παραγγελίες</strong> (εφόσον το site πωλεί προϊόντα). Όνομα, διεύθυνση, email και στοιχεία παραγγελίας, για την εκτέλεση της σύμβασης και για όσο απαιτεί η φορολογική νομοθεσία.</li>
</ul>
<h2>Αποδέκτες</h2>
<p>Τα δεδομένα παραμένουν στα συστήματά μας, εκτός από συγκεκριμένες υπηρεσίες απαραίτητες για την παροχή τους (π.χ. πάροχος αποστολής email για λειτουργικά μηνύματα, ή πάροχος πληρωμών κατά την ολοκλήρωση αγοράς — τα στοιχεία κάρτας δεν αγγίζουν ποτέ αυτό το site).</p>
<h2>Τα δικαιώματά σας</h2>
<p>Μπορείτε να ζητήσετε πρόσβαση, διόρθωση ή διαγραφή των δεδομένων σας, περιορισμό της επεξεργασίας, φορητότητα, και να εναντιωθείτε σε επεξεργασία που βασίζεται σε έννομο συμφέρον. Γράψτε στο {{trader_email}}. Έχετε επίσης δικαίωμα καταγγελίας στην Αρχή Προστασίας Δεδομένων Προσωπικού Χαρακτήρα.</p>
<h2>Χρόνοι διατήρησης</h2>
<p>Διατηρούμε προσωπικά δεδομένα μόνο για όσο απαιτεί ο εκάστοτε σκοπός ή οι νόμιμες υποχρεώσεις διατήρησης (π.χ. φορολογική νομοθεσία για παραστατικά).</p>
`,
      },
      de: {
        title: 'Datenschutzerklärung',
        slug: 'datenschutz',
        body: `
<p>Diese Seite erklärt, welche personenbezogenen Daten <strong>{{site_title}}</strong> ({{trader_legal_name}}) verarbeitet, warum, und welche Rechte Sie haben. Verantwortlicher: {{trader_legal_name}}, {{trader_address}} — Kontakt: {{trader_email}}.</p>
<h2>Was wir verarbeiten, und warum</h2>
<ul>
<li><strong>Technisch notwendige Daten.</strong> Für angemeldete Nutzer werden ein Sitzungs-Cookie und ein Sicherheits-Token (CSRF) gesetzt; sie sind für den Betrieb erforderlich und dienen nicht dem Tracking (Rechtsgrundlage: berechtigtes Interesse / Vertrag).</li>
<li><strong>Kontaktformular.</strong> Name, E-Mail-Adresse und Ihre Nachricht, gespeichert solange die Bearbeitung Ihres Anliegens dauert (Rechtsgrundlage: unser berechtigtes Interesse, Ihnen zu antworten).</li>
<li><strong>Newsletter.</strong> Ihre E-Mail-Adresse, nur nach Ihrer Anmeldung. Sie können sich jederzeit abmelden (Rechtsgrundlage: Einwilligung).</li>
<li><strong>Analyse und Marketing.</strong> Nur mit Ihrer Einwilligung über das Cookie-Banner, jederzeit widerrufbar unter „Cookie-Einstellungen“. Ohne Einwilligung werden keine entsprechenden Skripte geladen.</li>
<li><strong>Bestellungen</strong> (sofern diese Website Produkte verkauft). Name, Anschrift, E-Mail und Bestelldaten zur Vertragserfüllung, aufbewahrt solange steuerrechtliche Pflichten es verlangen.</li>
</ul>
<h2>Empfänger</h2>
<p>Daten verbleiben auf unseren Systemen, außer wo benannte Dienste zur Erbringung nötig sind (etwa ein E-Mail-Versanddienst für Transaktionsmails oder ein Zahlungsdienstleister beim Checkout — Kartendaten berühren diese Website nie).</p>
<h2>Ihre Rechte</h2>
<p>Sie haben das Recht auf Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung, Datenübertragbarkeit sowie Widerspruch gegen Verarbeitung auf Basis berechtigten Interesses. Schreiben Sie an {{trader_email}}. Außerdem besteht ein Beschwerderecht bei der zuständigen Aufsichtsbehörde.</p>
<h2>Speicherdauer</h2>
<p>Wir speichern personenbezogene Daten nur solange der jeweilige Zweck es erfordert oder gesetzliche Aufbewahrungspflichten (z. B. Steuerrecht für Belege) es verlangen.</p>
`,
      },
    },
  },
  {
    id: 'terms',
    label: 'Terms of service',
    locales: {
      en: {
        title: 'Terms of Service',
        slug: 'terms-of-service',
        body: `
<p>These terms govern the use of <strong>{{site_title}}</strong> ({{site_url}}), operated by {{trader_legal_name}}, {{trader_address}}.</p>
<h2>Use of this site</h2>
<p>The content of this site is provided for information (and, where a shop is offered, for purchasing the products presented). You agree not to misuse the site — including attempting to disrupt it, to access accounts or data that are not yours, or to submit unlawful content through its forms.</p>
<h2>Content and intellectual property</h2>
<p>Texts, images and other material on this site belong to {{trader_legal_name}} or their respective rights holders and may not be reused without permission, except where the law allows it.</p>
<h2>If this site sells products</h2>
<p>Product presentations are an invitation to order, not a binding offer. A contract is formed when we confirm your order. Prices include VAT where applicable; delivery costs are shown before checkout. Statutory warranty rights apply. Consumers have a right of withdrawal — see the withdrawal notice on this site.</p>
<h2>Liability</h2>
<p>We are liable without limitation for intent and gross negligence. For ordinary negligence we are liable only for breach of essential contractual obligations, limited to the foreseeable, typical damage. Statutory liability (for example for personal injury, or under product liability law) remains unaffected.</p>
<h2>Final provisions</h2>
<p>Should individual provisions of these terms be invalid, the remainder stays in force. The law of the operator's seat applies, without prejudice to mandatory consumer protections of your country of residence.</p>
`,
      },
      el: {
        title: 'Όροι Χρήσης',
        slug: 'oroi-xrisis',
        body: `
<p>Οι παρόντες όροι διέπουν τη χρήση του <strong>{{site_title}}</strong> ({{site_url}}), που λειτουργεί από την {{trader_legal_name}}, {{trader_address}}.</p>
<h2>Χρήση του ιστότοπου</h2>
<p>Το περιεχόμενο του ιστότοπου παρέχεται για ενημέρωση (και, όπου προσφέρεται κατάστημα, για την αγορά των προϊόντων που παρουσιάζονται). Συμφωνείτε να μην κάνετε κατάχρηση του ιστότοπου — μεταξύ άλλων να μην επιχειρείτε να διαταράξετε τη λειτουργία του, να αποκτήσετε πρόσβαση σε λογαριασμούς ή δεδομένα που δεν σας ανήκουν, ή να υποβάλετε παράνομο περιεχόμενο μέσω των φορμών του.</p>
<h2>Περιεχόμενο και πνευματική ιδιοκτησία</h2>
<p>Κείμενα, εικόνες και λοιπό υλικό ανήκουν στην {{trader_legal_name}} ή στους αντίστοιχους δικαιούχους και δεν επιτρέπεται η επαναχρησιμοποίησή τους χωρίς άδεια, εκτός όπου ο νόμος το επιτρέπει.</p>
<h2>Εφόσον ο ιστότοπος πωλεί προϊόντα</h2>
<p>Η παρουσίαση προϊόντων αποτελεί πρόσκληση για παραγγελία, όχι δεσμευτική προσφορά. Η σύμβαση καταρτίζεται με την επιβεβαίωση της παραγγελίας σας. Οι τιμές περιλαμβάνουν ΦΠΑ όπου ισχύει· τα έξοδα αποστολής εμφανίζονται πριν την ολοκλήρωση. Ισχύουν τα νόμιμα δικαιώματα εγγύησης. Οι καταναλωτές έχουν δικαίωμα υπαναχώρησης — δείτε τη σχετική ενημέρωση στον ιστότοπο.</p>
<h2>Ευθύνη</h2>
<p>Ευθυνόμαστε απεριόριστα για δόλο και βαριά αμέλεια. Για ελαφρά αμέλεια ευθυνόμαστε μόνο για παράβαση ουσιωδών συμβατικών υποχρεώσεων, περιοριζόμενη στην προβλέψιμη, τυπική ζημία. Η εκ του νόμου ευθύνη (π.χ. για σωματική βλάβη ή κατά τη νομοθεσία περί ευθύνης προϊόντων) παραμένει ανέπαφη.</p>
<h2>Τελικές διατάξεις</h2>
<p>Αν επιμέρους όροι κριθούν άκυροι, οι υπόλοιποι παραμένουν σε ισχύ. Εφαρμόζεται το δίκαιο της έδρας του διαχειριστή, με την επιφύλαξη αναγκαστικών διατάξεων προστασίας καταναλωτή της χώρας διαμονής σας.</p>
`,
      },
      de: {
        title: 'Nutzungsbedingungen',
        slug: 'nutzungsbedingungen',
        body: `
<p>Diese Bedingungen regeln die Nutzung von <strong>{{site_title}}</strong> ({{site_url}}), betrieben von {{trader_legal_name}}, {{trader_address}}.</p>
<h2>Nutzung dieser Website</h2>
<p>Die Inhalte dieser Website dienen der Information (und, wo ein Shop angeboten wird, dem Kauf der dargestellten Produkte). Sie verpflichten sich, die Website nicht zu missbrauchen — insbesondere nicht ihren Betrieb zu stören, auf fremde Konten oder Daten zuzugreifen oder rechtswidrige Inhalte über ihre Formulare zu übermitteln.</p>
<h2>Inhalte und geistiges Eigentum</h2>
<p>Texte, Bilder und sonstiges Material gehören {{trader_legal_name}} bzw. den jeweiligen Rechteinhabern und dürfen ohne Erlaubnis nicht weiterverwendet werden, soweit das Gesetz nichts anderes erlaubt.</p>
<h2>Sofern diese Website Produkte verkauft</h2>
<p>Produktdarstellungen sind eine Aufforderung zur Bestellung, kein bindendes Angebot. Der Vertrag kommt mit unserer Bestellbestätigung zustande. Preise enthalten die gesetzliche MwSt., Versandkosten werden vor dem Checkout angezeigt. Es gelten die gesetzlichen Gewährleistungsrechte. Verbrauchern steht ein Widerrufsrecht zu — siehe die Widerrufsbelehrung auf dieser Website.</p>
<h2>Haftung</h2>
<p>Wir haften unbeschränkt für Vorsatz und grobe Fahrlässigkeit. Bei einfacher Fahrlässigkeit haften wir nur für die Verletzung wesentlicher Vertragspflichten, begrenzt auf den vorhersehbaren, vertragstypischen Schaden. Die gesetzliche Haftung (etwa für Personenschäden oder nach dem Produkthaftungsgesetz) bleibt unberührt.</p>
<h2>Schlussbestimmungen</h2>
<p>Sollten einzelne Bestimmungen unwirksam sein, bleibt der Rest wirksam. Es gilt das Recht am Sitz des Betreibers, unbeschadet zwingender Verbraucherschutzvorschriften Ihres Wohnsitzlandes.</p>
`,
      },
    },
  },
  {
    id: 'cookies',
    label: 'Cookie policy',
    locales: {
      en: {
        title: 'Cookie Policy',
        slug: 'cookie-policy',
        body: `
<p><strong>{{site_title}}</strong> uses as few cookies as it can get away with, and asks before using any that are not strictly necessary.</p>
<h2>Strictly necessary</h2>
<p>A session cookie (signed-in users) and a security token protect your account and the forms on this site. They are exempt from consent because the service you asked for does not work without them.</p>
<h2>Everything else — only with your consent</h2>
<p>Preference, analytics and marketing cookies are grouped into categories you choose in the cookie banner. Before you consent, none of those scripts load — not "load and wait", but not loaded at all. Your choice is stored for six months and re-asked when it expires or when the categories change.</p>
<h2>Changing your mind</h2>
<p>Open “Cookie settings” (in the footer of every page) at any time to withdraw or change your consent. Withdrawing is one click, the same as accepting was.</p>
<h2>Questions</h2>
<p>Contact {{trader_legal_name}} at {{trader_email}}. Details on what each category processes are in our privacy policy.</p>
`,
      },
      el: {
        title: 'Πολιτική Cookies',
        slug: 'politiki-cookies',
        body: `
<p>Το <strong>{{site_title}}</strong> χρησιμοποιεί όσο το δυνατόν λιγότερα cookies, και ρωτά πριν χρησιμοποιήσει οποιοδήποτε δεν είναι απολύτως απαραίτητο.</p>
<h2>Απολύτως απαραίτητα</h2>
<p>Ένα cookie συνεδρίας (για συνδεδεμένους χρήστες) και ένα διακριτικό ασφαλείας προστατεύουν τον λογαριασμό σας και τις φόρμες του ιστότοπου. Εξαιρούνται από τη συγκατάθεση γιατί η υπηρεσία που ζητήσατε δεν λειτουργεί χωρίς αυτά.</p>
<h2>Όλα τα υπόλοιπα — μόνο με τη συγκατάθεσή σας</h2>
<p>Τα cookies προτιμήσεων, στατιστικών και μάρκετινγκ ομαδοποιούνται σε κατηγορίες που επιλέγετε στο banner. Πριν συγκατατεθείτε, κανένα από αυτά τα scripts δεν φορτώνεται — όχι «φορτώνει και περιμένει», αλλά δεν φορτώνεται καθόλου. Η επιλογή σας αποθηκεύεται για έξι μήνες και ζητείται ξανά όταν λήξει ή όταν αλλάξουν οι κατηγορίες.</p>
<h2>Αν αλλάξετε γνώμη</h2>
<p>Ανοίξτε τις «Ρυθμίσεις cookies» (στο υποσέλιδο κάθε σελίδας) οποτεδήποτε για να ανακαλέσετε ή να αλλάξετε τη συγκατάθεσή σας. Η ανάκληση είναι ένα κλικ, όσο και η αποδοχή.</p>
<h2>Απορίες</h2>
<p>Επικοινωνήστε με την {{trader_legal_name}} στο {{trader_email}}. Λεπτομέρειες για το τι επεξεργάζεται κάθε κατηγορία θα βρείτε στην πολιτική απορρήτου.</p>
`,
      },
      de: {
        title: 'Cookie-Richtlinie',
        slug: 'cookie-richtlinie',
        body: `
<p><strong>{{site_title}}</strong> verwendet so wenige Cookies wie möglich — und fragt, bevor irgendein nicht zwingend notwendiges gesetzt wird.</p>
<h2>Technisch notwendig</h2>
<p>Ein Sitzungs-Cookie (für angemeldete Nutzer) und ein Sicherheits-Token schützen Ihr Konto und die Formulare dieser Website. Sie sind einwilligungsfrei, weil der von Ihnen angeforderte Dienst ohne sie nicht funktioniert.</p>
<h2>Alles andere — nur mit Ihrer Einwilligung</h2>
<p>Präferenz-, Analyse- und Marketing-Cookies sind in Kategorien gruppiert, die Sie im Banner wählen. Vor Ihrer Einwilligung wird keines dieser Skripte geladen — nicht „laden und warten“, sondern gar nicht geladen. Ihre Wahl wird sechs Monate gespeichert und erneut erfragt, wenn sie abläuft oder sich die Kategorien ändern.</p>
<h2>Meinung geändert?</h2>
<p>Öffnen Sie jederzeit die „Cookie-Einstellungen“ (im Footer jeder Seite), um Ihre Einwilligung zu widerrufen oder zu ändern. Der Widerruf ist ein Klick — genau wie die Zustimmung.</p>
<h2>Fragen</h2>
<p>Kontaktieren Sie {{trader_legal_name}} unter {{trader_email}}. Details zu den einzelnen Kategorien stehen in der Datenschutzerklärung.</p>
`,
      },
    },
  },
  {
    id: 'imprint',
    label: 'Imprint / legal notice',
    locales: {
      en: {
        title: 'Legal Notice',
        slug: 'legal-notice',
        body: `
<h2>Site operator</h2>
<p>{{trader_legal_name}}<br />{{trader_address}}</p>
<h2>Contact</h2>
<p>Email: {{trader_email}}<br />Phone: {{trader_phone}}</p>
<h2>Responsible for content</h2>
<p>{{trader_legal_name}}, at the address above.</p>
<h2>Dispute resolution</h2>
<p>The European Commission provides a platform for online dispute resolution: <a href="https://ec.europa.eu/consumers/odr/" rel="noopener">ec.europa.eu/consumers/odr</a>. We are neither obliged nor willing to participate in dispute-settlement proceedings before a consumer arbitration board, unless stated otherwise here.</p>
`,
      },
      el: {
        title: 'Στοιχεία Επιχείρησης',
        slug: 'stoixeia-epixeirisis',
        body: `
<h2>Διαχειριστής ιστότοπου</h2>
<p>{{trader_legal_name}}<br />{{trader_address}}</p>
<h2>Επικοινωνία</h2>
<p>Email: {{trader_email}}<br />Τηλέφωνο: {{trader_phone}}</p>
<h2>Υπεύθυνος περιεχομένου</h2>
<p>{{trader_legal_name}}, στην παραπάνω διεύθυνση.</p>
<h2>Επίλυση διαφορών</h2>
<p>Η Ευρωπαϊκή Επιτροπή παρέχει πλατφόρμα ηλεκτρονικής επίλυσης διαφορών: <a href="https://ec.europa.eu/consumers/odr/" rel="noopener">ec.europa.eu/consumers/odr</a>. Δεν είμαστε υποχρεωμένοι ούτε πρόθυμοι να συμμετάσχουμε σε διαδικασία εναλλακτικής επίλυσης καταναλωτικών διαφορών, εκτός αν ορίζεται διαφορετικά εδώ.</p>
`,
      },
      de: {
        title: 'Impressum',
        slug: 'impressum',
        body: `
<h2>Betreiber der Website</h2>
<p>{{trader_legal_name}}<br />{{trader_address}}</p>
<h2>Kontakt</h2>
<p>E-Mail: {{trader_email}}<br />Telefon: {{trader_phone}}</p>
<h2>Inhaltlich verantwortlich</h2>
<p>{{trader_legal_name}}, unter obiger Anschrift.</p>
<h2>Streitbeilegung</h2>
<p>Die Europäische Kommission stellt eine Plattform zur Online-Streitbeilegung bereit: <a href="https://ec.europa.eu/consumers/odr/" rel="noopener">ec.europa.eu/consumers/odr</a>. Zur Teilnahme an einem Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle sind wir nicht verpflichtet und nicht bereit, sofern hier nichts anderes angegeben ist.</p>
`,
      },
    },
  },
  {
    id: 'returns',
    label: 'Returns (shops)',
    commerceOnly: true,
    locales: {
      en: {
        title: 'Returns',
        slug: 'returns',
        body: `
<p>We want you to keep what you ordered because it is right, not because returning it is hard.</p>
<h2>Your statutory right of withdrawal</h2>
<p>As a consumer you can withdraw from your purchase within the statutory period without giving a reason. The full, binding withdrawal notice — including the model withdrawal form — is here: <a href="/legal/withdrawal">Right of withdrawal</a>. That notice is the authoritative text; this page only describes the practical steps.</p>
<h2>How a return works in practice</h2>
<ul>
<li>Write to {{trader_email}} (or use the model form) telling us you are withdrawing — an order number speeds things up.</li>
<li>Send the items back to: {{trader_legal_name}}, {{trader_address}}.</li>
<li>Pack items so they survive the trip; you only owe us for loss of value from handling beyond what a shop would allow.</li>
<li>We refund with the same payment method you used, within the statutory deadline after receiving the goods or proof of return.</li>
</ul>
<h2>Faulty items</h2>
<p>Statutory warranty rights are separate from withdrawal and are not limited by anything on this page. If something arrives damaged or wrong, contact us and we will make it right.</p>
`,
      },
      el: {
        title: 'Επιστροφές',
        slug: 'epistrofes',
        body: `
<p>Θέλουμε να κρατήσετε ό,τι παραγγείλατε επειδή σας ταιριάζει — όχι επειδή η επιστροφή είναι δύσκολη.</p>
<h2>Το νόμιμο δικαίωμα υπαναχώρησης</h2>
<p>Ως καταναλωτής μπορείτε να υπαναχωρήσετε από την αγορά σας εντός της νόμιμης προθεσμίας χωρίς αιτιολογία. Η πλήρης, δεσμευτική ενημέρωση υπαναχώρησης — μαζί με το υπόδειγμα δήλωσης — βρίσκεται εδώ: <a href="/legal/withdrawal">Δικαίωμα υπαναχώρησης</a>. Εκείνο το κείμενο είναι το αυθεντικό· η παρούσα σελίδα περιγράφει μόνο τα πρακτικά βήματα.</p>
<h2>Πώς γίνεται μια επιστροφή στην πράξη</h2>
<ul>
<li>Γράψτε στο {{trader_email}} (ή χρησιμοποιήστε το υπόδειγμα) ότι υπαναχωρείτε — ο αριθμός παραγγελίας επιταχύνει τη διαδικασία.</li>
<li>Στείλτε τα προϊόντα στη διεύθυνση: {{trader_legal_name}}, {{trader_address}}.</li>
<li>Συσκευάστε τα ώστε να αντέξουν τη μεταφορά· ευθύνεστε μόνο για μείωση της αξίας από χρήση πέρα από όση θα επέτρεπε ένα κατάστημα.</li>
<li>Η επιστροφή χρημάτων γίνεται με το ίδιο μέσο πληρωμής, εντός της νόμιμης προθεσμίας από την παραλαβή των προϊόντων ή την απόδειξη αποστολής τους.</li>
</ul>
<h2>Ελαττωματικά προϊόντα</h2>
<p>Τα νόμιμα δικαιώματα εγγύησης είναι ανεξάρτητα από την υπαναχώρηση και δεν περιορίζονται από τίποτα σε αυτή τη σελίδα. Αν κάτι φτάσει ελαττωματικό ή λάθος, επικοινωνήστε μαζί μας και θα το διορθώσουμε.</p>
`,
      },
      de: {
        title: 'Rücksendungen',
        slug: 'ruecksendungen',
        body: `
<p>Sie sollen behalten, was Sie bestellt haben, weil es passt — nicht, weil die Rücksendung mühsam wäre.</p>
<h2>Ihr gesetzliches Widerrufsrecht</h2>
<p>Als Verbraucher können Sie Ihren Kauf innerhalb der gesetzlichen Frist ohne Angabe von Gründen widerrufen. Die vollständige, verbindliche Widerrufsbelehrung — samt Muster-Widerrufsformular — finden Sie hier: <a href="/legal/withdrawal">Widerrufsrecht</a>. Jener Text ist maßgeblich; diese Seite beschreibt nur die praktischen Schritte.</p>
<h2>So läuft eine Rücksendung ab</h2>
<ul>
<li>Schreiben Sie an {{trader_email}} (oder nutzen Sie das Musterformular), dass Sie widerrufen — die Bestellnummer beschleunigt die Bearbeitung.</li>
<li>Senden Sie die Artikel an: {{trader_legal_name}}, {{trader_address}}.</li>
<li>Verpacken Sie die Artikel transportsicher; Sie haften nur für Wertverlust durch einen Umgang, der über das im Laden Übliche hinausgeht.</li>
<li>Die Erstattung erfolgt mit demselben Zahlungsmittel innerhalb der gesetzlichen Frist nach Erhalt der Ware oder des Rücksendenachweises.</li>
</ul>
<h2>Mangelhafte Artikel</h2>
<p>Die gesetzlichen Gewährleistungsrechte bestehen unabhängig vom Widerruf und werden durch diese Seite nicht eingeschränkt. Kommt etwas beschädigt oder falsch an, melden Sie sich — wir bringen es in Ordnung.</p>
`,
      },
    },
  },
];

export function getLegalTemplate(id: string): LegalTemplate | undefined {
  return LEGAL_TEMPLATES.find((t) => t.id === id);
}

export interface RenderedLegalTemplate {
  title: string;
  slug: string;
  contentHtml: string;
  /** Placeholder keys that had no value and were rendered as visible markers. */
  missing: string[];
}

/**
 * Fill a template's placeholders from the settings map. A missing value
 * becomes a VISIBLE `<mark>[fill in: key]</mark>` marker — the page is
 * created as a draft, and an obvious gap is the honest state for a draft.
 */
export function renderLegalTemplate(
  id: string,
  locale: LegalTemplateLocale,
  settings: Record<string, unknown> | null | undefined,
): RenderedLegalTemplate | null {
  const template = getLegalTemplate(id);
  if (!template) return null;
  const text = template.locales[locale];
  if (!text) return null;

  const map = settings ?? {};
  const missing = new Set<string>();
  // Settings values are DATA landing in markup: escaped here, every time.
  // The withdrawal page documents why — a trader-address field is a
  // stored-XSS vector the moment it is interpolated raw. The whole result is
  // also sanitized on save like any page body; this escape is the first lock.
  const contentHtml = text.body.replace(/\{\{([a-z_]+)\}\}/g, (whole, key: string) => {
    if (!(TEMPLATE_PLACEHOLDER_KEYS as readonly string[]).includes(key)) return whole;
    const value = map[key];
    if (typeof value === 'string' && value.trim() !== '') return esc(value.trim());
    missing.add(key);
    return `<mark>[${FILL_MARKER[locale]}: ${key.replace(/_/g, ' ')}]</mark>`;
  }).trim();

  return { title: text.title, slug: text.slug, contentHtml, missing: [...missing].sort() };
}
