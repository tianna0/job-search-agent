import type { DiscoveredJob } from "./discover/discover.ts";

export const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export type Status =
  | "saved"
  | "applied"
  | "interviewing"
  | "offer"
  | "rejected";

export const STATUSES: Status[] = [
  "saved",
  "applied",
  "interviewing",
  "offer",
  "rejected",
];

export interface Application {
  id: string;
  url: string;
  company: string;
  title: string;
  status: Status;
  fitScore: number; // 0-100
  strengths: string[];
  gaps: string[];
  coverLetter: string;
  createdAt: string;
  updatedAt: string;
  /** Drafted when an application sits in "applied" with no news for a while. */
  followUp?: { text: string; draftedAt: string };
  /** Pre-filled example in the public demo, not a real analysis. */
  sample?: boolean;
}

/** Progress of a scan across all companies (run by a Workflow on Cloudflare, in-process locally). */
export interface ScanState {
  id: string;
  trigger: "manual" | "chat" | "cron";
  startedAt: string;
  finishedAt?: string;
  companies: string[];
  done: string[];
  failed: { company: string; error: string }[];
  matched: number;
  newJobs: number;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  at: string;
}

export interface TrackerState {
  resumeName: string;
  resume: string; // text extracted from the uploaded PDF
  applications: Application[];
  discovered: DiscoveredJob[];
  /** company id -> ISO time of the last successful discovery run */
  lastDiscovery: Record<string, string>;
  scan: ScanState | null;
  chat: ChatMessage[];
  /** Last time stale applications were checked for follow-ups. */
  followUps: { lastRunAt: string; drafted: number } | null;
  /** Demo only: when this visitor's copy was filled with sample data. */
  demoSeededAt: string | null;
  /** Demo only: AI calls used today, for the per-visitor daily cap. */
  aiUsage: { day: string; calls: number } | null;
}

export function emptyState(): TrackerState {
  return {
    resumeName: "",
    resume: "",
    applications: [],
    discovered: [],
    lastDiscovery: {},
    scan: null,
    chat: [],
    followUps: null,
    demoSeededAt: null,
    aiUsage: null,
  };
}

/** State saved by an older version may lack newer fields. */
export function withDefaults(s: Partial<TrackerState> | undefined): TrackerState {
  const d = emptyState();
  return {
    resumeName: s?.resumeName ?? d.resumeName,
    resume: s?.resume ?? d.resume,
    applications: s?.applications ?? d.applications,
    discovered: s?.discovered ?? d.discovered,
    lastDiscovery: s?.lastDiscovery ?? d.lastDiscovery,
    scan: s?.scan ?? d.scan,
    chat: s?.chat ?? d.chat,
    followUps: s?.followUps ?? d.followUps,
    demoSeededAt: s?.demoSeededAt ?? d.demoSeededAt,
    aiUsage: s?.aiUsage ?? d.aiUsage,
  };
}

/** Anything that can answer a prompt. */
export interface LLM {
  complete(system: string, user: string): Promise<string>;
}

/** Anything that can turn PDF bytes into plain text. */
export interface PdfReader {
  toText(bytes: ArrayBuffer): Promise<string>;
}

/** Where the tracker keeps its state. */
export interface Store {
  get(): TrackerState | Promise<TrackerState>;
  set(next: TrackerState): void | Promise<void>;
}

export interface Deps {
  llm: LLM;
  pdf: PdfReader;
  store: Store;
  /** Override for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Limits for one company's discovery run. Cloudflare Workers need a low request limit. */
  discover?: { maxRequests?: number; maxDetails?: number; sleep?: (ms: number) => Promise<void> };
  /**
   * Starts a scan of every readable company in the background and returns its id.
   * Only the local server provides this: scanning needs more CPU than the
   * Cloudflare free plan allows.
   */
  startScan?: (trigger: ScanState["trigger"]) => Promise<{ id: string }>;
  /**
   * Starts drafting follow-ups in the background (a Workflow on Cloudflare).
   * Without it, follow-ups are drafted inline.
   */
  startFollowUps?: () => Promise<{ id: string }>;
  /** Public demo: most AI calls one visitor can make per day. */
  aiDailyLimit?: number;
  /** Public demo: the shared job snapshot each visitor's copy starts from. */
  demoSnapshot?: () => Promise<CatalogSnapshot>;
}

/** Found jobs shared with every demo visitor (pushed from a local scan). */
export interface CatalogSnapshot {
  discovered: DiscoveredJob[];
  lastDiscovery: Record<string, string>;
}

/** An "applied" application with no change for this long gets a follow-up draft. */
export const FOLLOW_UP_AFTER_DAYS = 14;
