import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILT_IN_ROLE_NAMES,
  canAssignRole,
  DEFAULT_PROJECT_ROLES,
  hasPermission,
  PROJECT_PERMISSIONS,
  type ProjectPermission,
  REQUIRED_PERMISSION,
  validateCustomRole,
} from "../src/index.js";
import { packageRoot } from "./fixtures.js";

const admin = DEFAULT_PROJECT_ROLES.admin;
const member = DEFAULT_PROJECT_ROLES.member;
const viewer = DEFAULT_PROJECT_ROLES.viewer;

/** Parses the built-in roles table from docs/access-model.md into {permission -> {role -> boolean}}. */
function builtInRolesTableFromDocs(): Map<string, Record<string, boolean>> {
  const doc = readFileSync(join(packageRoot, "..", "..", "docs", "access-model.md"), "utf8");
  const section = doc.split("### Built-in roles")[1]?.split("### ")[0];
  if (!section) throw new Error("Built-in roles section not found in docs/access-model.md");
  const rows = section.split("\n").filter((l) => l.startsWith("| `"));
  const out = new Map<string, Record<string, boolean>>();
  for (const row of rows) {
    const cells = row
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean);
    const permission = cells[0]!.replace(/`/g, "");
    out.set(permission, {
      admin: cells[1] === "Yes",
      member: cells[2] === "Yes",
      viewer: cells[3] === "Yes",
    });
  }
  return out;
}

describe("permission catalogue", () => {
  it("has unique, namespaced identifiers", () => {
    expect(new Set(PROJECT_PERMISSIONS).size).toBe(PROJECT_PERMISSIONS.length);
    expect(PROJECT_PERMISSIONS.every((p) => /^[a-z]+\.[a-z]+$/.test(p))).toBe(true);
  });

  it("documents every permission in the catalogue table of docs/access-model.md", () => {
    const doc = readFileSync(join(packageRoot, "..", "..", "docs", "access-model.md"), "utf8");
    for (const p of PROJECT_PERMISSIONS) expect(doc, p).toContain(`| \`${p}\` |`);
  });
});

describe("built-in roles", () => {
  it("admin holds every permission", () => {
    expect([...admin].sort()).toEqual([...PROJECT_PERMISSIONS].sort());
  });

  it("member and viewer are strict subsets, and every role includes project.read", () => {
    expect([...member].every((p) => admin.has(p))).toBe(true);
    expect([...viewer].every((p) => member.has(p))).toBe(true);
    expect(viewer.size).toBeLessThan(member.size);
    expect(member.size).toBeLessThan(admin.size);
    for (const name of BUILT_IN_ROLE_NAMES)
      expect(hasPermission({ permissions: DEFAULT_PROJECT_ROLES[name] }, REQUIRED_PERMISSION)).toBe(true);
  });

  it("match the table in docs/access-model.md exactly", () => {
    const table = builtInRolesTableFromDocs();
    expect([...table.keys()].sort()).toEqual([...PROJECT_PERMISSIONS].sort());
    for (const [permission, roles] of table) {
      for (const name of BUILT_IN_ROLE_NAMES) {
        expect(DEFAULT_PROJECT_ROLES[name].has(permission as ProjectPermission), `${name} ${permission}`).toBe(
          roles[name],
        );
      }
    }
  });
});

describe("validateCustomRole", () => {
  it("accepts a well-formed role from an actor who holds its permissions", () => {
    const r = validateCustomRole(
      { name: "On-call", permissions: ["project.read", "issues.manage", "keys.manage"] },
      admin,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.role).toEqual({
        name: "On-call",
        permissions: new Set(["project.read", "issues.manage", "keys.manage"]),
        builtIn: false,
      });
    }
  });

  it("rejects empty, overlong, and reserved names", () => {
    const perms = ["project.read"];
    for (const [name, code] of [
      ["", "name_empty"],
      ["   ", "name_empty"],
      ["x".repeat(41), "name_too_long"],
      ["Admin", "name_reserved"],
      ["viewer", "name_reserved"],
    ] as const) {
      const r = validateCustomRole({ name, permissions: perms }, admin);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues.map((i) => i.code)).toContain(code);
    }
  });

  it("rejects unknown permissions and roles without project.read", () => {
    const r1 = validateCustomRole({ name: "x", permissions: ["project.read", "billing.manage"] }, admin);
    expect(!r1.ok && r1.issues.some((i) => i.code === "unknown_permission" && i.permission === "billing.manage")).toBe(
      true,
    );
    const r2 = validateCustomRole({ name: "x", permissions: ["issues.manage"] }, admin);
    expect(!r2.ok && r2.issues.some((i) => i.code === "missing_required_permission")).toBe(true);
    const r3 = validateCustomRole({ name: "x", permissions: "project.read" }, admin);
    expect(!r3.ok && r3.issues.some((i) => i.code === "unknown_permission")).toBe(true);
  });

  it("prevents escalation: actors cannot grant what they do not hold", () => {
    const actor = new Set<ProjectPermission>(["project.read", "issues.manage", "roles.manage"]);
    const r = validateCustomRole(
      { name: "Sneaky", permissions: ["project.read", "keys.manage", "project.delete"] },
      actor,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(
        r.issues
          .filter((i) => i.code === "escalation")
          .map((i) => i.permission)
          .sort(),
      ).toEqual(["keys.manage", "project.delete"]);
    }
    expect(validateCustomRole({ name: "Triage", permissions: ["project.read", "issues.manage"] }, actor).ok).toBe(true);
  });

  it("reports every problem at once", () => {
    const r = validateCustomRole({ name: "", permissions: ["nope"] }, viewer);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.issues.map((i) => i.code).sort()).toEqual([
        "missing_required_permission",
        "name_empty",
        "unknown_permission",
      ]);
  });
});

describe("canAssignRole", () => {
  it("requires members.manage and every permission of the role", () => {
    expect(canAssignRole(admin, { permissions: admin })).toBe(true);
    expect(canAssignRole(admin, { permissions: viewer })).toBe(true);
    expect(canAssignRole(member, { permissions: viewer })).toBe(false);
    const manager = new Set<ProjectPermission>(["project.read", "members.manage"]);
    expect(canAssignRole(manager, { permissions: viewer })).toBe(true);
    expect(canAssignRole(manager, { permissions: member })).toBe(false);
  });
});
