import { Action } from "../ui";
import { money, short } from "../model";
import { api, type Session } from "../session";

export function Wallet({ s }: { s: Session }) {
  const party = s.party;
  const w = party.wallet;
  const accounts = party.list().filter((p) => p.role !== "attester" && p.balance && p.balance !== "0");
  return (
    <>
      <h1>Wallet</h1>
      <header className="balance">
        <p className="balance-figure">
          <span className="amount">{money(s.wallet)}</span> <span className="unit">USDC</span>
        </p>
        <p className="balance-label">
          in your wallet{w && <> at <span className="mono" title={w.token}>{short(w.token)}</span></>}
        </p>
      </header>
      <div className="actions">
        <Action kind="primary" onRun={() => api.addFunds(party, 500_000_000n).then(() => s.refresh())}>
          Add 500 test USDC
        </Action>
        {accounts.length > 0 && <Action onRun={() => party.collectToWallet().then(() => s.refresh())}>Move everything to wallet</Action>}
      </div>
      <section className="section prose">
        <h2>How your money is kept</h2>
        <p>
          Your wallet is a Solana account whose key was made in this browser and never leaves it. Each payment gets its own fresh key and account too, so someone
          watching the chain can't tie your payments together through them.
        </p>
        <p>
          When a payment finishes, its money stays in that payment's account until you move it here. Moving it does link the two on the chain, so it's your choice
          when to do it.
        </p>
        <p className="hint">This is a development network: the USDC is test money from the network's faucet, and the chain resets when the platform restarts.</p>
      </section>
      {accounts.length > 0 && (
        <section className="section">
          <h2>Payment accounts with money in them</h2>
          <ul className="rows">
            {accounts.map((p) => (
              <li key={p.id} className="row static">
                <span className="row-main">
                  <strong>{p.purpose}</strong>
                  <span className="row-sub mono">{short(party.tokenAccount(p.id))}</span>
                </span>
                <span className="row-amount">{money(p.balance)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
