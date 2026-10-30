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

/** Deterministic checks a client can write in its criteria, one per line: "must include: <text>",
 * "regex: <pattern>", "min words: <n>", "json". Anyone can rerun them; null when the criteria hold none.
 * ponytail: a client pattern runs in the evaluator (bounded to 200 chars, result to 4000); sandbox it if
 * evaluators ever run unattended on hostile criteria. */
export function checkCriteria(criteria: string, result: string): { ok: boolean; reason: string } | null {
  let any = false;
  for (const line of criteria.split("\n")) {
    const m = line.trim().match(/^(must include|regex|min words|json)\s*:?\s*(.*)$/i);
    if (!m) continue;
    any = true;
    const [kind, arg] = [m[1].toLowerCase(), m[2].trim()];
    if (kind === "must include" && !result.toLowerCase().includes(arg.toLowerCase())) return { ok: false, reason: `missing "${arg}"` };
    if (kind === "regex" && arg.length <= 200) {
      let re: RegExp | null = null;
      try {
        re = new RegExp(arg, "m");
      } catch {
        // An invalid pattern checks nothing.
      }
      if (re && !re.test(result.slice(0, 4000))) return { ok: false, reason: `does not match /${arg}/` };
    }
    if (kind === "min words" && result.trim().split(/\s+/).length < Number(arg)) return { ok: false, reason: `fewer than ${arg} words` };
    if (kind === "json") {
      try {
        JSON.parse(result);
      } catch {
        return { ok: false, reason: "not valid JSON" };
      }
    }
  }
  return any ? { ok: true, reason: "every criteria check passes" } : null;
}

/** An evaluator's vote on a disputed delivery: empty fails, deterministic criteria decide when the
 * client wrote some, otherwise the LLM judge reads the brief with the criteria. */
export async function evaluate(llm: Llm, brief: string, criteria: string, result: string): Promise<Verdict> {
  if (obviouslyEmpty(result)) return { accept: false, reason: "empty deliverable", attestation: JSON.stringify({ source: "rule", reason: "empty" }) };
  const c = checkCriteria(criteria, result);
  if (c) return { accept: c.ok, reason: c.reason, attestation: JSON.stringify({ source: "criteria", ...c }) };
  return judge(llm, criteria ? `${brief}\n\nACCEPTANCE CRITERIA:\n${criteria}` : brief, result);
}
