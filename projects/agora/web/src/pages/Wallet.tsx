/** The wallet: credentials from the demo issuers, and the groups they let you join. */
import { useEffect, useRef, useState } from "react";
import type { Credential } from "@zk-toip/trust-core";
import type { IssuerInfo } from "../../../src/issuers/issuers";
import { Link, navigate } from "../router";
import { useApp, useLoad } from "../state";
import { Notice, day } from "../ui";

function CredentialCard({ vc, issuer }: { vc: Credential; issuer?: IssuerInfo }) {
  const { id: _id, ...claims } = vc.credentialSubject;
  return (
    <li className="credential">
      <div className="credential-head">
        <strong>{issuer?.title ?? vc.issuer}</strong>
        <span className="badge badge-ok">Signature checked</span>
      </div>
      <p className="credential-type">{issuer?.credentialLabel ?? vc.type.at(-1)}</p>
      <dl className="claims">
        {Object.entries(claims).map(([k, v]) => (
          <div key={k}>
            <dt>{issuer?.claims.find((c) => c.name === k)?.label ?? k}</dt>
            <dd>{String(v)}</dd>
          </div>
        ))}
        {vc.validUntil && (
          <div>
            <dt>Valid until</dt>
            <dd>{day(Date.parse(vc.validUntil))}</dd>
          </div>
        )}
      </dl>
    </li>
  );
}

function AskForm({ issuer, onDone }: { issuer: IssuerInfo; onDone: () => void }) {
  const { session } = useApp();
  const [claims, setClaims] = useState<Record<string, string>>(Object.fromEntries(issuer.claims.map((c) => [c.name, c.options?.[0] ?? c.example])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="ask"
      aria-label={`Ask ${issuer.title}`}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await session!.client.requestCredential(issuer.did, { credentialType: issuer.credentialType, claims });
          onDone();
        } catch (x) {
          setError(String((x as Error)?.message ?? x));
        } finally {
          setBusy(false);
        }
      }}
    >
      <h3>{issuer.title}</h3>
      <div className="ask-fields">
        {issuer.claims.map((c) => {
          const id = `${issuer.key}-${c.name}`;
          return (
            <div key={c.name}>
              <label htmlFor={id}>{c.label}</label>
              {c.options ? (
                <select id={id} value={claims[c.name]} onChange={(e) => setClaims({ ...claims, [c.name]: e.target.value })}>
                  {c.options.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              ) : (
                <input id={id} value={claims[c.name]} onChange={(e) => setClaims({ ...claims, [c.name]: e.target.value })} />
              )}
            </div>
          );
        })}
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <button className="btn" disabled={busy}>
        {busy ? "Asking…" : `Ask ${issuer.title}`}
      </button>
    </form>
  );
}

