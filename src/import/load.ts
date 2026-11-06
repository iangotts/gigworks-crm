// Writes a Plan into the database. Safe to run again: every GW-GIG id that was loaded is recorded in
// import_id_map, and a row that is already there is left alone, so a second run adds nothing.
import type pg from 'pg';
import { withSystem } from '../db.js';
import type { Plan, TenantPlan } from './plan.js';

export type Counts = Record<string, { added: number; skipped: number }>;
export interface LoadResult { tenants: Record<string, Counts>; logins: { added: number; skipped: number } }

class Ids {
  private m = new Map<string, string>();
  constructor(private c: pg.PoolClient, private tenantId: string) {}
  async preload(): Promise<void> {
    const r = await this.c.query<{ source_table: string; legacy_id: string; target_id: string }>('SELECT source_table, legacy_id, target_id FROM import_id_map WHERE tenant_id = $1', [this.tenantId]);
    for (const x of r.rows) this.m.set(`${x.source_table}:${x.legacy_id}`, x.target_id);
  }
  get(table: string, legacy: string | null): string | null {
    return legacy ? (this.m.get(`${table}:${legacy}`) ?? null) : null;
  }
  need(table: string, legacy: string | null): string {
    const id = this.get(table, legacy);
    if (!id) throw new Error(`Import order problem: ${table} ${legacy} has not been loaded.`);
    return id;
  }
  async record(table: string, target: string, targetTable: string[], legacyIds: string[]): Promise<void> {
    for (const legacy of legacyIds) {
      if (this.m.has(`${table}:${legacy}`)) continue;
      await this.c.query('INSERT INTO import_id_map (tenant_id, source_table, legacy_id, target_table, target_id) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING', [this.tenantId, table, legacy, targetTable[0], target]);
      this.m.set(`${table}:${legacy}`, target);
    }
  }
}

const bump = (counts: Counts, k: string, added: boolean): void => {
  const c = (counts[k] ??= { added: 0, skipped: 0 });
  if (added) c.added++;
  else c.skipped++;
};

