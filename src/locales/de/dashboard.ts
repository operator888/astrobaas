/**
 * de — admin.dashboard.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 */
export const dashboard = {
  'admin.dashboard.title': 'Übersicht',

  // Default-password banner. Split around the <code>admin@local</code> chip and
  // the /admin/profile link, both of which are values and stay untranslated —
  // so every language ends its sentence AT the link rather than wrapping it.
  'admin.dashboard.defaultPasswordTitle': 'Achtung:',
  'admin.dashboard.defaultPasswordBefore': 'das Standardkonto',
  'admin.dashboard.defaultPasswordAfter': 'besteht weiterhin. Ändern Sie das Passwort unter',

  'admin.dashboard.welcome': 'Willkommen zurück, {name}!',
  'admin.dashboard.subtitle': 'Das ist heute auf Ihrer Website los.',
  /** Shown in the greeting when the signed-in account has no name set. */
  'admin.dashboard.defaultUserName': 'Administrator',

  // Commerce cards
  'admin.dashboard.openOrders': 'Offene Bestellungen',
  'admin.dashboard.ordersTotal': '{count} insgesamt',
  'admin.dashboard.revenuePaid': 'Umsatz (bezahlt)',
  'admin.dashboard.revenuePaidHint': 'nur bezahlte Bestellungen',
  'admin.dashboard.products': 'Produkte',
  'admin.dashboard.productsHint': 'im Katalog',
  'admin.dashboard.outOfStock': 'Nicht auf Lager',
  'admin.dashboard.needsRestocking': 'muss nachbestellt werden',
  'admin.dashboard.allInStock': 'alles auf Lager',

  // Content stats
  'admin.dashboard.totalPosts': 'Beiträge insgesamt',
  'admin.dashboard.authors_one': '{count} Autor',
  'admin.dashboard.authors_other': '{count} Autoren',
  'admin.dashboard.published': 'Veröffentlicht',
  'admin.dashboard.publishedShare': '{percent} % aller Beiträge',
  'admin.dashboard.drafts': 'Entwürfe',
  'admin.dashboard.mediaFiles_one': '{count} Mediendatei',
  'admin.dashboard.mediaFiles_other': '{count} Mediendateien',
  'admin.dashboard.totalViews': 'Aufrufe insgesamt',
  'admin.dashboard.viewsHint': 'über alle veröffentlichten Beiträge',

  // Recent posts
  'admin.dashboard.recentPosts': 'Neueste Beiträge',
  'admin.dashboard.viewAll': 'Alle anzeigen',
  'admin.dashboard.noPosts': 'Noch keine Beiträge.',
  'admin.dashboard.createFirstPost': 'Ersten Beitrag erstellen →',
  'admin.dashboard.postViews_one': '{count} Aufruf',
  'admin.dashboard.postViews_other': '{count} Aufrufe',

  // Post status badge. The badge COLOUR and this label are both derived from
  // post.status; nothing matches on the label, so only the label is translated.
  'admin.dashboard.status.published': 'Veröffentlicht',
  'admin.dashboard.status.draft': 'Entwurf',
  'admin.dashboard.status.scheduled': 'Geplant',
  'admin.dashboard.status.trashed': 'Im Papierkorb',

  // Sidebar
  'admin.dashboard.quickActions': 'Schnellaktionen',
  'admin.dashboard.newPost': 'Neuer Beitrag',
  'admin.dashboard.uploadMedia': 'Medien hochladen',
  'admin.dashboard.manageCategories': 'Kategorien verwalten',
  'admin.dashboard.recentActivity': 'Letzte Aktivitäten',
  'admin.dashboard.noActivity': 'Noch keine Aktivitäten.',

  // Activity lines: '<entity> <verb>'. Built as one sentence per verb with the
  // entity as a parameter, because a language that puts the verb first cannot
  // be assembled from two independently translated halves.
  'admin.dashboard.activity.created': '{entity} erstellt',
  'admin.dashboard.activity.updated': '{entity} aktualisiert',
  'admin.dashboard.activity.deleted': '{entity} gelöscht',

  // Entity names, keyed by EntityType (kebab-case types become lowerCamelCase).
  'admin.dashboard.entity.post': 'Beitrag',
  'admin.dashboard.entity.theme': 'Theme',
  'admin.dashboard.entity.setting': 'Einstellung',
  'admin.dashboard.entity.category': 'Kategorie',
  'admin.dashboard.entity.user': 'Benutzer',
  'admin.dashboard.entity.plugin': 'Plugin',
  'admin.dashboard.entity.product': 'Produkt',
  'admin.dashboard.entity.brand': 'Marke',
  'admin.dashboard.entity.productCategory': 'Produktkategorie',
  'admin.dashboard.entity.order': 'Bestellung',
  'admin.dashboard.entity.customer': 'Kunde',
  'admin.dashboard.entity.media': 'Mediendatei',

  // Relative timestamps
  'admin.dashboard.time.justNow': 'gerade eben',
  'admin.dashboard.time.minutes_one': 'vor {count} Minute',
  'admin.dashboard.time.minutes_other': 'vor {count} Minuten',
  'admin.dashboard.time.hours_one': 'vor {count} Stunde',
  'admin.dashboard.time.hours_other': 'vor {count} Stunden',
  'admin.dashboard.time.days_one': 'vor {count} Tag',
  'admin.dashboard.time.days_other': 'vor {count} Tagen',
};

export default dashboard;
