// Turns the GW-GIG CSV exports into rows ready to load, following the rules Ian confirmed on 5 Nov 2026.
// Pure: no database and no files in here, so it can be tested and rehearsed without touching either.
import { localToInstant } from '../caltime.js';
import type { Row } from './csv.js';
import { BUBBLE_TZ, bubbleDate, bubbleInstant, normalizeEmail, normalizePhone, parseFee, roleKind, tidyCase, timeOfDay, venueKey, yes } from './rules.js';

export interface Exports {
  Fans: Row[];
  Gigs: Row[];
  Venues: Row[];
  FanGigs: Row[];
  FanVenues: Row[];
  GigNotes: Row[];
  GigActions: Row[];
  GigBandMembers: Row[];
  FanNotes: Row[];
  FanURLLinkLists: Row[];
  FanURLLinks: Row[];
  FanURLLinkPlays: Row[];
  BandMembers: Row[];
  Users: Row[];
}

export interface Rules {
  /** Bubble band id to tenant slug. Any other band is left out. */
  bands: Record<string, string>;
  /** GW-GIG status text to stage. */
  status: Record<string, string>;
  /** The band whose gigs and history come across, and the band that gets only the contacts flagged RockSolid. */
  main?: string;
  copyTo?: string;
  /** Gigs dated before this day are left behind. */
  gigsFrom: string;
  /** Today, so a payment is never dated in the future. */
  today: string;
}

// Every row keeps `legacy`: the GW-GIG ids it came from (more than one when fans were merged).
export interface VenueRow { legacy: string[]; name: string; city: string | null; address: string | null; website: string | null; phone: string | null; type: string | null; notes: string | null }
export interface ContactRow {
  legacy: string[];
  firstName: string | null; lastName: string | null; email: string | null; phone: string | null; company: string | null; jobTitle: string | null;
  address: string | null; source: string | null; isLocal: boolean | null; tags: string[]; notes: string | null; createdAt: string | null;
}
export interface GigRow {
  legacy: string; title: string; stage: string; postponed: boolean; lostReason: string | null; eventDate: string; loadIn: string | null; start: string | null; end: string | null;
  platform: string | null; tag: string | null; notes: string | null; feeQuoted: string | null; feeNote: string | null; archivedAt: string | null; createdAt: string | null;
  venue: string | null; // canonical venue legacy id
  contact: string | null; // canonical contact legacy id
}
export interface RoleRow { legacy: string; contact: string; kind: string; label: string | null; gig: string | null; venue: string | null }
export interface PaymentRow { legacy: string; gig: string; amount: string; paidOn: string; note: string }
export interface ActivityRow { legacy: string; kind: 'note' | 'task'; gig: string | null; contact: string | null; body: string; occurredAt: string | null; dueAt: string | null; completedAt: string | null; byEmail: string | null }
export interface GigMemberRow { legacy: string; gig: string; email: string; confirmed: boolean | null }
export interface LinkTargetRow { legacy: string; name: string; url: string; sortOrder: number }
export interface OutboundRow { legacy: string; contact: string; url: string; target: string | null; createdAt: string | null }
export interface ClickRow { legacy: string; link: string; clickedAt: string }
export interface LoginRow { email: string; name: string | null; memberships: { slug: string; role: 'admin' | 'member' | 'read_only' }[] }
// A contact made from a gig's own booking fields when no fan was linked.
export interface TenantPlan {
  slug: string;
  venues: VenueRow[]; contacts: ContactRow[]; gigs: GigRow[]; roles: RoleRow[]; payments: PaymentRow[]; activities: ActivityRow[];
  gigMembers: GigMemberRow[]; linkTargets: LinkTargetRow[]; outbound: OutboundRow[]; clicks: ClickRow[];
}
export interface Flag { table: string; id: string; label: string; problem: string }
export interface Plan {
  tenants: Record<string, TenantPlan>;
  logins: LoginRow[];
  flags: Flag[];
  dropped: Record<string, number>;
  spot: { gigs: SpotCheck[]; contacts: SpotCheck[] };
  /** Numbers to compare with the plan. */
  stats: Record<string, number>;
}
export interface SpotCheck { id: string; label: string; source: Record<string, string>; imported: Record<string, string | null> }

