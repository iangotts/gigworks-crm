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

export type ActivityKind = 'call' | 'voicemail' | 'text' | 'email' | 'note' | 'task';

/** One line of the log, for a contact or a gig. */
export interface LogItem {
  id: string;
  kind: ActivityKind;
  body: string | null;
  occurred_at: string;
  due_at: string | null;
  completed_at: string | null;
  contact_id: string | null;
  gig_id: string | null;
  gig_title: string | null;
  contact_name: string | null;
  by_name: string | null;
  subject?: string | null;
  email_to?: string | null;
  delivery?: 'sending' | 'sent' | 'failed' | null;
  delivery_error?: string | null;
}

export interface EmailSettings {
  from_name: string;
  from_email: string;
  reply_to: string;
  signature: string | null;
}

export interface ContactRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  job_title: string | null;
  city: string | null;
  tags: string[];
  subscription: 'subscribed' | 'unsubscribed' | 'bounced' | 'suppressed' | null;
  last_contact_at: string | null;
  open_gigs: number;
}

export interface Consent {
  status: 'subscribed' | 'unsubscribed' | 'bounced' | 'suppressed';
  consent_source: string | null;
  consented_at: string | null;
  unsubscribed_at: string | null;
}

export interface ContactFull extends ContactRow {
  consent: Consent | null;
  address: string | null;
  source: string | null;
  notes: string | null;
}

export interface ContactGig {
  id: string;
  title: string;
  stage: StageKey;
  postponed: boolean;
  event_date: string | null;
}

export type TemplateKind = 'decline' | 'pitch' | 'follow_up' | 'other';
export interface Template {
  id: string;
  name: string;
  kind: TemplateKind;
  subject: string | null;
  body: string;
}

export interface FollowupGig {
  id: string;
  title: string;
  stage: StageKey;
  contact_id: string | null;
  contact_name: string | null;
  next_action_at?: string;
  reply_owed_by?: string;
}
export interface Followups {
  tasks: LogItem[];
  gigs: (FollowupGig & { next_action_at: string })[];
  replies: (FollowupGig & { reply_owed_by: string })[];
}

export interface LinkTarget {
  id: string;
  name: string;
  url: string;
  sort_order: number;
  active: boolean;
  sent: number;
  clicks: number;
}

export interface BuiltLink {
  id: string;
  contact_id: string | null;
  gig_id: string | null;
  link_target_id: string | null;
  destination_url: string;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_content: string | null;
  created_at: string;
  target_name: string | null;
  gig_title: string | null;
  by_name: string | null;
  clicks: number;
  last_click_at: string | null;
}
