import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { fakeApi, MEMBER, renderApp } from "../../test/render";
import type { IngestionKey } from "../../types/api";
import { KeysSection } from "./keys-section";

const SECRET = "jk_K2NEWKEY0001_c2VjcmV0LW9ubHktZm9yLXRlc3Rz";

const KEY: IngestionKey = {
  key_id: "K1OLDKEY00001",
  name: "billing-api",
  status: "active",
  created_at: "2026-11-01T00:00:00.000Z",
  created_by: null,
  expires_at: null,
  revoked_at: null,
};

describe("KeysSection", () => {
  it("lists keys by key_id and shows a new key once, with copy and warning", async () => {
    const listKeys = vi.fn().mockResolvedValue([KEY]);
    const createKey = vi.fn().mockResolvedValue({
      key_id: "K2NEWKEY0001",
      key: SECRET,
      name: "worker",
      created_at: "2026-11-08T00:00:00.000Z",
    });
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    const { queryClient } = renderApp(<KeysSection projectId="prj_a" />, { api: fakeApi({ listKeys, createKey }) });

    expect(await screen.findByText("K1OLDKEY00001")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Create key" }));
    await user.type(screen.getByLabelText("Name"), "worker");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Create key" }));

    const dialog = await screen.findByRole("dialog", { name: "Copy your new ingestion key" });
    expect(createKey).toHaveBeenCalledWith("prj_a", "worker");
    expect(within(dialog).getByRole("textbox", { name: "Ingestion key K2NEWKEY0001" })).toHaveValue(SECRET);
    expect(within(dialog).getByText(/will not be shown again/)).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Copy" }));
    expect(writeText).toHaveBeenCalledWith(SECRET);
    expect(within(dialog).getByRole("button", { name: "Copied" })).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(document.body).not.toHaveTextContent(SECRET);
    expect(
      JSON.stringify(
        queryClient
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(SECRET);
    expect(
      JSON.stringify(
        queryClient
          .getMutationCache()
          .getAll()
          .map((m) => m.state.data),
      ),
    ).not.toContain(SECRET);
  });

  it("rotates after confirmation and says when the old key stops working", async () => {
    const rotateKey = vi.fn().mockResolvedValue({
      key_id: "K3ROTATED0001",
      key: SECRET,
      name: "billing-api",
      created_at: "2026-11-08T00:00:00.000Z",
      rotated: { ...KEY, status: "rotating", expires_at: "2026-11-09T00:00:00.000Z" },
    });
    const user = userEvent.setup();
    renderApp(<KeysSection projectId="prj_a" />, {
      api: fakeApi({ listKeys: vi.fn().mockResolvedValue([KEY]), rotateKey }),
    });

    await user.click(await screen.findByRole("button", { name: "Rotate" }));
    await user.click(screen.getByRole("button", { name: "Rotate key" }));
    const dialog = await screen.findByRole("dialog", { name: "Copy your new ingestion key" });
    expect(rotateKey).toHaveBeenCalledWith("prj_a", "K1OLDKEY00001");
    expect(within(dialog).getByText(/The old key K1OLDKEY00001 keeps working until/)).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox")).toHaveValue(SECRET);
  });

  it("explains the missing permission to a member without keys.manage", async () => {
    const listKeys = vi.fn();
    renderApp(<KeysSection projectId="prj_a" />, {
      user: MEMBER,
      api: fakeApi({
        listKeys,
        listMembers: vi
          .fn()
          .mockResolvedValue([
            { user_id: MEMBER.id, email: MEMBER.email, status: "active", role: "member", created_at: "" },
          ]),
        listRoles: vi.fn().mockResolvedValue([
          {
            name: "member",
            description: null,
            permissions: ["project.read", "issues.manage"],
            built_in: true,
            member_count: 1,
          },
        ]),
      }),
    });
    expect(await screen.findByText(/You need the keys.manage permission/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create key" })).not.toBeInTheDocument();
    expect(listKeys).not.toHaveBeenCalled();
  });
});