const blank = (s: string | undefined): string | null => {
  const t = (s ?? '').replace(/ /g, ' ').trim();
  return t === '' ? null : t;
};
const first = <T>(...v: (T | null | undefined)[]): T | null => v.find((x) => x !== null && x !== undefined) ?? null;
const addDropped = (p: Plan, why: string, n = 1): void => void (p.dropped[why] = (p.dropped[why] ?? 0) + n);

/** Evenly spread picks, always the same ones for the same data, so a rehearsal can be repeated. */
function pick<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const step = items.length / n;
  return Array.from({ length: n }, (_v, i) => items[Math.floor(i * step)] as T);
}

export function buildPlan(x: Exports, rules: Rules): Plan {
  const plan: Plan = { tenants: {}, logins: [], flags: [], dropped: {}, spot: { gigs: [], contacts: [] }, stats: {} };
  const flag = (table: string, id: string, label: string, problem: string): void => void plan.flags.push({ table, id, label, problem });
  const slugs = [...new Set(Object.values(rules.bands))];
  const blankTenant = (slug: string): TenantPlan => ({ slug, venues: [], contacts: [], gigs: [], roles: [], payments: [], activities: [], gigMembers: [], linkTargets: [], outbound: [], clicks: [] });
  for (const s of slugs) plan.tenants[s] = blankTenant(s);
  const rsSlug = rules.copyTo ?? 'rocksolid';
  const jbSlug = rules.main ?? Object.values(rules.bands).find((s) => s !== rsSlug);
  const jbBand = Object.entries(rules.bands).find(([, s]) => s === jbSlug)?.[0];
  if (!jbSlug || !jbBand) throw new Error('No Jane Blonde band in the import rules.');
  const jb = plan.tenants[jbSlug] as TenantPlan;
  const rs = plan.tenants[rsSlug];

  // ---- Gigs: Jane Blonde, dated, on or after the cut-off day.
  const gigRows = x.Gigs.filter((g) => g['Band'] === jbBand);
  const undated = gigRows.filter((g) => !bubbleDate(g['Gigdate'] ?? ''));
  addDropped(plan, 'gigs with no date', undated.length);
  addDropped(plan, 'gigs from other bands', x.Gigs.length - gigRows.length);
  const keptGigs = gigRows.filter((g) => {
    const d = bubbleDate(g['Gigdate'] ?? '');
    return d !== null && d.date >= rules.gigsFrom;
  });
  addDropped(plan, `gigs before ${rules.gigsFrom}`, gigRows.length - undated.length - keptGigs.length);
  const gigIds = new Set(keptGigs.map((g) => g['unique id'] as string));

  // ---- Fans: Jane Blonde, not deleted, not unsubscribed. Same email in one band becomes one contact.
  const jbFans = x.Fans.filter((f) => f['band'] === jbBand);
  addDropped(plan, 'fans from other bands', x.Fans.length - jbFans.length);
  const liveFans = jbFans.filter((f) => !yes(f['Deleted']) && !yes(f['UNSubscribed']));
  addDropped(plan, 'fans deleted or unsubscribed', jbFans.length - liveFans.length);
  const created = (r: Row): string => bubbleInstant(r['Creation Date'] ?? '') ?? '9999';
  const byEarliest = [...liveFans].sort((a, b) => created(a).localeCompare(created(b)) || (a['unique id'] as string).localeCompare(b['unique id'] as string));
  const groups = new Map<string, Row[]>();
  const canonical = new Map<string, string>(); // any live fan id -> the id of the contact it became
  for (const f of byEarliest) {
    const key = normalizeEmail(f['Email'] ?? '').email ?? `no-email:${f['unique id']}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  let mergedGroups = 0;
  const contacts: ContactRow[] = [];
  const contactById = new Map<string, ContactRow>();
  for (const [key, g] of groups) {
    const head = g[0] as Row;
    if (g.length > 1) mergedGroups++;
    const id = head['unique id'] as string;
    for (const f of g) canonical.set(f['unique id'] as string, id);
    const pickField = (name: string): string | null => first(...g.map((f) => blank(f[name])));
    const em = normalizeEmail(pickField('Email') ?? '');
    const ph = normalizePhone(pickField('Phone') ?? '');
    const tags = new Set<string>();
    for (const f of g) {
      if (yes(f['Fan'])) tags.add('fan');
      if (yes(f['Event organizer'])) tags.add('event-organizer');
      if (yes(f['Festival organizer'])) tags.add('festival-organizer');
      if (yes(f['Venue organizer'])) tags.add('venue-organizer');
      if (yes(f['RockSolid'])) tags.add('rocksolid');
    }
    const noteParts: string[] = [];
    for (const f of g) {
      for (const [label, col] of [['', 'Notes'], ['Feedback: ', 'Feedback'], ['Gig date: ', 'Gig date']] as const) {
        const v = blank(f[col]);
        if (v && !noteParts.includes(label + v)) noteParts.push(label + v);
      }
    }
    if (em.bad) noteParts.push(`Email as typed in GW-GIG: ${pickField('Email')}`);
    if (ph.junk) noteParts.push(`Phone as typed in GW-GIG: ${ph.junk}`);
    const row: ContactRow = {
      legacy: g.map((f) => f['unique id'] as string),
      firstName: pickField('First name'), lastName: pickField('Last name'), email: em.email, phone: ph.phone, company: pickField('Company'), jobTitle: pickField('Job Title'),
      address: pickField('Address'), source: pickField('Source'),
      isLocal: ((): boolean | null => { const v = (pickField('Local') ?? '').toLowerCase(); return v === 'yes' ? true : v === 'no' ? false : null; })(),
      tags: [...tags].sort(), notes: noteParts.length ? noteParts.join('\n\n') : null, createdAt: bubbleInstant(head['Creation Date'] ?? ''),
    };
    const label = [row.firstName, row.lastName].filter(Boolean).join(' ') || row.email || '(no name)';
    if (em.bad) flag('Fan', id, label, `Email is not valid and was moved into the notes: ${pickField('Email')}`);
    if (ph.junk) flag('Fan', id, label, `Not a phone number, moved into the notes: ${ph.junk}`);
    else if (ph.flag) flag('Fan', id, label, `Phone number kept as typed: ${pickField('Phone')}`);
    if (!row.firstName && !row.lastName && !row.email) flag('Fan', id, label, 'No name and no email');
    void key;
    contacts.push(row);
    contactById.set(id, row);
  }
  jb.contacts = contacts;
  const mergedAway = liveFans.length - contacts.length;
  addDropped(plan, 'fans merged into another contact by email', mergedAway);

  // The fans flagged RockSolid also become contacts, and only contacts, in ROCKSOLID.
  if (rs) {
    rs.contacts = contacts.filter((c) => c.tags.includes('rocksolid')).map((c) => ({ ...c, legacy: [...c.legacy] }));
  }

  // ---- Venues: only those an imported gig or a kept contact points to. Same name becomes one venue.
  const venueSource = new Map(x.Venues.filter((v) => v['band'] === jbBand).map((v) => [v['unique id'] as string, v]));
  const fanVenues = x.FanVenues.filter((r) => r['Band'] === jbBand && canonical.has(r['Fan'] ?? ''));
  addDropped(plan, 'fan-venue links to fans that were not kept', x.FanVenues.filter((r) => r['Band'] === jbBand).length - fanVenues.length);
  const wanted = new Set<string>();
  for (const g of keptGigs) if (g['Venue']) wanted.add(g['Venue']);
  for (const r of fanVenues) if (r['Venue']) wanted.add(r['Venue']);
  const venueCanon = new Map<string, string>();
  const venuesByKey = new Map<string, VenueRow>();
  const gigVenueAddress = new Map<string, string>();
  for (const g of keptGigs) {
    const a = blank(g['Venue-address']) ?? blank(g['Venue address-text']);
    if (g['Venue'] && a && !gigVenueAddress.has(g['Venue'])) gigVenueAddress.set(g['Venue'], a);
  }
  for (const id of [...wanted].sort()) {
    const v = venueSource.get(id);
    if (!v) {
      addDropped(plan, 'venue ids not in the Jane Blonde venue list');
      continue;
    }
    const name = (blank(v['Name']) ?? '').replace(/\s+/g, ' ');
    if (!name) {
      addDropped(plan, 'venues with no name');
      continue;
    }
    const k = venueKey(name);
    const existing = venuesByKey.get(k);
    if (existing) {
      existing.legacy.push(id);
      venueCanon.set(id, existing.legacy[0] as string);
      continue;
    }
    const booking = [blank(v['Booking manager']) && `Booking manager: ${v['Booking manager']?.trim()}`, blank(v['Booking email']) && `Booking email: ${v['Booking email']?.trim()}`, blank(v['Booking phone']) && `Booking phone: ${v['Booking phone']?.trim()}`, blank(v['Facebook']) && `Facebook: ${v['Facebook']?.trim()}`].filter(Boolean) as string[];
    const notes = [blank(v['Notes']), ...booking].filter(Boolean).join('\n');
    const row: VenueRow = {
      legacy: [id], name, city: blank(v['City']) ? tidyCase(v['City'] as string) : null, address: gigVenueAddress.get(id) ?? null,
      website: blank(v['Booking website']), phone: normalizePhone(v['Phone'] ?? '').phone, type: blank(v['Type']), notes: notes || null,
    };
    venuesByKey.set(k, row);
    venueCanon.set(id, id);
    jb.venues.push(row);
  }

  // ---- Fan to gig and fan to venue links.
  const fanGigs = x.FanGigs.filter((r) => gigIds.has(r['Gig'] ?? ''));
  const fanGigsKept = fanGigs.filter((r) => canonical.has(r['Fan'] ?? ''));
  addDropped(plan, 'fan-gig links to fans that were not kept', fanGigs.length - fanGigsKept.length);
  const seenRole = new Set<string>();
  const rolesByGig = new Map<string, { contact: string; role: string }[]>();
  for (const r of [...fanGigsKept].sort((a, b) => created(a).localeCompare(created(b)))) {
    const contact = canonical.get(r['Fan'] as string) as string;
    const label = blank(r['Role']);
    const k = `g|${contact}|${r['Gig']}|${(label ?? '').toLowerCase()}`;
    if (seenRole.has(k)) {
      addDropped(plan, 'repeated roles after merging contacts');
      continue;
    }
    seenRole.add(k);
    jb.roles.push({ legacy: r['unique id'] as string, contact, kind: roleKind(label ?? ''), label, gig: r['Gig'] as string, venue: null });
    rolesByGig.set(r['Gig'] as string, [...(rolesByGig.get(r['Gig'] as string) ?? []), { contact, role: roleKind(label ?? '') }]);
  }
  for (const r of [...fanVenues].sort((a, b) => created(a).localeCompare(created(b)))) {
    const contact = canonical.get(r['Fan'] as string) as string;
    const venue = venueCanon.get(r['Venue'] ?? '');
    if (!venue) {
      addDropped(plan, 'fan-venue links to a venue that was not kept');
      continue;
    }
    const label = blank(r['Role']);
    const k = `v|${contact}|${venue}|${(label ?? '').toLowerCase()}`;
    if (seenRole.has(k)) {
      addDropped(plan, 'repeated roles after merging contacts');
      continue;
    }
    seenRole.add(k);
    jb.roles.push({ legacy: r['unique id'] as string, contact, kind: roleKind(label ?? ''), label, gig: null, venue });
  }

  // ---- The gigs themselves.
  const contactByEmail = new Map(contacts.filter((c) => c.email).map((c) => [c.email as string, c.legacy[0] as string]));
  for (const g of keptGigs) {
    const id = g['unique id'] as string;
    const d = bubbleDate(g['Gigdate'] as string) as { date: string; time: string | null };
    const title = blank(g['name']) ?? 'Untitled gig';
    if (!blank(g['name'])) flag('Gig', id, title, 'The gig had no name.');
    if (d.time && d.time !== '00:00') flag('Gig', id, title, `The date in GW-GIG had a time of ${d.time}. Check the date is right (${d.date}).`);
    const statusText = (g['GigStatus-text'] ?? '').trim();
    const stage = rules.status[statusText];
    if (!stage) throw new Error(`Gig ${id} has a status "${statusText}" that is not in the import rules.`);
    const notesParts: string[] = [];
    if (statusText === '') {
      notesParts.push('[Import] This gig had no status in GW-GIG. It was set to New. Check the stage.');
      flag('Gig', id, title, 'No status in GW-GIG. Set to New.');
    }
    const body = blank(g['notes']);
    if (body) notesParts.push(body);
    for (const [label, col] of [['Dark stage', 'time-darkstage'], ['Booking website', 'Booking web'], ['Payment (GW-GIG)', 'Payment'], ['Fee received (GW-GIG)', 'fee received']] as const) {
      const v = blank(g[col]);
      if (v) notesParts.push(`${label}: ${v}`);
    }
    // Fees.
    const quote = parseFee(g['Fee-Quote'] ?? '');
    const paid = parseFee(g['Fee-Paid'] ?? '');
    const feeNote = [quote.text, paid.text ? `Paid: ${paid.text}` : null].filter(Boolean).join('; ') || null;
    if (blank(g['Fee-Paid'])) flag('Gig', id, title, `Fee-Paid in GW-GIG was "${g['Fee-Paid']?.trim()}" against a quote of "${(g['Fee-Quote'] ?? '').trim()}". Check by hand.`);
    // Booking contact: a linked booking manager first, then a client or organiser, then any linked person, then the gig's own booking fields.
    const roles = rolesByGig.get(id) ?? [];
    let contact: string | null = first(
      roles.find((r) => r.role === 'booking_manager')?.contact, roles.find((r) => r.role === 'client')?.contact, roles.find((r) => r.role === 'organizer')?.contact, roles[0]?.contact,
    );
    const bEmail = normalizeEmail(g['Booking email'] ?? '').email;
    const bName = blank(g['Booking name']);
    const bPhone = blank(g['Booking phone']);
    if (!contact && bEmail && contactByEmail.has(bEmail)) contact = contactByEmail.get(bEmail) as string;
    if (!contact && (bEmail || bName)) {
      const [fn, ...ln] = (bName ?? '').split(/\s+/).filter(Boolean);
      const synthetic = `booking:${id}`;
      const row: ContactRow = {
        legacy: [synthetic], firstName: fn ?? null, lastName: ln.join(' ') || null, email: bEmail, phone: normalizePhone(bPhone ?? '').phone, company: null, jobTitle: null, address: null,
        source: 'GW-GIG gig booking details', isLocal: null, tags: [], notes: null, createdAt: bubbleInstant(g['Creation Date'] ?? ''),
      };
      jb.contacts.push(row);
      contactById.set(synthetic, row);
      if (bEmail) contactByEmail.set(bEmail, synthetic);
      contact = synthetic;
      flag('Gig', id, title, `No linked contact, so one was made from the gig's booking details (${bName ?? bEmail}).`);
    }
    const archived = (g['Archive'] ?? '').trim().toUpperCase() === 'ARCHIVED';
    const row: GigRow = {
      legacy: id, title, stage, postponed: statusText === 'POSTPONED', lostReason: statusText === 'CANCELED' ? 'canceled' : null, eventDate: d.date,
      loadIn: timeOfDay(g['time-loadin'] ?? ''), start: timeOfDay(g['time-start'] ?? ''), end: timeOfDay(g['time-end'] ?? ''), platform: blank(g['Source']), tag: blank(g['GigTag']),
      notes: notesParts.length ? notesParts.join('\n\n') : null, feeQuoted: quote.amount, feeNote, archivedAt: archived ? (bubbleInstant(g['Modified Date'] ?? '') ?? bubbleInstant(g['Creation Date'] ?? '')) : null,
      createdAt: bubbleInstant(g['Creation Date'] ?? ''), venue: g['Venue'] ? (venueCanon.get(g['Venue']) ?? null) : null, contact,
    };
    for (const [col, v] of [['time-loadin', row.loadIn], ['time-start', row.start], ['time-end', row.end]] as const) {
      if (blank(g[col]) && !v) flag('Gig', id, title, `Could not read ${col} "${g[col]}". Left empty.`);
    }
    if (g['Venue'] && !row.venue) flag('Gig', id, title, 'The venue it pointed to was not in the venue export. Left without a venue.');
    jb.gigs.push(row);
    if (paid.amount && Number(paid.amount) > 0) {
      jb.payments.push({
        legacy: `fee-paid:${id}`, gig: id, amount: paid.amount, paidOn: d.date > rules.today ? rules.today : d.date,
        note: 'From Fee-Paid in GW-GIG. The date received was not recorded, so the gig date (or today, for a future gig) was used. Check it.',
      });
    }
  }

  // ---- Notes, actions and crew on imported gigs.
  const userEmail = (s: string | undefined): string | null => normalizeEmail(s ?? '').email;
  for (const r of x.GigNotes) {
    if (!gigIds.has(r['Gig'] ?? '')) continue;
    const text = blank(r['Notes']);
    if (!text) { addDropped(plan, 'empty gig notes'); continue; }
    jb.activities.push({ legacy: r['unique id'] as string, kind: 'note', gig: r['Gig'] as string, contact: null, body: text, occurredAt: bubbleInstant(r['Date (DATE)'] ?? '') ?? bubbleInstant(r['Creation Date'] ?? ''), dueAt: null, completedAt: null, byEmail: userEmail(r['CreatedBy']) });
  }
  for (const r of x.GigActions) {
    if (!gigIds.has(r['Gig'] ?? '')) continue;
    const text = blank(r['Action']);
    if (!text) { addDropped(plan, 'empty gig actions'); continue; }
    const due = bubbleDate(r['ActionDate'] ?? '');
    jb.activities.push({
      legacy: r['unique id'] as string, kind: 'task', gig: r['Gig'] as string, contact: null, body: text,
      occurredAt: bubbleInstant(r['Creation Date'] ?? ''), dueAt: due ? localToInstant(due.date, '09:00', BUBBLE_TZ) : null, completedAt: yes(r['Completed']) ? (bubbleInstant(r['Modified Date'] ?? '') ?? bubbleInstant(r['Creation Date'] ?? '')) : null, byEmail: null,
    });
  }
  const seenNote = new Set<string>();
  for (const r of x.FanNotes) {
    if (r['Band'] !== jbBand) continue;
    const contact = canonical.get(r['Fan'] ?? '');
    if (!contact) { addDropped(plan, 'fan notes for fans that were not kept'); continue; }
    const text = blank(r['FanNote']);
    if (!text) { addDropped(plan, 'empty fan notes'); continue; }
    const at = bubbleInstant(r['Date'] ?? '') ?? bubbleInstant(r['Creation Date'] ?? '');
    const k = `${contact}|${at}|${text}`;
    if (seenNote.has(k)) { addDropped(plan, 'repeated fan notes after merging contacts'); continue; }
    seenNote.add(k);
    jb.activities.push({ legacy: r['unique id'] as string, kind: 'note', gig: null, contact, body: text, occurredAt: at, dueAt: null, completedAt: null, byEmail: null });
  }

  // ---- Logins: the people in the two bands. Passwords are not in the export, so none are set.
  const wantedBands = new Set(Object.keys(rules.bands));
  const userName = new Map(x.Users.map((u) => [userEmail(u['email']) ?? '', blank(u['Name'])]));
  const logins = new Map<string, LoginRow>();
  for (const r of x.BandMembers) {
    const slug = rules.bands[r['band'] ?? ''];
    const email = userEmail(r['user']);
    if (!wantedBands.has(r['band'] ?? '') || !slug || !email) continue;
    if ((r['status'] ?? '').toUpperCase() !== 'ACTIVE') { addDropped(plan, 'band members that are not active'); continue; }
    const role = ({ ADMIN: 'admin', MEMBER: 'member', VIEWER: 'read_only' } as const)[(r['accessrights'] ?? '').toUpperCase() as 'ADMIN'];
    if (!role) { flag('BandMember', r['unique id'] as string, email, `Unknown access "${r['accessrights']}". Skipped.`); continue; }
    const l = logins.get(email) ?? { email, name: userName.get(email) ?? null, memberships: [] };
    if (!l.memberships.some((m) => m.slug === slug)) l.memberships.push({ slug, role });
    logins.set(email, l);
  }
  plan.logins = [...logins.values()];
  const jbPeople = new Set(plan.logins.filter((l) => l.memberships.some((m) => m.slug === jbSlug)).map((l) => l.email));
  for (const r of x.GigBandMembers) {
    if (!gigIds.has(r['Gig'] ?? '')) continue;
    const email = userEmail(r['User']);
    if (!email || !jbPeople.has(email)) { addDropped(plan, 'gig crew who are not logins of the band'); continue; }
    jb.gigMembers.push({ legacy: r['unique id'] as string, gig: r['Gig'] as string, email, confirmed: (r['Confirmed'] ?? '').toUpperCase() === 'YES' ? true : null });
  }

  // ---- Links: link lists, a link per person, and every time one was opened.
  for (const r of x.FanURLLinkLists) {
    if (r['band'] !== jbBand) continue;
    const url = blank(r['URL']);
    if (!url) continue;
    jb.linkTargets.push({ legacy: r['unique id'] as string, name: blank(r['Name']) ?? url, url, sortOrder: Number(r['Order']) || 0 });
  }
  const targetByUrl = new Map(jb.linkTargets.map((t) => [t.url, t.legacy]));
  // A link row says "this person was sent this address". Some rows have no address (one of them is shared by about 1,700 opens),
  // so those are kept under a plain label, and an open is always attached to the person who opened it.
  const NO_ADDRESS = 'Link from GW-GIG (address not recorded)';
  const linkRow = new Map<string, Row>();
  const outbound = new Map<string, OutboundRow>();
  const addOutbound = (legacy: string, contact: string, url: string, createdAt: string | null): OutboundRow => {
    const have = outbound.get(legacy);
    if (have) return have;
    const row: OutboundRow = { legacy, contact, url, target: targetByUrl.get(url) ?? null, createdAt };
    outbound.set(legacy, row);
    jb.outbound.push(row);
    return row;
  };
  for (const r of x.FanURLLinks) {
    if (r['band'] !== jbBand) continue;
    linkRow.set(r['unique id'] as string, r);
    const contact = canonical.get(r['fan'] ?? '');
    if (!contact) { addDropped(plan, 'link rows for fans that were not kept'); continue; }
    const url = blank(r['URL Link']);
    if (!url) addDropped(plan, 'link rows with no address (kept under a plain label)');
    addOutbound(r['unique id'] as string, contact, url ?? NO_ADDRESS, bubbleInstant(r['Creation Date'] ?? ''));
  }
  for (const r of x.FanURLLinkPlays) {
    if (r['band'] !== jbBand) continue;
    const contact = canonical.get(r['Fan'] ?? '');
    if (!contact) { addDropped(plan, 'link plays for fans that were not kept'); continue; }
    const at = bubbleInstant(r['Date (DATE)'] ?? '');
    if (!at) { addDropped(plan, 'link plays with no readable time'); continue; }
    const row = linkRow.get(r['fanURLlink'] ?? '');
    const playUrl = blank(r['FanURLLink-URL']);
    let link: OutboundRow;
    if (row) {
      const own = canonical.get(row['fan'] ?? '') === contact;
      const url = blank(row['URL Link']) ?? playUrl ?? NO_ADDRESS;
      link = addOutbound(own ? (row['unique id'] as string) : `${row['unique id']}:${contact}`, contact, url, bubbleInstant(row['Creation Date'] ?? ''));
    } else if (playUrl) {
      link = addOutbound(`play-url:${contact}:${playUrl}`, contact, playUrl, at);
    } else {
      addDropped(plan, 'link plays with no link and no address');
      continue;
    }
    jb.clicks.push({ legacy: r['unique id'] as string, link: link.legacy, clickedAt: at });
  }

    plan.stats = {
    'fans kept': liveFans.length,
    'fans merged away by email': mergedAway,
    'email groups merged': mergedGroups,
    'contacts made': contacts.length,
    'contacts copied to ROCKSOLID': rs?.contacts.length ?? 0,
    'gigs with no date': undated.length,
    'gigs imported': keptGigs.length,
    'venues imported': jb.venues.length,
    'fan-venue links kept': fanVenues.length,
    'logins': plan.logins.length,
    'logins in both bands': plan.logins.filter((l) => l.memberships.length > 1).length,
    'viewers in Jane Blonde': plan.logins.filter((l) => l.memberships.some((m) => m.slug === jbSlug && m.role === 'read_only')).length,
  };

  // ---- A repeatable sample for checking by hand.
  const gigSrc = new Map(keptGigs.map((g) => [g['unique id'] as string, g]));
  plan.spot.gigs = pick(jb.gigs, 20).map((g) => {
    const s = gigSrc.get(g.legacy) as Row;
    return {
      id: g.legacy, label: g.title,
      source: { Gigdate: s['Gigdate'] ?? '', GigStatus: s['GigStatus-text'] ?? '', 'Fee-Quote': s['Fee-Quote'] ?? '', 'Fee-Paid': s['Fee-Paid'] ?? '', Venue: s['Venue name'] ?? '', 'Booking name': s['Booking name'] ?? '', 'time-start': s['time-start'] ?? '', Archive: s['Archive'] ?? '' },
      imported: { date: g.eventDate, stage: g.stage + (g.postponed ? ' (postponed)' : ''), fee: g.feeQuoted, 'fee note': g.feeNote, venue: g.venue ? (jb.venues.find((v) => v.legacy.includes(g.venue as string))?.name ?? null) : null, contact: g.contact ? label(contactById.get(g.contact)) : null, start: g.start, archived: g.archivedAt ? 'yes' : 'no' },
    };
  });
  const fanSrc = new Map(liveFans.map((f) => [f['unique id'] as string, f]));
  plan.spot.contacts = pick(contacts.filter((c) => fanSrc.has(c.legacy[0] as string)), 20).map((c) => {
    const s = fanSrc.get(c.legacy[0] as string) as Row;
    return {
      id: c.legacy.join(' + '), label: label(c),
      source: { 'First name': s['First name'] ?? '', 'Last name': s['Last name'] ?? '', Email: s['Email'] ?? '', Phone: s['Phone'] ?? '', Company: s['Company'] ?? '', Local: s['Local'] ?? '', 'Event organizer': s['Event organizer'] ?? '', RockSolid: s['RockSolid'] ?? '', 'Merged fans': String(c.legacy.length) },
      imported: { name: label(c), email: c.email, phone: c.phone, company: c.company, local: c.isLocal === null ? null : String(c.isLocal), tags: c.tags.join(', ') || null, notes: c.notes ? c.notes.slice(0, 80) : null },
    };
  });
  return plan;
}

function label(c: ContactRow | undefined): string {
  if (!c) return '(unknown)';
  return [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || '(no name)';
}
