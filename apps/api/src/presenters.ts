import type { ProjectRecord, StoredEvent, UserRecord } from "@jekimo/storage-postgres";

export function publicUser(u: UserRecord) {
  return { id: u.id, email: u.email, instance_role: u.instanceRole, created_at: u.createdAt.toISOString() };
}

export function publicAccountUser(u: UserRecord) {
  return {
    id: u.id,
    email: u.email,
    instance_role: u.instanceRole,
    status: u.status,
    created_at: u.createdAt.toISOString(),
  };
}

export function publicProject(p: ProjectRecord) {
  return {
    id: p.id,
    name: p.name,
    retention_days: p.retentionDays,
    sample_rate: p.sampleRate,
    disabled: p.disabled,
    created_at: p.createdAt.toISOString(),
  };
}

export function publicEvent(e: StoredEvent) {
  return {
    received_at: e.receivedAt.toISOString(),
    key_id: e.keyId,
    ...(e.skewMs !== undefined && { skew_ms: e.skewMs }),
    event: e.event,
  };
}
