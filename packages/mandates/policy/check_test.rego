package mandates.check_test

import rego.v1

import data.mandates.check

link(id, issuer, subject, constraints) := {
	"id": id,
	"issuer": issuer,
	"subject": subject,
	"profile": "settle/1",
	"validFromS": 0,
	"validUntilS": 1000,
	"constraints": constraints,
	"delegation": {"maxDepth": 1},
	"escalation": {"approvable": ["perTx"], "approvalTtlSeconds": 60},
	"revocation": {"maxAgeSeconds": 60},
}

root := link("m0", "did:p", "did:a", {
	"actions": {"attr": "type", "anyOf": ["pay"]},
	"perTx": {"attr": "spend", "max": "30", "when": ["pay"]},
	"daily": {"attr": "spend", "budget": "100", "period": "P1D"},
	"cats": {"attr": "category", "within": ["software.*"]},
})

leaf := object.union(link("m1", "did:a", "did:b", object.union(root.constraints, {"perTx": {"attr": "spend", "max": "20", "when": ["pay"]}})), {"delegation": {"maxDepth": 0}})

base(chain, spend) := {
	"nowS": 10,
	"action": {"type": "pay", "attrs": {"spend": spend, "category": "software.ci"}},
	"actionHash": "sha256:a",
	"chain": chain,
	"structural": [],
	"approvalProblems": [],
	"state": {"spent": {"m0": {"P1D": "0"}, "m1": {"P1D": "0"}}},
	"approvals": [],
	"requirements": {"maxLinks": 3},
	"facts": {"rootCredentials": []},
}

test_allow_within_limits if {
	check.decision.outcome == "allow" with input as base([root, leaf], "20")
}

test_escalate_over_the_leaf_limit if {
	d := check.decision with input as base([root, leaf], "25")
	d.outcome == "escalate"
	d.approver == "did:a"
	count(d.reasons) == 1
}

test_escalate_over_both_goes_to_the_root if {
	d := check.decision with input as base([root, leaf], "31")
	d.outcome == "escalate"
	d.approver == "did:p"
}

test_approval_from_root_clears_both if {
	i := object.union(base([root, leaf], "31"), {"approvals": [{"id": "ap", "approverLink": 0, "actionHash": "sha256:a", "validUntilS": 100, "used": false}]})
	check.decision.outcome == "allow" with input as i
}

test_approval_from_link_1_leaves_link_0 if {
	i := object.union(base([root, leaf], "31"), {"approvals": [{"id": "ap", "approverLink": 1, "actionHash": "sha256:a", "validUntilS": 100, "used": false}]})
	d := check.decision with input as i
	d.outcome == "escalate"
	[r.link | some r in d.reasons] == [0]
}

test_structural_reason_denies if {
	i := object.union(base([root, leaf], "5"), {"structural": [{"code": "status.revoked", "link": 0, "approvable": false}]})
	check.decision.outcome == "deny" with input as i
}

test_widened_child_denies if {
	wide := object.union(leaf, {"constraints": object.union(root.constraints, {"perTx": {"attr": "spend", "max": "50", "when": ["pay"]}})})
	d := check.decision with input as base([root, wide], "5")
	d.outcome == "deny"
	[r.code | some r in d.reasons] == ["narrowing.widened"]
}

test_dropped_dimension if {
	# object.union merges deeply, so replace the constraints by removing them first.
	dropped := object.union(object.remove(leaf, ["constraints"]), {"constraints": object.remove(leaf.constraints, ["cats"])})
	r := check.narrowing with input as {"chain": [root, dropped]}
	[x.code | some x in r.reasons] == ["narrowing.dropped"]
}

test_bad_number_fails_closed if {
	d := check.decision with input as base([root], "lots")
	d.outcome != "allow"
}

test_budget_exceeded if {
	i := object.union(base([root], "10"), {"state": {"spent": {"m0": {"P1D": "95"}}}})
	d := check.decision with input as i
	[r.code | some r in d.reasons] == ["budget.exceeded"]
}

test_missing_spend_state if {
	i := object.union(object.remove(base([root], "10"), ["state"]), {"state": {"spent": {}}})
	d := check.decision with input as i
	d.outcome == "deny"
	[r.attr | some r in d.reasons] == ["spent.P1D"]
}

test_empty_chain_denies if {
	d := check.decision with input as base([], "1")
	d.outcome == "deny"
}

test_wildcard_coverage if {
	check.covered("software.tests.*", "software.*")
	check.covered("software.ci", "software.*")
	not check.covered("software.*", "software.ci")
	not check.covered("software", "software.*")
}
