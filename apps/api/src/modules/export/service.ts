import { pipeline, Readable } from "node:stream";
import { createGzip } from "node:zlib";
import type { EventStore, ProjectAccess } from "@jekimo/storage-postgres";
import { ApiError } from "../../errors.js";
import type { ExportRequest, ExportServiceDeps } from "../../types/index.js";

const BEGINNING = new Date(0);

async function* ndjson(events: EventStore, projectId: string, from: Date, to: Date): AsyncGenerator<string> {
  // The envelope alone: received_at and key_id are storage metadata, and
  // docs/object-storage.md, "Exports", promises lines in stored form.
  for await (const stored of events.streamEvents(projectId, { from, to })) {
    yield `${JSON.stringify(stored.event)}\n`;
  }
}

export class ExportService {
  constructor(private readonly deps: ExportServiceDeps) {}

  /**
   * Audit-logs the export before the first row is read, so an export the
   * client abandons is still on record. The project comes from the access
   * check and goes into every query (docs/access-model.md, "Authorization
   * enforcement", rule 4).
   */
  async start(access: ProjectAccess, req: ExportRequest): Promise<Readable> {
    const to = req.to ?? this.deps.clock();
    const from = req.from ?? BEGINNING;
    if (from >= to) throw new ApiError(400, "invalid_request", "from must be before to");
    await this.deps.metadata.appendAudit({
      actorUserId: access.userId,
      action: "data.exported",
      targetType: "project",
      targetId: access.projectId,
      projectId: access.projectId,
      sourceIp: req.sourceIp,
      viaInstanceAdmin: access.viaInstanceAdmin,
      details: { from: req.from?.toISOString() ?? null, to: to.toISOString(), compression: req.compression },
    });
    const lines = Readable.from(ndjson(this.deps.events, access.projectId, from, to));
    if (req.compression === "none") return lines;
    return pipeline(lines, createGzip(), () => {});
  }
}
