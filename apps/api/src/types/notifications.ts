import type { NotificationRepository } from "@jekimo/storage-postgres";
import type { preHandlerHookHandler } from "fastify";
import type { NotificationService } from "../modules/notifications/service.js";

export interface NotificationDeps {
  repository: NotificationRepository;
  encryptionKey: string | null;
}
export interface NotificationRouteOptions {
  service: NotificationService;
  session: preHandlerHookHandler;
  projectAccess: preHandlerHookHandler;
}
