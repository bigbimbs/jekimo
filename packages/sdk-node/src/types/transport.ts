/** Request passed to the transport. Global `fetch` accepts it as `RequestInit`. */
export interface TransportRequest {
  method: "POST";
  headers: Record<string, string>;
  body: string | Uint8Array;
  signal: AbortSignal;
  redirect: "manual";
}

/** The parts of a `fetch` Response the SDK reads. */
export interface TransportResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

/** A `fetch`-compatible function. Defaults to the global `fetch`. */
export type Transport = (url: string, request: TransportRequest) => Promise<TransportResponse>;
