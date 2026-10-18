// Small checks for the public demo, kept separate so they can be tested in Node.

/** The Agent instance that holds the shared job list. Visitors can't reach it directly. */
export const CATALOG = "catalog";

export function isDemo(env: { DEMO_MODE?: string }): boolean {
  return env.DEMO_MODE === "1" || env.DEMO_MODE === "true";
}

/** Visitor ids are random UUIDs made by the page. Anything else (catalog, default, junk) is refused. */
export function isValidVisitorId(id: string): boolean {
  return /^v-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Only you can push jobs into the demo: Authorization: Bearer <DEMO_PUSH_TOKEN>. */
export function checkPushToken(request: Request, secret: string | undefined): Response | null {
  const deny = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json" } });
  if (!secret || secret.length < 16) return deny(503, "Set a DEMO_PUSH_TOKEN secret (16+ characters) first.");
  const got = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  return sameText(got, secret) ? null : deny(401, "Wrong push token.");
}
