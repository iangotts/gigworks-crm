import { randomUUID } from 'node:crypto';

export interface OutgoingEmail {
  fromName: string;
  fromEmail: string;
  replyTo: string;
  to: string;
  subject: string;
  text: string;
}

export class EmailError extends Error {
  constructor(
    message: string,
    /** True when the provider is not set up, as opposed to refusing this one message. */
    readonly notConfigured = false,
  ) {
    super(message);
  }
}

export interface EmailProvider {
  /** Returns the provider's message id. Throws EmailError when the message was not accepted. */
  send(mail: OutgoingEmail): Promise<{ id: string }>;
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Plain paragraphs as simple HTML. No tracking pixel and no rewritten links. */
export function textToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/** Subject and names must be one line, so a pasted newline cannot add a header. */
export const oneLine = (s: string): string => s.replace(/[\r\n\u2028\u2029]+/g, ' ').trim();

export function sendGridProvider(apiKey: string, fetchImpl: typeof fetch = fetch): EmailProvider {
  return {
    async send(m) {
      let res: Response;
      try {
        res = await fetchImpl('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          signal: AbortSignal.timeout(15_000),
          body: JSON.stringify({
            personalizations: [{ to: [{ email: m.to }] }],
            from: { email: m.fromEmail, name: m.fromName },
            reply_to: { email: m.replyTo },
            subject: m.subject,
            content: [
              { type: 'text/plain', value: m.text },
              { type: 'text/html', value: textToHtml(m.text) },
            ],
            // Links stay exactly as written, so tagged links keep their UTM parameters.
            tracking_settings: { click_tracking: { enable: false, enable_text: false }, open_tracking: { enable: false } },
          }),
        });
      } catch {
        throw new EmailError('The email service did not answer. Nothing was sent.');
      }
      if (res.status === 202) return { id: res.headers.get('x-message-id') ?? randomUUID() };
      let detail = '';
      try {
        const j = (await res.json()) as { errors?: { message?: string }[] };
        detail = j.errors?.[0]?.message ?? '';
      } catch {
        /* no body */
      }
      if (res.status === 401 || res.status === 403) throw new EmailError(`The email service refused the account or sender. ${detail}`.trim(), true);
      throw new EmailError(`The email service rejected the message (${res.status}). ${detail}`.trim());
    },
  };
}

/** For local work and tests. Keeps what it was asked to send instead of sending it. */
export function logProvider(): EmailProvider & { sent: OutgoingEmail[]; failNext: string | null } {
  const p = {
    sent: [] as OutgoingEmail[],
    failNext: null as string | null,
    async send(m: OutgoingEmail) {
      if (p.failNext) {
        const msg = p.failNext;
        p.failNext = null;
        throw new EmailError(msg);
      }
      p.sent.push(m);
      return { id: `log-${randomUUID()}` };
    },
  };
  return p;
}

export function noProvider(): EmailProvider {
  return {
    async send() {
      throw new EmailError('Email sending is not set up on this server yet.', true);
    },
  };
}
