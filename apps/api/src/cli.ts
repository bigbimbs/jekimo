import { createPool, PostgresMetadataRepository } from "@jekimo/storage-postgres";
import { runAdminCommand } from "./admin-command.js";
import { loadApiConfig } from "./config.js";

async function main(): Promise<number> {
  const config = loadApiConfig();
  const pool = createPool({ applicationName: "jekimo-cli", max: 1 });
  try {
    return await runAdminCommand(process.argv.slice(2), {
      metadata: new PostgresMetadataRepository(pool),
      inviteExpiryDays: config.inviteExpiryDays,
      publicUrl: config.publicUrl,
      clock: () => new Date(),
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    });
  } finally {
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : "command failed");
    process.exit(1);
  },
);
