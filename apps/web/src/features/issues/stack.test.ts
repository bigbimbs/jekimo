import { describe, expect, it } from "vitest";
import { parseStack } from "./stack";

describe("parseStack", () => {
  it("splits frames and marks app frames by the event-format rule", () => {
    const lines = parseStack(
      [
        "TypeError: x is undefined",
        "    at formatTotal (/srv/app/src/format.ts:42:17)",
        "    at Layer.handle (/srv/app/node_modules/express/lib/router/layer.js:95:5)",
        "    at async Promise.all (index 0)",
        "    at /srv/app/src/main.ts:3:1",
        "    at process.processTicksAndRejections (node:internal/process/task_queues:105:5)",
      ].join("\n"),
    );
    expect(lines.map((l) => [l.frame, l.inApp])).toEqual([
      [false, false],
      [true, true],
      [true, false],
      [true, false],
      [true, true],
      [true, false],
    ]);
    expect(lines[1]?.parts).toEqual({
      lead: "    at ",
      fn: "formatTotal",
      location: "/srv/app/src/format.ts",
      position: ":42:17",
    });
    expect(lines[4]?.parts).toEqual({ lead: "    at ", fn: "", location: "/srv/app/src/main.ts", position: ":3:1" });
  });
});
