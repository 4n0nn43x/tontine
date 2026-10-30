// NEAR AI Cloud client (OpenAI-compatible) with a replay mode so `make demo` needs no key and no network.
//
// Live: NEARAI_API_KEY set. Each completion fetches its TEE signature from /v1/signature/{chat_id}.
// Replay: answers come from fixtures/llm.json, keyed by sha256(model + system + user). RECORD=1 with a key
// appends live answers to the fixture file.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Completion = {
  text: string;
  chatId: string;
  model: string;
  /** Signature payload from /v1/signature, null in replay without a recorded one. */
  signature: unknown | null;
  source: "near-ai-cloud" | "replay";
};

export interface Llm {
  complete(system: string, user: string): Promise<Completion>;
}

const BASE = process.env.NEARAI_BASE_URL ?? "https://cloud-api.near.ai/v1";
const MODEL = process.env.NEARAI_MODEL ?? "openai/gpt-oss-120b";
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "llm.json");

const key = (system: string, user: string) => createHash("sha256").update(`${MODEL}\n${system}\n${user}`).digest("hex");

function loadFixtures(): Record<string, Completion> {
  return existsSync(FIXTURES) ? JSON.parse(readFileSync(FIXTURES, "utf8")) : {};
}

export class NearAiCloud implements Llm {
  constructor(private apiKey: string, private record = process.env.RECORD === "1") {}

  async complete(system: string, user: string): Promise<Completion> {
    const r = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    });
    if (!r.ok) throw new Error(`NEAR AI Cloud ${r.status}: ${await r.text()}`);
    const j: any = await r.json();
    const out: Completion = { text: j.choices[0].message.content ?? "", chatId: j.id, model: MODEL, signature: await this.signature(j.id), source: "near-ai-cloud" };
    if (this.record) {
      const all = loadFixtures();
      all[key(system, user)] = { ...out, source: "replay" };
      writeFileSync(FIXTURES, JSON.stringify(all, null, 2) + "\n");
    }
    return out;
  }

  /** The signature can lag the completion: 404 is retried for a short, bounded time. */
  private async signature(chatId: string): Promise<unknown | null> {
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${BASE}/signature/${chatId}?model=${encodeURIComponent(MODEL)}&signing_algo=ecdsa`, {
        headers: { Accept: "application/json", Authorization: `Bearer ${this.apiKey}` },
      });
      if (r.ok) {
        const j: any = await r.json();
        return j.error_code ? null : j;
      }
      if (r.status !== 404) return null;
      await new Promise((res) => setTimeout(res, 1000));
    }
    return null;
  }
}

export class Replay implements Llm {
  private fx = loadFixtures();

  async complete(system: string, user: string): Promise<Completion> {
    const hit = this.fx[key(system, user)];
    if (hit) return hit;
    // No recording: a deterministic, clearly labelled stand-in.
    const id = key(system, user).slice(0, 16);
    return { text: `[replay ${id}] ${user.slice(0, 400)}`, chatId: `replay-${id}`, model: MODEL, signature: null, source: "replay" };
  }
}

export function makeLlm(): Llm {
  return process.env.NEARAI_API_KEY && process.env.REPLAY !== "1" ? new NearAiCloud(process.env.NEARAI_API_KEY) : new Replay();
}