export function WalletPage() {
  const { services, session, bump } = useApp();
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const restored = useRef(false);

  const data = useLoad(async () => {
    if (!session || !services) return null;
    const c = session.client;
    const groups = await c.allGroups();
    const views = await c.membershipViews();
    const sizes = await Promise.all(groups.map(async (g) => (await c.syncGroup(g.id).catch(() => null))?.head.size ?? 0));
    return { groups, views, sizes, creds: c.credentials(), memberships: c.memberships(), gen: c.generation() };
  }, [session]);

  // After restoring from a backup code: find this account's memberships.
  useEffect(() => {
    if (!session || restored.current || !location.search.includes("restored=1")) return;
    restored.current = true;
    setBusy("recover");
    session.client
      .recover()
      .then((found) => setMsg({ tone: "ok", text: found.length ? `Found your memberships in ${found.length} group${found.length === 1 ? "" : "s"}.` : "No group has a membership for this account." }))
      .catch((e) => setMsg({ tone: "error", text: String(e?.message ?? e) }))
      .finally(() => {
        setBusy(null);
        bump();
        navigate("/wallet", { replace: true });
      });
  }, [session, bump]);

  if (!session) {
    return (
      <section className="narrow">
        <h1 tabIndex={-1}>Wallet</h1>
        <p>Your wallet holds your credentials and your memberships. It lives in this browser.</p>
        <Link to="/account?next=/wallet" className="btn btn-primary">
          Sign in or create an account
        </Link>
      </section>
    );
  }

  const act = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setMsg(null);
    try {
      setMsg({ tone: "ok", text: await fn() });
    } catch (e) {
      setMsg({ tone: "error", text: String((e as Error)?.message ?? e) });
    } finally {
      setBusy(null);
      bump();
    }
  };

  const issuers = services!.config.issuers;
  const d = data.data;
  return (
    <section>
      <h1 tabIndex={-1}>Wallet</h1>
      <p className="lede">Credentials come from their issuers over an encrypted channel. Joining a group shows a credential to its registrar once. After that, proofs say only "a member", never which one.</p>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      {busy === "recover" && <p role="status">Asking each group for this account's membership…</p>}

      <div className="two-col">
        <div>
          <h2>Your credentials</h2>
          {d && d.creds.length === 0 && <p className="empty">No credentials yet. Ask an issuer for one.</p>}
          <ul className="plain credentials">
            {d?.creds.map((vc) => (
              <CredentialCard key={vc.id} vc={vc} issuer={issuers.find((i) => i.did === vc.issuer)} />
            ))}
          </ul>
        </div>
        <div>
          <h2>Ask for a credential</h2>
          <p className="hint">These demo issuers issue whatever you ask for. A real board would check first.</p>
          {issuers.map((i) => (
            <AskForm key={i.did} issuer={i} onDone={() => (setMsg({ tone: "ok", text: `${i.title} issued your credential.` }), bump())} />
          ))}
        </div>
      </div>

      <h2>Your groups</h2>
      <p className="hint">Each issuer runs a group of its credential holders. A group publishes a signed root at most once an hour.</p>
      <ul className="plain groups">
        {d?.groups.map((g, k) => {
          const view = d.views.find((v) => v.group === g.id);
          const m = d.memberships.find((x) => x.group === g.id && x.gen === d.gen);
          const hasCred = !!session.client.credentialFor(g);
          return (
            <li key={g.id} className="group">
              <div>
                <strong>{g.title}</strong>
                <span className="group-size">{d.sizes[k]} members in the latest root</span>
              </div>
              {m ? (
                <p className="group-status">
                  <span className="badge badge-ok">Joined</span> {view?.inRoot ? "In the latest root." : "Waiting for the next root."} Registered {day(m.leaf.registeredDay * 86_400_000)}.
                </p>
              ) : hasCred ? (
                <button className="btn btn-primary" disabled={!!busy} onClick={() => act(g.id, async () => (await session.client.join(g.id), `Joined ${g.title}.`))}>
                  {busy === g.id ? "Joining…" : `Join ${g.title}`}
                </button>
              ) : (
                <p className="group-status hint">
                  Needs a {g.credentialLabel} from {g.title}.
                </p>
              )}
            </li>
          );
        })}
      </ul>

      <details className="panel">
        <summary>Rotate your membership</summary>
        <p>
          Rotating gives you a new identity secret and a new leaf in every group you're in. Use it if you lost a device or think your secret leaked. Every
          pseudonym you have now is left behind, and forums that ask for a membership of some days make you wait again. Each group allows {d?.groups[0]?.rotation.maxPerYear ?? 2} rotations a
          year.
        </p>
        <button className="btn" disabled={!!busy || !d?.memberships.length} onClick={() => act("rotate", async () => (await session.client.rotate(), "Rotated. Your new leaves appear in the next roots."))}>
          Rotate membership
        </button>
      </details>
      <p>
        <button className="btn btn-quiet" disabled={!!busy} onClick={() => act("recover", async () => `Found ${(await session.client.recover()).length} memberships.`)}>
          Find my memberships
        </button>
      </p>
    </section>
  );
}
