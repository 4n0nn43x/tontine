// Claude (Anthropic API) as the managers' LLM until NEAR AI Cloud is wired in: used when ANTHROPIC_API_KEY is
// set and NEARAI_API_KEY is not (llm.ts, makeLlm). ANTHROPIC_MODEL picks the model.
import Anthropic from "@anthropic-ai/sdk";
import type { Completion, Llm } from "./llm.ts";

export const CLAUDE_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";

export class Claude implements Llm {
  private client = new Anthropic(); // reads ANTHROPIC_API_KEY

  async complete(system: string, user: string): Promise<Completion> {
    const r = await this.client.beta.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      system,
      messages: [{ role: "user", content: user }],
      // A small JSON decision: low effort is enough.
      output_config: { effort: "low" },
      // On a safety decline, the API retries on the model Anthropic recommends for that category.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (r.stop_reason === "refusal") throw new Error(`Claude declined (${r.stop_details?.category ?? "no category"})`);
    const text = r.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    return { text, chatId: r.id, model: r.model, signature: null, source: "anthropic" };
  }
}
