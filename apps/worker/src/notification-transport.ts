import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import type { ChannelSecret, ClaimedNotification, NotificationPayload, SmtpSettings } from "@jekimo/storage-postgres";
import ipaddr from "ipaddr.js";
import nodemailer from "nodemailer";

export class DeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly permanent = false,
  ) {
    super(code);
  }
}

export function publicAddress(address: string): boolean {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}

export function webhookBody(kind: string, payload: NotificationPayload, id: string): string {
  if (kind === "slack")
    return JSON.stringify({
      text: payload.subject,
      blocks: [
        { type: "section", text: { type: "plain_text", text: `${payload.subject}\n${payload.text}`.slice(0, 2900) } },
      ],
    });
  return JSON.stringify({ id, ...payload });
}

export async function sendWebhook(
  kind: string,
  secret: ChannelSecret,
  payload: NotificationPayload,
  id: string,
): Promise<void> {
  const url = new URL(secret.destination);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443"))
    throw new DeliveryError("destination_blocked", true);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const addresses = await Promise.race([
      lookup(url.hostname, { all: true }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new DeliveryError("dns_timeout")), 5000);
      }),
    ]);
    if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
      throw new DeliveryError("destination_blocked", true);
    const address = addresses[0];
    if (!address) throw new DeliveryError("dns_failed");
    const body = webhookBody(kind, payload, id);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const headers: Record<string, string | number> = {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
      host: url.host,
      "x-jekimo-delivery-id": id,
    };
    if (kind === "webhook") {
      if (!secret.signingSecret) throw new DeliveryError("missing_signing_secret", true);
      headers["x-jekimo-timestamp"] = timestamp;
      headers["x-jekimo-signature"] =
        `sha256=${createHmac("sha256", secret.signingSecret).update(`${timestamp}.${body}`).digest("hex")}`;
    }
    await new Promise<void>((resolve, reject) => {
      // Connect to the vetted IP, retaining the original TLS and Host identity.
      const req = request(
        {
          hostname: address.address,
          family: address.family,
          servername: url.hostname,
          port: 443,
          path: `${url.pathname}${url.search}`,
          method: "POST",
          headers,
          agent: false,
          signal: AbortSignal.timeout(15000),
        },
        (res) => {
          const status = res.statusCode ?? 500;
          res.destroy();
          if (status >= 200 && status < 300) resolve();
          else
            reject(
              new DeliveryError(`http_${status}`, status >= 300 && status < 500 && status !== 408 && status !== 429),
            );
        },
      );
      req.on("error", () => reject(new DeliveryError("connection_failed")));
      req.end(body);
    });
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendEmail(
  smtp: SmtpSettings,
  recipient: string,
  payload: NotificationPayload,
  id: string,
): Promise<void> {
  if (!smtp.enabled) throw new DeliveryError("email_disabled", true);
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.security === "tls",
    requireTLS: true,
    ...(smtp.username ? { auth: { user: smtp.username, pass: smtp.password } } : {}),
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    logger: false,
    debug: false,
    disableFileAccess: true,
    disableUrlAccess: true,
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      transport.sendMail({
        from: { name: smtp.fromName, address: smtp.from },
        to: { name: "", address: recipient },
        subject: payload.subject,
        text: payload.text,
        messageId: `<${id}@jekimo.local>`,
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          transport.close();
          reject(new DeliveryError("smtp_timeout"));
        }, 45000);
      }),
    ]);
  } catch (error) {
    if (error instanceof DeliveryError) throw error;
    const code = (error as { responseCode?: number }).responseCode;
    throw new DeliveryError(code ? `smtp_${code}` : "smtp_failed", Boolean(code && code >= 500));
  } finally {
    clearTimeout(timeout);
    transport.close();
  }
}

export async function deliverNotification(
  job: ClaimedNotification,
  secret: ChannelSecret,
  smtp: SmtpSettings | null,
  publicUrl: string | null,
): Promise<void> {
  const payload = { ...job.payload };
  if (payload.projectId && payload.issueId && publicUrl)
    payload.text += `\n\n${publicUrl}/projects/${encodeURIComponent(payload.projectId)}/issues/${encodeURIComponent(payload.issueId)}`;
  if (payload.projectId && payload.monitorId && publicUrl)
    payload.text += `\n\n${publicUrl}/projects/${encodeURIComponent(payload.projectId)}/cron`;
  if (payload.projectId && payload.trigger === "slow_query" && publicUrl)
    payload.text += `\n\n${publicUrl}/projects/${encodeURIComponent(payload.projectId)}/database`;
  if (job.kind === "email") {
    if (!smtp) throw new DeliveryError("email_not_configured", true);
    await sendEmail(smtp, secret.destination, payload, job.id);
  } else await sendWebhook(job.kind, secret, payload, job.id);
}
