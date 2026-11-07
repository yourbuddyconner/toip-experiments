/** Pieces the forum, thread and moderator pages share: the trust line, the nym panel, the composer, polls. */
import { useEffect, useState } from "react";
import type { Poll } from "../../../src/protocol/documents";
import type { ForumView, PollState } from "../../../src/client/reader";
import type { Eligibility } from "../../../src/protocol/describe";
import type { Vote } from "../../../src/protocol/documents";
import { Link, threadPath } from "../router";
import { useApp, useLoad } from "../state";
import { NymSeal, Notice, ProvingStatus, useProving, when } from "../ui";

/** Re-reads when the forum's feed grows. */
export function useForumEvents(forumId: string): void {
  const { services, bump } = useApp();
  useEffect(() => {
    if (!services) return;
    const es = new EventSource(services.host.eventsUrl(forumId));
    let t: ReturnType<typeof setTimeout> | undefined;
    es.onmessage = () => {
      clearTimeout(t);
      t = setTimeout(bump, 150);
    };
    return () => {
      clearTimeout(t);
      es.close();
    };
  }, [services, forumId, bump]);
}

export function TrustLine({ view }: { view: ForumView }) {
  if (view.warnings.length) {
    return (
      <Notice tone="error" title={view.historyChanged ? "This host's history changed since you last read it." : "Something here doesn't check out"}>
        <ul>
          {view.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </Notice>
    );
  }
  return (
    <p className="trustline" role="status">
      <span className="check" aria-hidden="true">
        ✓
      </span>
      Checked in this browser: {view.entries} signed entries from the host's log, every signature, and every pseudonym's proof.
    </p>
  );
}

export interface MemberContext {
  nym: string;
  name: string;
  eligibility: Eligibility;
  anonymity: number;
  moderator: boolean;
}

/** What the signed-in member can do here: their nym, the anonymity estimate, or why they can't post. */
export function useMember(view: ForumView | null, thread: string | null = null) {
  const { session } = useApp();
  return useLoad(async (): Promise<MemberContext | null> => {
    if (!session || !view) return null;
    const c = session.client;
    const [eligibility, anonymity] = await Promise.all([c.eligibility(view.policy.gate), c.anonymitySet(view.policy.gate).catch(() => 0)]);
    const nym = c.nymFor(view.forumId, thread);
    return { nym, name: c.nameFor(view.forumId, thread), eligibility, anonymity, moderator: view.policy.moderators.includes(c.did) };
  }, [session, view?.forumId, view?.head.s, thread]);
}

export function NymPanel({ view, member }: { view: ForumView; member: MemberContext | null }) {
  const { session } = useApp();
  if (!session) {
    return (
      <aside className="panel nym-panel">
        <h2>Post here</h2>
        <p>
          <Link to={`/account?next=${encodeURIComponent(location.pathname)}`}>Sign in</Link> with a wallet that holds {view.gateWords}.
        </p>
      </aside>
    );
  }
  if (!member) return <aside className="panel nym-panel">Checking your memberships…</aside>;
  const min = view.policy.gate.minAnonymitySet;
  return (
    <aside className="panel nym-panel" aria-label="Your pseudonym here">
      <h2>Your pseudonym here</h2>
      {member.eligibility.ok ? (
        <>
          <p className="nym-big">
            <NymSeal nym={member.nym} size={56} />
            <span>
              <strong data-testid="my-nym">{member.name}</strong>
              <span className="hint">The same on every device, and only in this forum.</span>
            </span>
          </p>
          {member.anonymity < min ? (
            <Notice tone="warn">
              This group is too small to keep you anonymous ({member.anonymity} people; this forum needs {min}).
            </Notice>
          ) : (
            <p className="anon-line">
              You'll post as {member.name}. The forum will know someone holding {view.gateWords} wrote it, out of about {member.anonymity} people.
            </p>
          )}
        </>
      ) : (
        <Notice tone="warn" title="You can't post here yet">
          <span data-testid="ineligible">{member.eligibility.reason}</span>{" "}
          {member.eligibility.code === "noMembership" || member.eligibility.code === "attribute" ? <Link to="/wallet">Open your wallet</Link> : null}
        </Notice>
      )}
    </aside>
  );
}

const LEAKS_OK = "agora.leaks-ok";

export function LeakNotice({ onAccept }: { onAccept: () => void }) {
  return (
    <div className="panel leak-notice">
      <h3>Before your first post</h3>
      <ul>
        <li>The host can see your network address unless you use Tor or a VPN.</li>
        <li>Your writing style can identify you.</li>
        <li>Posting right after joining a group narrows who you are.</li>
      </ul>
      <button
        type="button"
        className="btn"
        onClick={() => {
          localStorage.setItem(LEAKS_OK, "1");
          onAccept();
        }}
      >
        I understand
      </button>
    </div>
  );
}

/** Writes a new thread or a reply. Proves a nym pass first if there's no live one, and says so. */
export function Composer({ view, member, thread, parent, onPosted }: { view: ForumView; member: MemberContext; thread?: { id: string; scope: "forum" | "thread" }; parent?: string | null; onPosted: (postId: string, threadId: string) => void }) {
  const { session, services, bump } = useApp();
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [ownScope, setOwnScope] = useState(false);
  const [leaksOk, setLeaksOk] = useState(() => localStorage.getItem(LEAKS_OK) === "1");
  const proving = useProving();
  const [error, setError] = useState<string | null>(null);
  const busy = proving.state.phase === "running";
  if (!member.eligibility.ok) return null;
  if (!leaksOk) return <LeakNotice onAccept={() => setLeaksOk(true)} />;
  const c = session!.client;
  const scopeThread = thread ? (thread.scope === "thread" ? thread.id : null) : null;
  const submit = async () => {
    setError(null);
    const needsPass = thread ? !c.hasLivePass(view.forumId, scopeThread, view.policyHash) : ownScope || view.policy.nyms === "thread" || !c.hasLivePass(view.forumId, null, view.policyHash);
    const label = needsPass ? "Preparing your anonymous pass (once a day)" : "Posting";
    const post = await proving.run(label, (onProgress) =>
      thread
        ? c.reply({ forum: view.forumId, thread: thread.id, threadScope: thread.scope, parent: parent ?? null, body, onProgress })
        : c.startThread({ forum: view.forumId, title, body, nymScope: ownScope ? "thread" : "forum", onProgress }),
    );
    if (post) {
      setTitle("");
      setBody("");
      bump();
      onPosted(post.id, post.thread);
    }
  };
  const id = thread ? "reply" : "new";
  return (
    <form
      className="composer"
      aria-label={thread ? "Reply" : "Start a thread"}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2>{thread ? (parent ? "Reply to this post" : "Reply") : "Start a thread"}</h2>
      {!thread && (
        <>
          <label htmlFor={`${id}-title`}>Title</label>
          <input id={`${id}-title`} required maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} onFocus={() => void services?.warm()} />
        </>
      )}
      <label htmlFor={`${id}-body`}>{thread ? "Your reply" : "Your post"}</label>
      <textarea id={`${id}-body`} required rows={thread ? 4 : 6} value={body} onChange={(e) => setBody(e.target.value)} onFocus={() => void services?.warm()} />
      {!thread && view.policy.nyms === "forum" && (
        <label className="check-label">
          <input type="checkbox" checked={ownScope} onChange={(e) => setOwnScope(e.target.checked)} /> Give this thread its own pseudonyms. Nobody, including you in other threads, will be linked to what's said here. A ban in this thread covers only this thread.
        </label>
      )}
      <p className="hint">
        You'll post as <strong>{ownScope ? "a new pseudonym for this thread" : thread?.scope === "thread" ? c.nameFor(view.forumId, thread.id) : member.name}</strong>.
      </p>
      <ProvingStatus state={proving.state} />
      {error && <Notice tone="error">{error}</Notice>}
      <button className="btn btn-primary" disabled={busy || !body.trim() || (!thread && !title.trim())}>
        {busy ? "Working…" : "Post"}
      </button>
    </form>
  );
}

