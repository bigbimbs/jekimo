import type { CronRepository } from "@jekimo/storage-postgres";

export class CronWorker {
  private stopped = false;
  private running: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  private lastPrune = 0;
  constructor(
    private readonly repository: CronRepository,
    private readonly onError: () => void,
  ) {}
  start(): void {
    this.running ??= this.loop();
  }
  private async loop(): Promise<void> {
    while (!this.stopped) {
      let count = 0;
      try {
        const now = new Date();
        if (now.getTime() - this.lastPrune > 3600000) {
          await this.repository.prune(now);
          this.lastPrune = now.getTime();
        }
        count = await this.repository.scan(now);
      } catch {
        this.onError();
      }
      if (count < 100 && !this.stopped)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 5000);
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
