import { DISK_THRESHOLDS } from "@jekimo/event-schema";
import type { DiskConfig } from "../types/disk.js";

export const DEFAULT_DISK_CONFIG: DiskConfig = { thresholds: DISK_THRESHOLDS, path: "/", budgetBytes: null };
