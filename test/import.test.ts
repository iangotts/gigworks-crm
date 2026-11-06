// The import: a small made-up export through the plan, then into the database twice. Own tenants, cleaned up after.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createPool, withSystem } from '../src/db.js';
import { loadPlan } from '../src/import/load.js';
import { buildPlan, type Exports, type Plan, type Rules } from '../src/import/plan.js';

const tag = randomBytes(4).toString('hex');
const pool = createPool(loadConfig({ ...process.env }).databaseUrl);
const JB = 'band-jb';
const RS = 'band-rs';
const OTHER = 'band-other';
const slugMain = `itest-i1-${tag}`;
const slugRs = `itest-i2-${tag}`;
const rules: Rules = {
  bands: { [JB]: slugMain, [RS]: slugRs },
  main: slugMain,
  copyTo: slugRs,
  status: { PITCH: 'new', 'ON THE LIST': 'evaluating', 'IN-PROCESS': 'in_conversation', CONTRACTED: 'confirmed', PERFORMED: 'played', POSTPONED: 'confirmed', CANCELED: 'lost', LOST: 'lost', '': 'new' },
  gigsFrom: '2024-11-05',
  today: '2026-11-05',
};
const email = (n: string): string => `itest-${tag}-${n}@example.test`;

const fan = (id: string, o: Record<string, string> = {}) => ({ 'unique id': id, band: JB, 'First name': 'Fan', 'Last name': id, Email: email(id), 'Creation Date': 'Jan 1, 2023 9:00 am', Deleted: '', UNSubscribed: '', RockSolid: '', Fan: 'yes', ...o });
const gig = (id: string, o: Record<string, string> = {}) => ({ 'unique id': id, Band: JB, name: `Gig ${id}`, Gigdate: 'Mar 6, 2025 12:00 am', 'GigStatus-text': 'CONTRACTED', Venue: 'v1', 'Creation Date': 'Jan 1, 2025 9:00 am', 'Modified Date': 'Jan 2, 2025 9:00 am', Archive: 'CURRENT', ...o });

