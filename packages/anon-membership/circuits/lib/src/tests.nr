// Circuit tests. Each `should_fail` test changes one thing in a valid witness.
use crate::{commitment, gate, h, leaf_hash, merkle_root, nullifier, NODE};

global D: u32 = 20;
global TODAY: u64 = 20763; // 2026-11-06, in days since 1970-01-01
global GROUP_A: Field = 0xaa;
global GROUP_B: Field = 0xbb;
global SCHEMA: Field = 0x5c;
global SECRET: Field = 0x1234567;
global SCOPE: Field = 0x5c09e;
global SIGNAL: Field = 0x5161;

// The zero hashes of an empty tree: Z[0] = 0, Z[i+1] = H(NODE, Z[i], Z[i]).
fn zeros() -> [Field; D] {
    let mut z = [0; D];
    for i in 1..D {
        z[i] = h([NODE, z[i - 1], z[i - 1]]);
    }
    z
}

struct Case {
    secret: Field,
    group_index: u32,
    valid_until_day: u64,
    registered_day: u64,
    attrs: [Field; 4],
    index: Field,
    siblings: [Field; D],
    k: u32,
    group_ids: [Field; 4],
    roots: [Field; 4],
    schema_id: Field,
    today: u64,
    registered_by: u64,
    ops: [u8; 4],
    operands: [Field; 4],
    scope: Field,
    limit: u32,
    signal: Field,
}

// A member of group B (slot 1), alone at leaf 5 of an otherwise empty tree.
// Group A (slot 0) has some other root. Attributes: [hash("RN"), 7, 1000, 0].
fn valid() -> Case {
    let attrs = [0x524e, 7, 1000, 0];
    let c = commitment(SECRET, GROUP_B);
    let leaf = leaf_hash(c, SCHEMA, TODAY + 30, TODAY - 10, attrs);
    let siblings = zeros();
    let root = merkle_root(leaf, 5, siblings);
    Case {
        secret: SECRET,
        group_index: 1,
        valid_until_day: TODAY + 30,
        registered_day: TODAY - 10,
        attrs,
        index: 5,
        siblings,
        k: 0,
        group_ids: [GROUP_A, GROUP_B, 0, 0],
        roots: [0x1111, root, 0, 0],
        schema_id: SCHEMA,
        today: TODAY,
        registered_by: TODAY - 7,
        ops: [1, 2, 3, 0],
        operands: [0x524e, 5, 2000, 0],
        scope: SCOPE,
        limit: 1,
        signal: SIGNAL,
    }
}

fn run(c: Case) -> Field {
    gate(
        c.secret,
        c.group_index,
        c.valid_until_day,
        c.registered_day,
        c.attrs,
        c.index,
        c.siblings,
        c.k,
        c.group_ids,
        c.roots,
        c.schema_id,
        c.today,
        c.registered_by,
        c.ops,
        c.operands,
        c.scope,
        c.limit,
        c.signal,
    )
}

#[test]
fn a_valid_witness_gives_the_nullifier() {
    assert(run(valid()) == nullifier(SECRET, SCOPE, 0));
}

#[test]
fn each_group_slot_works() {
    for g in 0..4 {
        let mut c = valid();
        let mut ids = [0x10, 0x20, 0x30, 0x40];
        let mut roots = [0x1, 0x2, 0x3, 0x4];
        ids[g] = GROUP_B;
        roots[g] = c.roots[1];
        c.group_ids = ids;
        c.roots = roots;
        c.group_index = g;
        assert(run(c) == nullifier(SECRET, SCOPE, 0));
    }
}

#[test]
fn the_nullifier_does_not_depend_on_the_group() {
    // The same secret in group A at another index gives the same nullifier.
    let mut c = valid();
    let leaf = leaf_hash(commitment(SECRET, GROUP_A), SCHEMA, c.valid_until_day, c.registered_day, c.attrs);
    c.roots = [merkle_root(leaf, 9, c.siblings), 0x2222, 0, 0];
    c.index = 9;
    c.group_index = 0;
    assert(run(c) == run(valid()));
}

#[test]
fn the_rate_limit_index_changes_the_nullifier() {
    let mut c = valid();
    c.limit = 3;
    c.k = 2;
    let n2 = run(c);
    assert(n2 == nullifier(SECRET, SCOPE, 2));
    assert(n2 != run(valid()));
}

#[test(should_fail_with = "leaf not under the root")]
fn a_leaf_in_no_root_fails() {
    let mut c = valid();
    c.roots[1] = 0x3333;
    let _ = run(c);
}

#[test(should_fail_with = "leaf not under the root")]
fn the_wrong_secret_fails() {
    let mut c = valid();
    c.secret = SECRET + 1;
    let _ = run(c);
}

