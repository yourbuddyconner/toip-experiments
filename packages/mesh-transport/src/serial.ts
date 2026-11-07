/**
 * The serial port every serial radio adapter uses (design §14.6, §19.1). This entry runs in
 * browsers: webSerialPort wraps Web Serial. The Node wrapper (the "serialport" package) is in ./node.
 */

export interface SerialPortLike {
  readonly label: string;
  open(): Promise<void>;
  close(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  onData(fn: (bytes: Uint8Array) => void): () => void;
}

/** The parts of a Web Serial `SerialPort` we use. */
export interface WebSerialPortLike {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  getInfo?(): { usbVendorId?: number; usbProductId?: number };
}

/** A Web Serial port (Chrome and Edge, after a user gesture) as a SerialPortLike. */
export function webSerialPort(port: WebSerialPortLike, baud = 115200): SerialPortLike {
  const fns = new Set<(b: Uint8Array) => void>();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let closing = false;
  const info = port.getInfo?.() ?? {};
  const label = `webserial:${(info.usbVendorId ?? 0).toString(16).padStart(4, "0")}:${(info.usbProductId ?? 0).toString(16).padStart(4, "0")}`;
  return {
    label,
    async open() {
      closing = false;
      await port.open({ baudRate: baud });
      reader = port.readable?.getReader();
      void (async () => {
        while (reader && !closing) {
          const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
          if (done) break;
          if (value) for (const fn of [...fns]) fn(value);
        }
      })();
    },
    async close() {
      closing = true;
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
      await port.close();
    },
    async write(bytes) {
      const w = port.writable?.getWriter();
      if (!w) throw new Error("serial port not writable");
      try {
        await w.write(bytes);
      } finally {
        w.releaseLock();
      }
    },
    onData(fn) {
      fns.add(fn);
      return () => fns.delete(fn);
    },
  };
}
