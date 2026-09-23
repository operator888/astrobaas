/**
 * The withdrawal notice in each language AstroBaaS ships.
 *
 * ## Read this before changing anything here
 *
 * These are the model texts of **Annex I(A) and I(B) of Directive
 * 2011/83/EU**. They are not marketing copy and they are not ours: the
 * Directive publishes OFFICIAL translations in every EU language, and a
 * paraphrase — however fluent — is legally worse than the English original.
 *
 * `ORDER_BUTTON_LABEL` is the sharpest case. Article 8(2) requires the order
 * button to be labelled unambiguously; "Continue" does not bind the consumer,
 * and a mislabelled button can leave the contract unenforceable. The German
 * "Zahlungspflichtig bestellen" is the wording the statute itself names.
 *
 * ## These translations have NOT been checked against EUR-Lex
 *
 * They are a faithful reconstruction, good enough to build and test against and
 * NOT good enough to launch on. `withdrawalTextIsVerified()` is what gates
 * that, and it defaults to false: a shop serves the English text until its
 * operator confirms they have checked the translation for their language.
 *
 * That default is deliberate. English is the operator's own risk and they chose
 * it; a Greek text nobody read is a risk they did not choose.
 *
 * Official texts: EUR-Lex 32011L0083, Annex I.
 */

export interface WithdrawalStrings {
  /** Heading of the instructions. */
  rightTitle: string;
  /** `{days}` — the withdrawal window. */
  rightIntro: string;
  /** `{days}` */
  periodExpires: string;
  informUs: string;
  unequivocal: string;
  deadlineNotice: string;
  effectsTitle: string;
  reimburse: string;
  sameMeans: string;
  returnCostsTrader: string;
  returnCostsCustomer: string;
  diminishedValue: string;
  exceptionsTitle: string;

  formTitle: string;
  formOnlyIf: string;
  formTo: string;
  formNotice: string;
  formOrderedOn: string;
  formConsumerName: string;
  formConsumerAddress: string;
  formSignature: string;
  formDate: string;
  formDeleteAsAppropriate: string;

  /** Article 8(2). Rendered verbatim by storefronts. */
  orderButtonLabel: string;
}

const en: WithdrawalStrings = {
  rightTitle: 'Right of withdrawal',
  rightIntro: 'You have the right to withdraw from this contract within {days} days without giving any reason.',
  periodExpires: 'The withdrawal period expires after {days} days from the day on which you acquire, or a third party other than the carrier and indicated by you acquires, physical possession of the goods.',
  informUs: 'To exercise the right of withdrawal, you must inform us:',
  unequivocal: 'of your decision to withdraw from this contract by an unequivocal statement (for example, a letter sent by post or e-mail). You may use the model withdrawal form below, but it is not obligatory.',
  deadlineNotice: 'To meet the withdrawal deadline, it is sufficient for you to send your communication concerning your exercise of the right of withdrawal before the withdrawal period has expired.',
  effectsTitle: 'Effects of withdrawal',
  reimburse: 'If you withdraw from this contract, we shall reimburse to you all payments received from you, including the costs of delivery (with the exception of the supplementary costs resulting from your choice of a type of delivery other than the least expensive type of standard delivery offered by us), without undue delay and in any event not later than 14 days from the day on which we are informed about your decision to withdraw from this contract.',
  sameMeans: 'We will carry out such reimbursement using the same means of payment as you used for the initial transaction, unless you have expressly agreed otherwise; in any event, you will not incur any fees as a result of such reimbursement.',
  returnCostsTrader: 'We bear the cost of returning the goods.',
  returnCostsCustomer: 'You will have to bear the direct cost of returning the goods.',
  diminishedValue: 'You are only liable for any diminished value of the goods resulting from the handling other than what is necessary to establish the nature, characteristics and functioning of the goods.',
  exceptionsTitle: 'Exceptions to the right of withdrawal',

  formTitle: 'Model withdrawal form',
  formOnlyIf: '(complete and return this form only if you wish to withdraw from the contract)',
  formTo: 'To:',
  formNotice: 'I/We (*) hereby give notice that I/We (*) withdraw from my/our (*) contract of sale of the following goods (*)/for the provision of the following service (*),',
  formOrderedOn: 'Ordered on (*)/received on (*): ____________________',
  formConsumerName: 'Name of consumer(s): ____________________',
  formConsumerAddress: 'Address of consumer(s): ____________________',
  formSignature: 'Signature of consumer(s) (only if this form is notified on paper): ____________________',
  formDate: 'Date: ____________________',
  formDeleteAsAppropriate: '(*) Delete as appropriate.',

  orderButtonLabel: 'Order with obligation to pay',
};

