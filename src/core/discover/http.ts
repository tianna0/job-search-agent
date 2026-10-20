// A small, polite HTTP helper for reading job sites:
// - waits between requests (some sites rate-limit hard),
// - retries on 429/503 with backoff,
// - stops once a request budget is spent (Cloudflare Workers cap subrequests),
//   returning null so callers can keep what they already have.

export interface HttpOptions {
  /** Minimum pause between two requests, in ms. */
  delayMs?: number;
  /** Maximum number of requests for this run (retries included). */
  maxRequests?: number;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Waits before each retry on 429/503 (a Retry-After header, up to 60 s, wins if longer). */
  backoffMs?: number[];
  /** Override for tests (skips real waiting). */
  sleep?: (ms: number) => Promise<void>;
}

export const USER_AGENT = "Mozilla/5.0 (compatible; JobTrackerAgent/0.2; personal job search)";

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Http {
  private doFetch: typeof fetch;
  private delayMs: number;
  private maxRequests: number;
  private timeoutMs: number;
  private sleep: (ms: number) => Promise<void>;
  private backoffMs: number[];
  private last = 0;
  used = 0;

  constructor(doFetch: typeof fetch, opts: HttpOptions = {}) {
    // Call fetch as a plain function: browsers and Cloudflare Workers throw
    // "Illegal invocation" when fetch is called as a method of another object.
    this.doFetch = ((input: any, init?: RequestInit) => doFetch(input, init)) as typeof fetch;
    this.delayMs = opts.delayMs ?? 0;
    this.maxRequests = opts.maxRequests ?? 200;
    this.timeoutMs = opts.timeoutMs ?? 25000;
    this.sleep = opts.sleep ?? realSleep;
    this.backoffMs = opts.backoffMs ?? [3000, 8000];
  }

  get exhausted(): boolean {
    return this.used >= this.maxRequests;
  }

  /** Change the pause for the next requests (each site has its own pace). */
  setDelay(ms: number) {
    this.delayMs = ms;
  }

  /** Returns the response, or null when the request budget is spent. Throws on network errors and non-OK status. */
  async request(url: string, init: RequestInit = {}): Promise<Response | null> {
    const backoff = this.backoffMs;
    for (let attempt = 0; ; attempt++) {
      if (this.exhausted) return null;
      const wait = this.last + this.delayMs - Date.now();
      if (this.delayMs && wait > 0) await this.sleep(wait);
      this.used++;
      this.last = Date.now();

      const headers = new Headers(init.headers);
      if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);
      if (!headers.has("accept")) headers.set("accept", "application/json, text/html;q=0.9");
      const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
        ? AbortSignal.timeout(this.timeoutMs)
        : undefined;

      const res = await this.doFetch(url, { ...init, headers, signal, redirect: "follow" });
      if ((res.status === 429 || res.status === 503) && attempt < backoff.length) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const hinted = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : 0;
        await this.sleep(Math.max(backoff[attempt], hinted));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    }
  }

  async json(url: string, init?: RequestInit): Promise<any | null> {
    const res = await this.request(url, init);
    return res ? res.json() : null;
  }

  async text(url: string, init?: RequestInit): Promise<string | null> {
    const res = await this.request(url, init);
    return res ? res.text() : null;
  }
}
