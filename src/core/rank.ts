// Ranks jobs by how well they match the resume.
//   1. Embeddings: resume and each job become vectors (bge-base-en-v1.5 on Workers AI);
//      the score is their cosine similarity. Cheap, so every new job gets one.
//   2. For the top few, Llama 3.3 writes a one-line reason and the main gap.
import type { DiscoveredJob } from "./discover/discover.ts";
import type { LLM } from "./types.ts";

export type Embed = (texts: string[]) => Promise<number[][]>;

export interface FitNote {
  fit: number; // 0-100, the model's own estimate
  why: string;
  gap: string;
}

export interface Ranking {
  /** job id -> similarity score, 0-100 */
  scores: Record<string, number>;
  /** job id -> note, for the top jobs only */
  notes: Record<string, FitNote>;
}

// The embedding model reads at most 512 tokens (roughly 2,000 characters of English).
const CHUNK_CHARS = 1800;
const MAX_RESUME_CHUNKS = 4;

/** Splits text into pieces on paragraph or line breaks, each under `max` characters. */
export function chunkText(text: string, max = CHUNK_CHARS): string[] {
  const parts = text.split(/\n\s*\n|\n/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  for (const p of parts) {
    const piece = p.length > max ? p.slice(0, max) : p;
    if (cur && cur.length + piece.length + 1 > max) {
      chunks.push(cur);
      cur = "";
    }
    cur = cur ? `${cur}\n${piece}` : piece;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Average of unit-length vectors (one vector for a multi-chunk resume). */
export function meanVector(vectors: number[][]): number[] {
  const out = new Array(vectors[0].length).fill(0);
  for (const v of vectors) {
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    for (let i = 0; i < v.length; i++) out[i] += v[i] / n;
  }
  return out.map((x) => x / vectors.length);
}

/** What gets embedded for a job: title, then the start of the description. */
export function jobText(job: DiscoveredJob): string {
  return `${job.title} at ${job.companyName}\n${job.description ?? job.reasons.join("; ")}`.slice(0, CHUNK_CHARS);
}

export function parseFitNote(reply: string): FitNote | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    const p = JSON.parse(reply.slice(start, end + 1));
    const why = String(p.why ?? "").trim();
    if (!why) return null;
    return {
      fit: Math.max(0, Math.min(100, Math.round(Number(p.fit) || 0))),
      why: why.slice(0, 300),
      gap: String(p.gap ?? "").trim().slice(0, 300),
    };
  } catch {
    return null;
  }
}

const NOTE_SYSTEM =
  "You are a candid career coach. Compare the resume with the job. Reply with ONLY a JSON object: " +
  '{"fit": number 0-100, "why": "one sentence on the strongest match", "gap": "one sentence on the biggest gap"}. ' +
  "Use only facts from the resume and the job text.";

export async function rankJobs(
  resume: string,
  jobs: DiscoveredJob[],
  embed: Embed,
  llm: LLM | null,
  topN = 8
): Promise<Ranking> {
  const scores: Record<string, number> = {};
  const notes: Record<string, FitNote> = {};
  if (!jobs.length) return { scores, notes };

  const resumeChunks = chunkText(resume).slice(0, MAX_RESUME_CHUNKS);
  if (!resumeChunks.length) throw new Error("The resume is empty.");
  const vectors = await embed([...resumeChunks, ...jobs.map(jobText)]);
  if (vectors.length !== resumeChunks.length + jobs.length) throw new Error("The embedding service returned the wrong number of vectors.");
  const resumeVec = meanVector(vectors.slice(0, resumeChunks.length));
  jobs.forEach((j, i) => {
    scores[j.id] = Math.round(Math.max(0, cosine(resumeVec, vectors[resumeChunks.length + i])) * 100);
  });

  if (llm && topN > 0) {
    const top = [...jobs].sort((a, b) => scores[b.id] - scores[a.id]).slice(0, topN);
    for (const j of top) {
      try {
        const reply = await llm.complete(
          NOTE_SYSTEM,
          `RESUME:\n${resume.slice(0, 6000)}\n\nJOB: ${j.title} at ${j.companyName} (${j.location})\n${(j.description ?? "").slice(0, 4000)}`
        );
        const note = parseFitNote(reply);
        if (note) notes[j.id] = note;
      } catch {
        /* a missing note is fine; the job keeps its score */
      }
    }
  }
  return { scores, notes };
}
