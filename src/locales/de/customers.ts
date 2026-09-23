/**
 * de — admin.customers.*
 *
 * One file per screen. 983 keys in a single module is a file nobody can review
 * and every translator conflicts in; split by surface, a screen's strings live
 * next to each other and two people can work at once.
 */
export const customers = {
  'admin.customers.title': 'Kunden',
  'admin.customers.count_one': '{count} Kunde',
  'admin.customers.count_other': '{count} Kunden',
  'admin.customers.filterPlaceholder': 'Nach Name oder E-Mail filtern…',
  'admin.customers.colName': 'Name',
  'admin.customers.colEmail': 'E-Mail',
  'admin.customers.colPhone': 'Telefon',
  'admin.customers.colLocation': 'Ort',
  'admin.customers.colOrders': 'Bestellungen',
  'admin.customers.colLifetimeValue': 'Kundenwert gesamt',
  'admin.customers.colSince': 'Kunde seit',
};

export default customers;
