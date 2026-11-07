/** Write a forum's policy from the registrars' groups, sign it with your account, and post it to the host. */
import { useMemo, useState } from "react";
import type { GatePredicate, GroupDescriptor } from "../../../src/protocol/documents";
import { gateInWords } from "../../../src/protocol/describe";
import { gateProblem } from "../../../src/protocol/gate";
import { Link, forumPath, navigate } from "../router";
import { useApp, useLoad } from "../state";
import { Notice } from "../ui";

type Op = "any" | GatePredicate["op"];

export function NewForumPage() {
  const { services, session, bump } = useApp();
  const groups = useLoad(async () => (await services!.registrar.groups()).groups, []);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [preds, setPreds] = useState<Record<string, { op: Op; value: string }>>({});
  const [minDays, setMinDays] = useState(7);
  const [minSet, setMinSet] = useState(25);
  const [nyms, setNyms] = useState<"forum" | "thread">("forum");
  const [rules, setRules] = useState("");
  const [mods, setMods] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const all = groups.data ?? [];
  const descs = chosen.map((id) => all.find((g) => g.id === id)).filter((g): g is GroupDescriptor => !!g);
  const slots = descs[0]?.schema.slots.filter((s): s is NonNullable<typeof s> => !!s) ?? [];
  const gate = useMemo(
    () => ({
      anyOf: descs.map((d) => ({ group: d.id, registrar: d.issuer })),
      where: slots.filter((s) => preds[s.name] && preds[s.name].op !== "any" && preds[s.name].value.trim()).map((s) => ({ attr: s.name, op: preds[s.name].op as GatePredicate["op"], value: preds[s.name].value.trim() })),
      minRegisteredDays: minDays,
      minAnonymitySet: minSet,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chosen.join(), JSON.stringify(preds), minDays, minSet, all.length],
  );
  const problem = descs.length ? gateProblem(gate, descs) : "choose at least one group";

  if (!session) {
    return (
      <section className="narrow">
        <h1 tabIndex={-1}>New forum</h1>
        <p>A forum's owner signs its policy with their own account.</p>
        <Link to="/account?next=/new" className="btn btn-primary">
          Sign in or create an account
        </Link>
      </section>
    );
  }
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "forum";
  return (
    <section className="narrow">
      <h1 tabIndex={-1}>New forum</h1>
      <p className="lede">You'll sign the forum's policy with your account, and you'll moderate it under your own name.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            const p = await session.client.createForum({
              title: title.trim(),
              slug,
              description: description.trim(),
              gate,
              nyms,
              rules: rules.split("\n").map((r) => r.trim()).filter(Boolean),
              moderators: [session.client.did, ...mods.split(/\s+/).filter((d) => d.startsWith("did:key:"))],
            });
            bump();
            navigate(forumPath(p.forum.id));
          } catch (x) {
            setError(String((x as Error)?.message ?? x));
          } finally {
            setBusy(false);
          }
        }}
      >
        <label htmlFor="f-title">Name</label>
        <input id="f-title" required maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} />
        <label htmlFor="f-desc">What it's for</label>
        <textarea id="f-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />

        <fieldset>
          <legend>Who may post</legend>
          <p className="hint">Members of any of these groups. Groups in one forum must hold the same kind of credential.</p>
          {all.map((g) => (
            <label key={g.id} className="check-label">
              <input type="checkbox" checked={chosen.includes(g.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, g.id] : chosen.filter((x) => x !== g.id))} /> {g.title} ({g.credentialLabel})
            </label>
          ))}
        </fieldset>

        {slots.length > 0 && (
          <fieldset>
            <legend>And whose credential says</legend>
            {slots.map((s) => {
              const v = preds[s.name] ?? { op: "any" as Op, value: "" };
              return (
                <div key={s.name} className="pred-row">
                  <label htmlFor={`op-${s.name}`}>{s.label}</label>
                  <select id={`op-${s.name}`} value={v.op} onChange={(e) => setPreds({ ...preds, [s.name]: { ...v, op: e.target.value as Op } })}>
                    <option value="any">anything</option>
                    <option value="eq">is</option>
                    {s.encoding !== "hash" && <option value="gte">at least</option>}
                    {s.encoding !== "hash" && <option value="lte">at most</option>}
                  </select>
                  {v.op !== "any" && (
                    <input aria-label={`${s.label} value`} placeholder={s.encoding === "day" ? "2020-01-01" : ""} value={v.value} onChange={(e) => setPreds({ ...preds, [s.name]: { ...v, value: e.target.value } })} />
                  )}
                </div>
              );
            })}
          </fieldset>
        )}

        <div className="row">
          <div>
            <label htmlFor="f-days">Days in the group before posting</label>
            <input id="f-days" type="number" min={0} max={3650} value={minDays} onChange={(e) => setMinDays(Number(e.target.value))} />
          </div>
          <div>
            <label htmlFor="f-set">Smallest anonymity set</label>
            <input id="f-set" type="number" min={0} value={minSet} onChange={(e) => setMinSet(Number(e.target.value))} />
          </div>
        </div>
        <p className="hint">Waiting days slow down people who come back under a new pseudonym after a ban.</p>

        <fieldset>
          <legend>Pseudonyms</legend>
          <label className="radio-label">
            <input type="radio" name="nyms" checked={nyms === "forum"} onChange={() => setNyms("forum")} /> One per person for the whole forum. Bans work forum-wide. Any thread can still ask for its own.
          </label>
          <label className="radio-label">
            <input type="radio" name="nyms" checked={nyms === "thread"} onChange={() => setNyms("thread")} /> A new one in every thread. Less linkable, but a ban covers only one thread.
          </label>
        </fieldset>

        <label htmlFor="f-rules">Rules, one per line</label>
        <textarea id="f-rules" rows={3} value={rules} onChange={(e) => setRules(e.target.value)} />
        <label htmlFor="f-mods">Other moderators' DIDs (optional)</label>
        <textarea id="f-mods" rows={2} className="mono" value={mods} onChange={(e) => setMods(e.target.value)} />

        {descs.length > 0 && !problem && <p className="gate-line">Posting will need {gateInWords(gate, descs)}.</p>}
        {problem && chosen.length > 0 && <Notice tone="warn">{problem}</Notice>}
        {error && <Notice tone="error">{error}</Notice>}
        <button className="btn btn-primary" disabled={busy || !!problem || !title.trim()}>
          Sign and create forum
        </button>
      </form>
    </section>
  );
}