#[test(should_fail_with = "leaf not under the root")]
fn a_changed_sibling_fails() {
    let mut c = valid();
    c.siblings[7] = 1;
    let _ = run(c);
}

#[test(should_fail_with = "leaf not under the root")]
fn a_flipped_index_bit_fails() {
    let mut c = valid();
    c.index = 4;
    let _ = run(c);
}

#[test(should_fail)]
fn an_index_of_two_to_the_depth_fails() {
    // 2^20 + 5 has the same low 20 bits as 5, so only the range check stops it.
    let mut c = valid();
    c.index = 1048576 + 5;
    let _ = run(c);
}

#[test(should_fail_with = "empty group slot")]
fn selecting_a_zero_root_fails() {
    // A slot whose root is 0 can't be used, even with a leaf that hashes to it.
    let mut c = valid();
    c.group_ids = [GROUP_A, 0, 0, 0];
    c.roots = [0x1111, 0, 0, 0];
    let _ = run(c);
}

#[test(should_fail_with = "group index out of range")]
fn a_group_index_past_the_slots_fails() {
    let mut c = valid();
    c.group_index = 4;
    let _ = run(c);
}

#[test(should_fail_with = "leaf not under the root")]
fn the_wrong_group_id_in_the_commitment_fails() {
    let mut c = valid();
    c.group_ids[1] = GROUP_A;
    let _ = run(c);
}

#[test(should_fail_with = "membership expired")]
fn expired_membership_fails() {
    let mut c = valid();
    c.today = c.valid_until_day + 1;
    c.registered_by = c.today;
    let _ = run(c);
}

#[test]
fn membership_on_its_last_day_passes() {
    let mut c = valid();
    c.today = c.valid_until_day;
    c.registered_by = c.today;
    let _ = run(c);
}

#[test(should_fail_with = "registered too recently")]
fn registration_after_registered_by_fails() {
    let mut c = valid();
    c.registered_by = c.registered_day - 1;
    let _ = run(c);
}

#[test(should_fail_with = "attribute not equal")]
fn an_unmet_equality_fails() {
    let mut c = valid();
    c.operands[0] = 0x4c504e;
    let _ = run(c);
}

#[test(should_fail_with = "attribute below the bound")]
fn an_unmet_at_least_fails() {
    let mut c = valid();
    c.operands[1] = 8;
    let _ = run(c);
}

#[test(should_fail_with = "attribute above the bound")]
fn an_unmet_at_most_fails() {
    let mut c = valid();
    c.operands[2] = 999;
    let _ = run(c);
}

#[test]
fn bounds_are_inclusive() {
    let mut c = valid();
    c.operands = [0x524e, 7, 1000, 0];
    let _ = run(c);
}

#[test(should_fail)]
fn a_range_value_over_64_bits_fails() {
    // The attribute itself is too big for a range predicate.
    let attrs = [0x524e, 0x10000000000000000, 1000, 0];
    let mut c = valid();
    let leaf = leaf_hash(commitment(SECRET, GROUP_B), SCHEMA, c.valid_until_day, c.registered_day, attrs);
    // Truncated to 64 bits the value is 0, which would meet "at most 2000".
    c.ops[1] = 3;
    c.operands[1] = 2000;
    c.attrs = attrs;
    c.roots[1] = merkle_root(leaf, 5, c.siblings);
    let _ = run(c);
}

#[test(should_fail)]
fn a_range_operand_over_64_bits_fails() {
    let mut c = valid();
    c.ops[1] = 2; // truncated to 64 bits the operand is 0, and 7 >= 0 would hold
    c.operands[1] = 0x10000000000000000;
    let _ = run(c);
}

#[test(should_fail_with = "unknown op")]
fn an_unknown_op_fails() {
    let mut c = valid();
    c.ops[3] = 4;
    let _ = run(c);
}

#[test]
fn op_any_ignores_the_slot() {
    let mut c = valid();
    c.ops = [0, 0, 0, 0];
    c.operands = [1, 2, 3, 4];
    let _ = run(c);
}

#[test(should_fail_with = "message index not below the limit")]
fn k_equal_to_the_limit_fails() {
    let mut c = valid();
    c.limit = 2;
    c.k = 2;
    let _ = run(c);
}

#[test(should_fail_with = "limit too large")]
fn a_limit_over_two_to_the_sixteen_fails() {
    let mut c = valid();
    c.limit = 65537;
    c.k = 65536;
    let _ = run(c);
}

#[test(should_fail_with = "message index not below the limit")]
fn a_limit_of_zero_fails() {
    let mut c = valid();
    c.limit = 0;
    let _ = run(c);
}

#[test(should_fail_with = "zero scope")]
fn a_zero_scope_fails() {
    let mut c = valid();
    c.scope = 0;
    let _ = run(c);
}