export async function loadPlan(pool: pg.Pool, plan: Plan): Promise<LoadResult> {
  const result: LoadResult = { tenants: {}, logins: { added: 0, skipped: 0 } };
  await withSystem(pool, async (c) => {
    await c.query('BEGIN');
    try {
      const userIds = new Map<string, string>();
      for (const l of plan.logins) {
        const ex = await c.query<{ id: string }>('SELECT id FROM app_user WHERE email = $1', [l.email]);
        let id = ex.rows[0]?.id;
        if (id) result.logins.skipped++;
        else {
          id = (await c.query<{ id: string }>('INSERT INTO app_user (email, name, password_hash) VALUES ($1, $2, NULL) RETURNING id', [l.email, l.name])).rows[0]?.id as string;
          result.logins.added++;
        }
        userIds.set(l.email, id);
        for (const m of l.memberships) {
          await c.query('INSERT INTO membership (tenant_id, user_id, role) SELECT id, $2, $3 FROM tenant WHERE slug = $1 ON CONFLICT (tenant_id, user_id) DO NOTHING', [m.slug, id, m.role]);
        }
      }
      for (const t of Object.values(plan.tenants)) result.tenants[t.slug] = await loadTenant(c, t, userIds);
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  });
  return result;
}

async function loadTenant(c: pg.PoolClient, t: TenantPlan, userIds: Map<string, string>): Promise<Counts> {
  const counts: Counts = {};
  const tr = await c.query<{ id: string }>('SELECT id FROM tenant WHERE slug = $1', [t.slug]);
  const tenantId = tr.rows[0]?.id;
  if (!tenantId) throw new Error(`No tenant with slug ${t.slug}. Run the seed first.`);
  const ids = new Ids(c, tenantId);
  await ids.preload();
  const q = async (sql: string, params: unknown[]): Promise<string> => (await c.query<{ id: string }>(sql, params)).rows[0]?.id as string;

  for (const v of t.venues) {
    const have = ids.get('Venue', v.legacy[0] as string);
    bump(counts, 'venue', !have);
    const id = have ?? (await q('INSERT INTO venue (tenant_id, name, city, address, website, phone, type, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', [tenantId, v.name, v.city, v.address, v.website, v.phone, v.type, v.notes]));
    await ids.record('Venue', id, ['venue'], v.legacy);
  }
  for (const k of t.contacts) {
    const have = ids.get('Fan', k.legacy[0] as string);
    bump(counts, 'contact', !have);
    const id = have ?? (await q(
      `INSERT INTO contact (tenant_id, first_name, last_name, email, phone, company, job_title, address, source, is_local, tags, notes, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, COALESCE($13::timestamptz, now())) RETURNING id`,
      [tenantId, k.firstName, k.lastName, k.email, k.phone, k.company, k.jobTitle, k.address, k.source, k.isLocal, k.tags, k.notes, k.createdAt],
    ));
    await ids.record('Fan', id, ['contact'], k.legacy);
  }
  for (const g of t.gigs) {
    const have = ids.get('Gig', g.legacy);
    bump(counts, 'gig', !have);
    const id = have ?? (await q(
      `INSERT INTO gig (tenant_id, venue_id, contact_id, title, stage, postponed, lost_reason, event_date, load_in_time, start_time, end_time, platform, tag, notes, fee_quoted, fee_note, archived_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, COALESCE($18::timestamptz, now())) RETURNING id`,
      [tenantId, ids.get('Venue', g.venue), ids.get('Fan', g.contact), g.title, g.stage, g.postponed, g.lostReason, g.eventDate, g.loadIn, g.start, g.end, g.platform, g.tag, g.notes, g.feeQuoted, g.feeNote, g.archivedAt, g.createdAt],
    ));
    await ids.record('Gig', id, ['gig'], [g.legacy]);
  }
  for (const r of t.roles) {
    const src = r.gig ? 'FanGig' : 'FanVenue';
    const have = ids.get(src, r.legacy);
    bump(counts, 'contact role', !have);
    if (!have) {
      const id = await q('INSERT INTO contact_role (tenant_id, contact_id, kind, label, gig_id, venue_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [tenantId, ids.need('Fan', r.contact), r.kind, r.label, ids.get('Gig', r.gig), ids.get('Venue', r.venue)]);
      await ids.record(src, id, ['contact_role'], [r.legacy]);
    }
  }
  for (const p of t.payments) {
    const have = ids.get('GigFeePaid', p.legacy);
    bump(counts, 'payment', !have);
    if (!have) {
      const id = await q("INSERT INTO payment (tenant_id, gig_id, kind, amount, paid_on, note) VALUES ($1,$2,'other',$3,$4,$5) RETURNING id", [tenantId, ids.need('Gig', p.gig), p.amount, p.paidOn, p.note]);
      await ids.record('GigFeePaid', id, ['payment'], [p.legacy]);
    }
  }
  for (const a of t.activities) {
    const src = a.kind === 'task' ? 'GigAction' : a.gig ? 'GigNote' : 'FanNote';
    const have = ids.get(src, a.legacy);
    bump(counts, a.kind === 'task' ? 'gig action' : a.gig ? 'gig note' : 'contact note', !have);
    if (!have) {
      const by = a.byEmail ? (userIds.get(a.byEmail) ?? null) : null;
      const id = await q(
        `INSERT INTO activity (tenant_id, kind, contact_id, gig_id, body, occurred_at, due_at, completed_at, created_by)
         VALUES ($1,$2,$3,$4,$5, COALESCE($6::timestamptz, now()), $7, $8, $9) RETURNING id`,
        [tenantId, a.kind, ids.get('Fan', a.contact), ids.get('Gig', a.gig), a.body, a.occurredAt, a.dueAt, a.completedAt, by],
      );
      await ids.record(src, id, ['activity'], [a.legacy]);
    }
  }
  for (const m of t.gigMembers) {
    const have = ids.get('GigBandMember', m.legacy);
    bump(counts, 'gig crew', !have);
    if (!have) {
      const mem = await c.query<{ id: string }>('SELECT m.id FROM membership m JOIN app_user u ON u.id = m.user_id WHERE m.tenant_id = $1 AND u.email = $2', [tenantId, m.email]);
      const memId = mem.rows[0]?.id;
      if (!memId) throw new Error(`No membership for ${m.email} in ${t.slug}.`);
      const id = await q('INSERT INTO gig_member (tenant_id, gig_id, membership_id, confirmed) VALUES ($1,$2,$3,$4) ON CONFLICT (gig_id, membership_id) DO UPDATE SET confirmed = COALESCE(gig_member.confirmed, EXCLUDED.confirmed) RETURNING id', [tenantId, ids.need('Gig', m.gig), memId, m.confirmed]);
      await ids.record('GigBandMember', id, ['gig_member'], [m.legacy]);
    }
  }
  for (const l of t.linkTargets) {
    const have = ids.get('FanURLLinkList', l.legacy);
    bump(counts, 'link list', !have);
    if (!have) {
      const id = await q('INSERT INTO link_target (tenant_id, name, url, sort_order) VALUES ($1,$2,$3,$4) RETURNING id', [tenantId, l.name, l.url, l.sortOrder]);
      await ids.record('FanURLLinkList', id, ['link_target'], [l.legacy]);
    }
  }
  for (const o of t.outbound) {
    const have = ids.get('FanURLLink', o.legacy);
    bump(counts, 'link per person', !have);
    if (!have) {
      const id = await q('INSERT INTO outbound_link (tenant_id, contact_id, link_target_id, destination_url, created_at) VALUES ($1,$2,$3,$4, COALESCE($5::timestamptz, now())) RETURNING id', [tenantId, ids.need('Fan', o.contact), ids.get('FanURLLinkList', o.target), o.url, o.createdAt]);
      await ids.record('FanURLLink', id, ['outbound_link'], [o.legacy]);
    }
  }
  for (const k of t.clicks) {
    const have = ids.get('FanURLLinkPlay', k.legacy);
    bump(counts, 'link open', !have);
    if (!have) {
      const id = await q("INSERT INTO link_click (tenant_id, outbound_link_id, clicked_at, origin) VALUES ($1,$2,$3,'import') RETURNING id", [tenantId, ids.need('FanURLLink', k.link), k.clickedAt]);
      await ids.record('FanURLLinkPlay', id, ['link_click'], [k.legacy]);
    }
  }
  return counts;
}
