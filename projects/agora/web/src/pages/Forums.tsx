/** Every forum on this host. Anyone can read. */
import { gateInWords } from "../../../src/protocol/describe";
import { Link, forumPath } from "../router";
import { useApp, useLoad } from "../state";
import { Notice } from "../ui";

export function ForumsPage() {
  const { services } = useApp();
  const { data, error } = useLoad(async () => {
    const [{ forums }, { groups }] = await Promise.all([services!.host.forums(), services!.registrar.groups()]);
    return { forums, groups };
  }, []);
  return (
    <section>
      <div className="hero">
        <h1 tabIndex={-1}>Speak as a member, not as a name.</h1>
        <p className="lede">
          Every forum here says who may post: licensed nurses, residents of a district. A post proves its author holds that credential and nothing else. You get one pseudonym per forum, and nobody can link your pseudonyms across forums.
        </p>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <h2>Forums on this host</h2>
      {data && data.forums.length === 0 && (
        <p className="empty">
          No forums yet. <Link to="/new">Create the first one</Link>.
        </p>
      )}
      <ul className="plain forum-list">
        {data?.forums.map(({ policy, head }) => (
          <li key={policy.forum.id} className="forum-card">
            <h3>
              <Link to={forumPath(policy.forum.id)}>{policy.forum.title}</Link>
            </h3>
            {policy.forum.description && <p>{policy.forum.description}</p>}
            <p className="gate-line">
              Posting needs {gateInWords(policy.gate, policy.gate.anyOf.map((g) => data.groups.find((d) => d.id === g.group)))}.
            </p>
            <p className="meta">{head.s} entries in its signed log</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
