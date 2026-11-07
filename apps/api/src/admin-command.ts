// docs/access-model.md, "Invitations and recovery without email": this is how
// an instance admin recovers their own account, and there is no other back door.

import { accountLink, newAccountToken } from "./account-links.js";
import { DAY_MS } from "./constants/index.js";
import type { AdminCommandDeps } from "./types/index.js";

const ADMIN_USAGE = "usage: jekimo admin reset-password <email>";

export async function runAdminCommand(args: readonly string[], deps: AdminCommandDeps): Promise<number> {
  const [group, command, email, ...rest] = args;
  if (group !== "admin" || command !== "reset-password" || !email || rest.length > 0) {
    deps.err(ADMIN_USAGE);
    return 2;
  }
  const user = await deps.metadata.findUserByEmail(email);
  if (!user) {
    deps.err("no user with that email");
    return 1;
  }
  const { token, tokenHash } = newAccountToken();
  const result = await deps.metadata.createPasswordReset(null, {
    userId: user.id,
    tokenHash,
    expiresAt: new Date(deps.clock().getTime() + deps.inviteExpiryDays * DAY_MS),
  });
  if (!result.ok) {
    deps.err("no user with that email");
    return 1;
  }
  deps.out(`Password reset link for ${user.email}, valid until ${result.reset.expiresAt.toISOString()}, single use:`);
  deps.out("");
  deps.out(`  ${accountLink(deps.publicUrl, "reset-password", token)}`);
  deps.out("");
  if (deps.publicUrl === null) {
    deps.out("JEKIMO_PUBLIC_URL is not set, so this is a path: prefix it with the address you serve Jekimo on.");
  }
  deps.out("Until the dashboard is available, POST the token after #token= to /api/v1/auth/password-reset.");
  if (user.status !== "active") deps.out("Note: this user is deactivated and cannot sign in until reactivated.");
  return 0;
}
