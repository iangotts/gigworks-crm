import { randomUUID } from 'node:crypto';

export class GoogleError extends Error {
  constructor(
    message: string,
    /** The person has to sign in to Google again: the token was revoked or expired. */
    readonly needsReconnect = false,
  ) {
    super(message);
  }
}

export interface Tokens {
  refreshToken: string;
  accessToken: string;
  expiresInSec: number;
  email: string;
}
export interface BusyEvent {
  id: string;
  start: string; // ISO date-time, or YYYY-MM-DD for an all-day event
  end: string;
  allDay: boolean;
  /** Set when the event was made by GW-CRM for a gig. */
  gigId: string | null;
}
export interface CalendarEntry {
  id: string;
  name: string;
  primary: boolean;
}
export interface EventInput {
  summary: string;
  location?: string;
  description?: string;
  allDay: boolean;
  /** all-day: YYYY-MM-DD dates (end is the day after). timed: local date-times without offset. */
  start: string;
  end: string;
  timeZone: string;
  gigId: string;
  attendees: string[];
}
export interface CreatedEvent {
  id: string;
  htmlLink: string | null;
}

export interface GoogleClient {
  authUrl(state: string): string;
  exchangeCode(code: string): Promise<Tokens>;
  accessToken(refreshToken: string): Promise<{ accessToken: string; expiresInSec: number }>;
  revoke(token: string): Promise<void>;
  listCalendars(accessToken: string): Promise<CalendarEntry[]>;
  /** Events that make the person busy between two instants. */
  listBusy(accessToken: string, calendarId: string, from: string, to: string): Promise<BusyEvent[]>;
  insertEvent(accessToken: string, calendarId: string, e: EventInput): Promise<CreatedEvent>;
  patchEvent(accessToken: string, calendarId: string, eventId: string, e: EventInput): Promise<CreatedEvent>;
  /** Deleting an event that is already gone is not an error. */
  deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void>;
}

export const GOOGLE_SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'];

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

function eventBody(e: EventInput): Record<string, unknown> {
  return {
    summary: e.summary,
    ...(e.location ? { location: e.location } : {}),
    ...(e.description ? { description: e.description } : {}),
    start: e.allDay ? { date: e.start } : { dateTime: e.start, timeZone: e.timeZone },
    end: e.allDay ? { date: e.end } : { dateTime: e.end, timeZone: e.timeZone },
    // Lets us tell this event from the member's own events, so a gig never conflicts with itself.
    extendedProperties: { private: { gwcrmGigId: e.gigId } },
    ...(e.attendees.length ? { attendees: e.attendees.map((email) => ({ email })) } : {}),
    reminders: { useDefault: true },
  };
}

