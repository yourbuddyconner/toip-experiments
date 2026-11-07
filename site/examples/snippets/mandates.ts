// An owner lets a camera sign photos in California only. The engine decides each action.
import { MandateEngine, StatusRegistry, explain, issueMandate, staticStatusResolver, type Action } from "@toip-tools/mandates";
import { SystemClock, identityFromSeed, seedFrom } from "@toip-tools/trust-core";

const clock = new SystemClock();
const owner = identityFromSeed(seedFrom("example/photo-desk"));
const camera = identityFromSeed(seedFrom("example/camera"));
const status = new StatusRegistry(owner, clock);

const mandate = issueMandate(owner, clock, {
  subject: camera.did,
  validUntil: new Date(clock.now() + 7 * 86_400_000).toISOString(),
  status: status.allocate(),
  profile: "capture/1",
  constraints: {
    actions: { attr: "type", anyOf: ["capture/sign-media"] },
    where: { attr: "location", within: ["geo:us/ca/*"], when: ["capture/sign-media"] },
  },
  delegation: { maxDepth: 0 },
  escalation: { approvable: ["where"], approvalTtlSeconds: 600 },
  revocation: { maxAgeSeconds: 86_400 },
});

const photo = (location: string): Action => ({
  type: "capture/sign-media", profile: "capture/1", id: crypto.randomUUID(), actor: camera.did, at: clock.iso(),
  attrs: { spend: "0", device: camera.did, media: "sha256:2c26b46b", mediaType: "image/jpeg", location },
});

const engine = await MandateEngine.load();
for (const where of ["geo:us/ca/sf", "geo:us/ny/nyc"]) {
  const d = await engine.decide({ chain: [mandate], presenter: camera.did, action: photo(where), status: staticStatusResolver([status.sign()]), clock });
  console.log(where, d.outcome, explain(d, { name: (did) => (did === owner.did ? "Daily Planet photo desk" : "Dana's camera"), noun: "this photo" }).join(" "));
}
