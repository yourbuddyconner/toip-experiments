import { useState } from "react";
import { STEPS } from "../todo/scenario";
import { PersonPane, type PersonKey } from "./PersonPane";
import { RelayPane } from "./RelayPane";
import { WirePanel } from "./WirePanel";
import { useWorld } from "./useWorld";

const PEOPLE: PersonKey[] = ["alice", "bob", "carol", "mallory"];

export function App({ loadPolicy }: { loadPolicy: () => Promise<BufferSource> }) {
  const { world, error, next, previous, reset, perform } = useWorld(loadPolicy);
  const [free, setFree] = useState(false);

  if (!world) {
    return <main className="loading">{error ? `Could not start the demo: ${error}` : "Making everyone's keys…"}</main>;
  }

  const step = STEPS.find((s) => s.n === world.stepIndex) ?? STEPS[0];
  const last = world.stepIndex >= STEPS.length;

  return (
    <main className="fridge">
      <header className="controls">
        <div className="step">
          <p className="step-count">
            Step {step.n} of {STEPS.length}
          </p>
          <h1>{step.title}</h1>
          <p className="caption">{step.caption}</p>
        </div>
        <nav className="buttons" aria-label="Demo controls">
          <button onClick={() => void previous()} disabled={world.busy || world.stepIndex <= 1}>
            Previous step
          </button>
          <button className="primary" onClick={() => void next()} disabled={world.busy || last || free}>
            Next step
          </button>
          <button
            onClick={() => {
              setFree(false);
              void reset();
            }}
            disabled={world.busy}
          >
            Start over
          </button>
          <label className="toggle">
            <input type="checkbox" checked={free} onChange={(e) => setFree(e.target.checked)} />
            Free play
          </label>
        </nav>
        {error && <p className="error" role="alert">{error}</p>}
      </header>

      <section className="panes">
        {PEOPLE.map((k) => (
          <PersonPane key={k} world={world} who={k} free={free} perform={perform} />
        ))}
        <RelayPane world={world} />
      </section>

      <WirePanel world={world} />
    </main>
  );
}
