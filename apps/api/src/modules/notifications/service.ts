import { randomUUID } from "node:crypto";
import type {
  Actor,
  AlertRule,
  ChannelSecret,
  NotificationChannel,
  ProjectAccess,
  SmtpSettings,
} from "@jekimo/storage-postgres";
import { openNotification, sealNotification } from "@jekimo/storage-postgres";
import { ApiError } from "../../errors.js";
import type { NotificationDeps } from "../../types/notifications.js";

function invalid(message: string): never {
  throw new ApiError(400, "invalid_request", message);
}
function text(body: Record<string, unknown>, key: string, max = 200): string {
  const value = body[key];
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\r\n]/.test(value) ||
    value.includes(String.fromCharCode(0))
  )
    return invalid(`invalid ${key}`);
  return value.trim();
}
function bool(body: Record<string, unknown>, key: string): boolean {
  if (typeof body[key] !== "boolean") return invalid(`invalid ${key}`);
  return body[key];
}
function integer(body: Record<string, unknown>, key: string, min: number, max: number): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    return invalid(`invalid ${key}`);
  return value;
}
function email(value: string): string {
  if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value)) return invalid("invalid email address");
  return value;
}
export function notificationId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value))
    return invalid("invalid identifier");
  return value;
}

export class NotificationService {
  constructor(private readonly deps: NotificationDeps) {}
  private key(): string {
    if (!this.deps.encryptionKey)
      throw new ApiError(503, "notifications_unavailable", "notification encryption is not configured");
    return this.deps.encryptionKey;
  }
  private async smtpSecret(): Promise<SmtpSettings | null> {
    const encrypted = await this.deps.repository.getSmtp();
    if (!encrypted) return null;
    try {
      return openNotification<SmtpSettings>(encrypted, this.key(), "smtp");
    } catch {
      throw new ApiError(503, "notifications_unavailable", "email settings could not be opened");
    }
  }
  async smtp() {
    const smtp = await this.smtpSecret();
    return {
      available: Boolean(this.deps.encryptionKey),
      settings: smtp ? { ...smtp, password: undefined, hasPassword: Boolean(smtp.password) } : null,
    };
  }
  async saveSmtp(actor: Actor, body: Record<string, unknown>) {
    const key = this.key();
    const security = body.security;
    if (security !== "tls" && security !== "starttls") return invalid("choose TLS or STARTTLS");
    const host = text(body, "host", 253);
    if (!/^[a-zA-Z0-9.-]+$/.test(host)) return invalid("invalid SMTP host");
    const username =
      typeof body.username === "string" &&
      body.username.length <= 200 &&
      !/[\r\n]/.test(body.username) &&
      !body.username.includes(String.fromCharCode(0))
        ? body.username
        : invalid("invalid username");
    const password =
      body.password === undefined
        ? ((await this.smtpSecret())?.password ?? "")
        : typeof body.password === "string" && body.password.length <= 1000
          ? body.password
          : invalid("invalid password");
    if (username && !password) return invalid("a password is required for this username");
    const smtp: SmtpSettings = {
      host,
      port: integer(body, "port", 1, 65535),
      security,
      username,
      password,
      from: email(text(body, "from", 254)),
      fromName: text(body, "fromName", 100),
      enabled: bool(body, "enabled"),
    };
    await this.deps.repository.saveSmtp(actor, sealNotification(smtp, key, "smtp"));
    return this.smtp();
  }
  async testEmail(actor: Actor, body: Record<string, unknown>) {
    const smtp = await this.smtpSecret();
    if (!smtp?.enabled) throw new ApiError(409, "email_unavailable", "save and enable email first");
    const destination = email(text(body, "recipient", 254));
    const queued = await this.deps.repository.enqueueEmail(
      actor,
      sealNotification({ destination }, this.key(), "email-test"),
      { subject: "Jekimo test email", text: "Your Jekimo email delivery is connected." },
    );
    if (!queued) throw new ApiError(429, "notification_test_limited", "wait one minute before another test");
  }
  channels(access: ProjectAccess) {
    return this.deps.repository.listChannels(access);
  }
  rules(access: ProjectAccess) {
    return this.deps.repository.listRules(access);
  }
  deliveries(access: ProjectAccess | null) {
    return this.deps.repository.listDeliveries(access);
  }
  async createChannel(access: ProjectAccess, body: Record<string, unknown>) {
    const kind = body.kind;
    if (kind !== "email" && kind !== "slack" && kind !== "webhook") return invalid("invalid channel type");
    const destination = text(body, "destination", 2048);
    const secret: ChannelSecret = { destination };
    if (kind === "email") email(destination);
    else {
      let url: URL;
      try {
        url = new URL(destination);
      } catch {
        return invalid("invalid webhook URL");
      }
      if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443"))
        return invalid("webhooks require HTTPS on port 443 without credentials or fragments");
      if (
        kind === "slack" &&
        (!["hooks.slack.com", "hooks.slack-gov.com"].includes(url.hostname) || !url.pathname.startsWith("/services/"))
      )
        return invalid("use a Slack incoming webhook URL");
      if (kind === "webhook") {
        secret.signingSecret = text(body, "signingSecret", 256);
        if (secret.signingSecret.length < 32)
          return invalid("webhook signing secret must contain at least 32 characters");
      }
    }
    const channel: NotificationChannel = { id: randomUUID(), name: text(body, "name", 100), kind, enabled: true };
    await this.deps.repository.saveChannel(access, channel, sealNotification(secret, this.key(), channel.id));
    return channel;
  }
  async enableChannel(access: ProjectAccess, id: string, body: Record<string, unknown>) {
    if (!(await this.deps.repository.setChannelEnabled(access, notificationId(id), bool(body, "enabled"))))
      throw new ApiError(404, "not_found", "channel not found");
  }
  async saveRule(access: ProjectAccess, body: Record<string, unknown>, id?: string) {
    const trigger = body.trigger;
    if (trigger !== "new_issue" && trigger !== "regression" && trigger !== "slow_query")
      return invalid("invalid alert trigger");
    if (trigger !== "slow_query" && ["thresholdMs", "environment", "queryName"].some((key) => body[key] !== undefined))
      return invalid("query filters require a slow-query rule");
    const rule: AlertRule = {
      ...(trigger === "slow_query" && {
        thresholdMs: integer(body, "thresholdMs", 1, 604800000),
        ...(body.environment !== undefined && { environment: text(body, "environment", 128) }),
        ...(body.queryName !== undefined && { queryName: text(body, "queryName", 128) }),
      }),
      id: id ? notificationId(id) : randomUUID(),
      name: text(body, "name", 100),
      channelId: notificationId(body.channelId),
      trigger,
      cooldownMinutes: integer(body, "cooldownMinutes", 1, 1440),
      enabled: bool(body, "enabled"),
    };
    if (!(await this.deps.repository.saveRule(access, rule)))
      throw new ApiError(404, "not_found", "channel or rule not found");
    return rule;
  }
  async testChannel(access: ProjectAccess, id: string) {
    if (!(await this.deps.repository.enqueueTest(access, notificationId(id))))
      throw new ApiError(409, "notification_test_unavailable", "enable the channel and wait one minute between tests");
  }
}