function exportsFixture(): Exports {
  return {
    Fans: [
      fan('f1', { 'First name': 'Ann', 'Last name': 'Early', Email: email('dup'), Phone: '415-999-2428', 'Creation Date': 'Jan 1, 2023 9:00 am', Notes: 'first note', 'Event organizer': 'yes' }),
      fan('f2', { 'First name': '', 'Last name': '', Email: email('DUP').toUpperCase(), 'Creation Date': 'Jun 1, 2024 9:00 am', Notes: 'second note', Phone: 'not provided', Company: 'Acme' }),
      fan('f3', { 'First name': 'Rocky', RockSolid: 'yes' }),
      fan('f4', { Deleted: 'yes' }),
      fan('f5', { UNSubscribed: 'yes' }),
      fan('f6', { band: OTHER }),
      fan('f7', { Email: '' }),
      fan('f8', { Email: 'not an email' }),
    ],
    Gigs: [
      gig('g1', { 'Fee-Quote': '$3,200', 'Fee-Paid': '1000', 'GigStatus-text': 'PERFORMED', 'time-start': '2:30pm' }),
      gig('g2', { 'Fee-Quote': '1800 + 300 + travel', Gigdate: 'Nov 5, 2024 12:00 am', 'GigStatus-text': 'POSTPONED', Venue: 'v2' }),
      gig('g3', { Gigdate: 'Nov 4, 2024 12:00 am' }),
      gig('g4', { Gigdate: '' }),
      gig('g5', { Band: OTHER }),
      gig('g6', { 'GigStatus-text': '', Venue: 'v3', 'Booking name': 'Pat Booker', 'Booking email': email('booker') }),
      gig('g7', { 'GigStatus-text': 'CANCELED', Archive: 'ARCHIVED', Venue: 'v4', 'Fee-Quote': 'FREE', 'Fee-Paid': 'FREE' }),
    ],
    Venues: [
      { 'unique id': 'v1', band: JB, Name: 'Rose Hall', City: 'NAPA' },
      { 'unique id': 'v2', band: JB, Name: 'Rose  Hall ', City: 'Napa' },
      { 'unique id': 'v3', band: JB, Name: 'Barn', City: '' },
      { 'unique id': 'v4', band: JB, Name: 'Unused? no, used', City: '' },
      { 'unique id': 'v5', band: JB, Name: 'Never used', City: '' },
    ],
    FanGigs: [
      { 'unique id': 'fg1', band: JB, Fan: 'f2', Gig: 'g1', Role: 'Booking manager', 'Creation Date': 'Jan 3, 2025 9:00 am' },
      { 'unique id': 'fg2', band: JB, Fan: 'f1', Gig: 'g1', Role: 'Booking manager', 'Creation Date': 'Jan 4, 2025 9:00 am' },
      { 'unique id': 'fg3', band: JB, Fan: 'f4', Gig: 'g1', Role: 'Client', 'Creation Date': 'Jan 5, 2025 9:00 am' },
      { 'unique id': 'fg4', band: JB, Fan: 'f1', Gig: 'g3', Role: 'Client', 'Creation Date': 'Jan 5, 2025 9:00 am' },
    ],
    FanVenues: [{ 'unique id': 'fv1', Band: JB, Fan: 'f1', Venue: 'v1', Role: 'Booking manager', 'Creation Date': 'Jan 3, 2025 9:00 am' }],
    GigNotes: [
      { 'unique id': 'n1', band: '', Gig: 'g1', Notes: 'bring extra cables', CreatedBy: email('ian'), 'Date (DATE)': 'Feb 1, 2025 12:00 am' },
      { 'unique id': 'n2', band: JB, Gig: 'g3', Notes: 'before cut-off', 'Date (DATE)': 'Feb 1, 2025 12:00 am' },
      { 'unique id': 'n3', band: JB, Gig: 'g1', Notes: '  ', 'Date (DATE)': 'Feb 1, 2025 12:00 am' },
    ],
    GigActions: [{ 'unique id': 'a1', band: JB, Gig: 'g1', Action: 'chase payment', ActionDate: 'Feb 10, 2025 12:00 am', Completed: 'yes', 'Modified Date': 'Feb 11, 2025 9:00 am', 'Creation Date': 'Feb 1, 2025 9:00 am' }],
    GigBandMembers: [
      { 'unique id': 'm1', Band: '', Gig: 'g1', User: email('ian'), Confirmed: 'YES' },
      { 'unique id': 'm2', Band: '', Gig: 'g1', User: email('stranger'), Confirmed: 'NO' },
      { 'unique id': 'm3', Band: '', Gig: 'g3', User: email('ian'), Confirmed: 'YES' },
    ],
    FanNotes: [
      { 'unique id': 'fn1', Band: JB, Fan: 'f1', FanNote: 'met at gig', Date: 'May 27, 2024', 'Creation Date': 'May 27, 2024 6:15 pm' },
      { 'unique id': 'fn2', Band: JB, Fan: 'f2', FanNote: 'met at gig', Date: 'May 27, 2024', 'Creation Date': 'May 27, 2024 6:15 pm' },
      { 'unique id': 'fn3', Band: JB, Fan: 'f4', FanNote: 'deleted fan', Date: 'May 27, 2024' },
    ],
    FanURLLinkLists: [{ 'unique id': 'll1', band: JB, Name: 'Website', Order: '1', URL: 'https://example.test/jbg' }],
    FanURLLinks: [
      { 'unique id': 'l1', band: JB, fan: 'f1', 'URL Link': 'https://example.test/jbg', 'Creation Date': 'May 6, 2024 9:40 pm' },
      { 'unique id': 'l2', band: JB, fan: 'f3', 'URL Link': '', 'Creation Date': 'May 7, 2025 1:09 pm' },
      { 'unique id': 'l3', band: JB, fan: 'f4', 'URL Link': 'https://example.test/x', 'Creation Date': 'May 7, 2025 1:09 pm' },
    ],
    FanURLLinkPlays: [
      { 'unique id': 'p1', band: JB, Fan: 'f1', fanURLlink: 'l1', 'Date (DATE)': 'May 6, 2024 10:02 pm', 'FanURLLink-URL': 'https://example.test/jbg' },
      { 'unique id': 'p2', band: JB, Fan: 'f2', fanURLlink: 'l2', 'Date (DATE)': 'May 8, 2025 7:45 am', 'FanURLLink-URL': '' },
      { 'unique id': 'p3', band: JB, Fan: 'f3', fanURLlink: 'l2', 'Date (DATE)': 'May 8, 2025 7:46 am', 'FanURLLink-URL': '' },
      { 'unique id': 'p4', band: JB, Fan: 'f1', fanURLlink: '', 'Date (DATE)': 'Aug 10, 2025 12:16 pm', 'FanURLLink-URL': 'https://example.test/other' },
      { 'unique id': 'p5', band: JB, Fan: 'f4', fanURLlink: 'l3', 'Date (DATE)': 'May 8, 2025 7:46 am', 'FanURLLink-URL': '' },
      { 'unique id': 'p6', band: JB, Fan: 'f1', fanURLlink: '', 'Date (DATE)': 'Aug 11, 2025 12:16 pm', 'FanURLLink-URL': '' },
    ],
    BandMembers: [
      { 'unique id': 'b1', band: JB, user: email('ian'), accessrights: 'ADMIN', status: 'ACTIVE' },
      { 'unique id': 'b2', band: RS, user: email('ian'), accessrights: 'ADMIN', status: 'ACTIVE' },
      { 'unique id': 'b3', band: JB, user: email('view'), accessrights: 'VIEWER', status: 'ACTIVE' },
      { 'unique id': 'b4', band: JB, user: email('gone'), accessrights: 'MEMBER', status: 'INACTIVE' },
      { 'unique id': 'b5', band: OTHER, user: email('elsewhere'), accessrights: 'ADMIN', status: 'ACTIVE' },
    ],
    Users: [{ 'unique id': 'u1', email: email('ian'), Name: 'Ian Tester' }],
  };
}

