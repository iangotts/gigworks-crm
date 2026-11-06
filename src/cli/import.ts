// Import the GW-GIG exports.
//
//   npm run import -- --dir /path/to/exports --dry-run          read the files and write the report only
//   npm run import -- --dir /path/to/exports --yes              load into the database DATABASE_URL points at
//
// Runs as the database owner. Do a dry run first, then rehearse into a scratch database (twice: the second
// run must add nothing), and only then run it against production. Reports go to --out (default ./import-report).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config.js';
import { createPool, withSystem } from '../db.js';
import { parseCsv, type Row } from '../import/csv.js';
import { loadPlan } from '../import/load.js';
import { buildPlan, type Exports, type Plan } from '../import/plan.js';

const { values } = parseArgs({ options: { dir: { type: 'string' }, out: { type: 'string' }, 'dry-run': { type: 'boolean' }, yes: { type: 'boolean' }, today: { type: 'string' }, 'gigs-from': { type: 'string' } } });
if (!values.dir) {
  console.error('Need --dir, the folder holding the exported CSV files.');
  process.exit(2);
}
const dir = values.dir;
const out = values.out ?? 'import-report';

// Expected figures from the plan (the 5 Nov 2026 exports).
const EXPECTED: Record<string, number> = {
  'fans kept': 1274,
  'email groups merged': 27,
  'contacts copied to ROCKSOLID': 37,
  'gigs with no date': 15,
  'venues imported': 129,
  'fan-venue links kept': 116,
  logins: 15,
  'logins in both bands': 6,
  'viewers in Jane Blonde': 5,
};

function readExport(name: string): Row[] {
  const files = readdirSync(dir).filter((f) => new RegExp(`export_All-${name}(-modified[^_]*)?_`).test(f));
  if (files.length === 0) throw new Error(`No export for ${name} in ${dir}.`);
  const parsed = files.map((f) => ({ f, rows: parseCsv(readFileSync(join(dir, f), 'utf8')) }));
  // The "modified" export carries a unique id column. Prefer a file that has it.
  const withId = parsed.filter((p) => p.rows[0] && 'unique id' in p.rows[0]);
  const chosen = (withId.length ? withId : parsed).sort((a, b) => b.f.localeCompare(a.f))[0];
  console.log(`  ${name}: ${chosen?.f} (${chosen?.rows.length} rows)`);
  return chosen?.rows ?? [];
}

const config = loadConfig();
const pool = createPool(config.databaseUrl);
try {
  console.log('Reading exports');
  const x: Exports = {
    Fans: readExport('Fans'), Gigs: readExport('Gigs'), Venues: readExport('Venues'), FanGigs: readExport('FanGigs'), FanVenues: readExport('FanVenues'),
    GigNotes: readExport('GigNotes'), GigActions: readExport('GigActions'), GigBandMembers: readExport('GigBandMembers'), FanNotes: readExport('Fan-Notes'),
    FanURLLinkLists: readExport('FanURLLinkLists'), FanURLLinks: readExport('FanURLLinks'), FanURLLinkPlays: readExport('FanURLLinkPlays'),
    BandMembers: readExport('BandMembers'), Users: readExport('Users'),
  };
  const rules = await withSystem(pool, async (c) => {
    const r = await c.query<{ kind: string; source_value: string; target_value: string | null; slug: string | null }>(
      'SELECT m.kind, m.source_value, m.target_value, t.slug FROM import_mapping m LEFT JOIN tenant t ON t.id = m.tenant_id',
    );
    const bands: Record<string, string> = {};
    const status: Record<string, string> = {};
    for (const m of r.rows) {
      if (m.kind === 'band' && m.slug) bands[m.source_value] = m.slug;
      if (m.kind === 'status' && m.target_value) status[m.source_value] = m.target_value;
    }
    return { bands, status, gigsFrom: values['gigs-from'] ?? '2024-11-05', today: values.today ?? new Date().toISOString().slice(0, 10) };
  });
  if (Object.keys(rules.bands).length === 0) throw new Error('The import rules are empty. Run the seed first (npm run db:seed).');
  const plan = buildPlan(x, rules);

  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'report.md'), reportMarkdown(plan, rules.gigsFrom));
  writeFileSync(join(out, 'spot-check.md'), spotMarkdown(plan));
  writeFileSync(join(out, 'flags.csv'), ['table,legacy id,name,problem', ...plan.flags.map((f) => [f.table, f.id, f.label, f.problem].map(csvCell).join(','))].join('\n') + '\n');
  console.log('\nAgainst the plan');
  let off = 0;
  for (const [k, want] of Object.entries(EXPECTED)) {
    const got = plan.stats[k];
    if (got !== want) off++;
    console.log(`  ${got === want ? 'ok  ' : 'DIFF'} ${k}: got ${got}, plan says ${want}`);
  }
  console.log(`\n${plan.flags.length} rows flagged for a look (flags.csv). Reports are in ${out}/`);

  if (values['dry-run']) {
    console.log('Dry run: nothing was written to the database.');
  } else {
    const target = new URL(config.databaseUrl);
    const where = `${target.hostname || target.searchParams.get('host') || 'local socket'}${target.port ? `:${target.port}` : ''}${target.pathname}`;
    if (!values.yes) {
      console.log(`\nNot loaded. This would write to ${where}. Add --yes to load, or --dry-run to only read.`);
      process.exit(1);
    }
    console.log(`\nLoading into ${where}`);
    const res = await loadPlan(pool, plan);
    writeFileSync(join(out, 'load.json'), JSON.stringify(res, null, 2));
    for (const [slug, counts] of Object.entries(res.tenants)) {
      console.log(`  ${slug}`);
      for (const [k, c] of Object.entries(counts)) console.log(`    ${k.padEnd(16)} added ${String(c.added).padStart(5)}   already there ${String(c.skipped).padStart(5)}`);
    }
    console.log(`  logins           added ${res.logins.added}   already there ${res.logins.skipped}`);
  }
  if (off > 0) console.log(`\n${off} figure(s) differ from the plan. Look at them before going on.`);
} finally {
  await pool.end();
}

