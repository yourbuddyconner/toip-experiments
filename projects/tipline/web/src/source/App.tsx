// The Ledger's tip page (design §7.4). It keeps nothing: no storage, no cookies, no service worker.
// The membership code and the tip code live in this page's memory until it closes.
import { useEffect, useMemo, useRef, useState } from "react";
import { MembershipWorkerClient } from "@zk-toip/anon-membership/worker";
import { initHashing, type GroupRoot } from "@zk-toip/anon-membership";
import { buildTip, checkGroup, deliver, findMembership, loadDescriptor, TipConversation, type GroupCheck, type Membership } from "../../../src/agents/source";
import { httpFetcher } from "../../../src/agents/logs";
import { newTipCode, decodeTipCode } from "../../../src/protocol/codes";
import { storyOpen, type Descriptor, type Story } from "../../../src/protocol/descriptor";
import { REASON_TEXT } from "../../../src/protocol/messages";
import { ServerClock, getJson, hourOf, longDate } from "../common/net";
import { Field, Notice, useAction } from "../common/ui";
import { cleanFile, type CleanedFile } from "./clean";

const clock = new ServerClock();
const fetcher = httpFetcher();
const outletUrl = location.origin + "/";
const ORG_SHORT = (label: string) => label.replace(/ employees$/, "");

let worker: MembershipWorkerClient | undefined;
function prover(): MembershipWorkerClient {
  if (!worker) {
    worker = new MembershipWorkerClient(new Worker(new URL("./prover.worker.ts", import.meta.url), { type: "module" }));
    void worker.warm().catch(() => {});
  }
  return worker;
}

/** Ends the session: frees the prover (which also deletes bb.js's cache, if any) and forgets everything. */
async function endSession() {
  const w = worker;
  worker = undefined;
  await w?.destroy().catch(() => {});
}

export function App() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void Promise.all([clock.start().catch(() => {}), initHashing()]).then(() => setReady(true), () => setReady(true));
    return () => clock.stop();
  }, []);
  const slug = /^\/tip\/([a-z0-9-]+)\/?$/.exec(location.pathname)?.[1];
  return (
    <div className="ledger">
      <header className="masthead">
        <a className="wordmark" href="/">
          The Ledger
        </a>
        <span className="section-name">Tip line</span>
      </header>
      <main id="main">{!ready ? <p className="loading">Loading…</p> : slug ? <TipPage slug={slug} /> : <Home />}</main>
      <footer className="colophon">
        <p>This page stores nothing on your device. Close the window when you're done.</p>
      </footer>
    </div>
  );
}

