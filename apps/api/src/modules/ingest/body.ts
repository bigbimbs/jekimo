import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { IngestError } from "../../errors.js";
import type { ParsedIngestBody } from "../../types/index.js";

const gunzipAsync = promisify(gunzip);
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Reads the body stream, stopping as soon as it passes `limit` bytes. */
function readLimited(stream: NodeJS.ReadableStream, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        stream.removeAllListeners("data");
        stream.resume();
        reject(new IngestError("payload_too_large", `request body exceeds ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

/** `maxBytes` bounds both the compressed and the decompressed body. */
export async function parseIngestBody(
  stream: NodeJS.ReadableStream,
  contentEncoding: string | undefined,
  maxBytes: number,
): Promise<ParsedIngestBody> {
  const raw = await readLimited(stream, maxBytes);
  let body = raw;
  if (contentEncoding?.toLowerCase() === "gzip") {
    try {
      body = await gunzipAsync(raw, { maxOutputLength: maxBytes });
    } catch (err) {
      if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
        throw new IngestError("payload_too_large", `decompressed body exceeds ${maxBytes} bytes`);
      }
      throw new IngestError("invalid_json", "request body is not valid gzip");
    }
  }
  let text: string;
  try {
    text = utf8.decode(body);
  } catch {
    throw new IngestError("invalid_json", "request body is not valid UTF-8");
  }
  try {
    return { json: JSON.parse(text) as unknown, bytes: body.length };
  } catch {
    throw new IngestError("invalid_json", "request body is not valid JSON");
  }
}
