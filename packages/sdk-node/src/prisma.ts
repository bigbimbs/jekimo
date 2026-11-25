import type { PrismaTracingExtension, PrismaTracingOptions } from "./types/integrations.js";

export function createPrismaTracingExtension(options: PrismaTracingOptions): PrismaTracingExtension {
  return {
    name: "jekimo-query-timing",
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          return options.client.traceQuery(
            {
              name: `${model}.${operation}`,
              system: options.system,
              operation: /^(find|count|aggregate|groupBy)/.test(operation)
                ? "select"
                : operation.startsWith("create")
                  ? "insert"
                  : operation.startsWith("update")
                    ? "update"
                    : operation.startsWith("delete")
                      ? "delete"
                      : "other",
            },
            () => query(args),
          );
        },
      },
    },
  };
}