function Home() {
  const [boxes, setBoxes] = useState<{ slug: string; outlet: string; journalist: string; stories: { id: string; title: string }[] }[] | null>(null);
  useEffect(() => {
    void getJson<typeof boxes>("/api/dropboxes").then(setBoxes, () => setBoxes([]));
  }, []);
  return (
    <article className="column">
      <h1 className="headline">Send us a tip</h1>
      <p className="dek">If you work somewhere and know something the public should, our reporters want to hear from you. You can prove you work there without telling us who you are.</p>
      {boxes === null ? (
        <p className="loading">Loading…</p>
      ) : boxes.length === 0 ? (
        <Notice title="No reporter is taking tips here yet">A reporter sets up a drop box from their inbox. Then it is listed here.</Notice>
      ) : (
        <ul className="boxes">
          {boxes.map((b) => (
            <li key={b.slug}>
              <a href={`/tip/${b.slug}`}>
                <span className="who">{b.journalist}</span>
                <span className="what">{b.stories.map((s) => s.title).join("; ") || "No open stories"}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

function TorWarning() {
  const firefox = /Firefox\/\d+/.test(navigator.userAgent);
  return (
    <Notice kind="warn" title={firefox ? "We can't tell whether this is Tor Browser" : "This doesn't look like Tor Browser"}>
      Anyone between you and us can see your IP address: your internet provider, your employer's network, and the relay that carries your tip, which may be run by the
      organization you are reporting on. For a real tip, use{" "}
      <a href="https://www.torproject.org/download/" rel="noreferrer">
        Tor Browser
      </a>{" "}
      on a device and network your employer doesn't control. You can carry on without it.
    </Notice>
  );
}

function TipPage({ slug }: { slug: string }) {
  const [d, setD] = useState<Descriptor | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [mode, setMode] = useState<"choose" | "new" | "return" | "left">("choose");
  const [returnCode, setReturnCode] = useState("");
  useEffect(() => {
    loadDescriptor(outletUrl, slug, fetcher, clock).then(setD, (e) => setErr(e.message));
  }, [slug]);
  if (err) return <Notice kind="bad" title="This drop box can't be used">{err}</Notice>;
  if (!d) return <p className="loading">Checking the drop box…</p>;
  const leave = async () => {
    await endSession();
    setReturnCode("");
    setMode("left");
  };
  return (
    <article className="column">
      <h1 className="headline">Send a tip to {d.journalist.name}</h1>
      <p className="dek">
        {d.outlet}'s drop box checks that you belong to the group a story is about, without learning which member you are. You get a tip code to come back with. Nothing is kept on this
        device.
      </p>
      {mode !== "left" && <TorWarning />}
      {mode === "choose" && (
        <div className="choices">
          <button onClick={() => setMode("new")}>Send a new tip</button>
          <button className="secondary" onClick={() => setMode("return")}>
            I have a tip code
          </button>
        </div>
      )}
      {mode === "new" && (
        <NewTip
          d={d}
          onDone={(code) => {
            setReturnCode(code);
            setMode("return");
          }}
          onLeave={leave}
        />
      )}
      {mode === "return" && <Conversation d={d} initialCode={returnCode} onLeave={leave} />}
      {mode === "left" && (
        <Notice kind="good" title="You can close this window now">
          This page kept nothing. To come back, open {location.origin}
          {location.pathname} in a new private window and type your tip code.
        </Notice>
      )}
    </article>
  );
}

// ── A new tip ─────────────────────────────────────────────────────────

type Phase = "compose" | "code" | "proving" | "waiting" | "sending" | "sent";

function NewTip({ d, onDone, onLeave }: { d: Descriptor; onDone: (code: string) => void; onLeave: () => void }) {
  const today = clock.iso().slice(0, 10);
  const stories = d.stories.filter((s) => storyOpen(s, today));
  const [storyId, setStoryId] = useState(stories.length === 1 ? stories[0].id : "");
  const story = stories.find((s) => s.id === storyId);
  const [alsoOrg, setAlsoOrg] = useState(true);
  const [check, setCheck] = useState<GroupCheck | null>(null);
  const [code, setCode] = useState("");
  const [membership, setMembership] = useState<Membership | null>(null);
  const [memberWhy, setMemberWhy] = useState<string | null>(null);
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [files, setFiles] = useState<CleanedFile[]>([]);
  const [cleaning, setCleaning] = useState(false);
  const [checklist, setChecklist] = useState(false);
  const [delay, setDelay] = useState(false);
  const [phase, setPhase] = useState<Phase>("compose");
  const [tipCode, setTipCode] = useState("");
  const [progress, setProgress] = useState<{ proveMs?: number; sent?: number; of?: number; sendAt?: number }>({});
  const send = useAction();
  const look = useAction();
  const group = story?.groups[0];

  useEffect(() => {
    prover(); // load the prover in the background while the source writes
    return () => files.forEach((f) => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadGroup = (s: Story | undefined, org: boolean) =>
    look.run(async () => {
      setCheck(null);
      setMembership(null);
      if (!s) return;
      await clock.sync().catch(() => {});
      setCheck(await checkGroup({ outletUrl, group: s.groups[0], fetcher, clock, alsoOrganization: org, organization: ORG_SHORT(s.groups[0].label) }));
    });

  useEffect(() => {
    void loadGroup(story, alsoOrg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storyId, alsoOrg]);

  const view = check?.ok ? check.view : null;
  const checkCode = () =>
    look.run(async () => {
      if (!view) return;
      setMembership(null);
      setMemberWhy(null);
      const r = await findMembership({ code, view, outletUrl, fetcher });
      if (r.ok) setMembership(r.membership);
      else setMemberWhy(r.why);
    });

  const addFiles = async (list: FileList | null) => {
    if (!list) return;
    setCleaning(true);
    try {
      const out: CleanedFile[] = [];
      for (const f of Array.from(list)) out.push(await cleanFile(f));
      setFiles((prev) => [...prev, ...out].slice(0, d.limits.maxAttachments));
    } catch (e) {
      send.setError(`Couldn't read that file: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCleaning(false);
    }
  };

  const canWrite = !!membership;
  const canSend = canWrite && (subject.trim() || text.trim()) && checklist && !cleaning;

  const proveAndSend = (codeNow: string) =>
    send.run(async () => {
      if (!story || !membership) return;
      setPhase("proving");
      try {
      const built = await buildTip({
        code: codeNow,
        descriptor: d,
        story,
        membership,
        body: { subject: subject.trim(), text: text.trim() },
        files: files.map((f) => ({ bytes: f.bytes, mediaType: f.mediaType, cleaned: f.cleaned })),
        prover: prover(),
        clock,
      });
      setProgress({ proveMs: built.proveMs });
      if (delay) {
        const wait = (1 + Math.random() * 11) * 3_600_000;
        setProgress({ proveMs: built.proveMs, sendAt: Date.now() + wait });
        setPhase("waiting");
        await new Promise((r) => setTimeout(r, wait));
      }
      setPhase("sending");
      await deliver(built, { relayUrl: d.relay, onSent: (sent, of) => setProgress((p) => ({ ...p, sent, of })) });
      setPhase("sent");
      } catch (e) {
        setPhase("code");
        throw e;
      }
    });

  return (
    <ol className="steps">
      <li className="step">
        <h2>Choose the story</h2>
        {stories.length === 0 ? (
          <Notice>This drop box has no open stories right now.</Notice>
        ) : (
          <fieldset className="stories">
            <legend className="visually-hidden">Story</legend>
            {stories.map((s) => (
              <label key={s.id} className={`story ${s.id === storyId ? "chosen" : ""}`}>
                <input type="radio" name="story" value={s.id} checked={s.id === storyId} onChange={() => setStoryId(s.id)} disabled={phase !== "compose"} />
                <span>
                  <span className="story-title">{s.title}</span>
                  <span className="story-group">For members of {s.groups.map((g) => g.label).join(" or ")}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {story && (
          <>
            <label className="check">
              <input type="checkbox" checked={alsoOrg} onChange={(e) => setAlsoOrg(e.target.checked)} disabled={phase !== "compose"} />
              <span>
                Also check the member list that {ORG_SHORT(group!.label)} publishes itself. This makes sure The Ledger's copy hasn't been swapped for one built to pick you out.
                The organization's server sees that someone checked, not who or why.
              </span>
            </label>
            {look.busy && !check && <p className="loading">Checking the group…</p>}
            {check && !check.ok && <GroupRefused check={check} />}
            {view && (
              <p className="verdict good" data-testid="group-ok">
                Checked: {view.group.label} signed a list of <strong>{view.head.size} members</strong> on {longDate(view.head.epoch)}
                {view.checkedOrganization ? `, and The Ledger's copy matches the one ${ORG_SHORT(view.group.label)} publishes.` : "."}
              </p>
            )}
          </>
        )}
      </li>

      <li className={`step ${view ? "" : "locked"}`}>
        <h2>Prove you're a member</h2>
        <p>Paste the membership code from your wallet. It stays on this page; only a proof that you are one of the members leaves it.</p>
        <Field label="Membership code">
          {(id) => (
            <div className="row">
              <input
                id={id}
                className="code-input"
                autoComplete="off"
                spellCheck={false}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                disabled={!view || phase !== "compose"}
              />
              <button className="secondary" onClick={checkCode} disabled={!view || !code.trim() || phase !== "compose"}>
                Check code
              </button>
            </div>
          )}
        </Field>
        {memberWhy && <p className="error">{memberWhy}</p>}
        {membership && (
          <p className="verdict good" data-testid="member-ok">
            You are one of {membership.root.size} members of {group!.label}. Nobody, including The Ledger, will learn which one.
            {!membership.newest && ` Your membership is only in the list of ${longDate(membership.root.epoch)}; the reporter may refuse a list that old.`}
          </p>
        )}
      </li>

      <li className={`step ${canWrite ? "" : "locked"}`}>
        <h2>Write your tip</h2>
        <Field label="Subject">{(id) => <input id={id} value={subject} onChange={(e) => setSubject(e.target.value)} disabled={!canWrite || phase !== "compose"} />}</Field>
        <Field label="What you know" hint="Say what happened, when, and who else knows. Leave out details only you would know.">
          {(id) => <textarea id={id} value={text} onChange={(e) => setText(e.target.value)} disabled={!canWrite || phase !== "compose"} />}
        </Field>
        <Field label="Files" hint={`Up to ${d.limits.maxAttachments} files. Photos are cleaned here before they're sent. Each file is renamed attachment-1, attachment-2, and so on.`}>
          {(id) => <input id={id} type="file" multiple onChange={(e) => void addFiles(e.target.files)} disabled={!canWrite || phase !== "compose"} />}
        </Field>
        {cleaning && <p className="loading">Cleaning…</p>}
        {files.length > 0 && (
          <ul className="files">
            {files.map((f, i) => (
              <FileCard
                key={i}
                f={f}
                n={i + 1}
                onRemove={
                  phase === "compose"
                    ? () => {
                        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl);
                        setFiles(files.filter((x) => x !== f));
                      }
                    : undefined
                }
              />
            ))}
          </ul>
        )}
      </li>

      <li className={`step ${canWrite ? "" : "locked"}`}>
        <h2>Before you send</h2>
        <ul className="checklist">
          <li>Documents can be traced. An organization may give each person a slightly different copy, and printers add tracking dots.</li>
          <li>Screenshots can show your username, your screen or your time zone.</li>
          <li>Only send what several people could have seen.</li>
          <li>A photo signed by a camera or a phone names the device. Cleaning removes the signature, along with the location.</li>
        </ul>
        <label className="check">
          <input type="checkbox" checked={checklist} onChange={(e) => setChecklist(e.target.checked)} disabled={!canWrite || phase !== "compose"} />
          <span>I've checked my tip and files for these.</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={delay} onChange={(e) => setDelay(e.target.checked)} disabled={!canWrite || phase !== "compose"} />
          <span>Wait a random 1 to 12 hours before sending, so the time doesn't point to me. I'll keep this tab open.</span>
        </label>
        {phase === "compose" && (
          <button
            disabled={!canSend}
            onClick={() => {
              setTipCode(newTipCode());
              setPhase("code");
            }}
          >
            Get my tip code
          </button>
        )}
      </li>

      {phase !== "compose" && (
        <li className="step">
          <h2>Write down your tip code</h2>
          <p>It is the only way back to this conversation. Anyone who has it can read the replies and write as you, so keep it somewhere safe and away from work.</p>
          <TipTicket code={tipCode} />
          {phase === "code" && (
            <button onClick={() => void proveAndSend(tipCode)} disabled={send.busy}>
              I've written it down. Send my tip
            </button>
          )}
          {send.error && <p className="error">Not sent: {send.error}</p>}
          <SendProgress phase={phase} progress={progress} />
          {phase === "sent" && (
            <>
              <Notice kind="good" title="Your tip is on its way">
                {d.journalist.name} will see it as coming from a member of {group!.label}, and nothing more about you. Come back with your tip code in a few days to read replies.
              </Notice>
              <div className="choices">
                <button onClick={() => onDone(tipCode)}>Check for replies now</button>
                <button className="secondary" onClick={onLeave}>
                  I'm done
                </button>
              </div>
            </>
          )}
        </li>
      )}
    </ol>
  );
}

function GroupRefused({ check }: { check: Extract<GroupCheck, { ok: false }> }) {
  return (
    <Notice kind="bad" title="Don't send a tip to this story right now">
      <p>{check.why[0].toUpperCase() + check.why.slice(1)}.</p>
      {check.evidence && (
        <>
          <p>Both lists below are signed by the organization for the same day. Tell the reporter some other way: this is evidence the organization tried to single someone out.</p>
          <div className="evidence">
            {check.evidence.map((r: GroupRoot) => (
              <div key={r.id}>
                <strong>{r.size} members</strong>, signed {hourOf(r.issuedAt)}
                <br />
                <code>{r.root.slice(0, 18)}…</code>
              </div>
            ))}
          </div>
        </>
      )}
    </Notice>
  );
}

function FileCard({ f, n, onRemove }: { f: CleanedFile; n: number; onRemove?: () => void }) {
  return (
    <li className="file">
      {f.previewUrl ? <img src={f.previewUrl} alt={`Cleaned preview of attachment ${n}`} /> : <div className="file-icon" aria-hidden="true" />}
      <div>
        <p className="file-name">
          {f.localName} <span className="sent-as">will be sent as attachment-{n}</span>
        </p>
        {f.cleaned === "reencoded" ? (
          <>
            {f.before.length > 0 ? (
              <div className="found">
                <p>This photo carried:</p>
                <ul>
                  {f.before.map((x, i) => (
                    <li key={i}>
                      {x.what}
                      {x.value ? `: ${x.value}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="found">No metadata found in the original.</p>
            )}
            <p className={f.after.length ? "error" : "verdict good"} data-testid={`cleaned-${n}`}>
              {f.after.length ? `Still found after cleaning: ${f.after.map((x) => x.what).join(", ")}` : "Cleaned: redrawn without any metadata."}
            </p>
          </>
        ) : (
          <div className="found warn">
            <p>This kind of file can't be cleaned here. It is sent as it is. It may carry:</p>
            <ul>
              {f.warnings.map((x, i) => (
                <li key={i}>
                  {x.what}
                  {x.value ? `: ${x.value}` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
        {onRemove && (
          <button className="quiet" onClick={onRemove}>
            Remove attachment-{n}
          </button>
        )}
      </div>
    </li>
  );
}

/** The tip code as a claim ticket: the stub the source tears off and keeps. */
function TipTicket({ code }: { code: string }) {
  const groups = code.split("-");
  return (
    <figure className="ticket" aria-label="Your tip code">
      <div className="ticket-stub" aria-hidden="true">
        <span>Tip</span>
        <span>code</span>
      </div>
      <div className="ticket-body">
        <code className="ticket-code" data-testid="tip-code" data-value={code}>
          {groups.map((g, i) => (
            <span key={i}>{g}</span>
          ))}
        </code>
        <figcaption>Letters O and I read as 0 and 1. Dashes and spaces don't matter.</figcaption>
      </div>
    </figure>
  );
}

function SendProgress({ phase, progress }: { phase: Phase; progress: { proveMs?: number; sent?: number; of?: number; sendAt?: number } }) {
  if (phase === "compose" || phase === "code") return null;
  const done = (p: Phase[]) => p.includes(phase);
  return (
    <ul className="progress" aria-live="polite">
      <li className={done(["proving"]) ? "now" : "done"}>
        {done(["proving"]) ? "Proving you're a member, in this browser…" : `Proved membership in ${((progress.proveMs ?? 0) / 1000).toFixed(1)} s (designed to be zero-knowledge).`}
      </li>
      {phase === "waiting" && progress.sendAt && <li className="now">Waiting until {new Date(progress.sendAt).toLocaleTimeString()} to send. Keep this tab open.</li>}
      {done(["sending", "sent"]) && (
        <li className={phase === "sent" ? "done" : "now"}>
          {phase === "sent" ? `Sent ${progress.of} messages of identical size through the relay.` : `Sending ${progress.sent ?? 0} of ${progress.of ?? "…"}…`}
        </li>
      )}
    </ul>
  );
}

// ── Coming back with a tip code ───────────────────────────────────────

function Conversation({ d, initialCode, onLeave }: { d: Descriptor; initialCode: string; onLeave: () => void }) {
  const [code, setCode] = useState(initialCode);
  const [convo, setConvo] = useState<TipConversation | null>(null);
  const [, setVersion] = useState(0);
  const [reply, setReply] = useState("");
  const open = useAction();
  const sendA = useAction();
  const convoRef = useRef<TipConversation | null>(null);
  useEffect(() => () => convoRef.current?.close(), []);

  const start = (c: string) =>
    open.run(async () => {
      if (!decodeTipCode(c)) throw new Error("That tip code has a typo. Check each group of four.");
      const t = new TipConversation({ code: c, descriptor: d, relayUrl: d.relay, clock, onChange: () => setVersion((v) => v + 1) });
      convoRef.current = t;
      await t.start();
      setConvo(t);
    });

  useEffect(() => {
    if (initialCode) void start(initialCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!convo) {
    return (
      <section className="step-like">
        <h2>Come back to your tip</h2>
        <Field label="Tip code">
          {(id) => <input id={id} className="code-input" autoComplete="off" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} />}
        </Field>
        <button onClick={() => void start(code)} disabled={!code.trim() || open.busy}>
          {open.busy ? "Opening…" : "Open my tip"}
        </button>
        {open.error && <p className="error">{open.error}</p>}
      </section>
    );
  }
  const r = convo.receipt;
  return (
    <section className="step-like conversation">
      <h2>Your conversation with {d.journalist.name}</h2>
      {!r ? (
        <p className="loading">Waiting for {d.journalist.name}'s inbox to pick up your tip. It may be offline; replies wait for you for 30 days.</p>
      ) : r.status === "verified" ? (
        <p className="verdict good" data-testid="receipt">
          {d.outlet} checked your proof and has your tip and files.
        </p>
      ) : (
        <Notice kind="bad" title="Your tip was refused">
          {r.reason ? REASON_TEXT[r.reason] : "No reason given"}.
        </Notice>
      )}
      <ol className="thread" aria-label="Messages">
        {convo.messages.map((m) => (
          <li key={m.id} className={m.from}>
            <p className="who">
              {m.from === "source" ? "You" : d.journalist.name} <span>{m.at ? hourOf(m.at) : ""}</span>
            </p>
            <p className="text">{m.text}</p>
          </li>
        ))}
      </ol>
      {convo.proofRequest && <FreshProof d={d} convo={convo} />}
      <Field label={`Reply to ${d.journalist.name}`}>{(id) => <textarea id={id} value={reply} onChange={(e) => setReply(e.target.value)} />}</Field>
      <div className="row">
        <button
          onClick={() =>
            sendA.run(async () => {
              await convo.send(reply);
              setReply("");
            })
          }
          disabled={!reply.trim() || sendA.busy}
        >
          Send reply
        </button>
        <button className="secondary" onClick={onLeave}>
          I'm done
        </button>
      </div>
      {sendA.error && <p className="error">{sendA.error}</p>}
    </section>
  );
}

function FreshProof({ d, convo }: { d: Descriptor; convo: TipConversation }) {
  const [code, setCode] = useState("");
  const a = useAction();
  const story = useMemo(() => d.stories.find((s) => s.id === convo.proofRequest?.story), [d, convo.proofRequest]);
  if (!story) return null;
  return (
    <Notice kind="warn" title={`${d.journalist.name} asks you to prove again that you are still a member`}>
      <p>This uses today's member list. Your answer shows as the same source; nothing else about you is sent.</p>
      <Field label="Membership code">{(id) => <input id={id} className="code-input" autoComplete="off" value={code} onChange={(e) => setCode(e.target.value)} />}</Field>
      <button
        disabled={!code.trim() || a.busy}
        onClick={() =>
          a.run(async () => {
            await clock.sync().catch(() => {});
            const c = await checkGroup({ outletUrl, group: story.groups[0], fetcher, clock, alsoOrganization: true, organization: ORG_SHORT(story.groups[0].label) });
            if (!c.ok) throw new Error(c.why);
            const m = await findMembership({ code, view: c.view, outletUrl, fetcher, lookBack: 0 });
            if (!m.ok) throw new Error(m.why);
            await convo.present({ membership: m.membership, prover: prover() });
          })
        }
      >
        {a.busy ? "Proving…" : "Prove again"}
      </button>
      {a.error && <p className="error">{a.error}</p>}
    </Notice>
  );
}
