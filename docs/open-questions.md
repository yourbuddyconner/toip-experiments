# Open questions

## For the P2P Trust Stack people

1. What did you intend the R-Card level "available only through a zero-knowledge proof" to prove, and with what?
2. Would you adopt a policy language for community governance, and would Cedar work?
3. What signature format do VRCs use, and what are their fields?
4. Could a community, or the Community Network Manager, sign one root over its members' facts?
5. How is a credential or a membership revoked?
6. Can an application send arbitrary payloads over TSP, and is there a plug-in point for Trust Tasks?
7. When will the Agent App and the SDK be released, and in which languages?

## Ours

1. Phone proving times, browser and native. Not measured in zk-pdp.
2. Ed25519 at about half the gates, using windowed multiplication.
3. Unlinkability across peers.
4. Revocation and freshness beyond an epoch.
5. Which existing credential format to accept first.
