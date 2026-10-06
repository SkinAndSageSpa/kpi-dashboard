/**
 * staffGroups.js
 * Skin & Sage provider → role group, for the employee dashboard's Esti vs LMT columns.
 *
 * `id` is Mangomint's staff id (the values in a report's settings.staffIds), `name`
 * is how that staff member appears in report rows. Ids/names were read from a probe
 * of the BI Appointments report (one fetch per staffId); roles come from each
 * provider's When I Work position (Esthetician / Brow Lash Esti → esti,
 * Massage Therapist → lmt).
 *
 * New provider? Add them here. Each run, the scraper lists anyone with booked hours
 * in the dashboard's window who isn't in this list, and shows it on the owner
 * dashboard's banner — until then their numbers are left out of both columns.
 */

const SKINSAGE_STAFF = [
  // Estheticians (incl. Brow/Lash)
  { id: 34, name: 'Ana Stickler',      group: 'esti' },
  { id: 89, name: 'Pamella Kropp',     group: 'esti' },
  { id: 87, name: 'Savanna Kohlruss',  group: 'esti' },
  { id:  6, name: 'Sofie LaCarrubba',  group: 'esti' },
  { id: 79, name: 'Steph Burnett',     group: 'esti' },
  { id: 28, name: 'Dr. Julie Do',      group: 'esti' },
  { id: 67, name: 'Naomi Hughes',      group: 'esti' },

  // Licensed Massage Therapists
  { id: 91, name: 'Carolyn McCotter',  group: 'lmt' },
  { id: 86, name: 'Charli Archer',     group: 'lmt' },
  { id: 82, name: 'Katie Bennett',     group: 'lmt' },
  { id: 83, name: 'Manny Navarro',     group: 'lmt' },
  { id: 57, name: 'Priscilla Barajas', group: 'lmt' },
  { id: 77, name: 'Tatyana Temple',    group: 'lmt' },
  { id: 61, name: 'Yan Cao',           group: 'lmt' },
];

const staffIdsFor = group => SKINSAGE_STAFF.filter(s => s.group === group).map(s => s.id);

module.exports = { SKINSAGE_STAFF, staffIdsFor };
