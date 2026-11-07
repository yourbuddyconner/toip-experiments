"""Reads a KERI 1.0 CESR text stream on stdin and prints the key state KERIpy computes, as JSON.

Usage: python keripy_check.py < kel.cesr

Prints one object per identifier KERIpy accepted:
  {"<aid>": {"i", "s", "d", "kt", "k", "nt", "n", "bt", "b"}}
Events KERIpy escrows (for example, not yet witnessed) are not in the key state.
"""
import json
import sys

from dataclasses import asdict

from keri.core import eventing, parsing
from keri.db import basing


def main():
    stream = sys.stdin.buffer.read()
    with basing.openDB(name="eventlog-interop", temp=True) as db:
        kvy = eventing.Kevery(db=db, lax=False, local=False)
        parser = parsing.Parser(kvy=kvy)
        parser.parse(ims=bytearray(stream))
        out = {}
        for pre, kever in kvy.kevers.items():
            st = asdict(kever.state())
            out[pre] = {
                "i": st["i"],
                "s": int(st["s"], 16),
                "d": st["d"],
                "kt": st["kt"],
                "k": st["k"],
                "nt": st["nt"],
                "n": st["n"],
                "bt": st["bt"],
                "b": st["b"],
            }
        print(json.dumps(out))


if __name__ == "__main__":
    main()