let plan: Plan;
beforeAll(async () => {
  await withSystem(pool, async (c) => {
    for (const [slug, name] of [[slugMain, 'Import Test Main'], [slugRs, 'Import Test Copy']] as const) await c.query('INSERT INTO tenant (name, slug) VALUES ($1, $2)', [name, slug]);
  });
  plan = buildPlan(exportsFixture(), rules);
});
afterAll(async () => {
  await withSystem(pool, async (c) => {
    await c.query('DELETE FROM app_user WHERE email LIKE $1', [`itest-${tag}-%`]);
    await c.query('DELETE FROM tenant WHERE slug LIKE $1', [`itest-i%-${tag}`]);
  });
  await pool.end();
});

describe('what is left out', () => {
  const main = () => plan.tenants[slugMain]!;
  it('leaves out other bands, deleted and unsubscribed fans, undated and older gigs', () => {
    expect(main().gigs.map((g) => g.legacy).sort()).toEqual(['g1', 'g2', 'g6', 'g7']);
    expect(plan.stats['gigs with no date']).toBe(1);
    expect(plan.stats['fans kept']).toBe(5);
    expect(plan.dropped['fans deleted or unsubscribed']).toBe(2);
    expect(plan.dropped['gigs from other bands']).toBe(1);
  });
  it('brings notes, actions and crew only for gigs that came across', () => {
    expect(main().activities.filter((a) => a.gig).map((a) => a.legacy).sort()).toEqual(['a1', 'n1']);
    expect(main().gigMembers.map((m) => m.legacy)).toEqual(['m1']);
  });
  it('drops the fan-gig link to a fan that was not kept, and a role repeated by merging', () => {
    expect(main().roles.filter((r) => r.gig).map((r) => r.legacy)).toEqual(['fg1']);
    expect(plan.dropped['repeated roles after merging contacts']).toBe(1);
    expect(plan.dropped['fan-gig links to fans that were not kept']).toBe(1);
  });
});

