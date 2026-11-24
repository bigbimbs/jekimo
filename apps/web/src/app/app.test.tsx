import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { createI18n } from "../lib/i18n";
import { ADMIN, project } from "../test/render";
import { App } from "./app";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

it("keeps the original dashboard destination when concurrent requests expire, then returns there after sign-in", async () => {
  let summaryResponse: (response: Response) => void = () => undefined;
  let issuesResponse: (response: Response) => void = () => undefined;
  let signedBackIn = false;
  const fetchMock = vi.fn((input: string) => {
    if (input.endsWith("/auth/session")) return Promise.resolve(json({ user: ADMIN, csrf_token: "synthetic" }));
    if (input.endsWith("/auth/login")) {
      signedBackIn = true;
      return Promise.resolve(json({ user: ADMIN, csrf_token: "synthetic" }));
    }
    if (input.endsWith("/projects")) return Promise.resolve(json({ projects: [project("prj_a")] }));
    if (input.endsWith("/events/summary"))
      return signedBackIn
        ? Promise.resolve(json({ from: "2026-11-10T12:00:00Z", to: "2026-11-11T12:00:00Z", activity: [] }))
        : new Promise<Response>((resolve) => {
            summaryResponse = resolve;
          });
    if (input.includes("/issues?"))
      return signedBackIn
        ? Promise.resolve(json({ issues: [] }))
        : new Promise<Response>((resolve) => {
            issuesResponse = resolve;
          });
    return Promise.reject(new Error(`unexpected request: ${input}`));
  });
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState(null, "", "/projects/prj_a/dashboard");
  const user = userEvent.setup();
  render(<App i18n={createI18n(["en"])} />);
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.filter(([url]) => url.includes("/issues?") || url.endsWith("/events/summary")),
    ).toHaveLength(2),
  );
  await act(async () => {
    summaryResponse(json({ error: { code: "unauthorized", message: "expired" } }, 401));
  });
  await screen.findByRole("heading", { name: "Sign in to Jekimo" });
  await act(async () => {
    issuesResponse(json({ error: { code: "unauthorized", message: "expired" } }, 401));
  });
  expect(new URLSearchParams(window.location.search).get("next")).toBe("/projects/prj_a/dashboard");
  await user.type(screen.getByLabelText("Email"), "admin@example.test");
  await user.type(screen.getByLabelText("Password"), "synthetic-password-123");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  expect(await screen.findByText("No activity in the last 24 hours")).toBeInTheDocument();
  expect(window.location.pathname).toBe("/projects/prj_a/dashboard");
});
