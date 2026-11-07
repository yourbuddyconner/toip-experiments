// anon-membership/v1/gate-d20: the gate circuit at depth 20.
// Public inputs, in this order: group_ids[4], roots[4], schema_id, today, registered_by,
// ops[4], operands[4], scope, limit, signal. Then the returned nullifier.
use anon_membership::gate;

fn main(
    secret: Field,
    group_index: u32,
    valid_until_day: u64,
    registered_day: u64,
    attrs: [Field; 4],
    index: Field,
    siblings: [Field; 20],
    k: u32,
    group_ids: pub [Field; 4],
    roots: pub [Field; 4],
    schema_id: pub Field,
    today: pub u64,
    registered_by: pub u64,
    ops: pub [u8; 4],
    operands: pub [Field; 4],
    scope: pub Field,
    limit: pub u32,
    signal: pub Field,
) -> pub Field {
    gate(
        secret,
        group_index,
        valid_until_day,
        registered_day,
        attrs,
        index,
        siblings,
        k,
        group_ids,
        roots,
        schema_id,
        today,
        registered_by,
        ops,
        operands,
        scope,
        limit,
        signal,
    )
}
