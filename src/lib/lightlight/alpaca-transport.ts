/** Transport primitives shared by equity and crypto; no broker/API implementation. */
export class AlpacaTransportError extends Error {
  readonly kind:
    | "AUTHENTICATION_FAILURE"
    | "UNSUPPORTED_DATA_FEED"
    | "DISCONNECTED_STREAM"
    | "HTTP_FAILURE"
    | "SUBSCRIPTION_FAILURE"
    | "PROTOCOL_FAILURE"
    | "TIMEOUT";
  constructor(
    kind:
      | "AUTHENTICATION_FAILURE"
      | "UNSUPPORTED_DATA_FEED"
      | "DISCONNECTED_STREAM"
      | "HTTP_FAILURE"
      | "SUBSCRIPTION_FAILURE"
      | "PROTOCOL_FAILURE"
      | "TIMEOUT",
    message: string,
  ) {
    super(message);
    this.kind = kind;
  }
}

export type WebSocketLike = {
  readonly readyState?: number;
  send(payload: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "error" | "close", listener: (event: { data?: unknown }) => void): void;
};

export type WebSocketFactory = (url: string) => WebSocketLike;

/** Normalizes Node and browser WebSocket message payloads before JSON parsing. */
export async function websocketPayloadToText(payload: unknown): Promise<string> {
  if (typeof payload === "string") return payload;
  if (payload instanceof Blob) return payload.text();
  if (payload instanceof ArrayBuffer || ArrayBuffer.isView(payload)) return new TextDecoder().decode(payload);
  throw new TypeError("Unsupported WebSocket payload.");
}

