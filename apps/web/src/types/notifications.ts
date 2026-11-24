export interface EmailSettings {
  host: string;
  port: number;
  security: "tls" | "starttls";
  username: string;
  from: string;
  fromName: string;
  enabled: boolean;
  hasPassword?: boolean;
  password?: string;
}
export interface EmailConfiguration {
  available: boolean;
  settings: EmailSettings | null;
}
export interface NotificationChannel {
  id: string;
  name: string;
  kind: "email" | "slack" | "webhook";
  enabled: boolean;
}
export interface ChannelInput {
  name: string;
  kind: NotificationChannel["kind"];
  destination: string;
  signingSecret?: string;
}
export interface AlertRule {
  id: string;
  name: string;
  channelId: string;
  trigger: "new_issue" | "regression" | "slow_query";
  thresholdMs?: number;
  environment?: string;
  queryName?: string;
  cooldownMinutes: number;
  enabled: boolean;
}
export interface NotificationDelivery {
  id: string;
  channelName: string;
  status: "queued" | "sending" | "retrying" | "sent" | "failed";
  attempts: number;
  createdAt: string;
  error: string | null;
}
export interface NotificationApi {
  getEmailSettings(): Promise<EmailConfiguration>;
  saveEmailSettings(settings: EmailSettings): Promise<EmailConfiguration>;
  testEmail(recipient: string): Promise<void>;
  listNotificationChannels(projectId: string): Promise<NotificationChannel[]>;
  createNotificationChannel(projectId: string, input: ChannelInput): Promise<NotificationChannel>;
  enableNotificationChannel(projectId: string, id: string, enabled: boolean): Promise<void>;
  testNotificationChannel(projectId: string, id: string): Promise<void>;
  listAlertRules(projectId: string): Promise<AlertRule[]>;
  saveAlertRule(projectId: string, rule: Omit<AlertRule, "id">, id?: string): Promise<AlertRule>;
  listNotificationDeliveries(projectId?: string): Promise<NotificationDelivery[]>;
}
