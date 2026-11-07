// anon-membership: the gate statement, shared by every compiled depth.
//
// "I know a secret whose leaf is in one of these group roots, the leaf's attributes meet
// these predicates, it has not expired, it was registered by this day, and this is my
// nullifier for this scope and message index." The proof hides which group and which leaf.
use poseidon::poseidon2::Poseidon2;

mod tests;
mod vectors;

// Domain tags. Each hash starts with one, so a value made for one purpose can't pass as another.
pub global COMMIT: Field = 1;
pub global NULLIFIER: Field = 2;
pub global NODE: Field = 3;
pub global LEAF: Field = 4;

pub global GROUPS: u32 = 4;
pub global SLOTS: u32 = 4;
pub global OP_ANY: u8 = 0;
pub global OP_EQ: u8 = 1;
pub global OP_GTE: u8 = 2;
pub global OP_LTE: u8 = 3;
pub global MAX_LIMIT: u32 = 65536;

/// H: Poseidon2 sponge over BN254, as noir-lang/poseidon v0.4.0 and Barretenberg compute it.
pub fn h<let N: u32>(inputs: [Field; N]) -> Field {
    Poseidon2::hash(inputs, N)
}

pub fn commitment(secret: Field, group_id: Field) -> Field {
    h([COMMIT, secret, group_id])
}

pub fn leaf_hash(
    commitment: Field,
    schema_id: Field,
    valid_until_day: u64,
    registered_day: u64,
    attrs: [Field; 4],
) -> Field {
    h(
        [
            LEAF, commitment, schema_id, valid_until_day as Field, registered_day as Field, attrs[0],
            attrs[1], attrs[2], attrs[3],
        ],
    )
}

pub fn nullifier(secret: Field, scope: Field, k: u32) -> Field {
    h([NULLIFIER, secret, scope, k as Field])
}

/// The root over `leaf` at `index`. `siblings` is the path, leaf level first.
/// Decomposing `index` into D bits also checks that it is below 2^D.
pub fn merkle_root<let D: u32>(leaf: Field, index: Field, siblings: [Field; D]) -> Field {
    let bits: [bool; D] = index.to_le_bits();
    let mut node = leaf;
    for i in 0..D {
        let (l, r) = if bits[i] { (siblings[i], node) } else { (node, siblings[i]) };
        node = h([NODE, l, r]);
    }
    node
}

/// One predicate on one attribute slot. Range ops compare as 64-bit integers, and both
/// values must fit in 64 bits.
pub fn check_predicate(op: u8, attr: Field, operand: Field) {
    assert(op <= OP_LTE, "unknown op");
    let ranged = (op == OP_GTE) | (op == OP_LTE);
    let a = if ranged { attr } else { 0 };
    let b = if ranged { operand } else { 0 };
    a.assert_max_bit_size::<64>();
    b.assert_max_bit_size::<64>();
    let (a, b) = (a as u64, b as u64);
    if op == OP_EQ {
        assert(attr == operand, "attribute not equal");
    }
    if op == OP_GTE {
        assert(a >= b, "attribute below the bound");
    }
    if op == OP_LTE {
        assert(a <= b, "attribute above the bound");
    }
}

pub fn gate<let D: u32>(
    secret: Field,
    group_index: u32,
    valid_until_day: u64,
    registered_day: u64,
    attrs: [Field; SLOTS],
    index: Field,
    siblings: [Field; D],
    k: u32,
    group_ids: [Field; GROUPS],
    roots: [Field; GROUPS],
    schema_id: Field,
    today: u64,
    registered_by: u64,
    ops: [u8; SLOTS],
    operands: [Field; SLOTS],
    scope: Field,
    limit: u32,
    signal: Field,
) -> Field {
    // Pick the group without branching on which one it is.
    let mut group_id = 0;
    let mut root = 0;
    let mut hits = 0;
    for i in 0..GROUPS {
        let hit = (group_index == i) as Field;
        group_id += hit * group_ids[i];
        root += hit * roots[i];
        hits += hit;
    }
    assert(hits == 1, "group index out of range");
    assert(root != 0, "empty group slot");

    let c = commitment(secret, group_id);
    let leaf = leaf_hash(c, schema_id, valid_until_day, registered_day, attrs);
    assert(merkle_root(leaf, index, siblings) == root, "leaf not under the root");

    assert(valid_until_day >= today, "membership expired");
    assert(registered_day <= registered_by, "registered too recently");
    for j in 0..SLOTS {
        check_predicate(ops[j], attrs[j], operands[j]);
    }

    assert(limit <= MAX_LIMIT, "limit too large");
    assert(k < limit, "message index not below the limit");
    assert(scope != 0, "zero scope");

    // `signal` takes part in no constraint. It is a public input, so it is in the proof's
    // transcript; tests check that changing it makes verification fail.
    let _ = signal;
    nullifier(secret, scope, k)
}