const de: WithdrawalStrings = {
  rightTitle: 'Widerrufsrecht',
  rightIntro: 'Sie haben das Recht, binnen {days} Tagen ohne Angabe von Gründen diesen Vertrag zu widerrufen.',
  periodExpires: 'Die Widerrufsfrist beträgt {days} Tage ab dem Tag, an dem Sie oder ein von Ihnen benannter Dritter, der nicht der Beförderer ist, die Waren in Besitz genommen haben bzw. hat.',
  informUs: 'Um Ihr Widerrufsrecht auszuüben, müssen Sie uns:',
  unequivocal: 'mittels einer eindeutigen Erklärung (z. B. ein mit der Post versandter Brief oder eine E-Mail) über Ihren Entschluss, diesen Vertrag zu widerrufen, informieren. Sie können dafür das beigefügte Muster-Widerrufsformular verwenden, das jedoch nicht vorgeschrieben ist.',
  deadlineNotice: 'Zur Wahrung der Widerrufsfrist reicht es aus, dass Sie die Mitteilung über die Ausübung des Widerrufsrechts vor Ablauf der Widerrufsfrist absenden.',
  effectsTitle: 'Folgen des Widerrufs',
  reimburse: 'Wenn Sie diesen Vertrag widerrufen, haben wir Ihnen alle Zahlungen, die wir von Ihnen erhalten haben, einschließlich der Lieferkosten (mit Ausnahme der zusätzlichen Kosten, die sich daraus ergeben, dass Sie eine andere Art der Lieferung als die von uns angebotene, günstigste Standardlieferung gewählt haben), unverzüglich und spätestens binnen vierzehn Tagen ab dem Tag zurückzuzahlen, an dem die Mitteilung über Ihren Widerruf dieses Vertrags bei uns eingegangen ist.',
  sameMeans: 'Für diese Rückzahlung verwenden wir dasselbe Zahlungsmittel, das Sie bei der ursprünglichen Transaktion eingesetzt haben, es sei denn, mit Ihnen wurde ausdrücklich etwas anderes vereinbart; in keinem Fall werden Ihnen wegen dieser Rückzahlung Entgelte berechnet.',
  returnCostsTrader: 'Wir tragen die Kosten der Rücksendung der Waren.',
  returnCostsCustomer: 'Sie tragen die unmittelbaren Kosten der Rücksendung der Waren.',
  diminishedValue: 'Sie müssen für einen etwaigen Wertverlust der Waren nur aufkommen, wenn dieser Wertverlust auf einen zur Prüfung der Beschaffenheit, Eigenschaften und Funktionsweise der Waren nicht notwendigen Umgang mit ihnen zurückzuführen ist.',
  exceptionsTitle: 'Ausnahmen vom Widerrufsrecht',

  formTitle: 'Muster-Widerrufsformular',
  formOnlyIf: '(Wenn Sie den Vertrag widerrufen wollen, dann füllen Sie bitte dieses Formular aus und senden Sie es zurück.)',
  formTo: 'An:',
  formNotice: 'Hiermit widerrufe(n) ich/wir (*) den von mir/uns (*) abgeschlossenen Vertrag über den Kauf der folgenden Waren (*)/die Erbringung der folgenden Dienstleistung (*),',
  formOrderedOn: 'Bestellt am (*)/erhalten am (*): ____________________',
  formConsumerName: 'Name des/der Verbraucher(s): ____________________',
  formConsumerAddress: 'Anschrift des/der Verbraucher(s): ____________________',
  formSignature: 'Unterschrift des/der Verbraucher(s) (nur bei Mitteilung auf Papier): ____________________',
  formDate: 'Datum: ____________________',
  formDeleteAsAppropriate: '(*) Unzutreffendes streichen.',

  // Named by Article 8(2) itself. Not a phrase to improve on.
  orderButtonLabel: 'Zahlungspflichtig bestellen',
};

