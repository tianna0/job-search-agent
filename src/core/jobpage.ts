import { HttpError } from "./util.ts";

export const MAX_TEXT_CHARS = 12000;
const MIN_JOB_TEXT_CHARS = 300;

export function htmlToText(html: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  const body = html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  return title ? `Page title: ${title}\n${body}` : body;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * Greenhouse job pages are rendered with JavaScript, but Greenhouse exposes
 * the posting through a public JSON API.
 */
async function fetchGreenhouse(
  parsed: URL,
  doFetch: typeof fetch
): Promise<string | null> {
  if (!/(^|\.)greenhouse\.io$/i.test(parsed.hostname)) return null;
  const m = parsed.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/);
  if (!m) return null;
  try {
    const res = await doFetch(
      `https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${m[2]}`,
      { headers: { accept: "application/json" } }
    );
    if (!res.ok) return null;
    const job: any = await res.json();
    if (!job?.title || !job?.content) return null;
    const body = htmlToText(decodeEntities(String(job.content)));
    const parts = [
      `Page title: ${job.title}`,
      job.company_name ? `Company: ${job.company_name}` : `Company board: ${m[1]}`,
      job.location?.name ? `Location: ${job.location.name}` : "",
      body,
    ];
    return parts.filter(Boolean).join("\n").slice(0, MAX_TEXT_CHARS);
  } catch {
    return null;
  }
}

/** Download a job posting and return its readable text. */
export async function fetchJobPage(
  rawUrl: string,
  doFetch: typeof fetch = fetch
): Promise<{ url: string; text: string }> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new HttpError(400, "Enter a valid job link, including https://");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new HttpError(400, "Only http(s) links are supported.");
  }

  const gh = await fetchGreenhouse(parsed, doFetch);
  if (gh && gh.length >= MIN_JOB_TEXT_CHARS) {
    return { url: parsed.toString(), text: gh };
  }

  let res: Response;
  try {
    res = await doFetch(parsed.toString(), {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; JobTrackerAgent/0.1)",
        accept: "text/html,application/xhtml+xml,text/plain",
      },
      redirect: "follow",
    });
  } catch {
    throw new HttpError(422, "Couldn't reach that link.");
  }
  if (!res.ok) {
    throw new HttpError(
      422,
      `Couldn't open the page (HTTP ${res.status}). Some job sites block automated access.`
    );
  }

  const raw = await res.text();
  const isHtml = (res.headers.get("content-type") ?? "").includes("html");
  const text = (isHtml ? htmlToText(raw) : raw.trim()).slice(0, MAX_TEXT_CHARS);
  if (text.length < MIN_JOB_TEXT_CHARS) {
    throw new HttpError(
      422,
      "Couldn't read enough text from that page. It may require a login or load its content with JavaScript."
    );
  }
  return { url: parsed.toString(), text };
}
