import { loadPolicy, type LoadedPolicy } from "@open-policy-agent/opa-wasm";

/** Rego policies compiled to one WebAssembly bundle with `opa build -t wasm`, evaluated locally. */
export class Policies {
  private constructor(private readonly policy: LoadedPolicy) {}

  static async load(wasm: BufferSource): Promise<Policies> {
    return new Policies(await loadPolicy(wasm));
  }

  entrypoints(): string[] {
    return Object.keys(this.policy.entrypoints ?? {});
  }

  /** Evaluates `entrypoint` (e.g. "todo/authz/decision") and returns its value. */
  evaluate<T>(entrypoint: string, input: object): T {
    if (!(entrypoint in (this.policy.entrypoints ?? {}))) throw new Error(`no such entrypoint: ${entrypoint}`);
    const out = this.policy.evaluate(input, entrypoint) as { result: T }[];
    if (!out || out.length === 0) throw new Error(`entrypoint ${entrypoint} is undefined for this input`);
    return out[0].result;
  }
}
