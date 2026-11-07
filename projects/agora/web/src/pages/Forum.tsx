/** A forum: its rules and gate, your pseudonym here, its polls and threads. */
import { useEffect } from "react";
import { Link, moderatePath, navigate, threadPath } from "../router";
import { useApp, useLoad } from "../state";
import { NymTag, Notice, when } from "../ui";
import { Composer, NymPanel, PollCard, TrustLine, useForumEvents, useMember } from "./parts";

export function ForumPage({ forumId }: { forumId: string }) {
  const { services } = useApp();
  useForumEvents(forumId);
  useEffect(() => void services?.warm().catch(() => {}), [services]);
  const { data: view, error } = useLoad(() => services!.reader.read(forumId), [forumId]);
  const member = useMember(view);
  useEffect(() => {
    if (view) document.title = `${view.policy.forum.title}: Agora`;
  }, [view]);

  if (error) return <Notice tone="error" title="Couldn't read this forum">{error}</Notice>;
  if (!view) return <p className="loading">Reading the forum and checking every proof…</p>;
  const f = view.policy.forum;
  return (
    <section>
      <header className="forum-head">
        <h1 tabIndex={-1}>{f.title}</h1>
        {f.description && <p className="lede">{f.description}</p>}
        <p className="gate-line">
          <strong>Posting needs</strong> {view.gateWords}.
        </p>
        {member.data?.moderator && (
          <p>
            <Link to={moderatePath(forumId)} className="btn btn-small">
              Moderate this forum
            </Link>
          </p>
        )}
      </header>
      <TrustLine view={view} />
      <div className="forum-grid">
        <div className="forum-main">
          {view.polls.length > 0 && (
            <section aria-labelledby="polls-h">
              <h2 id="polls-h">Polls</h2>
              {view.polls.map((p) => (
                <PollCard key={p.poll.id} view={view} poll={p} />
              ))}
            </section>
          )}
          <section aria-labelledby="threads-h">
            <h2 id="threads-h">Threads</h2>
            {view.threads.length === 0 && <p className="empty">No threads yet.</p>}
            <ul className="plain threads">
              {view.threads.map((t) => {
                const first = t.posts[0];
                return (
                  <li key={t.id} className="thread-row">
                    <Link to={threadPath(forumId, t.id)} className="thread-title">
                      {t.title}
                    </Link>
                    <span className="thread-meta">
                      {first?.nym ? <NymTag nym={first.nym} you={first.nym === member.data?.nym} /> : null}
                      <span>
                        {t.posts.length} post{t.posts.length === 1 ? "" : "s"}, last {when(t.lastAt)}
                      </span>
                      {t.scope === "thread" && <span className="badge">Own pseudonyms</span>}
                      {t.locked && <span className="badge badge-warn">Locked</span>}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
          {member.data && <Composer view={view} member={member.data} onPosted={(_p, thread) => navigate(threadPath(forumId, thread))} />}
        </div>
        <div className="forum-side">
          <NymPanel view={view} member={member.data} />
          {view.policy.rules.length > 0 && (
            <section className="panel" aria-labelledby="rules-h">
              <h2 id="rules-h">Rules</h2>
              <ol className="rules">
                {view.policy.rules.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ol>
            </section>
          )}
          <section className="panel" aria-labelledby="mods-h">
            <h2 id="mods-h">Moderators</h2>
            <p className="hint">Moderators act under their own names. Every action they take is signed and public.</p>
            <ul className="plain">
              {view.policy.moderators.map((m) => (
                <li key={m}>
                  <code className="did">{m.slice(0, 20)}…</code>
                </li>
              ))}
            </ul>
            <p className="meta">{view.moderation.length} moderation actions so far.</p>
          </section>
        </div>
      </div>
    </section>
  );
}
