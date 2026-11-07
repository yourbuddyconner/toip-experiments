/**
 * Camera K-7, a scripted device (design §12.2): P-256 keys, a captures trail, photos signed outside the log
 * with a -F group naming the key state, and a scheduled key rotation.
 */
import { toB64u, utf8 } from "@toip-tools/trust-core";
import { Controller, digest, encodeKeyRefSig, type KeyRefSig, type Signer } from "@toip-tools/eventlog";
import type { Capture, World } from "./world";

/** A capture manifest: what a camera signs. The pixels are stand-ins. */
export function manifest(photo: string, takenAt: string): Uint8Array {
  const pixels = utf8(`pixels of photo ${photo}`);
  return utf8(JSON.stringify({ type: "capture/manifest", device: "K-7", photo, takenAt, pixels: digest(pixels) }));
}

/** Signs bytes under the controller's current key state (or under `estSn` with a retired key). */
export async function signCapture(aid: string, est: { estSn: number; estSaid: string }, signer: Signer, bytes: Uint8Array): Promise<KeyRefSig> {
  const sig = (await signer.sign(bytes)) as Uint8Array;
  return { aid, estSn: est.estSn, estSaid: est.estSaid, sigs: [{ code: "E", index: 0, ondex: 0, sig }] };
}

export async function provision(world: World): Promise<Controller> {
  const cold = world.cameraCold;
  const ws = world.state.scoutWitnesses.map((n) => world.witness(n).aid);
  const camera = await Controller.incept({
    hot: cold.release(0, 1),
    cold,
    witnesses: ws,
    bt: 2,
    data: { device: "camera", model: "K-7" },
    store: world.cameraStore,
    clock: world.clock,
  });
  const trail = await camera.openTrail("device/captures");
  await camera.publish(world.scoutClients());
  world.camera = camera;
  world.state.camera = { aid: camera.aid, trailId: trail.id };
  world.adaWatcher.watch(trail.id, camera.aid);
  return camera;
}

/** Takes a photo: signs its manifest, and anchors the manifest's digest in the captures trail. */
export async function capture(world: World, photo: string): Promise<Capture> {
  const camera = world.camera!;
  const bytes = manifest(photo, world.clock.iso());
  const st = camera.state();
  const sig = await signCapture(camera.aid, st, camera.signers()[0], bytes);
  await camera.trail(world.state.camera!.trailId).append({ kind: "device/capture", body: { photo, manifestDigest: digest(bytes) }, refs: [{ d: digest(bytes) }] });
  await camera.publish(world.scoutClients());
  return { label: `Photo ${photo}`, bytes: toB64u(bytes), sig: encodeKeyRefSig(sig), note: `Signed under key state ${st.estSn}, anchored in the captures trail` };
}

/** A photo signed with a retired key and never anchored: what a thief with an old key could make. */
export async function captureWithRetiredKey(world: World, photo: string, set: number): Promise<Capture> {
  const camera = world.camera!;
  const kel = camera.kelMessages();
  const est = kel.filter((m) => m.t === "icp" || m.t === "rot")[set];
  const bytes = manifest(photo, world.clock.iso());
  const sig = await signCapture(camera.aid, { estSn: est.s, estSaid: est.d }, world.cameraCold.release(set, 1)[0], bytes);
  return { label: `Photo ${photo}`, bytes: toB64u(bytes), sig: encodeKeyRefSig(sig), note: `Signed later with retired key ${set}, never anchored` };
}
