// Per-browser collaboration session (stream T8, r2-platform.md §4): display name, clientId, optional LAN shared secret,
// lock tokens and the base revision of each project. No imports — api.ts depends on this module (no import cycle).

const NAME_KEY = 'aidc:displayName';
const CLIENT_KEY = 'aidc:clientId';
const SECRET_KEY = 'aidc:sharedSecret';
const TOKENS_KEY = 'aidc:lockTokens'; // sessionStorage (per tab)

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

function randomId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID().replace(/-/g, '');
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

function loadClientId(): string {
  const existing = safe(() => localStorage.getItem(CLIENT_KEY), null);
  if (existing && /^[A-Za-z0-9_-]{8,80}$/.test(existing)) return existing;
  const id = randomId();
  safe(() => localStorage.setItem(CLIENT_KEY, id), undefined);
  return id;
}

export const session = {
  clientId: loadClientId(),
  displayName: safe(() => localStorage.getItem(NAME_KEY), null) as string | null,
  secret: safe(() => localStorage.getItem(SECRET_KEY), null) as string | null,
  /** projectId → updatedAt of the server copy this browser last loaded or saved (sent as If-Match) */
  baseRev: {} as Record<string, string>,
  lockTokens: safe(() => JSON.parse(sessionStorage.getItem(TOKENS_KEY) ?? '{}') as Record<string, string>, {}),
  /** set by the collab module: asks the user for the shared secret (returns null when cancelled) */
  requestSecret: null as null | (() => string | null),
};

export function setDisplayName(name: string | null): void {
  const clean = name?.trim().slice(0, 60) || null;
  session.displayName = clean;
  safe(() => (clean ? localStorage.setItem(NAME_KEY, clean) : localStorage.removeItem(NAME_KEY)), undefined);
}

export function setSharedSecret(secret: string | null): void {
  session.secret = secret || null;
  safe(() => (secret ? localStorage.setItem(SECRET_KEY, secret) : localStorage.removeItem(SECRET_KEY)), undefined);
}

export function setLockToken(projectId: string, token: string | null): void {
  if (token) session.lockTokens[projectId] = token;
  else delete session.lockTokens[projectId];
  safe(() => sessionStorage.setItem(TOKENS_KEY, JSON.stringify(session.lockTokens)), undefined);
}

export function recordRev(p: { id?: string; updatedAt?: string } | null | undefined): void {
  if (p?.id && typeof p.updatedAt === 'string') session.baseRev[p.id] = p.updatedAt;
}

/** Headers for every API call: shared secret + display name. */
export function commonHeaders(): Record<string, string> {
  return {
    ...(session.secret ? { 'x-aidc-secret': session.secret } : {}),
    ...(session.displayName ? { 'x-aidc-user': encodeURIComponent(session.displayName) } : {}),
  };
}

/** Headers for a project save: base revision (If-Match) + lock token. */
export function saveHeaders(projectId: string): Record<string, string> {
  const rev = session.baseRev[projectId];
  const token = session.lockTokens[projectId];
  return { ...(rev ? { 'if-match': `"${rev}"` } : {}), ...(token ? { 'x-aidc-lock': token } : {}) };
}
