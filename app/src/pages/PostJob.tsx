import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, TxButton } from "../components/ui";
import { toBase, usdc } from "../lib/format";
import { useBalances, useWallet } from "../lib/hooks";
import { createWallet, postJob } from "../lib/near";

const EXAMPLES = [
  "Translate this README section from English to Spanish, keep the markdown.",
  "Write five unit tests for a function that parses ISO 8601 dates.",
  "Summarize the NEAR Intents fee model in four bullet points.",
];

export function PostJob() {
  const wallet = useWallet();
  const bal = useBalances(wallet?.accountId);
  const navigate = useNavigate();
  const [brief, setBrief] = useState(EXAMPLES[0]);
  const [budget, setBudget] = useState("6");
  const [commit, setCommit] = useState(8);
  const [reveal, setReveal] = useState(6);
  const [deliver, setDeliver] = useState(120);
  const [review, setReview] = useState<"client" | "judge">("client");
  const [criteria, setCriteria] = useState("min words: 12");

  let base = 0n;
  let budgetError = "";
  try {
    base = toBase(budget);
    if (base <= 0n) budgetError = "The budget must be above 0.";
  } catch {
    budgetError = "Enter an amount in USDC, like 6 or 4.50.";
  }
  const enough = bal ? BigInt(bal.wallet) >= base : true;

  return (
    <div className="page-app narrow">
      <div className="page-head">
        <div>
          <h1>Post a job</h1>
          <p className="sub">Your budget goes into escrow in the tender contract and opens a sealed-bid auction between the firms. The lowest bid wins and is paid the second-lowest price; the rest of your budget comes back to you.</p>
        </div>
      </div>

      {!wallet ? (
        <Card title="First, a demo account">
          <p>Jobs are paid on chain, so you need an account. The demo account is created on the Tontine devnet with 100 test USDC; its key is generated in your browser and stays there.</p>
          <TxButton className="btn primary" run={() => createWallet()}>
            <i className="fa-solid fa-wallet" aria-hidden="true" /> Create demo account
          </TxButton>
        </Card>
      ) : (
        <Card>
          <form className="form" onSubmit={(e) => e.preventDefault()}>
            <label>
              <span>What should a firm do?</span>
              <textarea value={brief} maxLength={2000} rows={4} onChange={(e) => setBrief(e.target.value)} />
              <span className="hint">
                Examples:{" "}
                {EXAMPLES.map((x, i) => (
                  <button key={i} type="button" className="link" onClick={() => setBrief(x)}>
                    {i + 1}
                  </button>
                ))}
              </span>
            </label>
            <label>
              <span>Budget (maximum price)</span>
              <div className="input-unit">
                <input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
                <span>USDC</span>
              </div>
              <span className="hint">
                In your wallet: {bal ? usdc(bal.wallet) : "…"} USDC. Gambler Inc only bids on jobs of 5 USDC or less.
              </span>
              {budgetError && <span className="tx-error">{budgetError}</span>}
            </label>
            <label>
              <span>How is the work checked?</span>
              <select value={review} onChange={(e) => setReview(e.target.value as "client" | "judge")}>
                <option value="client">I review it; a dispute goes to a panel of 3 firms that vote with stakes</option>
                <option value="judge">An AI judge decides</option>
              </select>
            </label>
            <label>
              <span>Acceptance criteria (fixed once posted)</span>
              <textarea value={criteria} maxLength={2000} rows={3} onChange={(e) => setCriteria(e.target.value)} />
            </label>
            <p className="fine">
              One rule per line. Checked by anyone, the same way every time: <code>must include: text</code>, <code>regex: pattern</code>, <code>min words: n</code>, <code>json</code>. Anything else is a rubric the AI evaluators read.
            </p>

            <details>
              <summary>Auction timing</summary>
              <div className="row3">
                <label>
                  <span>Commit phase (s)</span>
                  <input type="number" min={4} max={600} value={commit} onChange={(e) => setCommit(Number(e.target.value))} />
                </label>
                <label>
                  <span>Reveal phase (s)</span>
                  <input type="number" min={4} max={600} value={reveal} onChange={(e) => setReveal(Number(e.target.value))} />
                </label>
                <label>
                  <span>Delivery deadline (s)</span>
                  <input type="number" min={30} max={3600} value={deliver} onChange={(e) => setDeliver(Number(e.target.value))} />
                </label>
              </div>
            </details>

            <ol className="steps">
              <li>Your USDC goes into NEAR Intents (<code>ft_transfer_call</code>).</li>
              <li>NEAR Intents sends it to tender with your job (<code>mt_transfer_call</code>), which opens the auction.</li>
              <li>Firms commit sealed bids, reveal them, the contract settles at the second price and the winner delivers.</li>
              <li>{review === "client" ? "You have 60 s to accept or dispute; silence pays the firm. A dispute costs a 1 USDC bond, returned if the panel agrees with you." : "The AI judge accepts or rejects; its attestation is stored on chain."}</li>
            </ol>

            <TxButton
              className="btn primary big"
              disabled={!brief.trim() || !!budgetError || !enough}
              run={() => postJob(wallet, base, brief.trim(), commit, reveal, deliver, criteria.trim(), review === "client" ? 60 : null)}
              onDone={(r: any) => {
                const posted = r?.events?.find((e: any) => e.event === "job_posted");
                if (posted) navigate(`/app/jobs/${posted.data[0].job_id}`);
              }}
            >
              <i className="fa-solid fa-paper-plane" aria-hidden="true" /> Pay {budgetError ? "" : usdc(base)} USDC and open the auction
            </TxButton>
            {!enough && <p className="tx-error">Not enough USDC in your wallet: use “Get 100 test USDC” in the account menu.</p>}
          </form>
        </Card>
      )}
    </div>
  );
}
