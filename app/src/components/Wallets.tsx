import { useState, type ReactNode } from "react";
import { CHAINS, connectWallet, detected, type Chain } from "../lib/near";
import { TxButton } from "./ui";

// Logos, inlined: Solana, TON and Stellar from Simple Icons 16.36.0, Tron from cryptocurrency-icons 0.18.1
// (both CC0-1.0). The marks belong to their owners; they name the wallets that work here.
const LOGO: Partial<Record<Chain, ReactNode>> = {
  solana: (
    <svg viewBox="0 0 24 24">
      <defs>
        <linearGradient id="sol-grad" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#9945ff" />
          <stop offset="1" stopColor="#14f195" />
        </linearGradient>
      </defs>
      <path fill="url(#sol-grad)" d="m23.8764 18.0313-3.962 4.1393a.9201.9201 0 0 1-.306.2106.9407.9407 0 0 1-.367.0742H.4599a.4689.4689 0 0 1-.2522-.0733.4513.4513 0 0 1-.1696-.1962.4375.4375 0 0 1-.0314-.2545.4438.4438 0 0 1 .117-.2298l3.9649-4.1393a.92.92 0 0 1 .3052-.2102.9407.9407 0 0 1 .3658-.0746H23.54a.4692.4692 0 0 1 .2523.0734.4531.4531 0 0 1 .1697.196.438.438 0 0 1 .0313.2547.4442.4442 0 0 1-.1169.2297zm-3.962-8.3355a.9202.9202 0 0 0-.306-.2106.941.941 0 0 0-.367-.0742H.4599a.4687.4687 0 0 0-.2522.0734.4513.4513 0 0 0-.1696.1961.4376.4376 0 0 0-.0314.2546.444.444 0 0 0 .117.2297l3.9649 4.1394a.9204.9204 0 0 0 .3052.2102c.1154.049.24.0744.3658.0746H23.54a.469.469 0 0 0 .2523-.0734.453.453 0 0 0 .1697-.1961.4382.4382 0 0 0 .0313-.2546.4444.4444 0 0 0-.1169-.2297zM.46 6.7225h18.7815a.9411.9411 0 0 0 .367-.0742.9202.9202 0 0 0 .306-.2106l3.962-4.1394a.4442.4442 0 0 0 .117-.2297.4378.4378 0 0 0-.0314-.2546.453.453 0 0 0-.1697-.196.469.469 0 0 0-.2523-.0734H4.7596a.941.941 0 0 0-.3658.0745.9203.9203 0 0 0-.3052.2102L.1246 5.9687a.4438.4438 0 0 0-.1169.2295.4375.4375 0 0 0 .0312.2544.4512.4512 0 0 0 .1692.196.4689.4689 0 0 0 .2518.0739z" />
    </svg>
  ),
  tron: (
    <svg viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="16" fill="#ef0027" />
      <path transform="translate(6.9 6.45)" fill="#fff" d="M14.432 2.663L0 .007 7.595 19.12 18.178 6.225l-3.746-3.562zm-.232 1.17l2.208 2.099-6.038 1.093 3.83-3.192zM9.058 6.806L2.694 1.528l10.402 1.914-4.038 3.364zm-.453.934l-1.038 8.58L1.972 2.237 8.605 7.74zm.96.455l6.687-1.21-7.67 9.343.983-8.133z" />
    </svg>
  ),
  ton: (
    <svg viewBox="0 0 24 24">
      <path fill="#0098ea" d="M12 0C5.373 0 0 5.373 0 12s5.373 12 12 12 12-5.373 12-12S18.627 0 12 0zM7.902 6.697h8.196c1.505 0 2.462 1.628 1.705 2.94l-5.059 8.765a.86.86 0 0 1-1.488 0L6.199 9.637c-.758-1.314.197-2.94 1.703-2.94zm4.844 1.496v7.58l1.102-2.128 2.656-4.756a.465.465 0 0 0-.408-.696h-3.35zM7.9 8.195a.464.464 0 0 0-.408.694l2.658 4.754 1.102 2.13V8.195H7.9z" />
    </svg>
  ),
  stellar: (
    <svg viewBox="0 0 24 24">
      <path fill="#f2f2f2" d="M12.003 1.716c-1.37 0-2.7.27-3.948.78A10.18 10.18 0 0 0 2.66 7.901a10.136 10.136 0 0 0-.797 3.954c0 .258.01.516.027.775a1.942 1.942 0 0 1-1.055 1.88L0 14.934v1.902l2.463-1.26.072-.032v.005l.77-.39.758-.385.066-.039 14.807-7.56 1.666-.847 3.392-1.732V2.694L17.792 5.86 3.744 13.025l-.104.055-.017-.115a8.286 8.286 0 0 1-.071-1.105c0-2.255.88-4.377 2.474-5.977a8.462 8.462 0 0 1 2.71-1.82 8.513 8.513 0 0 1 3.2-.654h.067a8.41 8.41 0 0 1 4.09 1.055l1.628-.83.126-.066a10.11 10.11 0 0 0-5.845-1.853zM24 7.143 5.047 16.808l-1.666.847L0 19.382v1.902l3.282-1.671 2.91-1.485 14.058-7.153.105-.055.016.115c.05.369.072.743.072 1.11 0 2.255-.88 4.383-2.475 5.978a8.461 8.461 0 0 1-2.71 1.82 8.305 8.305 0 0 1-3.2.654h-.06c-1.441 0-2.86-.369-4.102-1.061l-.066.033-1.683.857c.594.418 1.232.776 1.903 1.062a10.11 10.11 0 0 0 3.947.797 10.09 10.09 0 0 0 7.17-2.975 10.136 10.136 0 0 0 2.969-7.18c0-.259-.005-.523-.027-.781a1.942 1.942 0 0 1 1.055-1.88L24 9.044z" />
    </svg>
  ),
};
const ICON: Partial<Record<Chain, string>> = { evm: "fa-brands fa-ethereum", passkey: "fa-solid fa-fingerprint" };

/** A chain's mark: its logo, or an icon. */
export function ChainMark({ chain }: { chain: Chain }) {
  return LOGO[chain] ? (
    <span className={`chain-mark chain-logo ${chain}`} aria-hidden="true">
      {LOGO[chain]}
    </span>
  ) : (
    <i className={`chain-mark ${ICON[chain]}`} aria-hidden="true" />
  );
}

/** One button per chain whose wallets sign NEAR Intents; a wallet this browser lacks is shown as such. */
export function WalletPicker({ onDone }: { onDone?: () => void }) {
  const has = detected();
  return (
    <div className="wallet-picker" role="group" aria-label="Connect a wallet">
      {(Object.keys(CHAINS) as Chain[]).map((c) => (
        <TxButton key={c} className="btn wallet-choice" disabled={!has[c]} run={() => connectWallet(c)} onDone={onDone}>
          <ChainMark chain={c} />
          <span className="wc-text">
            <b>{CHAINS[c].name}</b>
            <small>{has[c] ? CHAINS[c].wallets : "No wallet found in this browser"}</small>
          </span>
        </TxButton>
      ))}
    </div>
  );
}

/** A button that opens the picker in place (trade and portfolio pages). */
export function ConnectWallet({ className = "btn go" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return open ? (
    <WalletPicker />
  ) : (
    <button type="button" className={className} onClick={() => setOpen(true)}>
      <i className="fa-solid fa-link" aria-hidden="true" /> Connect a wallet: EVM, Solana, Tron, TON, Stellar or a passkey
    </button>
  );
}
