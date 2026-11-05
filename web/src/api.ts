export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

export async function api<T>(method: 'GET' | 'POST' | 'PATCH', url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    // A 401 anywhere else than the login form means the session ended.
    if (res.status === 401 && url !== '/api/login') onUnauthorized();
    throw new ApiError(res.status, data.error ?? 'request_failed');
  }
  return data as T;
}

const MESSAGES: Record<string, string> = {
  invalid_credentials: 'That email and password do not match.',
  read_only: 'You have read-only access to this band, so you cannot make changes.',
  not_a_member: 'You are not a member of that band.',
  no_active_tenant: 'Choose a band first.',
  unknown_contact_or_venue: 'That contact or venue is not in this band.',
  postponed_needs_confirmed: 'Only a confirmed gig can be marked as postponed.',
  email_exists: 'A contact with that email already exists in this band.',
  invalid_request: 'Some details are not valid. Check the fields and try again.',
  bad_origin: 'This request was blocked. Reload the page and try again.',
  not_found: 'That record no longer exists. Reload the page.',
  template_name_exists: 'You already have a template with that name.',
  needs_contact_or_gig: 'Choose a contact or a gig to log this against.',
  unknown_contact_or_gig: 'That contact or gig is not in this band.',
  only_tasks_have_due_date: 'Only a to-do can have a due date.',
};

export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 429) return 'Too many attempts. Wait a minute and try again.';
    return MESSAGES[err.code] ?? 'Something went wrong. Try again.';
  }
  return 'Could not reach the server. Check your connection and try again.';
}
