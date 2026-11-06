# settle/policies/attested-completion/1 (design §8).
# Each signer's device evaluates this before signing an outcome for an escrow.
# The proposal is "pay the payee `payeeUnits`, the rest back to the payer".
package settle.attested_completion

import rego.v1

full if input.proposal.payeeUnits == input.terms.amountUnits

ruling_matches if {
	input.ruling != null
	input.proposal.payeeUnits == input.ruling.payeeUnits
}

# The attester's latest verified word, timed from when this party received it (computed by the agent).
attested_complete if input.completion.claim == "complete"

window_passed if {
	attested_complete
	input.now >= input.completion.atSeconds + input.terms.disputeWindowSeconds
}

disputed if count(input.disputes) > 0

# The payer signs a full release once the attester says it's done and the window passed with no dispute,
# or anything the arbiter ruled.
payer_ok if {
	full
	attested_complete
	window_passed
	not disputed
}

payer_ok if ruling_matches

# The payee signs any full release, anything the arbiter ruled, or a full refund it chose to offer.
payee_ok if full

payee_ok if ruling_matches

# A full refund the payee offered: the payee signs it, and the payer signs it once the payee has.
# The agent sets payeeCancels only for its own refund offer (payee) or a refund it verified the payee signed (payer).
payee_cancels if {
	input.proposal.payeeUnits == "0"
	input.payeeCancels
}

payee_ok if payee_cancels

payer_ok if payee_cancels

# The arbiter signs only its own ruling.
arbiter_ok if ruling_matches

sign if {
	input.role == "payer"
	payer_ok
}

sign if {
	input.role == "payee"
	payee_ok
}

sign if {
	input.role == "arbiter"
	arbiter_ok
}

reasons contains "the work hasn't been attested complete" if {
	input.role == "payer"
	full
	not attested_complete
	not ruling_matches
}

reasons contains "the dispute window hasn't passed" if {
	input.role == "payer"
	full
	attested_complete
	not window_passed
	not ruling_matches
}

reasons contains "there is an open dispute" if {
	input.role == "payer"
	full
	disputed
	not ruling_matches
}

reasons contains "a partial payout needs an arbiter's ruling" if {
	not full
	not ruling_matches
	not payee_cancels
}

reasons contains "the arbiter only signs its own ruling" if {
	input.role == "arbiter"
	not ruling_matches
}

default sign := false

decision := {"sign": sign, "reasons": reasons}
