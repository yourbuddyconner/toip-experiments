"""Builds KELs with KERIpy, for the "we accept KERIpy's" tests. Salts are fixed, so Ed25519 output is stable.

Usage: python keripy_make.py > ../tests/fixtures/keripy-kels.json

Also prints known-answer vectors: secrets, public keys and next-key digests.
"""
import json

from keri.core import coring, eventing, signing
from keri.core.coring import MtrDex


def salter(tag):
    return signing.Salter(raw=(tag * 16)[:16].encode())


def ed_signers(tag, count, transferable=True):
    return salter(tag).signers(count=count, transferable=transferable, temp=True)


def dig(verfer):
    return coring.Diger(ser=verfer.qb64b, code=MtrDex.Blake3_256).qb64


def msg(serder, sigers, wigers=None):
    return eventing.messagize(serder, sigers=sigers, wigers=wigers).decode()


def witnessed(serder, sigers, wits):
    wigers = [w.sign(serder.raw, index=i) for i, w in enumerate(wits)]
    return msg(serder, sigers, wigers)


def state(pre, serder, kt, keys, nt, ndigs, bt, wits):
    return {"i": pre, "s": int(serder.ked["s"], 16), "d": serder.said, "kt": kt, "k": keys, "nt": nt, "n": ndigs, "bt": bt, "b": wits}


def basic():
    """icp with 3 witnesses (bt 2), ixn with a seal, rot cutting w3 and adding w4."""
    keys = ed_signers("a", 3)
    ws = ed_signers("w", 4, transferable=False)
    w = [x.verfer.qb64 for x in ws]
    icp = eventing.incept(keys=[keys[0].verfer.qb64], ndigs=[dig(keys[1].verfer)], code=MtrDex.Blake3_256,
                          wits=w[:3], toad=2)
    pre = icp.pre
    out = [witnessed(icp, [keys[0].sign(icp.raw, index=0)], ws[:3])]
    seal = {"i": "EBy-4XLcIHjt9TfGwJu_qGU8nhZrB5BzbBgE6X-M9SbO", "s": "3", "d": "EBy-4XLcIHjt9TfGwJu_qGU8nhZrB5BzbBgE6X-M9SbO"}
    ixn = eventing.interact(pre, dig=icp.said, sn=1, data=[seal])
    out.append(witnessed(ixn, [keys[0].sign(ixn.raw, index=0)], ws[:3]))
    rot = eventing.rotate(pre, keys=[keys[1].verfer.qb64], dig=ixn.said, sn=2, ndigs=[dig(keys[2].verfer)],
                          wits=w[:3], cuts=[w[2]], adds=[w[3]], toad=2)
    new_wits = [ws[0], ws[1], ws[3]]
    out.append(witnessed(rot, [keys[1].sign(rot.raw, index=0)], new_wits))
    return {"name": "basic", "stream": "".join(out),
            "state": state(pre, rot, "1", [keys[1].verfer.qb64], "1", [dig(keys[2].verfer)], "2", [w[0], w[1], w[3]])}


def multisig():
    """kt 2 of 3 and nt 2 of 3, then a rotation, no witnesses."""
    keys = ed_signers("m", 6)
    cur, nxt = keys[:3], keys[3:]
    icp = eventing.incept(keys=[k.verfer.qb64 for k in cur], isith="2", ndigs=[dig(k.verfer) for k in nxt], nsith="2",
                          code=MtrDex.Blake3_256)
    pre = icp.pre
    out = [msg(icp, [k.sign(icp.raw, index=i) for i, k in enumerate(cur)])]
    nn = ed_signers("n", 3)
    rot = eventing.rotate(pre, keys=[k.verfer.qb64 for k in nxt], isith="2", dig=icp.said, sn=1,
                          ndigs=[dig(k.verfer) for k in nn], nsith="2")
    out.append(msg(rot, [k.sign(rot.raw, index=i) for i, k in enumerate(nxt[:2])]))
    return {"name": "multisig", "stream": "".join(out),
            "state": state(pre, rot, "2", [k.verfer.qb64 for k in nxt], "2", [dig(k.verfer) for k in nn], "0", [])}


def p256():
    """P-256 keys: icp, ixn, rot. ECDSA signatures are randomized, so this fixture is fixed once made."""
    ks = [signing.Signer(code=MtrDex.ECDSA_256r1_Seed, transferable=True) for _ in range(3)]
    icp = eventing.incept(keys=[ks[0].verfer.qb64], ndigs=[dig(ks[1].verfer)], code=MtrDex.Blake3_256)
    pre = icp.pre
    out = [msg(icp, [ks[0].sign(icp.raw, index=0)])]
    ixn = eventing.interact(pre, dig=icp.said, sn=1, data=[{"d": icp.said}])
    out.append(msg(ixn, [ks[0].sign(ixn.raw, index=0)]))
    rot = eventing.rotate(pre, keys=[ks[1].verfer.qb64], dig=ixn.said, sn=2, ndigs=[dig(ks[2].verfer)])
    out.append(msg(rot, [ks[1].sign(rot.raw, index=0)]))
    return {"name": "p256", "stream": "".join(out),
            "state": state(pre, rot, "1", [ks[1].verfer.qb64], "1", [dig(ks[2].verfer)], "0", [])}


def vectors():
    keys = ed_signers("a", 2)
    out = []
    for k in keys:
        out.append({"seed": k.raw.hex(), "key": k.verfer.qb64, "digest": dig(k.verfer)})
    ks = signing.Signer(raw=bytes(range(1, 33)), code=MtrDex.ECDSA_256r1_Seed, transferable=True)
    out.append({"seed": ks.raw.hex(), "key": ks.verfer.qb64, "digest": dig(ks.verfer), "curve": "p256"})
    w = ed_signers("w", 1, transferable=False)[0]
    out.append({"seed": w.raw.hex(), "key": w.verfer.qb64, "digest": dig(w.verfer), "nontransferable": True})
    return out


if __name__ == "__main__":
    print(json.dumps({"keripy": "1.3.6", "vectors": vectors(), "kels": [basic(), multisig(), p256()]}, indent=1))
