/** The moderator view: reports, each nym's record here, actions signed under the moderator's own DID, and polls. */
import { useState } from "react";
import type { ModerationAction } from "../../../src/protocol/documents";
import { Link, forumPath } from "../router";
import { useApp, useLoad } from "../state";
import { NymTag, Notice, when } from "../ui";
import { useForumEvents } from "./parts";

const BANS: [string, number | null][] = [
  ["1 day", 1],
  ["7 days", 7],
  ["30 days", 30],
  ["Permanently", null],
];

export function ModeratePage({ forumId }: { forumId: string }) {
  const { services, session, bump } = useApp();
  useForumEvents(forumId);
  const { data: view, error } = useLoad(() => services!.reader.read(forumId), [forumId]);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [q, setQ] = useState("");
  const [choices, setChoices] = useState("Yes\nNo\nAbstain");
  const [days, setDays] = useState(3);
  const [restrict, setRestrict] = useState<{ attr: string; value: string }>({ attr: "", value: "" });

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!view) return <p className="loading">Reading the forum…</p>;
  if (!session || !view.policy.moderators.includes(session.client.did)) {
    return (
      <section className="narrow">
        <h1 tabIndex={-1}>Moderate {view.policy.forum.title}</h1>
        <Notice tone="warn">Only this forum's moderators can act here. Sign in with a moderator's account.</Notice>
      </section>
    );
  }
  const c = session.client;
  const rules = view.policy.rules;
  const act = async (action: ModerationAction, target: string, extra: { until?: string | null; rate?: { posts: number; perSeconds: number } } = {}) => {
    setMsg(null);
    if (!reason.trim()) return setMsg({ tone: "error", text: "Give a reason first: choose a rule or type one." });
    try {
      await c.moderate(forumId, action, target, reason.trim(), extra);
      setMsg({ tone: "ok", text: "Done. The action is signed and in the public log." });
      bump();
    } catch (e) {
      setMsg({ tone: "error", text: String((e as Error)?.message ?? e) });
    }
  };
  const posts = view.threads.flatMap((t) => t.posts);
  const reports = [...view.reports].reverse();
  const slots = view.descriptors[0]?.schema.slots.filter((s): s is NonNullable<typeof s> => !!s && s.encoding === "hash") ?? [];
  return (
    <section>
      <p className="crumbs">
        <Link to={forumPath(forumId)}>{view.policy.forum.title}</Link>
      </p>
      <h1 tabIndex={-1}>Moderate</h1>
      <p className="hint">
        Bans apply to a pseudonym. A banned person can come back under a new one after rotating their membership, which takes at least {view.policy.gate.minRegisteredDays} days in this forum.
      </p>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <div className="panel">
        <label htmlFor="reason">Reason for the next action</label>
        <div className="row">
          {rules.map((r, i) => (
            <button key={r} type="button" className="btn btn-small btn-quiet" onClick={() => setReason(r)}>
              Rule {i + 1}
            </button>
          ))}
        </div>
        <input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Choose a rule or type a reason" />
      </div>

      <h2>Reports</h2>
      {reports.length === 0 && <p className="empty">No reports.</p>}
      <ul className="plain reports">
        {reports.map((r) => {
          const post = posts.find((p) => p.id === r.doc.target);
          const nym = r.targetNym;
          const record = nym ? view.nyms.get(nym) : undefined;
          return (
            <li key={r.doc.id} className="report">
              <p className="meta">
                Reported {when(r.at)}: "{r.doc.reason}"
              </p>
              <blockquote className={post?.status === "hidden" ? "removed" : ""}>{post?.body ?? post?.note ?? "(post not found)"}</blockquote>
              {nym && (
                <p className="report-nym">
                  <NymTag nym={nym} /> {record?.posts ?? 0} posts here since {record ? when(record.firstAt) : "?"}, {record?.reports ?? 0} reports.
                  {record?.banned && <span className="badge badge-warn">Banned{record.banned.until ? ` until ${when(record.banned.until)}` : ""}</span>}
                </p>
              )}
              <div className="row">
                {post && post.status !== "hidden" && post.status !== "deleted" && (
                  <button type="button" className="btn btn-small" onClick={() => act("hide-post", post.id)}>
                    Hide post
                  </button>
                )}
                {post?.status === "hidden" && (
                  <button type="button" className="btn btn-small btn-quiet" onClick={() => act("restore-post", post.id)}>
                    Restore post
                  </button>
                )}
                {nym &&
                  !record?.banned &&
                  BANS.map(([label, d]) => (
                    <button key={label} type="button" className="btn btn-small btn-quiet" onClick={() => act("ban-nym", nym, { until: d === null ? null : new Date(services!.clock.now() + d * 86_400_000).toISOString() })}>
                      Ban {d === null ? "permanently" : `for ${label}`}
                    </button>
                  ))}
                {nym && record?.banned && (
                  <button type="button" className="btn btn-small btn-quiet" onClick={() => act("unban-nym", nym)}>
                    Lift ban
                  </button>
                )}
                {nym && (
                  <button type="button" className="btn btn-small btn-quiet" onClick={() => act("slow-nym", nym, { rate: { posts: 3, perSeconds: 86400 }, until: new Date(services!.clock.now() + 7 * 86_400_000).toISOString() })}>
                    Slow to 3 a day
                  </button>
                )}
                {post && (
                  <button type="button" className="btn btn-small btn-quiet" onClick={() => act(view.threads.find((t) => t.id === post.thread)?.locked ? "unlock-thread" : "lock-thread", post.thread)}>
                    {view.threads.find((t) => t.id === post.thread)?.locked ? "Unlock thread" : "Lock thread"}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <h2>Open a poll</h2>
      <form
        className="panel"
        onSubmit={async (e) => {
          e.preventDefault();
          setMsg(null);
          try {
            await c.openPoll({
              forum: forumId,
              question: q.trim(),
              choices: choices.split("\n").map((x) => x.trim()).filter(Boolean),
              closesAt: new Date(services!.clock.now() + days * 86_400_000).toISOString(),
              where: restrict.attr && restrict.value.trim() ? [{ attr: restrict.attr, op: "eq", value: restrict.value.trim() }] : [],
            });
            setQ("");
            setMsg({ tone: "ok", text: "Poll opened. The groups' current roots are pinned to it." });
            bump();
          } catch (x) {
            setMsg({ tone: "error", text: String((x as Error)?.message ?? x) });
          }
        }}
      >
        <label htmlFor="p-q">Question</label>
        <input id="p-q" required value={q} onChange={(e) => setQ(e.target.value)} />
        <label htmlFor="p-c">Choices, one per line</label>
        <textarea id="p-c" rows={3} value={choices} onChange={(e) => setChoices(e.target.value)} />
        <div className="row">
          <div>
            <label htmlFor="p-days">Open for (days)</label>
            <input id="p-days" type="number" min={1} max={60} value={days} onChange={(e) => setDays(Number(e.target.value))} />
          </div>
          {slots.length > 0 && (
            <div>
              <label htmlFor="p-attr">Only for</label>
              <select id="p-attr" value={restrict.attr} onChange={(e) => setRestrict({ ...restrict, attr: e.target.value })}>
                <option value="">everyone who can post</option>
                {slots.map((s) => (
                  <option key={s.name} value={s.name}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>
          )}
          {restrict.attr && (
            <div>
              <label htmlFor="p-val">equal to</label>
              <input id="p-val" value={restrict.value} onChange={(e) => setRestrict({ ...restrict, value: e.target.value })} />
            </div>
          )}
        </div>
        <button className="btn btn-primary">Open poll</button>
      </form>

      <h2>Moderation log</h2>
      <p className="hint">Every action by every moderator. Readers see this too.</p>
      {view.moderation.length === 0 && <p className="empty">No actions yet.</p>}
      <ol className="plain modlog">
        {[...view.moderation].reverse().map((m) => (
          <li key={m.doc.id}>
            <span className="meta">{when(m.at)}</span> {m.doc.action.replace("-", " ")}: "{m.doc.reason}" <code className="did">{m.by.slice(0, 18)}…</code>
          </li>
        ))}
      </ol>
    </section>
  );
}