function csvCell(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function reportMarkdown(p: Plan, from: string): string {
  const lines = ['# Import report', '', `Gigs dated on or after ${from}. Times in the exports are read as America/Los_Angeles.`, '', '## Counts', ''];
  for (const [k, v] of Object.entries(p.stats)) lines.push(`- ${k}: ${v}`);
  for (const t of Object.values(p.tenants)) {
    lines.push('', `## ${t.slug}`, '');
    for (const [k, v] of Object.entries({ venues: t.venues.length, contacts: t.contacts.length, gigs: t.gigs.length, 'contact roles': t.roles.length, payments: t.payments.length, 'notes and tasks': t.activities.length, 'gig crew': t.gigMembers.length, 'link lists': t.linkTargets.length, 'links per person': t.outbound.length, 'link opens': t.clicks.length })) lines.push(`- ${k}: ${v}`);
  }
  lines.push('', '## Left behind', '');
  for (const [k, v] of Object.entries(p.dropped).sort((a, b) => b[1] - a[1])) lines.push(`- ${k}: ${v}`);
  lines.push('', '## Logins (no passwords yet)', '');
  for (const l of p.logins) lines.push(`- ${l.email}: ${l.memberships.map((m) => `${m.slug} ${m.role}`).join(', ')}`);
  return lines.join('\n') + '\n';
}

function spotMarkdown(p: Plan): string {
  const block = (title: string, items: Plan['spot']['gigs']): string[] => {
    const l = [`## ${title}`, ''];
    items.forEach((s, i) => {
      l.push(`### ${i + 1}. ${s.label}`, '', `GW-GIG id: ${s.id}`, '', '| GW-GIG says | GW-CRM has |', '| --- | --- |');
      const a = Object.entries(s.source);
      const b = Object.entries(s.imported);
      for (let n = 0; n < Math.max(a.length, b.length); n++) l.push(`| ${a[n] ? `${a[n]?.[0]}: ${(a[n]?.[1] ?? '').replace(/\|/g, '/') || '(blank)'}` : ''} | ${b[n] ? `${b[n]?.[0]}: ${String(b[n]?.[1] ?? '(blank)').replace(/\|/g, '/')}` : ''} |`);
      l.push('');
    });
    return l;
  };
  return ['# Spot check', '', 'Open each one in GW-GIG and in GW-CRM and tick it off.', '', ...block('20 gigs', p.spot.gigs), ...block('20 contacts', p.spot.contacts)].join('\n') + '\n';
}
