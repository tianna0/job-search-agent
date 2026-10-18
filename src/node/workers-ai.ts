// Workers AI over its REST API, for the local version (the deployed Worker uses
// its AI binding instead). Needs CF_ACCOUNT_ID and CF_API_TOKEN in .env.
import { HttpError, llmText } from "../core/util.ts";
import { MODEL, type LLM } from "../core/types.ts";
import type { Embed } from "../core/rank.ts";

export const EMBED_MODEL = "@cf/baai/bge-base-en-v1.5";
const EMBED_BATCH = 50;

async function run(model: string, body: unknown): Promise<any> {
  const accountId = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_API_TOKEN;
  if (!accountId || !token) {
    throw new HttpError(500, "Set CF_ACCOUNT_ID and CF_API_TOKEN in the .env file (see .env.example).");
  }
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || data.success === false) {
    const reason = data?.errors?.[0]?.message ?? `HTTP ${res.status}`;
    throw new HttpError(502, `Workers AI error: ${reason}`);
  }
  return data.result;
}

/** Llama 3.3 on Workers AI. */
export const workersAi: LLM = {
  async complete(system, user) {
    const result = await run(MODEL, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: 1200,
    });
    return llmText(result?.response);
  },
};

/** bge-base-en-v1.5 embeddings, in batches. */
export const workersAiEmbed: Embed = async (texts) => {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const result = await run(EMBED_MODEL, { text: texts.slice(i, i + EMBED_BATCH) });
    const data = result?.data;
    if (!Array.isArray(data)) throw new Error("Unexpected embedding response.");
    out.push(...data);
  }
  return out;
};