const el: WithdrawalStrings = {
  rightTitle: 'Δικαίωμα υπαναχώρησης',
  rightIntro: 'Έχετε το δικαίωμα να υπαναχωρήσετε από την παρούσα σύμβαση εντός {days} ημερών χωρίς να δώσετε οποιαδήποτε εξήγηση.',
  periodExpires: 'Η προθεσμία υπαναχώρησης λήγει {days} ημέρες από την ημέρα που εσείς ή κάποιος τρίτος διάφορος του μεταφορέα, τον οποίο θα έχετε υποδείξει, αποκτά τη φυσική κατοχή των αγαθών.',
  informUs: 'Για να ασκήσετε το δικαίωμα υπαναχώρησης, οφείλετε να μας ενημερώσετε:',
  unequivocal: 'για την απόφασή σας να υπαναχωρήσετε από την παρούσα σύμβαση με μια ξεκάθαρη δήλωση (π.χ. επιστολή που θα σταλεί με ταχυδρομείο ή ηλεκτρονικό ταχυδρομείο). Μπορείτε να χρησιμοποιήσετε το συνημμένο υπόδειγμα εντύπου υπαναχώρησης, χωρίς τούτο να είναι υποχρεωτικό.',
  deadlineNotice: 'Για να τηρήσετε την προθεσμία υπαναχώρησης, είναι αρκετό να στείλετε τη δήλωσή σας περί άσκησης του δικαιώματος υπαναχώρησής σας πριν λήξει η προθεσμία υπαναχώρησης.',
  effectsTitle: 'Συνέπειες της υπαναχώρησης',
  reimburse: 'Εάν υπαναχωρήσετε από την παρούσα σύμβαση, θα σας επιστρέψουμε όλα τα χρήματα που λάβαμε από εσάς, συμπεριλαμβανομένων των εξόδων παράδοσης (εξαιρουμένων των συμπληρωματικών εξόδων που οφείλονται στη δική σας επιλογή να χρησιμοποιηθεί τρόπος παράδοσης άλλος από τον φθηνότερο τυποποιημένο τρόπο παράδοσης που εμείς προσφέρουμε), χωρίς αδικαιολόγητη καθυστέρηση και οπωσδήποτε εντός 14 ημερών από την ημέρα που θα πληροφορηθούμε την απόφασή σας να υπαναχωρήσετε από την παρούσα σύμβαση.',
  sameMeans: 'Θα εκτελέσουμε την ανωτέρω επιστροφή χρημάτων χρησιμοποιώντας το ίδιο μέσο πληρωμής που εσείς χρησιμοποιήσατε για την αρχική συναλλαγή, εκτός κι αν εσείς έχετε συμφωνήσει ρητώς για κάτι διαφορετικό· σε κάθε περίπτωση, δεν θα σας χρεωθούν έξοδα για τέτοια επιστροφή χρημάτων.',
  returnCostsTrader: 'Εμείς επιβαρυνόμαστε με το κόστος επιστροφής των αγαθών.',
  returnCostsCustomer: 'Εσείς θα επιβαρυνθείτε με την άμεση δαπάνη επιστροφής των αγαθών.',
  diminishedValue: 'Φέρετε ευθύνη μόνο για οποιαδήποτε μείωση της αξίας των αγαθών προκύψει από χειρισμό που δεν ήταν απαραίτητος για να προσδιοριστεί η φύση, τα χαρακτηριστικά και η λειτουργία των αγαθών.',
  exceptionsTitle: 'Εξαιρέσεις από το δικαίωμα υπαναχώρησης',

  formTitle: 'Υπόδειγμα εντύπου υπαναχώρησης',
  formOnlyIf: '(συμπληρώστε και επιστρέψτε το παρόν έντυπο μόνο εάν επιθυμείτε να υπαναχωρήσετε από τη σύμβαση)',
  formTo: 'Προς:',
  formNotice: 'Γνωστοποιώ/Γνωστοποιούμε (*) με την παρούσα ότι υπαναχωρώ/υπαναχωρούμε (*) από τη σύμβασή μου/μας (*) πώλησης των ακόλουθων αγαθών (*)/παροχής της ακόλουθης υπηρεσίας (*),',
  formOrderedOn: 'Παραγγελθέν(τα) στις (*)/παραληφθέν(τα) στις (*): ____________________',
  formConsumerName: 'Όνομα καταναλωτή(ών): ____________________',
  formConsumerAddress: 'Διεύθυνση καταναλωτή(ών): ____________________',
  formSignature: 'Υπογραφή καταναλωτή(ών) (μόνο εάν το παρόν έντυπο κοινοποιηθεί σε χαρτί): ____________________',
  formDate: 'Ημερομηνία: ____________________',
  formDeleteAsAppropriate: '(*) Διαγράψτε την περιττή ένδειξη.',

  orderButtonLabel: 'Παραγγελία με υποχρέωση πληρωμής',
};

