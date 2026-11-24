import type { ChannelSecret, NotificationRepository, SmtpSettings } from "@jekimo/storage-postgres";
import { openNotification } from "@jekimo/storage-postgres";
import { DeliveryError, deliverNotification } from "./notification-transport.js";

export async function deliverNextNotification(
  repository: NotificationRepository,
  encryptionKey: string,
  publicUrl: string | null,
  send: typeof deliverNotification = deliverNotification,
): Promise<boolean> {
  const job = await repository.claim();
  if (!job) return false;
  let failure: string | null = null;
  let permanent = false;
  try {
    const separator = job.secret.indexOf(":");
    let secret: ChannelSecret;
    let smtp: SmtpSettings | null = null;
    try {
      secret = openNotification<ChannelSecret>(
        job.secret.slice(separator + 1),
        encryptionKey,
        job.secret.slice(0, separator),
      );
      if (job.kind === "email") {
        const encrypted = await repository.getSmtp();
        if (encrypted) smtp = openNotification<SmtpSettings>(encrypted, encryptionKey, "smtp");
      }
    } catch {
      throw new DeliveryError("settings_unavailable");
    }
    await send(job, secret, smtp, publicUrl);
  } catch (error) {
    failure = error instanceof DeliveryError ? error.code : "delivery_failed";
    permanent = error instanceof DeliveryError && error.permanent;
  }
  await repository.finish(job, failure, permanent);
  return true;
}

export class NotificationWorker {
  private stopped = false;
  private running: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private lastPrune = 0;
  constructor(
    private readonly repository: NotificationRepository,
    private readonly key: string,
    private readonly publicUrl: string | null,
    private readonly onError: () => void,
  ) {}
  start(): void {
    this.running ??= this.loop();
  }
  private async loop(): Promise<void> {
    while (!this.stopped) {
      let busy = false;
      try {
        if (Date.now() - this.lastPrune > 3600000) {
          await this.repository.prune();
          this.lastPrune = Date.now();
        }
        await this.repository.scheduleAlerts();
        busy = await deliverNextNotification(this.repository, this.key, this.publicUrl);
      } catch {
        this.onError();
      }
      if (!busy && !this.stopped)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1000);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.running;
  }
}
