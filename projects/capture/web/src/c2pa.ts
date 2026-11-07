/** Reading Content Credentials (C2PA) with the Content Authenticity SDK, compiled to WebAssembly. Shown next to Capture's own result; it never changes Capture's verdict. */
export interface C2paResult {
  present: boolean;
  signer?: string;
  claimGenerator?: string;
  state?: string;
  trusted?: boolean;
  title?: string;
  actions?: string[];
  error?: string;
}

let c2paP: Promise<unknown> | undefined;

async function sdk() {
  const [{ createC2pa, Reader }, wasm] = await Promise.all([import("@contentauth/c2pa-web"), import("@contentauth/c2pa-web/resources/c2pa.wasm?url")]);
  c2paP ??= createC2pa({ wasmSrc: wasm.default });
  return { c2pa: (await c2paP) as Awaited<ReturnType<typeof createC2pa>>, Reader };
}

export async function readC2pa(bytes: Uint8Array, mime: string): Promise<C2paResult> {
  try {
    const { c2pa, Reader } = await sdk();
    const reader = await Reader.fromBlob(c2pa, mime, new Blob([bytes as BlobPart], { type: mime }));
    if (!reader) return { present: false };
    try {
      const j = (await reader.json()) as {
        active_manifest?: string;
        validation_state?: string;
        validation_status?: { code: string }[];
        manifests?: Record<string, { claim_generator?: string; title?: string; signature_info?: { issuer?: string; common_name?: string }; assertions?: { label: string; data?: { actions?: { action: string }[] } }[] }>;
      };
      const m = j.active_manifest ? j.manifests?.[j.active_manifest] : undefined;
      const actions = (m?.assertions ?? []).filter((a) => a.label.startsWith("c2pa.actions")).flatMap((a) => a.data?.actions?.map((x) => x.action) ?? []);
      const codes = (j.validation_status ?? []).map((s) => s.code);
      const state = j.validation_state ?? (codes.length ? codes.join(", ") : "Valid");
      return {
        present: true,
        signer: m?.signature_info?.common_name ?? m?.signature_info?.issuer,
        claimGenerator: m?.claim_generator,
        title: m?.title,
        state,
        trusted: /trusted/i.test(state) && !codes.some((c) => /untrusted/i.test(c)),
        actions,
      };
    } finally {
      await reader.free();
    }
  } catch (e) {
    return { present: false, error: (e as Error).message ?? String(e) };
  }
}
