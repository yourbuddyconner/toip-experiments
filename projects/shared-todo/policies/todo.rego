# Who may do what to the "Maple St House" list (design 4.6).
# Evaluated on every member's device, for every operation, before it is applied.
package todo.authz

import rego.v1

# Kinds each role may always do.
allowed := {
	"admin": {"add", "check", "uncheck", "edit", "delete", "invite", "revoke"},
	"editor": {"add", "check", "uncheck", "edit"},
	"viewer": set(),
}

item_kinds := {"check", "uncheck", "edit", "delete"}

role_ok if input.kind in allowed[input.role]

# An editor may delete only items they added.
role_ok if {
	input.role == "editor"
	input.kind == "delete"
	input.isItemAuthor
}

role_reasons := [] if role_ok

role_reasons := [sprintf("%s may not %s", [input.role, input.kind])] if not role_ok

# On a private item, only its readers may change it, whatever their role.
reader_reasons := ["not a reader of this item"] if {
	input.itemPrivate
	not input.isReader
	input.kind in item_kinds
}

default reader_reasons := []

reasons := array.concat(reader_reasons, role_reasons)

decision := {"allow": count(reasons) == 0, "reasons": reasons}
