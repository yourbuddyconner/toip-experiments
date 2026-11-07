// Sam's inbox: the drop box runs here, in this browser. Tips are verified here, labeled by nullifier,
// and stored sealed with the passkey. No server holds them in the clear.
import { useEffect, useState, useSyncExternalStore } from "react";
import { PasskeyUnsupported, type Account } from "@toip-tools/web-vault";
import { initHashing, type GroupRoot } from "@toip-tools/anon-membership";
import type { AttachmentRecord, GroupStatus, TipRecord } from "../../../src/agents/inbox";
import { REASON_TEXT } from "../../../src/protocol/messages";
import { ServerClock, getJson, hourOf, longDate, shortDid } from "../common/net";
import { Copyable, Field, Notice, useAction, useTick } from "../common/ui";
import { InboxSession, vault, type InboxConfig, type Profile } from "./session";

const clock = new ServerClock();

export function App() {
  const [config, setConfig] = useState<InboxConfig | null>(null);
  const [session, setSession] = useState<InboxSession | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([clock.start(1000), getJson<InboxConfig>("/api/config"), initHashing()]).then(([, c]) => setConfig(c), (e) => setErr(String(e?.message ?? e)));
  }, []);
  if (err) return <Shell><Notice kind="bad" title="The inbox couldn't start">{err}</Notice></Shell>;
  if (!config) return <Shell><p className="muted">Loading…</p></Shell>;
  if (!session) return <Shell><Welcome config={config} onOpen={setSession} /></Shell>;
  return <Desk session={session} onLock={() => { session.close(); vault.lockAll(); setSession(null); }} />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="inbox-shell">
      <header className="topbar">
        <span className="brand">Drop box</span>
      </header>
      <main className="welcome">{children}</main>
    </div>
  );
}

function Welcome({ config, onOpen }: { config: InboxConfig; onOpen: (s: InboxSession) => void }) {
  const [accounts] = useState<Account[]>(() => vault.accounts());
  const [journalist, setJournalist] = useState("Sam Ortiz");
  const [outlet, setOutlet] = useState("The Ledger");
  const [slug, setSlug] = useState("ledger-sam");
  const [usePass, setUsePass] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const a = useAction();
  const open = async (u: Awaited<ReturnType<typeof vault.unlock>>) => onOpen(await InboxSession.open(u, config, clock));

  if (accounts.length > 0) {
    const acct = accounts[0];
    const needsPass = acct.lock?.kind === "passphrase";
    return (
      <section className="panel narrow">
        <h1>Welcome back, {acct.name}.</h1>
        <p>Your drop box key is sealed in this browser. Unlock it to collect tips.</p>
        {needsPass && <Field label="Passphrase">{(id) => <input id={id} type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />}</Field>}
        <button disabled={a.busy} onClick={() => a.run(async () => open(await vault.unlock(acct, needsPass ? passphrase : undefined)))}>
          {a.busy ? "Unlocking…" : `Unlock ${acct.name}`}
        </button>
        {a.error && <p className="error">{a.error}</p>}
      </section>
    );
  }
  return (
    <section className="panel narrow">
      <h1>Set up your drop box</h1>
      <p>
        Your drop box is a key that lives in this browser. Sources send to it through the relay, sealed so only this browser can read them. Unlock it with a passkey, or a passphrase if
        your browser can't.
      </p>
      <Field label="Your name">{(id) => <input id={id} value={journalist} onChange={(e) => setJournalist(e.target.value)} />}</Field>
      <Field label="Publication">{(id) => <input id={id} value={outlet} onChange={(e) => setOutlet(e.target.value)} />}</Field>
      <Field label="Drop box address" hint={`Sources will open ${config.outletUrl}/tip/${slug || "…"}`}>
        {(id) => <input id={id} value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))} />}
      </Field>
      {usePass && <Field label="Passphrase" hint="At least 12 characters.">{(id) => <input id={id} type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />}</Field>}
      <div className="row">
        <button
          disabled={a.busy || !journalist.trim() || slug.length < 3 || (usePass && passphrase.length < 12)}
          onClick={() =>
            a.run(async () => {
              let u;
              try {
                u = await vault.createAccount(journalist.trim(), usePass ? { kind: "passphrase", passphrase } : { kind: "passkey" });
              } catch (e) {
                if (e instanceof PasskeyUnsupported) {
                  setUsePass(true);
                  throw new Error("This browser's passkeys can't seal keys. Choose a passphrase instead.");
                }
                throw e;
              }
              const profile: Profile = { journalist: journalist.trim(), outlet: outlet.trim() || "The Ledger", slug };
              await vault.writeJson(u, "profile", profile);
              await open(u);
            })
          }
        >
          {usePass ? "Create drop box" : "Create drop box with a passkey"}
        </button>
        {!usePass && (
          <button className="quiet" onClick={() => setUsePass(true)}>
            Use a passphrase instead
          </button>
        )}
      </div>
      {a.error && <p className="error">{a.error}</p>}
    </section>
  );
}

