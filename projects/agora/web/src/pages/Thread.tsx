/** A thread: its posts, each checked in this browser, and a reply box. */
import { useEffect, useState } from "react";
import type { PostView } from "../../../src/client/reader";
import { Link, forumPath } from "../router";
import { useApp, useLoad } from "../state";
import { NymSeal, Notice, when } from "../ui";
import { Composer, NymPanel, TrustLine, useForumEvents, useMember } from "./parts";

function PostItem({ post, mine, canAct, onReport, onDelete, onReply }: { post: PostView; mine: boolean; canAct: boolean; onReport: (reason: string) => Promise<void>; onDelete: () => Promise<void>; onReply: () => void }) {
  const [reporting, setReporting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  if (post.status === "hidden" || post.status === "deleted") {
    return (
      <li className="post post-removed" id={`post-${post.id.slice(-12)}`}>
        <p>{post.note}</p>
      </li>
    );
  }
  return (
    <li className={`post${mine ? " post-mine" : ""}`} id={`post-${post.id.slice(-12)}`}>
      <div className="post-seal">
        <NymSeal nym={post.nym} size={44} />
      </div>
      <div className="post-main">
        <p className="post-head">
          <strong className="nymname" title={post.nym}>
            {post.name}
          </strong>
          {mine && <span className="you">you</span>}
          {post.status === "verified" ? (
            <span className="badge badge-ok" title="Its pass's zero-knowledge proof and its signature check out in this browser.">
              Verified member
            </span>
          ) : (
            <span className="badge badge-error">Couldn't verify</span>
          )}
          <time dateTime={post.at}>{when(post.at)}</time>
        </p>
        <div className="post-body">{post.body}</div>
        {post.reports > 0 && <p className="meta">{post.reports} report{post.reports === 1 ? "" : "s"}</p>}
        {canAct && (
          <div className="post-actions">
            <button type="button" className="btn btn-small btn-quiet" onClick={onReply}>
              Reply
            </button>
            {mine ? (
              <button
                type="button"
                className="btn btn-small btn-quiet"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  await onDelete();
                  setBusy(false);
                }}
              >
                Delete
              </button>
            ) : (
              <button type="button" className="btn btn-small btn-quiet" aria-expanded={reporting} onClick={() => setReporting(!reporting)}>
                Report
              </button>
            )}
          </div>
        )}
        {reporting && (
          <form
            className="report-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              await onReport(reason);
              setBusy(false);
              setReporting(false);
              setReason("");
            }}
          >
            <label htmlFor={`reason-${post.id}`}>Why are you reporting this?</label>
            <input id={`reason-${post.id}`} required value={reason} onChange={(e) => setReason(e.target.value)} />
            <button className="btn btn-small" disabled={busy}>
              Send report
            </button>
          </form>
        )}
      </div>
    </li>
  );
}

export function ThreadPage({ forumId, threadId }: { forumId: string; threadId: string }) {
  const { services, session, bump } = useApp();
  useForumEvents(forumId);
  useEffect(() => void services?.warm().catch(() => {}), [services]);
  const { data: view, error } = useLoad(() => services!.reader.read(forumId), [forumId]);
  const thread = view?.threads.find((t) => t.id === threadId);
  const member = useMember(view, thread?.scope === "thread" ? threadId : null);
  const [parent, setParent] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  useEffect(() => {
    if (thread) document.title = `${thread.title}: Agora`;
  }, [thread]);

  if (error) return <Notice tone="error" title="Couldn't read this forum">{error}</Notice>;
  if (!view) return <p className="loading">Reading the thread and checking every proof…</p>;
  if (!thread) return <Notice tone="warn">No such thread in this forum.</Notice>;
  const canAct = !!session && !!member.data?.eligibility.ok;
  const act = async (fn: () => Promise<void>, ok: string) => {
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: "ok", text: ok });
      bump();
    } catch (e) {
      setMsg({ tone: "error", text: String((e as Error)?.message ?? e) });
    }
  };
  const scopeThread = thread.scope === "thread" ? thread.id : null;
  return (
    <section>
      <p className="crumbs">
        <Link to={forumPath(forumId)}>{view.policy.forum.title}</Link>
      </p>
      <h1 tabIndex={-1}>{thread.title}</h1>
      {thread.scope === "thread" && <p className="hint">This thread has its own pseudonyms: names here aren't the ones people use elsewhere in the forum.</p>}
      <TrustLine view={view} />
      <p className="hint">Every post below comes from someone holding {view.gateWords}. Nobody, the host included, can tell who.</p>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <div className="forum-grid">
        <div className="forum-main">
          <ol className="plain posts">
            {thread.posts.map((p) => (
              <PostItem
                key={p.id}
                post={p}
                mine={!!member.data && p.nym === member.data.nym}
                canAct={canAct}
                onReply={() => {
                  setParent(p.id);
                  document.getElementById("reply-body")?.focus();
                }}
                onReport={(reason) => act(() => session!.client.report(forumId, p.id, reason, scopeThread), "Reported. The moderators will see it.")}
                onDelete={() => act(() => session!.client.deletePost(forumId, p.id, scopeThread), "Deleted.")}
              />
            ))}
          </ol>
          {thread.locked ? (
            <Notice tone="warn">A moderator locked this thread.</Notice>
          ) : (
            member.data && <Composer view={view} member={member.data} thread={{ id: thread.id, scope: thread.scope }} parent={parent} onPosted={() => setParent(null)} />
          )}
        </div>
        <div className="forum-side">
          <NymPanel view={view} member={member.data} />
        </div>
      </div>
    </section>
  );
}
