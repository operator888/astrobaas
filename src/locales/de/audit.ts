/**
 * de — admin.audit.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 */
export const audit = {
  'admin.audit.title': 'Protokoll',
  'admin.audit.intro':
    'Wer hat was getan. Anmeldungen und Sicherheitsereignisse sowie Änderungen an Inhalten und Verkäufen — angelegte, geänderte oder gelöschte Beiträge und Produkte und Statuswechsel von Bestellungen. Änderungen an Preis, Lagerbestand und Status werden mit vorherigem und neuem Wert festgehalten; jedes andere Feld wird nur mit seinem NAMEN erfasst, damit hier niemals eine zweite Kopie Ihrer Inhalte entsteht.',
  'admin.audit.filterAction': 'Aktion',
  'admin.audit.filterActor': 'Wer',
  'admin.audit.actorPlaceholder': 'beliebiger Benutzer',
  'admin.audit.filterFrom': 'Von',
  'admin.audit.filterTo': 'Bis',
  'admin.audit.apply': 'Filtern',
  'admin.audit.clear': 'Zurücksetzen',
  'admin.audit.colWhen': 'Wann',
  'admin.audit.colAction': 'Aktion',
  'admin.audit.colActor': 'Benutzer',
  'admin.audit.colTarget': 'Ziel',
  'admin.audit.colIp': 'IP',
  'admin.audit.loading': 'Wird geladen…',
  'admin.audit.empty': 'Keine Ereignisse entsprechen diesen Filtern.',
  'admin.audit.count_one': '{count} Ereignis',
  'admin.audit.count_other': '{count} Ereignisse',
  'admin.audit.countCapped': '{count} Ereignisse (begrenzt — grenzen Sie den Zeitraum ein)',
};

export default audit;
