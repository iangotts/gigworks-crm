export type StageKey = 'new' | 'evaluating' | 'in_conversation' | 'confirmed' | 'played' | 'lost';
export type Role = 'admin' | 'member' | 'read_only';

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  role: Role;
}

export interface Me {
  user: { id: string; email: string; name: string | null };
  tenants: Tenant[];
  activeTenantId: string | null;
  role: Role | null;
}

/** A gig as shown on a pipeline card. Numbers from Postgres numeric columns arrive as strings. */
export interface Gig {
  id: string;
  title: string;
  stage: StageKey;
  postponed: boolean;
  event_date: string | null; // YYYY-MM-DD
  start_time: string | null;
  event_type: string | null;
  platform: string | null;
  budget: string | null;
  fee_quoted: string | null;
  fee_note: string | null;
  next_action_at: string | null;
  reply_owed_by: string | null; // YYYY-MM-DD
  decision: 'pursue' | 'decline' | null;
  contact_id: string | null;
  venue_id: string | null;
  contact_name: string | null;
  venue_name: string | null;
  updated_at: string;
}

export interface GigDetail extends Gig {
  load_in_time: string | null;
  end_time: string | null;
  lead_url: string | null;
  indoor_outdoor: 'indoor' | 'outdoor' | 'both' | null;
  hours: string | null;
  verified_phone: boolean;
  credits_spent: number;
  drive_miles: string | null;
  band_pitched: string | null;
  decline_reason: string | null;
  lost_reason: string | null;
  notes: string | null;
  tag: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  venue_city: string | null;
}

export interface Activity {
  id: string;
  kind: 'call' | 'voicemail' | 'text' | 'email' | 'note' | 'task';
  body: string | null;
  occurred_at: string;
}

export interface Pick {
  id: string;
  label: string;
  /** A second line in the list, such as an email address or a city. */
  hint?: string;
}
