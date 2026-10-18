// Verifies the Cloudflare Access login token on every API request.
//
// Cloudflare Access (enabled in the dashboard) makes visitors sign in and then
// adds a signed JWT to each request in the Cf-Access-Jwt-Assertion header.
// Checking it here means the API stays closed even if a URL is reached without
// going through Access (for example a preview URL). Uses WebCrypto only, so it
// runs in Workers and in Node tests.

export interface AccessEnv {
  TEAM_DOMAIN?: string; // e.g. https://myteam.cloudflareaccess.com
  POLICY_AUD?: string; // the Access application's AUD tag
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

const KEY_CACHE_MS = 60 * 60 * 1000;
let keyCache: { url: string; keys: Jwk[]; at: number } | null = null;

/** For tests. */
export function clearAccessKeyCache() {
  keyCache = null;
}

/** Accepts "myteam", "myteam.cloudflareaccess.com" or the full https URL. */
export function normalizeTeamDomain(team: string): string {
  let t = team.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(t)) t = `https://${t}`;
  const host = new URL(t).host;
  return `https://${host.includes(".") ? host : `${host}.cloudflareaccess.com`}`;
}

function b64urlBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(s: string): any {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
}

async function signingKeys(team: string, doFetch: typeof fetch, now: number, kid: string): Promise<Jwk[]> {
  const url = `${team}/cdn-cgi/access/certs`;
  const fresh = keyCache && keyCache.url === url && now - keyCache.at < KEY_CACHE_MS;
  // Refetch when the cache is old or doesn't know this key (keys rotate about every 6 weeks).
  if (!fresh || !keyCache!.keys.some((k) => k.kid === kid)) {
    const res = await doFetch(url);
    if (!res.ok) throw new Error(`could not load Access keys (HTTP ${res.status})`);
    const body = (await res.json()) as { keys?: Jwk[] };
    keyCache = { url, keys: body.keys ?? [], at: now };
  }
  return keyCache!.keys;
}

export async function verifyAccessJwt(
  token: string,
  cfg: { teamDomain: string; aud: string },
  doFetch: typeof fetch = fetch,
  now = Date.now()
): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const header = b64urlJson(parts[0]);
  const payload = b64urlJson(parts[1]);
  if (header.alg !== "RS256") throw new Error("unexpected algorithm");

  const team = normalizeTeamDomain(cfg.teamDomain);
  const jwk = (await signingKeys(team, (u, i) => doFetch(u, i), now, header.kid)).find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("unknown signing key");
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  if (!valid) throw new Error("bad signature");

  if (payload.iss !== team) throw new Error("wrong issuer");
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(cfg.aud)) throw new Error("wrong audience");
  const nowSec = now / 1000;
  if (typeof payload.exp !== "number" || payload.exp < nowSec - 60) throw new Error("expired");
  if (typeof payload.nbf === "number" && payload.nbf > nowSec + 60) throw new Error("not valid yet");
  return payload;
}

const deny = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });

/** Returns a response to send back when the request isn't allowed, or null to let it through. */
export async function checkAccess(request: Request, env: AccessEnv, doFetch: typeof fetch = fetch): Promise<Response | null> {
  const team = env.TEAM_DOMAIN?.trim();
  const aud = env.POLICY_AUD?.trim();
  if (!team && !aud) return null; // Access not set up: the app is public.
  if (!team || !aud) return deny(500, "Access is half set up: set both TEAM_DOMAIN and POLICY_AUD.");

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return deny(403, "Sign-in required. Reload the page to sign in.");
  try {
    await verifyAccessJwt(token, { teamDomain: team, aud }, doFetch);
    return null;
  } catch (err) {
    console.warn("Access check failed:", (err as Error).message);
    return deny(403, "Your sign-in couldn't be verified. Reload the page to sign in again.");
  }
}
