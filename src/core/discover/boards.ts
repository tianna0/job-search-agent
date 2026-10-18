// Readers for the public job-board APIs of Greenhouse, Lever and Ashby.
// Each returns the same normalized shape.
import { htmlToText } from "../jobpage.ts";
import { firstDate } from "./posted.ts";

export type Ats = "greenhouse" | "lever" | "ashby";

export interface RawJob {
  externalId: string;
  title: string;
  location: string;
  url: string;
  description: string; // plain text
  /** When the job was posted (ISO), if the board says. */
  postedAt?: string;
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

async function getJson(doFetch: typeof fetch, url: string): Promise<any> {
  const res = await doFetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function listGreenhouse(slug: string, doFetch: typeof fetch): Promise<RawJob[]> {
  const data = await getJson(
    doFetch,
    `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`
  );
  return (data.jobs ?? []).map((j: any) => ({
    externalId: String(j.id),
    title: String(j.title ?? ""),
    location: String(j.location?.name ?? ""),
    url: String(j.absolute_url ?? ""),
    description: htmlToText(decodeEntities(String(j.content ?? ""))),
    // updated_at changes on every edit, so only the first publish date counts.
    postedAt: firstDate(j.first_published),
  }));
}

export async function listLever(slug: string, doFetch: typeof fetch): Promise<RawJob[]> {
  const data = await getJson(doFetch, `https://api.lever.co/v0/postings/${slug}?mode=json`);
  return (Array.isArray(data) ? data : []).map((j: any) => ({
    externalId: String(j.id),
    title: String(j.text ?? ""),
    location: String(j.categories?.location ?? ""),
    url: String(j.hostedUrl ?? ""),
    description: String(j.descriptionPlain ?? "") +
      (Array.isArray(j.lists)
        ? "\n" + j.lists.map((l: any) => `${l.text}\n${htmlToText(String(l.content ?? ""))}`).join("\n")
        : ""),
    postedAt: firstDate(j.createdAt),
  }));
}

export async function listAshby(slug: string, doFetch: typeof fetch): Promise<RawJob[]> {
  const data = await getJson(
    doFetch,
    `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=false`
  );
  return (data.jobs ?? [])
    .filter((j: any) => j.isListed !== false)
    .map((j: any) => ({
      externalId: String(j.id),
      title: String(j.title ?? ""),
      location: String(j.location ?? ""),
      url: String(j.jobUrl ?? ""),
      description: String(j.descriptionPlain ?? htmlToText(String(j.descriptionHtml ?? ""))),
      postedAt: firstDate(j.publishedAt, j.publishedDate),
    }));
}

export function listJobs(ats: Ats, slug: string, doFetch: typeof fetch): Promise<RawJob[]> {
  if (ats === "greenhouse") return listGreenhouse(slug, doFetch);
  if (ats === "lever") return listLever(slug, doFetch);
  return listAshby(slug, doFetch);
}
