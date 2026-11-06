import { useState } from "react";
import { Action, Field } from "../ui";
import { api, type Session } from "../session";
import { Backup } from "./Accounts";

export function Profile({ s, onLeave }: { s: Session; onLeave: () => void }) {
  const party = s.party;
  const [business, setBusiness] = useState(party.name);
  const [category, setCategory] = useState("");
  const verified = party.credentials.find((c) => c.type.includes("VerifiedBusiness"));
  return (
    <>
      <h1>Profile</h1>
      <dl className="facts wide">
        <dt>Name</dt>
        <dd>{party.name}</dd>
        <dt>Identifier</dt>
        <dd className="mono breakable">{party.did}</dd>
        <dt>Verified</dt>
        <dd>{verified ? `Yes: Settle Verify vouches for "${String(verified.credentialSubject.name)}"` : "Not yet"}</dd>
      </dl>
      <p className="hint">
        Your identifier is a <code>did:key</code>: your public key, written as a name. Anyone can check your signatures with it, and only this browser holds the private
        key, sealed {s.account.lock?.kind === "passphrase" ? "with your passphrase" : s.account.lock ? "with your passkey" : "not yet: protect it from the banner above"}.
      </p>

      <section className="section">
        <h2>{verified ? "Verify again" : "Get verified"}</h2>
        <p className="lede">
          Customers see a verified badge on your payment links. Settle Verify issues you a credential: a signed statement that your links carry, so anyone can check it
          without asking us.
        </p>
        <form
          className="form"
          onSubmit={async (e) => {
            e.preventDefault();
            await api.verify(party, business, category);
            s.changed();
            void s.loadPeople();
          }}
        >
          <Field label="Business name">
            <input value={business} onChange={(e) => setBusiness(e.target.value)} maxLength={80} required />
          </Field>
          <Field label="What you do" hint="Optional. Plumbing, painting, tutoring…">
            <input value={category} onChange={(e) => setCategory(e.target.value)} maxLength={60} />
          </Field>
          <button className="btn btn-primary" disabled={!business.trim()}>
            Get verified
          </button>
          <p className="hint">This is a development verifier: it vouches for any name. A real one would check your documents first.</p>
        </form>
      </section>

      <Backup u={s.unlocked} />

      <section className="section">
        <h2>This browser</h2>
        <div className="actions">
          <Action onRun={async () => onLeave()}>Lock and switch account</Action>
        </div>
      </section>
    </>
  );
}
