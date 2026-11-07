import { MembershipProver, MembershipVerifier } from "@toip-tools/anon-membership";
import { Bus, DemoClock, Endpoint, identityFromSeed, seedFrom } from "@toip-tools/trust-core";
import { AgoraClient, MemoryWallet } from "../src/client/client";
import { HostApi, RegistrarApi } from "../src/client/http";
import { ForumReader, MemoryKeyValue } from "../src/client/reader";
import { startWorld, type World } from "../src/platform/world";

export const HOUR = 3600_000;
export const DAY = 86_400_000;

export interface TestWorld extends World {
  bus: Bus;
  clock: DemoClock;
  prover: MembershipProver;
  member(label: string, seed?: Uint8Array): Promise<AgoraClient>;
  reader(): ForumReader;
  advance(ms: number): Promise<void>;
}

let prover: Promise<MembershipProver> | undefined;
export const sharedProver = () => (prover ??= MembershipProver.create());

export async function testWorld(o: { dataDir?: string; simulated?: number; start?: string } = {}): Promise<TestWorld> {
  const clock = new DemoClock(o.start ?? "2026-11-06T09:00:00.000Z");
  const bus = new Bus(clock);
  const w = await startWorld({ clock, tsp: { bus }, dataDir: o.dataDir, simulated: o.simulated ?? 40, tickMs: 0, devClock: true });
  const p = await sharedProver();
  return {
    ...w,
    clock,
    bus,
    prover: p,
    async member(label, seed) {
      const s = seed ?? seedFrom(`agora-test/${label}`);
      const endpoint = new Endpoint({ identity: identityFromSeed(s), transport: bus, clock, timeoutMs: 10_000 });
      return AgoraClient.open({ seed: s, clock, host: new HostApi(w.hostServer.url), registrar: new RegistrarApi(w.registrarServer.url), prover: p, wallet: new MemoryWallet(), endpoint });
    },
    reader() {
      return new ForumReader(new HostApi(w.hostServer.url), new RegistrarApi(w.registrarServer.url), w.verifier as MembershipVerifier, clock, new MemoryKeyValue());
    },
    async advance(ms) {
      clock.advance(ms);
      await w.tick();
    },
  };
}

export const nursingClaims = (licenseType: "RN" | "LPN", state = "WA") => ({ credentialType: "NursingLicense", claims: { licenseType, state, licensedSince: "2019-05-01" } });
export const residencyClaims = (district: string) => ({ credentialType: "ResidencyCredential", claims: { district, residentSince: "2021-03-15" } });
