import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PersistentReplayGuard } from "@toip-tools/trust-core";
import { fileGatewayStore, fileOutbox, fileReplayStore, listSerialPorts, mockSerialPort } from "../src/node";

const dir = () => mkdtempSync(join(tmpdir(), "mesh-node-"));

describe("the Node serial wrapper", () => {
  it("opens, writes and reads through the serialport package (its mock binding)", async () => {
    const port = mockSerialPort("/dev/ROBOT", { echo: true });
    const got: Uint8Array[] = [];
    port.onData((b) => got.push(b));
    await port.open();
    await port.write(new TextEncoder().encode("AT\r\n"));
    await new Promise((r) => setTimeout(r, 50));
    expect(new TextDecoder().decode(Buffer.concat(got))).toBe("AT\r\n");
    await port.close();
    expect(port.label).toBe("/dev/ROBOT");
  });

  it("hints at the board family from the USB vendor id", async () => {
    const ports = await listSerialPorts(async () => [{ path: "/dev/tty.usbserial-0001", vendorId: "10C4", productId: "EA60" }, { path: "/dev/ttyS0" }]);
    expect(ports[0]).toMatchObject({ path: "/dev/tty.usbserial-0001", vendorId: "10c4", hint: expect.stringContaining("CP210x") });
    expect(ports[1]).toEqual({ path: "/dev/ttyS0" });
  });
});

describe("file stores", () => {
  it("keep the outbox, the gateway's custody record and the replay record across restarts", async () => {
    const d = dir();
    const outbox = fileOutbox(join(d, "outbox.json"));
    const item = { pid: "abcd0123", to: "did:key:z6Mk", wire: Uint8Array.of(1, 2, 3), createdMs: 1, attempts: 0, nextTryMs: 1, state: "pending" as const };
    await outbox.save([item]);
    expect(await fileOutbox(join(d, "outbox.json")).load()).toEqual([item]);

    await fileGatewayStore(join(d, "gw.json")).record("abcd0123", Uint8Array.of(5, 6));
    const again = fileGatewayStore(join(d, "gw.json"));
    expect(await again.has("abcd0123")).toBe(true);
    expect(await again.receipt("abcd0123")).toEqual(Uint8Array.of(5, 6));
    expect(await again.has("ffff0000")).toBe(false);

    const g1 = new PersistentReplayGuard(fileReplayStore(join(d, "replay.json")));
    expect((await g1.claim("urn:uuid:1", "digest", undefined, 0)).kind).toBe("fresh");
    const g2 = new PersistentReplayGuard(fileReplayStore(join(d, "replay.json")));
    expect((await g2.claim("urn:uuid:1", "digest", undefined, 0)).kind).toBe("duplicate");
  });
});
