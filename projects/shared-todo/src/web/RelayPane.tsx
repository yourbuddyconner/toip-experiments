import type { World } from "../todo/world";

export function RelayPane({ world }: { world: World }) {
  const held = world.relay.held();
  return (
    <section className="note relay" data-person="relay" aria-label="The relay">
      <header className="note-head">
        <h2>Relay</h2>
        <span className="role">hosted by anyone</span>
      </header>
      <p className="relay-note">Keeps sealed messages for phones that are offline. It can't open them, and it can't change them without breaking their seal.</p>
      <h3>Holding</h3>
      {held.length === 0 ? (
        <p className="empty">Nothing right now.</p>
      ) : (
        <ul className="held">
          {held.map((m, i) => (
            <li key={i}>
              <span>
                Sealed for {world.nameOf(m.to)}, left by {world.nameOf(m.from)}, {m.bytes} bytes
              </span>
              <code>{m.head}…</code>
            </li>
          ))}
        </ul>
      )}
      <h3>What I can read</h3>
      <p className="empty">Nothing. Only who each message is for, who left it, and how big it is.</p>
    </section>
  );
}