describe('contacts', () => {
  const main = () => plan.tenants[slugMain]!;
  it('merges the same email into the earliest contact, keeping notes and roles', () => {
    const merged = main().contacts.find((c) => c.legacy.includes('f1'))!;
    expect(merged.legacy).toEqual(['f1', 'f2']);
    expect(merged.firstName).toBe('Ann');
    expect(merged.company).toBe('Acme');
    expect(merged.notes).toContain('first note');
    expect(merged.notes).toContain('second note');
    expect(merged.tags).toContain('event-organizer');
    expect(merged.phone).toBe('(415) 999-2428');
    expect(main().roles.filter((r) => r.gig === 'g1').every((r) => r.contact === 'f1')).toBe(true);
    expect(main().activities.filter((a) => a.contact === 'f1' && a.body === 'met at gig')).toHaveLength(1);
    expect(plan.stats['email groups merged']).toBe(1);
  });
  it('moves a bad email and a junk phone into the notes', () => {
    const bad = main().contacts.find((c) => c.legacy.includes('f8'))!;
    expect(bad.email).toBeNull();
    expect(bad.notes).toContain('Email as typed in GW-GIG: not an email');
    expect(plan.flags.some((f) => f.id === 'f8')).toBe(true);
  });
  it('copies only the RockSolid fans to the other band, as contacts alone', () => {
    const copy = plan.tenants[slugRs]!;
    expect(copy.contacts.map((c) => c.legacy)).toEqual([['f3']]);
    expect(copy.gigs).toHaveLength(0);
    expect(copy.activities).toHaveLength(0);
    expect(main().contacts.some((c) => c.legacy.includes('f3'))).toBe(true);
  });
});

describe('gigs', () => {
  const g = (id: string) => plan.tenants[slugMain]!.gigs.find((x) => x.legacy === id)!;
  it('maps statuses, with postponed and canceled kept as flags', () => {
    expect(g('g1').stage).toBe('played');
    expect(g('g2')).toMatchObject({ stage: 'confirmed', postponed: true });
    expect(g('g7')).toMatchObject({ stage: 'lost', lostReason: 'canceled' });
    expect(g('g7').archivedAt).not.toBeNull();
  });
  it('gives a blank status New and says so on the gig', () => {
    expect(g('g6').stage).toBe('new');
    expect(g('g6').notes).toContain('no status in GW-GIG');
  });
  it('splits fees into number and text, and turns a numeric Fee-Paid into a payment to check', () => {
    expect(g('g1')).toMatchObject({ feeQuoted: '3200', feeNote: null });
    expect(g('g2')).toMatchObject({ feeQuoted: null, feeNote: '1800 + 300 + travel' });
    expect(g('g7')).toMatchObject({ feeQuoted: null, feeNote: 'FREE; Paid: FREE' });
    const pays = plan.tenants[slugMain]!.payments;
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({ gig: 'g1', amount: '1000', paidOn: '2025-03-06' });
  });
  it('picks the booking manager as the contact, merged to the earliest contact', () => {
    expect(g('g1').contact).toBe('f1');
  });
  it('makes a contact from the gig booking details when nobody is linked', () => {
    expect(g('g6').contact).toBe('booking:g6');
    const made = plan.tenants[slugMain]!.contacts.find((c) => c.legacy[0] === 'booking:g6')!;
    expect(made).toMatchObject({ firstName: 'Pat', lastName: 'Booker', email: email('booker') });
  });
  it('merges venues that are the same name and keeps only the ones used', () => {
    const v = plan.tenants[slugMain]!.venues;
    expect(v.map((x) => x.name).sort()).toEqual(['Barn', 'Rose Hall', 'Unused? no, used']);
    expect(v.find((x) => x.name === 'Rose Hall')!.legacy).toEqual(['v1', 'v2']);
    expect(v.find((x) => x.name === 'Rose Hall')!.city).toBe('Napa');
    expect(g('g2').venue).toBe('v1');
  });
});

