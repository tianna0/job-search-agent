// The body of the Cloudflare Workflow that drafts follow-up emails, kept free of
// Cloudflare imports so it can be tested with a fake step runner.
//
// Each application is its own durable step, so a failed model call is retried
// on its own without redoing the others. The work is mostly waiting on Workers AI,
// which fits the free plan's 10 ms CPU per step.

type Duration = string | number;
export interface StepConfig {
  retries?: { limit: number; delay: Duration; backoff?: "constant" | "linear" | "exponential" };
  timeout?: Duration;
}

/** The part of Cloudflare's WorkflowStep this code uses. */
export interface StepRunner {
  do<T>(name: string, config: StepConfig, callback: () => Promise<T>): Promise<T>;
}

/** The Agent methods the Workflow calls (over RPC on Cloudflare). */
export interface FollowUpAgentApi {
  staleApplicationIds(): Promise<string[]>;
  draftFollowUp(id: string): Promise<unknown>;
  followUpsDone(drafted: number): Promise<void>;
}

const AGENT_CALL: StepConfig = { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } };
const DRAFT_STEP: StepConfig = { retries: { limit: 2, delay: "1 minute", backoff: "exponential" }, timeout: "5 minutes" };

export async function runFollowUpSteps(
  step: StepRunner,
  agent: () => Promise<FollowUpAgentApi>
): Promise<{ checked: number; drafted: number; failed: string[] }> {
  const ids = await step.do("find stale applications", AGENT_CALL, async () => (await agent()).staleApplicationIds());

  let drafted = 0;
  const failed: string[] = [];
  for (const id of ids) {
    try {
      await step.do(`draft follow-up ${id}`, DRAFT_STEP, async () => {
        await (await agent()).draftFollowUp(id);
        return true;
      });
      drafted++;
    } catch (err) {
      // Retries are used up; leave this one for tomorrow's run.
      console.error(`follow-up ${id} failed:`, err);
      failed.push(id);
    }
  }

  await step.do("finish", AGENT_CALL, async () => {
    await (await agent()).followUpsDone(drafted);
    return true;
  });
  return { checked: ids.length, drafted, failed };
}
