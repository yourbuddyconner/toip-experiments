# mandates/check/1: narrowing and decisions for delegation chains (agents design §7, §8).
#
# TypeScript has already checked signatures, links, the presenter, time, status lists and approvals'
# signatures (steps 1 to 8 and part of 11). It passes plain facts here. This policy decides
# narrowing (step 9), the action against every link (step 10), which approvals clear what (11),
# the verifier's requirements (12) and the outcome (13).
#
# Every check is written as "not ok(...)", so a rule that can't be evaluated (a bad value,
# a builtin error) counts as a failure, never as a pass.
package mandates.check

import rego.v1

# ---------------------------------------------------------------- helpers

ops := ["anyOf", "noneOf", "within", "is", "max", "min", "budget"]

approvable_codes := {"constraint.failed", "budget.exceeded"}

member(x, xs) if {
	some e in xs
	e == x
}

has_key(obj, k) if {
	_ = obj[k]
}

op_of(c) := o if {
	some o in ops
	has_key(c, o)
}

num(x) := x if is_number(x)

num(x) := to_number(x) if {
	is_string(x)
	regex.match(`^(0|[1-9][0-9]{0,15})$`, x)
}

is_wild(p) if endswith(p, ".*")

is_wild(p) if endswith(p, "/*")

prefix(p) := trim_suffix(p, "*")

matches(v, p) if {
	is_string(v)
	v == p
}

matches(v, p) if {
	is_string(v)
	is_wild(p)
	startswith(v, prefix(p))
}

# A child pattern c is covered by a parent pattern p if they're equal, or p is a wildcard
# and c, without a trailing "*", starts with p's prefix.
covered(c, p) if c == p

covered(c, p) if {
	is_wild(p)
	startswith(trim_suffix(c, "*"), prefix(p))
}

# ---------------------------------------------------------------- narrowing (step 9)

same_meaning(pc, cc) if {
	pc.attr == cc.attr
	op_of(pc) == op_of(cc)
	not has_key(pc, "budget")
}

same_meaning(pc, cc) if {
	pc.attr == cc.attr
	has_key(pc, "budget")
	has_key(cc, "budget")
	pc.period == cc.period
}

narrower(pc, cc) if {
	op_of(pc) == "anyOf"
	every e in cc.anyOf {
		member(e, pc.anyOf)
	}
}

narrower(pc, cc) if {
	op_of(pc) == "noneOf"
	every e in pc.noneOf {
		member(e, cc.noneOf)
	}
}

narrower(pc, cc) if {
	op_of(pc) == "within"
	every e in cc.within {
		some p in pc.within
		covered(e, p)
	}
}

narrower(pc, cc) if {
	op_of(pc) == "is"
	cc.is == pc.is
}

narrower(pc, cc) if {
	op_of(pc) == "max"
	num(cc.max) <= num(pc.max)
}

narrower(pc, cc) if {
	op_of(pc) == "min"
	num(cc.min) >= num(pc.min)
}

narrower(pc, cc) if {
	op_of(pc) == "budget"
	num(cc.budget) <= num(pc.budget)
}

# A child's `when` must be the same as or wider than the parent's. No `when` applies to everything.
when_ok(_, cc) if not has_key(cc, "when")

when_ok(pc, cc) if {
	has_key(pc, "when")
	has_key(cc, "when")
	every w in pc.when {
		member(w, cc.when)
	}
}

depth_ok(p, c) if c.delegation.maxDepth <= p.delegation.maxDepth - 1

window_ok(p, c) if {
	c.validFromS >= p.validFromS
	c.validUntilS <= p.validUntilS
}

revocation_ok(p, c) if c.revocation.maxAgeSeconds <= p.revocation.maxAgeSeconds

has_escalation(l) if is_object(l.escalation)

has_passport if is_object(input.facts.passport)

escalation_ok(_, c) if not has_escalation(c)

escalation_ok(p, c) if {
	has_escalation(c)
	has_escalation(p)
	every a in c.escalation.approvable {
		member(a, p.escalation.approvable)
	}
	c.escalation.approvalTtlSeconds <= p.escalation.approvalTtlSeconds
}

narrowing_reasons contains r if {
	some i, c in input.chain
	i > 0
	p := input.chain[i - 1]
	some name, pc in p.constraints
	not has_key(c.constraints, name)
	r := {"code": "narrowing.dropped", "link": i, "dimension": name, "op": op_of(pc), "attr": pc.attr, "approvable": false}
}

