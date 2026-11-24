export const CRON_RUN_STATUSES = ["started", "ok", "error", "timeout", "missed", "cancelled"] as const;
export type CronRunStatus = (typeof CRON_RUN_STATUSES)[number];
export const CRON_HEALTH = ["pending", "healthy", "failing"] as const;
export type CronHealth = (typeof CRON_HEALTH)[number];
export const CRON_LIMITS = { monitors: 100, checkInsPerMinute: 120, concurrentRuns: 100, historyDays: 30 } as const;