describe('logins and links', () => {
  it('turns band members into logins, with viewers read-only, and skips inactive ones', () => {
    const logins = Object.fromEntries(plan.logins.map((l) => [l.email, l.memberships.map((m) => `${m.slug}:${m.role}`).sort()]));
    expect(logins[email('ian')]).toEqual([`${slugMain}:admin`, `${slugRs}:admin`].sort());
    expect(logins[email('view')]).toEqual([`${slugMain}:read_only`]);
    expect(logins[email('gone')]).toBeUndefined();
    expect(logins[email('elsewhere')]).toBeUndefined();
  });
  it('keeps every open from a kept fan, attached to the person who opened it', () => {
    const t = plan.tenants[slugMain]!;
    expect(t.clicks.map((c) => c.legacy).sort()).toEqual(['p1', 'p2', 'p3', 'p4']);
    const forP2 = t.outbound.find((o) => o.legacy === t.clicks.find((c) => c.legacy === 'p2')!.link)!;
    const forP3 = t.outbound.find((o) => o.legacy === t.clicks.find((c) => c.legacy === 'p3')!.link)!;
    expect(forP3.contact).toBe('f3');
    expect(forP2.contact).toBe('f1');
    expect(forP2.url).toBe('Link from GW-GIG (address not recorded)');
    expect(t.outbound.find((o) => o.url === 'https://example.test/other')!.contact).toBe('f1');
    expect(plan.dropped['link plays for fans that were not kept']).toBe(1);
    expect(plan.dropped['link plays with no link and no address']).toBe(1);
    expect(t.outbound.find((o) => o.legacy === 'l1')!.target).toBe('ll1');
  });
});

describe('loading', () => {
  it('loads, and a second load adds nothing', async () => {
    const first = await loadPlan(pool, plan);
    const main = first.tenants[slugMain]!;
    expect(main['gig']).toEqual({ added: 4, skipped: 0 });
    expect(main['contact']!.added).toBe(plan.tenants[slugMain]!.contacts.length);
    expect(first.tenants[slugRs]!['contact']).toEqual({ added: 1, skipped: 0 });
    expect(first.logins.added).toBe(plan.logins.length);
    const second = await loadPlan(pool, plan);
    for (const counts of Object.values(second.tenants)) for (const c of Object.values(counts)) expect(c.added).toBe(0);
    expect(second.logins.added).toBe(0);
  });
  it('writes what the plan says', async () => {
    await withSystem(pool, async (c) => {
      const t = await c.query<{ id: string }>('SELECT id FROM tenant WHERE slug = $1', [slugMain]);
      const tid = t.rows[0]!.id;
      const gigs = await c.query<{ title: string; stage: string; postponed: boolean; fee_quoted: string | null; venue: string | null; contact: string | null; state: string }>(
        `SELECT g.title, g.stage, g.postponed, g.fee_quoted::text, v.name AS venue, trim(concat_ws(' ', ct.first_name, ct.last_name)) AS contact, m.state
           FROM gig g LEFT JOIN venue v ON v.id = g.venue_id LEFT JOIN contact ct ON ct.id = g.contact_id JOIN gig_money m ON m.gig_id = g.id
          WHERE g.tenant_id = $1 ORDER BY g.title`, [tid]);
      const byTitle = Object.fromEntries(gigs.rows.map((r) => [r.title, r]));
      expect(byTitle['Gig g1']).toMatchObject({ stage: 'played', fee_quoted: '3200.00', venue: 'Rose Hall', contact: 'Ann Early', state: 'part_paid' });
      expect(byTitle['Gig g2']).toMatchObject({ stage: 'confirmed', postponed: true, venue: 'Rose Hall' });
      const roles = await c.query('SELECT 1 FROM contact_role WHERE tenant_id = $1', [tid]);
      expect(roles.rowCount).toBe(2);
      const crew = await c.query<{ confirmed: boolean | null; email: string }>('SELECT gm.confirmed, u.email FROM gig_member gm JOIN membership m ON m.id = gm.membership_id JOIN app_user u ON u.id = m.user_id WHERE gm.tenant_id = $1', [tid]);
      expect(crew.rows).toEqual([{ confirmed: true, email: email('ian') }]);
      const clicks = await c.query('SELECT 1 FROM link_click WHERE tenant_id = $1 AND origin = $2', [tid, 'import']);
      expect(clicks.rowCount).toBe(4);
      const noPw = await c.query('SELECT 1 FROM app_user WHERE email LIKE $1 AND password_hash IS NOT NULL', [`itest-${tag}-%`]);
      expect(noPw.rowCount).toBe(0);
      const other = await c.query<{ n: string }>('SELECT count(*)::text AS n FROM gig WHERE tenant_id = (SELECT id FROM tenant WHERE slug = $1)', [slugRs]);
      expect(other.rows[0]!.n).toBe('0');
    });
  });
});
