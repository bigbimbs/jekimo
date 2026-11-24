import type { DatabaseQuery } from "@jekimo/event-schema";
import type { Actor, ProjectAccess } from "./access.js";

export type NotificationKind = "email" | "slack" | "webhook";
export type AlertTrigger = "new_issue" | "regression" | "slow_query";
export interface SmtpSettings {
  host: string;
  port: number;
  security: "tls" | "starttls";
  username: string;
  password: string;
  from: string;
  fromName: string;
  enabled: boolean;
}
export interface NotificationChannel {
  id: string;
  name: string;
  kind: NotificationKind;
  enabled: boolean;
}
export interface ChannelSecret {
  destination: string;
  signingSecret?: string;
}
export interface AlertRule {
  thresholdMs?: number;
  environment?: string;
  queryName?: string;
  id: string;
  name: string;
  channelId: string;
  trigger: AlertTrigger;
  cooldownMinutes: number;
  enabled: boolean;
}
export interface NotificationPayload {
  subject: string;
  text: string;
  issueId?: string;
  monitorId?: string;
  eventId?: string;
  projectId?: string;
  trigger?: AlertTrigger;
}
export interface NotificationDelivery {
  id: string;
  channelName: string;
  status: "queued" | "sending" | "retrying" | "sent" | "failed";
  attempts: number;
  createdAt: string;
  error: string | null;
}
export interface ClaimedNotification {
  id: string;
  lease: string;
  attempts: number;
  kind: NotificationKind;
  secret: string;
  payload: NotificationPayload;
}
export interface QueryObservation {
  eventId: string;
  receivedAt: Date;
  database: DatabaseQuery;
  environment?: string;
}
export interface NotificationRepository {
  scheduleQueryAlerts(projectId: string, observations: QueryObservation[]): Promise<number>;
  getSmtp(): Promise<string | null>;
  saveSmtp(actor: Actor, encrypted: string): Promise<void>;
  listChannels(access: ProjectAccess): Promise<NotificationChannel[]>;
  saveChannel(access: ProjectAccess, channel: NotificationChannel, encrypted: string): Promise<void>;
  setChannelEnabled(access: ProjectAccess, id: string, enabled: boolean): Promise<boolean>;
  listRules(access: ProjectAccess): Promise<AlertRule[]>;
  saveRule(access: ProjectAccess, rule: AlertRule): Promise<boolean>;
  listDeliveries(access: ProjectAccess | null): Promise<NotificationDelivery[]>;
  enqueueTest(access: ProjectAccess, channelId: string): Promise<boolean>;
  enqueueEmail(actor: Actor, encryptedRecipient: string, payload: NotificationPayload): Promise<boolean>;
  scheduleAlerts(): Promise<number>;
  claim(): Promise<ClaimedNotification | null>;
  finish(job: ClaimedNotification, error: string | null, permanent?: boolean): Promise<void>;
  prune(): Promise<void>;
}
