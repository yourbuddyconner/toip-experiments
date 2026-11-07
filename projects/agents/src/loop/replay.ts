/** Recording a live session, and playing it back (design §12.1). A request that differs from the recording fails loudly. */
import { hashOf } from "./hash";
import type { Message, ModelClient, ModelRequest } from "./model";

export interface Recording {
  model: string;
  turns: { requestHash: string; response: Message }[];
}

export const requestHash = (req: ModelRequest): string => hashOf({ system: req.system, tools: req.tools, messages: req.messages });

export class RecordingModel implements ModelClient {
  readonly recording: Recording;
  constructor(private readonly inner: ModelClient) {
    this.recording = { model: inner.id, turns: [] };
  }
  get id(): string {
    return this.inner.id;
  }
  async next(req: ModelRequest): Promise<Message> {
    const h = requestHash(req);
    const response = await this.inner.next(req);
    this.recording.turns.push({ requestHash: h, response: structuredClone(response) });
    return response;
  }
}

export class ReplayModel implements ModelClient {
  private n = 0;
  readonly id: string;
  constructor(private readonly recording: Recording) {
    this.id = recording.model;
  }
  async next(req: ModelRequest): Promise<Message> {
    const turn = this.recording.turns[this.n];
    if (!turn) throw new Error(`replay: the recording has only ${this.recording.turns.length} turns`);
    const h = requestHash(req);
    if (h !== turn.requestHash) throw new Error(`replay: request ${this.n} differs from the recording (${h} ≠ ${turn.requestHash})`);
    this.n++;
    return structuredClone(turn.response);
  }
}