const VOTE_DELAY_MS = 10 * 60_000;

export function PollCard({ view, poll }: { view: ForumView; poll: PollState }) {
  const { session, bump } = useApp();
  const proving = useProving();
  const [choice, setChoice] = useState<number | null>(null);
  const [ready, setReady] = useState<{ vote: Vote; sendAt: number } | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);
  const el = useLoad(async () => (session ? session.client.eligibility(poll.poll.gate, "This poll") : null), [session, poll.poll.id]);

  const send = async (vote: Vote) => {
    setReady(null);
    try {
      const r = await session!.client.sendVote(view.forumId, vote);
      setSent(r.replaced ? "Vote changed. Your earlier vote no longer counts." : "Vote counted.");
      bump();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  };
  useEffect(() => {
    if (!ready) return;
    const t = setInterval(() => {
      if (Date.now() >= ready.sendAt) void send(ready.vote);
      else tick((x) => x + 1);
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  const p: Poll = poll.poll;
  const total = poll.tally.reduce((a, b) => a + b, 0);
  const qid = `poll-${p.id.slice(-12)}`;
  return (
    <article className="poll" aria-labelledby={qid}>
      <h3 id={qid}>{p.question}</h3>
      <p className="meta">
        {poll.closed ? "Closed" : `Open until ${when(p.closesAt)}`}. {poll.votes} vote{poll.votes === 1 ? "" : "s"}. The last vote from each person counts while the poll is open.
      </p>
      <ul className="plain tally" aria-label="Tally">
        {p.choices.map((c, i) => {
          const pct = total ? Math.round((poll.tally[i] / total) * 100) : 0;
          return (
            <li key={c}>
              <span className="tally-label">
                {c} <span className="tally-n">{poll.tally[i]}</span>
              </span>
              <span className="bar" aria-hidden="true">
                <span style={{ width: `${pct}%` }} />
              </span>
            </li>
          );
        })}
      </ul>
      {!poll.closed && session && el.data && !el.data.ok && (
        <Notice tone="warn">
          <span data-testid="poll-ineligible">{el.data.reason}</span>
        </Notice>
      )}
      {!poll.closed && session && el.data?.ok && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (choice === null) return;
            setError(null);
            setSent(null);
            const vote = await proving.run("Proving your vote", (onProgress) => session.client.prepareVote(p, choice, onProgress));
            if (vote) setReady({ vote, sendAt: Date.now() + Math.random() * VOTE_DELAY_MS });
          }}
        >
          <fieldset>
            <legend>Your vote</legend>
            {p.choices.map((c, i) => (
              <label key={c} className="radio-label">
                <input type="radio" name={qid} checked={choice === i} onChange={() => setChoice(i)} /> {c}
              </label>
            ))}
          </fieldset>
          <ProvingStatus state={proving.state} />
          {ready ? (
            <div className="vote-ready" role="status">
              <p>
                Vote ready, sending within {Math.max(1, Math.ceil((ready.sendAt - Date.now()) / 60_000))} minute{Math.ceil((ready.sendAt - Date.now()) / 60_000) === 1 ? "" : "s"}. The wait keeps your vote from lining up with anything else you do here.
              </p>
              <button type="button" className="btn btn-primary" onClick={() => void send(ready.vote)}>
                Send now
              </button>
            </div>
          ) : (
            <button className="btn btn-primary" disabled={choice === null || proving.state.phase === "running"}>
              Prove my vote
            </button>
          )}
        </form>
      )}
      {sent && <Notice tone="ok">{sent}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      <p className="hint">A snapshot: the poll counts members of the groups' roots when it opened. People who joined later can't vote; members removed later still can.</p>
      {p.thread && <Link to={threadPath(view.forumId, p.thread)}>Discussion</Link>}
    </article>
  );
}
