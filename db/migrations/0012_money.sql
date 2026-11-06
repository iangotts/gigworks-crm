-- 0012_money: what a gig is worth, what has been received, and what is still owed.
-- One definition of "paid" for the whole app. It runs with the caller's row-level security.
-- Money is only ever added up here, in numeric, never in the browser or in floating point.
CREATE VIEW gig_money WITH (security_invoker = true) AS
SELECT g.tenant_id,
       g.id AS gig_id,
       g.fee_quoted AS fee,
       s.scheduled,
       s.received,
       -- What the gig should bring in: its fee, or the payments scheduled when no fee is set.
       GREATEST(coalesce(g.fee_quoted, s.scheduled) - s.received, 0) AS outstanding,
       CASE
         WHEN coalesce(g.fee_quoted, s.scheduled) = 0 AND s.received = 0 THEN 'none'
         WHEN s.received = 0 THEN 'unpaid'
         WHEN s.received < coalesce(g.fee_quoted, s.scheduled) THEN 'part_paid'
         WHEN s.received = coalesce(g.fee_quoted, s.scheduled) THEN 'paid'
         ELSE 'overpaid'
       END AS state,
       -- Set when payments exist and do not add up to the fee.
       CASE WHEN g.fee_quoted IS NOT NULL AND s.n > 0 AND s.scheduled <> g.fee_quoted THEN g.fee_quoted - s.scheduled END AS schedule_gap
  FROM gig g
  CROSS JOIN LATERAL (
    SELECT count(*)::int AS n,
           coalesce(sum(p.amount), 0) AS scheduled,
           coalesce(sum(p.amount) FILTER (WHERE p.paid_on IS NOT NULL), 0) AS received
      FROM payment p WHERE p.tenant_id = g.tenant_id AND p.gig_id = g.id
  ) s;
GRANT SELECT ON gig_money TO crm_app;