// ── The desk ──────────────────────────────────────────────────────────

function Desk({ session, onLock }: { session: InboxSession; onLock: () => void }) {
  useSyncExternalStore(
    (fn) => session.subscribe(fn),
    () => session.version,
  );
  const agent = session.agent;
  const d = agent.getDescriptor();
  const [storyId, setStoryId] = useState<string | null>(d?.stories[0]?.id ?? null);
  const [tipId, setTipId] = useState<string | null>(null);
  const [composing, setComposing] = useState(!d?.stories.length);
  const [groups, setGroups] = useState<GroupStatus[]>([]);
  const [today, setToday] = useState(clock.iso().slice(0, 10));
  const refresh = () => void agent.groupStatus().then(setGroups, () => {});
  useEffect(refresh, [d?.id]);
  useTick(() => {
    refresh();
    setToday(clock.iso().slice(0, 10));
  }, 4000, [d?.id]);

  const story = d?.stories.find((s) => s.id === storyId) ?? null;
  const tips = agent.list().filter((t) => t.story === storyId);
  const tip = tipId ? agent.tip(tipId) : undefined;
  const evidence = groups.filter((g) => g.evidence);
  const refused = agent.refusals();

  return (
    <div className="desk">
      <header className="topbar">
        <span className="brand">Drop box</span>
        <span className="who">
          {session.profile.journalist}, {session.profile.outlet}
        </span>
        <span className={`relay ${session.transport.status}`} role="status">
          {session.transport.status === "connected" ? "Collecting from the relay" : session.transport.status === "connecting" ? "Connecting to the relay…" : "Offline"}
        </span>
        <span className="today" title="The demo's clock">
          {longDate(today)}
        </span>
        <button className="quiet on-dark" onClick={onLock}>
          Lock
        </button>
      </header>
      <div className="desk-body">
        <nav className="rail" aria-label="Stories and tips">
          <div className="rail-head">
            <h2>Stories</h2>
            <button className="quiet" onClick={() => { setComposing(true); setTipId(null); }}>
              Open a story
            </button>
          </div>
          {!d?.stories.length && <p className="muted small">No stories yet.</p>}
          <ul className="story-list">
            {d?.stories.map((s) => (
              <li key={s.id}>
                <button className={`story-item ${s.id === storyId && !composing ? "current" : ""}`} aria-current={s.id === storyId && !composing} onClick={() => { setStoryId(s.id); setTipId(null); setComposing(false); }}>
                  <span className="title">{s.title}</span>
                  <span className="meta">
                    {plural(agent.list().filter((t) => t.story === s.id).length, "tip")} from {plural(agent.sources(s.id), "source")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {story && !composing && (
            <>
              <h2 className="rail-sub">Tips</h2>
              {tips.length === 0 && <p className="muted small">Nothing yet. Tips wait on the relay until this inbox collects them.</p>}
              <ul className="tip-list">
                {tips.map((t) => (
                  <li key={t.tipId}>
                    <button className={`tip-item ${t.tipId === tipId ? "current" : ""}`} aria-current={t.tipId === tipId} onClick={() => setTipId(t.tipId)}>
                      <SourceMark label={t.label} />
                      <span>
                        <span className="title">{t.subject || "(no subject)"}</span>
                        <span className="meta">
                          {t.label}, {hourOf(t.receivedAt)}
                          {t.attachments.length ? `, ${t.attachments.length} ${t.attachments.length === 1 ? "file" : "files"}` : ""}
                          {t.status === "receiving" ? ", receiving files…" : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {refused.length > 0 && (
            <details className="refused">
              <summary>
                {refused.length} refused {refused.length === 1 ? "message" : "messages"}
              </summary>
              <ul>
                {refused
                  .slice()
                  .reverse()
                  .map((r, i) => (
                    <li key={i} data-reason={r.reason}>
                      <strong>{hourOf(r.at)}</strong> from {shortDid(r.from)}: {REASON_TEXT[r.reason]}.
                    </li>
                  ))}
              </ul>
            </details>
          )}
        </nav>
        <main className="reading" id="main">
          {evidence.map((g) => (
            <Equivocation key={g.group} g={g} />
          ))}
          {composing ? (
            <OpenStory session={session} onDone={(id) => { setStoryId(id); setComposing(false); }} onCancel={d?.stories.length ? () => setComposing(false) : undefined} />
          ) : tip ? (
            <TipView key={tip.tipId} session={session} tip={tip} />
          ) : story ? (
            <StoryOverview session={session} storyId={story.id} groups={groups} />
          ) : null}
        </main>
      </div>
    </div>
  );
}

function SourceMark({ label, large }: { label: string; large?: boolean }) {
  return (
    <span className={`source-mark ${large ? "large" : ""}`} aria-hidden="true">
      {label.replace(/^Source /, "")}
    </span>
  );
}

function OpenStory({ session, onDone, onCancel }: { session: InboxSession; onDone: (id: string) => void; onCancel?: () => void }) {
  const orgs = session.config.organizations;
  const [title, setTitle] = useState("Valve failures at Acme's Riverside plant");
  const [orgIx, setOrgIx] = useState(0);
  const [minSize, setMinSize] = useState(50);
  const [maxAge, setMaxAge] = useState(3);
  const a = useAction();
  const org = orgs[orgIx];
  return (
    <section className="panel">
      <h1>Open a story</h1>
      <p>Sources who tip on this story must prove they belong to the group you choose. Each member counts once on the story, as Source A, Source B and so on.</p>
      <Field label="Story title">{(id) => <input id={id} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
      <Field label="Who may tip" hint="The group is run and signed by the organization itself.">
        {(id) => (
          <select id={id} value={orgIx} onChange={(e) => setOrgIx(Number(e.target.value))}>
            {orgs.map((o, i) => (
              <option key={o.group} value={i}>
                {o.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      {org && (
        <div className="pinned">
          <p className="small">
            {org.org} signs its member lists with this key. Check it against {org.org}'s own website before you rely on it.
          </p>
          <Copyable value={org.issuer} label="Signing key" display={shortDid(org.issuer)} />
        </div>
      )}
      <div className="two">
        <Field label="Smallest group to accept" hint="A small group makes a source easy to pick out.">
          {(id) => <input id={id} type="number" min={1} value={minSize} onChange={(e) => setMinSize(Number(e.target.value))} />}
        </Field>
        <Field label="Oldest member list to accept, in days" hint="Someone who left can tip for this long after the first list without them.">
          {(id) => <input id={id} type="number" min={0} max={30} value={maxAge} onChange={(e) => setMaxAge(Number(e.target.value))} />}
        </Field>
      </div>
      <div className="row">
        <button disabled={a.busy || !org} onClick={() => a.run(async () => onDone((await session.openStory({ title, org, minSize, maxEpochAge: maxAge })).stories.at(-1)!.id))}>
          {a.busy ? "Signing…" : "Sign and publish"}
        </button>
        {onCancel && (
          <button className="secondary" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {a.error && <p className="error">{a.error}</p>}
    </section>
  );
}

function StoryOverview({ session, storyId, groups }: { session: InboxSession; storyId: string; groups: GroupStatus[] }) {
  const d = session.agent.getDescriptor()!;
  const story = d.stories.find((s) => s.id === storyId)!;
  const n = session.agent.sources(storyId);
  const g = story.groups[0];
  const status = groups.find((x) => x.group === g.group);
  return (
    <section className="panel">
      <h1 className="story-title">{story.title}</h1>
      <p className="count" data-testid="source-count">
        {n === 0 ? "No sources yet." : `${n} distinct ${n === 1 ? "member" : "members"} of this group.`} The issuer could control some of them: {g.label.replace(/ employees$/, "")} can
        enroll people it chooses.
      </p>
      <dl className="facts">
        <dt>Open to</dt>
        <dd>
          {g.label}, at least {g.minSize} members, member lists up to {g.maxEpochAge} days old
        </dd>
        <dt>Newest member list</dt>
        <dd>{status?.head ? `${longDate(status.head.epoch)}, ${status.head.size} members` : status?.why ?? "Checking…"}</dd>
        <dt>Sources send tips at</dt>
        <dd>
          <a href={session.tipUrl} target="_blank" rel="noreferrer">
            {session.tipUrl}
          </a>
        </dd>
        <dt>Drop box key</dt>
        <dd>
          <code>{shortDid(session.identity.did)}</code>
        </dd>
      </dl>
    </section>
  );
}

function Equivocation({ g }: { g: GroupStatus }) {
  const [a, b] = g.evidence!;
  return (
    <Notice kind="bad" title={`${g.label.replace(/ employees$/, "")} signed two different member lists for ${longDate(a.epoch)}`}>
      <p>That is evidence it tried to show someone a list built to single them out. Tips proved against this group are refused from now on. Keep both signed documents.</p>
      <div className="evidence">
        {[a, b].map((r: GroupRoot, i) => (
          <details key={r.id}>
            <summary>
              List {i + 1}: {r.size} members, signed {hourOf(r.issuedAt)}
            </summary>
            <pre>{JSON.stringify(r, null, 2)}</pre>
          </details>
        ))}
      </div>
    </Notice>
  );
}

function TipView({ session, tip }: { session: InboxSession; tip: TipRecord }) {
  const d = session.agent.getDescriptor()!;
  const story = d.stories.find((s) => s.id === tip.story);
  const label = story?.groups[0].label ?? tip.group;
  const [reply, setReply] = useState("");
  const a = useAction();
  const p = useAction();
  return (
    <article className="tip">
      <header className="tip-head">
        <SourceMark label={tip.label} large />
        <div>
          <h1>{tip.label}</h1>
          <p className="verified" data-testid="verified">
            A member of {label} ({tip.size} members) as of {longDate(tip.epoch)}. Designed-to-be-zero-knowledge proof verified.
          </p>
          <p className="muted small">
            {tip.firstFromSource ? "First tip from this source on this story." : `Not the first tip from ${tip.label} on this story: the same member sent it with a new tip code.`} Received{" "}
            {hourOf(tip.receivedAt)}. Replies go to <code>{shortDid(tip.from)}</code>, a key made for this tip only.
          </p>
          <details className="small">
            <summary>The number behind the label</summary>
            <p>
              {tip.label} is this nullifier. The same member makes the same one on this story every time, and an unrelated one anywhere else. Only this inbox has seen it.
            </p>
            <Copyable value={tip.nullifier} label="Nullifier" display={`${tip.nullifier.slice(0, 18)}…`} />
          </details>
        </div>
      </header>
      <h2 className="subject">{tip.subject || "(no subject)"}</h2>
      <div className="body">
        {tip.text.split(/\n{2,}/).map((para, i) => (
          <p key={i}>{para}</p>
        ))}
      </div>
      {tip.attachments.length > 0 && (
        <section className="attachments">
          <h3>Files</h3>
          <ul>
            {tip.attachments.map((x) => (
              <Attachment key={x.id} session={session} tipId={tip.tipId} a={x} />
            ))}
          </ul>
        </section>
      )}
      <section className="thread-pane">
        <h3>Conversation</h3>
        {tip.thread.length === 0 && <p className="muted small">No messages yet. Your reply waits on the relay until the source comes back with their tip code, for up to 30 days.</p>}
        <ol className="thread">
          {tip.thread.map((m) => (
            <li key={m.id} className={m.from}>
              <p className="who">
                {m.from === "source" ? tip.label : "You"} <span>{hourOf(m.at)}</span>
              </p>
              <p className="text">{m.text}</p>
            </li>
          ))}
        </ol>
        <Field label={`Reply to ${tip.label}`}>{(id) => <textarea id={id} value={reply} onChange={(e) => setReply(e.target.value)} />}</Field>
        <div className="row">
          <button
            disabled={!reply.trim() || a.busy}
            onClick={() =>
              a.run(async () => {
                await session.agent.reply(tip.tipId, reply);
                setReply("");
              })
            }
          >
            Send reply
          </button>
          <button className="secondary" disabled={p.busy || !!tip.pendingChallenge} onClick={() => p.run(async () => void (await session.agent.requestProof(tip.tipId)))}>
            {tip.pendingChallenge ? "Fresh proof requested" : "Ask for a fresh proof"}
          </button>
        </div>
        {(a.error || p.error) && <p className="error">{a.error ?? p.error}</p>}
        {tip.proofs.length > 0 && (
          <ul className="proofs">
            {tip.proofs.map((f, i) => (
              <li key={i} className={f.ok ? "ok" : "bad"}>
                {f.ok ? `Still a member as of ${longDate(f.epoch!)} (${f.size} members), the same source.` : `A fresh proof was refused: ${f.reason}.`} {hourOf(f.at)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </article>
  );
}

function Attachment({ session, tipId, a }: { session: InboxSession; tipId: string; a: AttachmentRecord }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let u: string | null = null;
    if (a.status === "ok")
      void session.agent.file(tipId, a.id).then((b) => {
        if (b) setUrl((u = URL.createObjectURL(new Blob([b as BlobPart], { type: a.mediaType }))));
      });
    return () => {
      if (u) URL.revokeObjectURL(u);
    };
  }, [tipId, a.id, a.status]);
  const image = a.mediaType.startsWith("image/");
  return (
    <li className="attachment">
      {image && url ? <img src={url} alt={`${a.name} from the source`} /> : <div className="file-icon" aria-hidden="true" />}
      <div>
        <p className="name">
          {a.name} <span className="muted">{(a.bytes / 1024).toFixed(0)} KB</span>
        </p>
        {a.status === "receiving" && <p className="muted small">Receiving…</p>}
        {a.status === "bad" && <p className="error">This file didn't match the hash the source proved. It was dropped.</p>}
        {a.status === "ok" &&
          (a.findings && a.findings.length ? (
            <p className="warn small">Metadata found: {a.findings.map((f) => f.what).join(", ")}. Check it before you share the file.</p>
          ) : (
            <p className="clean small" data-testid="no-metadata">
              No metadata found{a.cleaned === "reencoded" ? ": the source's browser redrew it" : ""}. Review it for other tells before publication.
            </p>
          ))}
        {url && (
          <a href={url} download={a.name} className="small">
            Save {a.name}
          </a>
        )}
      </div>
    </li>
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
