import type { Actor, IngestLimitSettings, ProjectAccess } from "@jekimo/storage-postgres";
import type { LimitServiceDeps, ResolvedLimits } from "../../types/index.js";

/** A null setting inherits the instance-wide default. */
export class LimitService {
  constructor(private readonly deps: LimitServiceDeps) {}

  private resolve(settings: IngestLimitSettings): ResolvedLimits {
    return {
      settings,
      effective: {
        ratePerMinute: settings.rateLimitPerMinute ?? this.deps.defaults.ratePerMinute,
        eventsPerDay: settings.eventsPerDay ?? this.deps.defaults.eventsPerDay,
      },
    };
  }

  async get(access: ProjectAccess): Promise<ResolvedLimits> {
    return this.resolve(await this.deps.limits.getSettings(access));
  }

  async set(
    actor: Actor,
    access: ProjectAccess,
    settings: IngestLimitSettings,
    sourceIp: string,
  ): Promise<ResolvedLimits> {
    return this.resolve(await this.deps.limits.setSettings(actor, access, settings, sourceIp));
  }
}
