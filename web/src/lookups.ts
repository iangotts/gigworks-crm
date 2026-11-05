import { api } from './api';
import type { Pick } from './types';

interface ContactRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  company: string | null;
}
interface VenueRow {
  id: string;
  name: string;
  city: string | null;
}

const contactPick = (c: ContactRow): Pick => {
  const label = [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email || 'No name';
  const hint = [c.company, c.email && label !== c.email ? c.email : null].filter(Boolean).join(', ');
  return hint ? { id: c.id, label, hint } : { id: c.id, label };
};

export async function searchContacts(q: string): Promise<Pick[]> {
  const r = await api<{ contacts: ContactRow[] }>('GET', `/api/contacts?limit=20&q=${encodeURIComponent(q)}`);
  return r.contacts.map(contactPick);
}

/** A new contact from a typed name. The first word is the first name, the rest the last name. */
export async function createContact(name: string): Promise<Pick> {
  const [first, ...rest] = name.trim().split(/\s+/);
  const c = await api<ContactRow>('POST', '/api/contacts', { first_name: first, last_name: rest.join(' ') || null });
  return contactPick(c);
}

export async function searchVenues(q: string): Promise<Pick[]> {
  const r = await api<{ venues: VenueRow[] }>('GET', `/api/venues?q=${encodeURIComponent(q)}`);
  return r.venues.map((v) => (v.city ? { id: v.id, label: v.name, hint: v.city } : { id: v.id, label: v.name }));
}

export async function createVenue(name: string): Promise<Pick> {
  const v = await api<VenueRow>('POST', '/api/venues', { name });
  return { id: v.id, label: v.name };
}