narrowing_reasons contains r if {
	some i, c in input.chain
	i > 0
	p := input.chain[i - 1]
	some name, pc in p.constraints
	cc := c.constraints[name]
	not same_meaning(pc, cc)
	r := {"code": "narrowing.changedMeaning", "link": i, "dimension": name, "op": op_of(pc), "attr": pc.attr, "approvable": false}
}

narrowing_reasons contains r if {
	some i, c in input.chain
	i > 0
	p := input.chain[i - 1]
	some name, pc in p.constraints
	cc := c.constraints[name]
	same_meaning(pc, cc)
	op := op_of(pc)
	not narrower(pc, cc)
	r := {"code": "narrowing.widened", "link": i, "dimension": name, "op": op, "attr": pc.attr, "limit": pc[op], "value": cc[op], "approvable": false}
}

narrowing_reasons contains r if {
	some i, c in input.chain
	i > 0
	p := input.chain[i - 1]
	some name, pc in p.constraints
	cc := c.constraints[name]
	same_meaning(pc, cc)
	not when_ok(pc, cc)
	r := {"code": "narrowing.widened", "link": i, "dimension": name, "op": "when", "attr": pc.attr, "limit": object.get(pc, "when", null), "value": object.get(cc, "when", null), "approvable": false}
}

narrowing_reasons contains r if {
	some i, c in input.chain
	i > 0
	p := input.chain[i - 1]
	not depth_ok(p, c)
	r := {"code": "narrowing.depth", "link": i, "limit": p.delegation.maxDepth - 1, "value": c.delegation.maxDepth, "approvable": false}
}

narrowing_reasons contains r if {
	some i, c in input.chain
	i > 0
	p := input.chain[i - 1]
	not window_ok(p, c)
	r := {"code": "narrowing.window", "link": i, "approvable": false}
}

narrowing_reasons contains r if {
	some i, c in input.chain
	i > 0
	p := input.chain[i - 1]
	not escalation_ok(p, c)
	r := {"code": "narrowing.escalation", "link": i, "approvable": false}
}

narrowing_reasons contains r if {
	some i, c in input.chain
	i > 0
	p := input.chain[i - 1]
	not revocation_ok(p, c)
	r := {"code": "narrowing.revocation", "link": i, "limit": p.revocation.maxAgeSeconds, "value": c.revocation.maxAgeSeconds, "approvable": false}
}

# ---------------------------------------------------------------- the action (step 10)

leaf := count(input.chain) - 1

applies(c) if not has_key(c, "when")

applies(c) if member(input.action.type, c.when)

has_value("type") if input.action.type

has_value(attr) if {
	attr != "type"
	has_key(input.action.attrs, attr)
}

value("type") := input.action.type

value(attr) := input.action.attrs[attr] if attr != "type"

strings(v) if {
	is_array(v)
	every e in v {
		is_string(e)
	}
}

satisfied(c, v) if {
	op_of(c) == "anyOf"
	is_string(v)
	member(v, c.anyOf)
}

satisfied(c, v) if {
	op_of(c) == "anyOf"
	strings(v)
	some e in v
	member(e, c.anyOf)
}

satisfied(c, v) if {
	op_of(c) == "noneOf"
	is_string(v)
	not member(v, c.noneOf)
}

satisfied(c, v) if {
	op_of(c) == "noneOf"
	strings(v)
	every e in v {
		not member(e, c.noneOf)
	}
}

satisfied(c, v) if {
	op_of(c) == "within"
	some p in c.within
	matches(v, p)
}

satisfied(c, v) if {
	op_of(c) == "within"
	strings(v)
	count(v) > 0
	every e in v {
		some p in c.within
		matches(e, p)
	}
}

satisfied(c, v) if {
	op_of(c) == "is"
	v == c.is
}

satisfied(c, v) if {
	op_of(c) == "max"
	num(v) <= num(c.max)
}

satisfied(c, v) if {
	op_of(c) == "min"
	num(v) >= num(c.min)
}

approvable(name) if {
	member(name, input.chain[leaf].escalation.approvable)
} else := false

action_reasons contains r if {
	some i, link in input.chain
	some name, c in link.constraints
	op := op_of(c)
	op != "budget"
	applies(c)
	not has_value(c.attr)
	r := {"code": "attr.missing", "link": i, "dimension": name, "op": op, "attr": c.attr, "approvable": false}
}

