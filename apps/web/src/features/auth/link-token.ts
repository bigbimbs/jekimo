import { useState } from "react";

/**
 * Reads `#token=` from an invitation or reset link once, then removes it from
 * the address bar and history. The token travels in the fragment so it never
 * reaches servers or proxies (apps/api/README.md, invitation links).
 */
export function useLinkToken(): string | null {
  const [token] = useState(() => {
    const value = new URLSearchParams(window.location.hash.slice(1)).get("token");
    if (window.location.hash) {
      window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
    }
    return value;
  });
  return token;
}
