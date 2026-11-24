import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api-client";
import { fakeApi, MEMBER, renderApp } from "../../test/render";
import { SignInPage } from "../auth/sign-in-page";
import { SecurityPage } from "./security-page";

vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,synthetic") } }));
const OPTIONAL = { enabled: false, required: false, configured: true, recovery_codes_remaining: 0 };
const SECRET = "SYNTHETICSETUPKEY";
const RECOVERY = "aabb-ccdd-eeff-0011-2233-4455-6677-8899";

async function confirmPassword(user: ReturnType<typeof userEvent.setup>, code?: string) {
  await user.type(screen.getByLabelText("Current password"), "synthetic-password");
  if (code) await user.type(screen.getByLabelText("Authenticator or recovery code"), code);
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Confirm" }));
}

describe("Account security", () => {
  it("lets a regular user opt in, shows QR/manual setup, and keeps secrets out of caches", async () => {
    const user = userEvent.setup();
    const getTwoFactor = vi.fn().mockResolvedValue(OPTIONAL);
    const setupTwoFactor = vi.fn().mockResolvedValue({
      secret: SECRET,
      otpauth_uri: "otpauth://totp/Jekimo:synthetic?secret=SYNTHETICSETUPKEY",
      expires_at: "2026-11-11T12:00:00Z",
    });
    const enableTwoFactor = vi.fn().mockImplementation(async () => {
      getTwoFactor.mockResolvedValue({ ...OPTIONAL, enabled: true, recovery_codes_remaining: 8 });
      return { recovery_codes: [RECOVERY] };
    });
    const { queryClient } = renderApp(<SecurityPage />, {
      user: MEMBER,
      api: fakeApi({ getTwoFactor, setupTwoFactor, enableTwoFactor }),
    });
    await user.click(await screen.findByRole("button", { name: "Set up authenticator" }));
    await confirmPassword(user);
    expect(await screen.findByLabelText("Setup key")).toHaveValue(SECRET);
    expect(await screen.findByRole("img", { name: "Authenticator setup QR code" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("Authenticator code"), "123456");
    await user.click(screen.getByRole("button", { name: "Verify and enable" }));
    expect(await screen.findByText(RECOVERY)).toBeInTheDocument();
    expect(enableTwoFactor).toHaveBeenCalledWith("123456");
    expect(screen.queryByLabelText("Setup key")).not.toBeInTheDocument();
    expect(screen.queryByText("Instance security")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "I saved my recovery codes" }));
    expect(screen.queryByText(RECOVERY)).not.toBeInTheDocument();
    const cache = JSON.stringify({
      queries: queryClient
        .getQueryCache()
        .getAll()
        .map((q) => q.state),
      mutations: queryClient
        .getMutationCache()
        .getAll()
        .map((m) => m.state),
    });
    for (const secret of [SECRET, RECOVERY, "synthetic-password", "123456"]) expect(cache).not.toContain(secret);
  });

  it("hides project navigation for mandatory enrollment and prevents opt-out when required", async () => {
    const { unmount } = renderApp(<SecurityPage />, {
      api: fakeApi({ getTwoFactor: vi.fn().mockResolvedValue({ ...OPTIONAL, required: true }) }),
    });
    expect(await screen.findByText(/Set it up to continue/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Back to dashboard" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Make 2FA optional" })).toBeDisabled();
    unmount();
    renderApp(<SecurityPage />, {
      user: MEMBER,
      api: fakeApi({ getTwoFactor: vi.fn().mockResolvedValue({ ...OPTIONAL, enabled: true, required: true }) }),
    });
    expect(await screen.findByText("Two-factor authentication is enabled.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Disable two-factor authentication" })).not.toBeInTheDocument();
  });

  it("requires password and factor before an enrolled admin changes enforcement", async () => {
    const user = userEvent.setup();
    const getTwoFactor = vi.fn().mockResolvedValue({ ...OPTIONAL, enabled: true });
    const setTwoFactorPolicy = vi.fn().mockImplementation(async () => {
      getTwoFactor.mockResolvedValue({ ...OPTIONAL, enabled: true, required: true });
      return { required: true };
    });
    renderApp(<SecurityPage />, { api: fakeApi({ getTwoFactor, setTwoFactorPolicy }) });
    await user.click(await screen.findByRole("button", { name: "Require 2FA for everyone" }));
    expect(setTwoFactorPolicy).not.toHaveBeenCalled();
    await confirmPassword(user, "123456");
    expect(await screen.findByText("Two-factor authentication is required for everyone.")).toBeInTheDocument();
    expect(setTwoFactorPolicy).toHaveBeenCalledWith(true, "synthetic-password", "123456");
  });

  it("shows the second-factor challenge at sign-in and submits the entered code", async () => {
    const user = userEvent.setup();
    const login = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(401, "two_factor_required", "code required"))
      .mockRejectedValue(new ApiError(400, "invalid_two_factor_code", "invalid"));
    renderApp(<SignInPage />, { api: fakeApi({ login }), user: null });
    await user.type(screen.getByLabelText("Email"), "user@example.test");
    await user.type(screen.getByLabelText("Password"), "synthetic-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await user.type(await screen.findByLabelText("Authenticator or recovery code"), "654321");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(login).toHaveBeenLastCalledWith("user@example.test", "synthetic-password", "654321"));
    expect(await screen.findByText(/This code is invalid or has already been used/)).toBeInTheDocument();
  });
});
