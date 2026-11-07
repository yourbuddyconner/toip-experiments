/**
 * Owner-to-device mandates with the `capture/1` profile (@toip-tools/mandates). The owner limits what a
 * device may sign for it; the verifier decides the capture as a `capture/sign-media` action.
 */
import { explain, issueMandate, MandateEngine, staticStatusResolver, type Mandate, type StatusRegistry } from "@toip-tools/mandates";
import type { Clock, Identity } from "@toip-tools/trust-core";
import type { MandateCheck } from "./verify";

/** A camera's mandate: sign photos of the given types for the owner, until `validUntil`. */
export function cameraMandate(owner: Identity, clock: Clock, status: StatusRegistry, device: string, o: { validUntil: string; mediaTypes?: string[]; purpose?: string }): Mandate {
  return issueMandate(owner, clock, {
    subject: device,
    validUntil: o.validUntil,
    status: status.allocate(),
    profile: "capture/1",
    ...(o.purpose ? { purpose: o.purpose } : {}),
    constraints: {
      actions: { attr: "type", anyOf: ["capture/sign-media"] },
      media: { attr: "mediaType", anyOf: o.mediaTypes ?? ["image/jpeg", "image/png"], when: ["capture/sign-media"] },
    },
    delegation: { maxDepth: 0 },
    revocation: { maxAgeSeconds: 365 * 86_400 },
  });
}

/** A sensor's mandate: sign readings of these quantities. */
export function sensorMandate(owner: Identity, clock: Clock, status: StatusRegistry, device: string, o: { validUntil: string; quantities: string[] }): Mandate {
  return issueMandate(owner, clock, {
    subject: device,
    validUntil: o.validUntil,
    status: status.allocate(),
    profile: "capture/1",
    constraints: {
      actions: { attr: "type", anyOf: ["capture/sign-reading"] },
      quantity: { attr: "quantity", anyOf: o.quantities, when: ["capture/sign-reading"] },
    },
    delegation: { maxDepth: 0 },
    revocation: { maxAgeSeconds: 365 * 86_400 },
  });
}

const fixed = (ms: number): Clock => ({ now: () => ms, iso: () => new Date(ms).toISOString(), date: () => new Date(ms) });

/** A MandateCheck for verifyAsset, deciding at the time of capture. */
export function mandateChecker(engine: MandateEngine): MandateCheck {
  return async ({ mandate, device, media, mediaType, at, statusLists }) => {
    const clock = fixed(at);
    const d = await engine.decide({
      chain: [mandate as unknown as Mandate],
      presenter: device,
      action: { type: "capture/sign-media", profile: "capture/1", id: media, actor: device, at: clock.iso(), attrs: { spend: "0", device, media, mediaType } },
      status: staticStatusResolver(statusLists),
      clock,
    });
    return { outcome: d.outcome, reasons: d.outcome === "allow" ? [] : explain(d, { noun: "this photo" }) };
  };
}

export { MandateEngine };
