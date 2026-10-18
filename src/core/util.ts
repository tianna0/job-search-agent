export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Workers AI sometimes returns an already-parsed object instead of a string
 * when the model's answer is valid JSON. Normalize both to a string.
 */
export function llmText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value);
}

/** Pull the first JSON object out of an LLM reply. */
export function extractJson(text: string): any {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const fail = () => {
    console.error("Could not parse model reply as JSON. Raw reply:\n" + text.slice(0, 1500));
    return new HttpError(502, "The model returned an unexpected answer. Try again.");
  };
  if (start === -1 || end <= start) throw fail();
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw fail();
  }
}