export function realGoogle(cfg: GoogleConfig, fetchImpl: typeof fetch = fetch): GoogleClient {
  const call = async (url: string, init: RequestInit & { token?: string }): Promise<Response> => {
    const { token, ...rest } = init;
    try {
      return await fetchImpl(url, {
        ...rest,
        signal: AbortSignal.timeout(15_000),
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(rest.headers ?? {}) },
      });
    } catch {
      throw new GoogleError('Google did not answer. Try again in a moment.');
    }
  };
  const fail = async (res: Response, what: string): Promise<never> => {
    let detail = '';
    try {
      const j = (await res.json()) as { error?: { message?: string } | string; error_description?: string };
      detail = typeof j.error === 'string' ? (j.error_description ?? j.error) : (j.error?.message ?? '');
    } catch {
      /* no body */
    }
    if (res.status === 401) throw new GoogleError('Google no longer accepts this sign-in. Connect again.', true);
    throw new GoogleError(`${what} failed (${res.status}). ${detail}`.trim());
  };
  const form = (o: Record<string, string>): string => new URLSearchParams(o).toString();

  return {
    authUrl(state) {
      return (
        'https://accounts.google.com/o/oauth2/v2/auth?' +
        form({
          client_id: cfg.clientId,
          redirect_uri: cfg.redirectUri,
          response_type: 'code',
          scope: GOOGLE_SCOPES.join(' '),
          access_type: 'offline',
          prompt: 'consent', // makes Google return a refresh token every time
          state,
        })
      );
    },
    async exchangeCode(code) {
      const res = await call('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({ code, client_id: cfg.clientId, client_secret: cfg.clientSecret, redirect_uri: cfg.redirectUri, grant_type: 'authorization_code' }),
      });
      if (!res.ok) return fail(res, 'Connecting to Google');
      const j = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; id_token?: string };
      if (!j.access_token || !j.refresh_token || !j.id_token) {
        throw new GoogleError('Google did not give the access needed. Connect again and allow calendar access.');
      }
      // The token came straight from Google over TLS, so its payload can be read without checking a signature.
      const payload = JSON.parse(Buffer.from(j.id_token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { email?: string };
      if (!payload.email) throw new GoogleError('Google did not share an email address.');
      return { refreshToken: j.refresh_token, accessToken: j.access_token, expiresInSec: j.expires_in ?? 3600, email: payload.email };
    },
    async accessToken(refreshToken) {
      const res = await call('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({ refresh_token: refreshToken, client_id: cfg.clientId, client_secret: cfg.clientSecret, grant_type: 'refresh_token' }),
      });
      if (res.status === 400 || res.status === 401) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        if (j.error === 'invalid_grant') throw new GoogleError('Google no longer accepts this sign-in. Connect again.', true);
        throw new GoogleError('Google refused the sign-in.');
      }
      if (!res.ok) return fail(res, 'Refreshing the Google sign-in');
      const j = (await res.json()) as { access_token: string; expires_in?: number };
      return { accessToken: j.access_token, expiresInSec: j.expires_in ?? 3600 };
    },
    async revoke(token) {
      await call('https://oauth2.googleapis.com/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form({ token }),
      }).catch(() => undefined);
    },
    async listCalendars(accessToken) {
      const res = await call('https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&fields=items(id,summary,primary)', { token: accessToken });
      if (!res.ok) return fail(res, 'Listing calendars');
      const j = (await res.json()) as { items?: { id: string; summary?: string; primary?: boolean }[] };
      return (j.items ?? []).map((i) => ({ id: i.id, name: i.summary ?? i.id, primary: Boolean(i.primary) }));
    },
    async listBusy(accessToken, calendarId, from, to) {
      const q = form({
        timeMin: from,
        timeMax: to,
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '50',
        fields: 'items(id,status,transparency,start,end,extendedProperties/private)',
      });
      const res = await call(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${q}`, { token: accessToken });
      if (!res.ok) return fail(res, 'Reading the calendar');
      const j = (await res.json()) as {
        items?: {
          id: string;
          status?: string;
          transparency?: string;
          start?: { date?: string; dateTime?: string };
          end?: { date?: string; dateTime?: string };
          extendedProperties?: { private?: Record<string, string> };
        }[];
      };
      const out: BusyEvent[] = [];
      for (const i of j.items ?? []) {
        if (i.status === 'cancelled' || i.transparency === 'transparent') continue; // free time does not block
        const s = i.start?.dateTime ?? i.start?.date;
        const e = i.end?.dateTime ?? i.end?.date;
        if (!s || !e) continue;
        out.push({ id: i.id, start: s, end: e, allDay: !i.start?.dateTime, gigId: i.extendedProperties?.private?.gwcrmGigId ?? null });
      }
      return out;
    },
    async insertEvent(accessToken, calendarId, e) {
      const res = await call(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=none`, {
        method: 'POST',
        token: accessToken,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(eventBody(e)),
      });
      if (!res.ok) return fail(res, 'Adding the event');
      const j = (await res.json()) as { id: string; htmlLink?: string };
      return { id: j.id, htmlLink: j.htmlLink ?? null };
    },
    async patchEvent(accessToken, calendarId, eventId, e) {
      const res = await call(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, {
        method: 'PATCH',
        token: accessToken,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(eventBody(e)),
      });
      if (res.status === 404 || res.status === 410) throw new GoogleError('The event was deleted in Google Calendar.');
      if (!res.ok) return fail(res, 'Updating the event');
      const j = (await res.json()) as { id: string; htmlLink?: string };
      return { id: j.id, htmlLink: j.htmlLink ?? null };
    },
    async deleteEvent(accessToken, calendarId, eventId) {
      const res = await call(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=none`, {
        method: 'DELETE',
        token: accessToken,
      });
      if (res.status === 404 || res.status === 410 || res.ok) return;
      return fail(res, 'Removing the event');
    },
  };
}

/** For tests and local work with no Google account. Keeps calendars in memory. */
export function fakeGoogle() {
  const events = new Map<string, { calendarId: string; input: EventInput; id: string }>();
  const owners = new Map<string, string>();
  const busyByCalendar = new Map<string, BusyEvent[]>();
  const f = {
    events,
    busyByCalendar,
    revoked: [] as string[],
    calls: [] as string[],
    /** Emails whose refresh token Google now rejects. */
    revokedEmails: new Set<string>(),
    failNext: null as string | null,
    authUrl: (state: string) => `https://accounts.example.test/auth?state=${encodeURIComponent(state)}`,
    async exchangeCode(code: string): Promise<Tokens> {
      if (!code.startsWith('good-')) throw new GoogleError('Connecting to Google failed (400).');
      const email = code.slice(5);
      return { refreshToken: `refresh-${email}`, accessToken: `access-${email}`, expiresInSec: 3600, email };
    },
    async accessToken(refreshToken: string) {
      f.calls.push('token');
      const email = refreshToken.replace('refresh-', '');
      if (f.revokedEmails.has(email)) throw new GoogleError('Google no longer accepts this sign-in. Connect again.', true);
      return { accessToken: `access-${email}`, expiresInSec: 3600 };
    },
    async revoke(token: string) {
      f.revoked.push(token);
    },
    async listCalendars(): Promise<CalendarEntry[]> {
      return [{ id: 'primary', name: 'Main', primary: true }, { id: 'band@group.calendar.example', name: 'Band gigs', primary: false }];
    },
    async listBusy(accessToken: string, calendarId: string, from: string, to: string): Promise<BusyEvent[]> {
      f.calls.push(`busy:${accessToken}:${calendarId}`);
      const email = accessToken.replace('access-', '');
      const mine = [...(busyByCalendar.get(`${accessToken}:${calendarId}`) ?? [])];
      for (const e of events.values()) {
        // An event shows on the calendar it was written to, and on an invited member's main calendar.
        const here = (e.calendarId === calendarId && owners.get(e.id) === email) || (calendarId === 'primary' && e.input.attendees.includes(email));
        if (here) mine.push({ id: e.id, start: e.input.start, end: e.input.end, allDay: e.input.allDay, gigId: e.input.gigId });
      }
      return mine.filter((b) => b.start < to && b.end > from);
    },
    async insertEvent(accessToken: string, calendarId: string, e: EventInput): Promise<CreatedEvent> {
      f.calls.push('insert');
      if (f.failNext) {
        const m = f.failNext;
        f.failNext = null;
        throw new GoogleError(m);
      }
      const id = `ev-${randomUUID()}`;
      owners.set(id, accessToken.replace('access-', ''));
      events.set(id, { calendarId, input: e, id });
      return { id, htmlLink: `https://calendar.example.test/${id}` };
    },
    async patchEvent(_t: string, calendarId: string, eventId: string, e: EventInput): Promise<CreatedEvent> {
      f.calls.push('patch');
      if (!events.has(eventId)) throw new GoogleError('The event was deleted in Google Calendar.');
      events.set(eventId, { calendarId, input: e, id: eventId });
      return { id: eventId, htmlLink: `https://calendar.example.test/${eventId}` };
    },
    async deleteEvent(_t: string, _c: string, eventId: string): Promise<void> {
      f.calls.push('delete');
      events.delete(eventId);
    },
  };
  return f;
}
