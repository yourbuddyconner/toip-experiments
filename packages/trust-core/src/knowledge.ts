import type { Clock } from "./clock";

/** What one agent has learned about another, and how. Drives the "what I know" view and the disclosure tests. */
export interface Fact {
  about: string;
  what: string;
  value?: string;
  how: string;
  at: string;
}

export class KnowledgeLog {
  private readonly facts: Fact[] = [];

  constructor(private readonly clock: Clock) {}

  add(f: Omit<Fact, "at">): void {
    this.facts.push({ ...f, at: this.clock.iso() });
  }

  list(): readonly Fact[] {
    return this.facts;
  }

  about(did: string): Fact[] {
    return this.facts.filter((f) => f.about === did);
  }
}
