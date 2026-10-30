// Delivery oracle: an LLM judge on NEAR AI Cloud scores the deliverable against the job brief.
// The verdict and its signature are stored on-chain with `tender.verdict(job_id, accept, attestation)`.
import type { Llm } from "./llm.ts";

export type Verdict = { accept: boolean; reason: string; attestation: string };

const SYSTEM =
  "You are a strict delivery judge for a jobs market. Given a job brief and a deliverable, answer only JSON " +
  '{"accept": boolean, "reason": string}. Reject empty, off-topic or placeholder deliverables.';

/** Floor applied in every mode: an empty or trivially short deliverable is never accepted. */
export function obviouslyEmpty(result: string): boolean {
  return result.replace(/\[replay [0-9a-f]+\]/, "").trim().length < 20;
}

export async function judge(llm: Llm, brief: string, result: string): Promise<Verdict> {
  const c = await llm.complete(SYSTEM, `BRIEF:\n${brief}\n\nDELIVERABLE:\n${result}`);
  let accept: boolean;
  let reason: string;
  try {
    const j = JSON.parse(c.text.match(/\{[\s\S]*\}/)?.[0] ?? "");
    accept = j.accept === true;
    reason = String(j.reason ?? "");
  } catch {
    // Replay without a recorded verdict: deterministic rule, labelled in the attestation.
    accept = !obviouslyEmpty(result);
    reason = accept ? "non-empty deliverable (replay rule)" : "empty deliverable (replay rule)";
  }
  if (obviouslyEmpty(result)) [accept, reason] = [false, "empty deliverable"];
  const attestation = JSON.stringify({ source: c.source, model: c.model, chat_id: c.chatId, accept, reason, signature: c.signature });
  return { accept, reason, attestation };
}
