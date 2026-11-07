import { groupFieldOf } from "./encode";
import type { Field } from "./field";
import { commitmentOf, leafHash, plainLeaf, type Leaf } from "./hash";
import { MembershipError } from "./prove";
import type { Predicate, Statement, Witness } from "./statement";
import type { GroupTree } from "./tree";

export interface MembershipInputsOptions {
  secret: Field;
  /** The statement's group slots, in order. Each tree must be the group's tree at the root you prove against. */
  groups: { group: string | Field; tree: GroupTree }[];
  /** The leaf's other fields, as the issuer recorded them. Default: a plain leaf. */
  leaf?: Omit<Leaf, "commitment">;
  scope: Field;
  signal: Field;
  today: number;
  registeredBy?: number;
  schemaId?: Field;
  predicates?: Predicate[];
  limit?: number;
  messageIndex?: number;
}

/**
 * Finds the member's leaf in one of the groups and builds the statement and witness to prove.
 * Throws MembershipError if no group holds the leaf. Searching the whole snapshot means no request
 * ever names an index.
 */
export function membershipInputs(o: MembershipInputsOptions): { statement: Statement; witness: Witness } {
  const ids = o.groups.map((g) => (typeof g.group === "string" ? groupFieldOf(g.group) : g.group));
  const statement: Statement = {
    groups: o.groups.map((g, i) => ({ groupId: ids[i], root: g.tree.root() })),
    schemaId: o.schemaId ?? o.leaf?.schemaId ?? 0n,
    today: o.today,
    registeredBy: o.registeredBy ?? o.today,
    predicates: o.predicates ?? [],
    scope: o.scope,
    limit: o.limit ?? 1,
    signal: o.signal,
  };
  for (let g = 0; g < o.groups.length; g++) {
    const commitment = commitmentOf(o.secret, ids[g]);
    const leaf: Leaf = o.leaf ? { ...o.leaf, commitment } : plainLeaf(commitment);
    const index = o.groups[g].tree.indexOf(leafHash(leaf));
    if (index >= 0) {
      return { statement, witness: { secret: o.secret, groupIndex: g, leaf, path: o.groups[g].tree.path(index), messageIndex: o.messageIndex } };
    }
  }
  throw new MembershipError("not a member: no group holds this secret's leaf");
}