const BY_LOCALE: Readonly<Record<string, WithdrawalStrings>> = { en, de, el };

/**
 * Locales whose text has been checked against the official Directive text.
 *
 * English only, because English is what this repository was written in and is
 * what the operator has always been serving. `de` and `el` are reconstructions
 * — good enough to build against, not good enough to launch on — and they stay
 * out of this set until somebody has compared them with EUR-Lex 32011L0083.
 *
 * An operator who has done that comparison opts in with
 * WITHDRAWAL_VERIFIED_LOCALES, which is an environment variable rather than a
 * setting on purpose: asserting that a legal text has been checked is a
 * deployment-time statement by whoever is accountable for it, not a checkbox
 * anyone with admin access can tick.
 */
export const OFFICIALLY_VERIFIED_LOCALES: readonly string[] = ['en'];

export function withdrawalTextIsVerified(
  locale: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const code = String(locale ?? '').trim().toLowerCase();
  if (OFFICIALLY_VERIFIED_LOCALES.includes(code)) return true;
  return String(env.WITHDRAWAL_VERIFIED_LOCALES ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(code);
}

/**
 * The strings for a locale, or English.
 *
 * Falls back for TWO reasons, and the second matters more: the locale may have
 * no translation, or it may have one nobody has verified. Serving unverified
 * legal text is the failure this function exists to prevent.
 */
export function withdrawalStringsFor(
  locale: string,
  env: NodeJS.ProcessEnv = process.env,
): { strings: WithdrawalStrings; locale: string; fellBack: boolean } {
  const code = String(locale ?? '').trim().toLowerCase();
  const found = BY_LOCALE[code];
  if (found && withdrawalTextIsVerified(code, env)) {
    return { strings: found, locale: code, fellBack: false };
  }
  return { strings: en, locale: 'en', fellBack: !!code && code !== 'en' };
}

/** Locales this build carries text for, verified or not. For the admin. */
export function withdrawalLocales(): string[] {
  return Object.keys(BY_LOCALE).sort();
}
