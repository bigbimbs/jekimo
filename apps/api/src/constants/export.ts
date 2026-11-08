export const EXPORT_COMPRESSIONS = ["none", "gzip"] as const;

export type ExportCompression = (typeof EXPORT_COMPRESSIONS)[number];

export const NDJSON_CONTENT_TYPE = "application/x-ndjson";
export const GZIP_CONTENT_TYPE = "application/gzip";