action_reasons contains r if {
	some i, link in input.chain
	some name, c in link.constraints
	op := op_of(c)
	op != "budget"
	applies(c)
	has_value(c.attr)
	v := value(c.attr)
	not satisfied(c, v)
	r := {"code": "constraint.failed", "link": i, "dimension": name, "op": op, "attr": c.attr, "limit": c[op], "value": v, "approvable": approvable(name)}
}

# Budgets: the leaf only (§8.6). Spent in the period + the action's spend <= budget.
has_spent(period) if is_string(input.state.spent[input.chain[leaf].id][period])

budget_ok(spent, c) if num(spent) + num(input.action.attrs.spend) <= num(c.budget)

leaf_budgets[name] := c if {
	some name, c in input.chain[leaf].constraints
	has_key(c, "budget")
	applies(c)
}

action_reasons contains r if {
	some name, c in leaf_budgets
	not has_spent(c.period)
	r := {"code": "attr.missing", "link": leaf, "dimension": name, "op": "budget", "attr": concat(".", ["spent", c.period]), "approvable": false}
}

action_reasons contains r if {
	some name, c in leaf_budgets
	spent := input.state.spent[input.chain[leaf].id][c.period]
	not budget_ok(spent, c)
	r := {"code": "budget.exceeded", "link": leaf, "dimension": name, "op": "budget", "attr": c.attr, "limit": c.budget, "value": input.action.attrs.spend, "spent": spent, "period": c.period, "approvable": approvable(name)}
}

# ---------------------------------------------------------------- approvals (step 11)

# TypeScript passes only approvals whose signatures and bindings it checked. An approval from the
# issuer of link j clears approvable failures at links j and below.
cleared(r) if {
	r.approvable == true
	some a in input.approvals
	a.actionHash == input.actionHash
	a.used == false
	a.validUntilS > input.nowS
	a.approverLink >= 0
	a.approverLink <= r.link
}

uncleared contains r if {
	some r in action_reasons
	not cleared(r)
}

# ---------------------------------------------------------------- requirements (step 12)

requirement_reasons contains r if {
	count(input.chain) > input.requirements.maxLinks
	r := {"code": "requirement.failed", "requirement": "maxLinks", "limit": input.requirements.maxLinks, "value": count(input.chain), "approvable": false}
}

requirement_reasons contains r if {
	some need in input.requirements.rootMustHold
	not member(need, input.facts.rootCredentials)
	r := {"code": "requirement.failed", "requirement": "rootMustHold", "limit": need, "approvable": false}
}

requirement_reasons contains r if {
	input.requirements.passport == "required"
	not has_passport
	r := {"code": "requirement.failed", "requirement": "passport", "approvable": false}
}

requirement_reasons contains r if {
	input.requirements.passportIssuerMustBeRoot == true
	has_passport
	input.facts.passport.issuer != input.chain[0].issuer
	r := {"code": "requirement.failed", "requirement": "passportIssuerMustBeRoot", "limit": input.chain[0].issuer, "value": input.facts.passport.issuer, "approvable": false}
}

# ---------------------------------------------------------------- the outcome (step 13)

structural_reasons contains r if some r in input.structural

structural_reasons contains r if some r in input.approvalProblems

# Defense in depth: TypeScript never sends an empty chain without a reason.
structural_reasons contains {"code": "chain.malformed", "detail": "no links", "approvable": false} if {
	count(input.chain) == 0
	count(input.structural) == 0
}

# A test hook: with the narrowing step switched off, the per-link check must still hold.
narrowing_used := set() if {
	input.options.skipNarrowing == true
} else := narrowing_reasons

all_reasons := ((structural_reasons | narrowing_used) | uncleared) | requirement_reasons

escalatable if {
	count(all_reasons) > 0
	every r in all_reasons {
		r.approvable == true
		approvable_codes[r.code]
	}
}

outcome := "allow" if {
	count(all_reasons) == 0
} else := "escalate" if {
	escalatable
} else := "deny"

# The approver is the issuer of the lowest-numbered link with a failure.
approver := input.chain[min({r.link | some r in all_reasons})].issuer if {
	outcome == "escalate"
} else := null

decision := {"outcome": outcome, "reasons": all_reasons, "approver": approver}

narrowing := {"reasons": narrowing_reasons}
