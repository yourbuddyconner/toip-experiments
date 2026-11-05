package fixture

default decision := {"allow": false, "reasons": ["no rule matched"]}

decision := {"allow": true, "reasons": []} if input.role == "admin"

decision := {"allow": false, "reasons": [sprintf("%s may not %s", [input.role, input.kind])]} if input.role != "admin"
