# Web dashboard

The React and TypeScript dashboard: first-run setup, sign-in, invitation and password reset links, a project switcher, a project overview with 24-hour counts and activity, separate log and custom-event explorers, each project's issues with filters, an issue's detail with its latest event and stack trace, resolving, ignoring, and reopening issues, the project's ingestion keys, project membership management, account security with authenticator enrollment and recovery codes, instance-wide 2FA enforcement, and admin user management, invitations, and audit log.

It is built with Vite, React, TypeScript, Tailwind CSS, shadcn/ui components (copied into `src/components/ui` as source, on Radix primitives), TanStack Query, and React Router. The build is static files with every script, stylesheet, font (Inter, from `@fontsource-variable/inter`), and icon bundled; the browser contacts only the Jekimo instance. See "Dashboard" and "Translation" in [docs/architecture.md](../../docs/architecture.md).

See [Dashboard navigation and counts](../../docs/dashboard.md) for the distinction between record explorers and grouped issues.

## Pages

| Path | Page |
| --- | --- |
| `/security` | Account 2FA setup, recovery-code regeneration, opt-out when optional, and instance-admin enforcement controls. |
| `/admin/users` | Instance-admin account list with email/role/status filters, role changes, activation controls, and one-time password-reset links. |
| `/admin/invitations` | Pending invitations, one-time link creation and copying, expiry dates, and confirmed revocation. |
| `/admin/audit-log` | Instance-admin audit viewer with action, actor, and time filters, expandable details, and cursor pagination. |
| `/setup` | First-run setup with the token from the API's log. Shows the first project's ingestion key once, then signs in. |
| `/sign-in` | Sign in. Returns to the page that asked for it (`?next=`, same-site paths only). |
| `/invite#token=…` | Accept an invitation by choosing a password. |
| `/reset-password#token=…` | Set a new password from a reset link. |
| `/projects/:id/dashboard` | Overview: stored-record totals for the last 24 hours, hourly activity, severity breakdown, and the five most recently seen unresolved issues. |
| `/projects/:id/logs` | Individual `kind=log` records, message search, exact environment, severity and receipt-time filters, and cursor pagination. |
| `/projects/:id/events` | Individual `kind=event` custom application records, with the same search and filter controls. |
| `/projects/:id/logs/:event_id`, `/projects/:id/events/:event_id` | Record message, receipt and occurrence timestamps, metadata, context, attributes, and stored payload. |
| `/projects/:id/issues` | Issues, newest last seen first, filtered by status, kind, severity, and last seen, with "Load more" pages. Filters are kept in the address. |
| `/projects/:id/issues/:issue_id` | Message, exception type and value, stack trace (app frames highlighted, library frames can be hidden), context, attributes, release, environment, first and last seen, and the latest event. |
| `/projects/:id/members` | Project members, account status, roles, and join dates; add existing users by email, change roles, and confirm removals. |
| `/projects/:id/settings` | Project settings and ingestion keys by `key_id`. |

The link pages read the token from the fragment and remove it from the address bar and history before anything else.

## Rules it follows

- **Project isolation.** A project id in the address is used only to route; the API decides access on every request ([docs/access-model.md](../../docs/access-model.md), "Authorization enforcement", rule 6). Every cached query with project data is keyed under `["project", id]`, and leaving a project removes all of them, so switching projects never shows the previous project's data, even for a frame. A project the user cannot access renders "Project not found" and fetches nothing else.
- **Permissions.** Resolve, ignore, and reopen appear only for users with `issues.manage`; the key list and its actions only with `keys.manage`. Membership changes require `members.manage`; target members and assignable roles are limited to permissions the operator holds. Membership changes refresh permissions and project access. Removing your own membership drops the project cache, while instance admins retain instance-wide access. The dashboard never sends `force=true`, so the API protects the last project admin. The dashboard derives the user's permissions from the project's members and roles (instance admins hold every permission); the API still checks every request.
- **Ingestion keys are shown once.** Creating or rotating a key opens a dialog with the full key, a copy button, and a warning that it will not be shown again ([docs/ingestion-protocol.md](../../docs/ingestion-protocol.md), "Authentication", Rules). The key is held in that dialog's state only and dropped when it closes; it never enters the query cache.
- **Sessions.** The API client sends cookies same-origin and the CSRF token from the session response in `x-jekimo-csrf-token` on every state change. The token lives in memory only. A `401` on a signed-in request clears every cache and returns to sign-in.
- **Text.** Every user-visible string comes from the ICU catalogues in `src/locales/en/<namespace>.json` (`common`, `auth`, `issues`, `settings`, `members`, `security`, `audit`, `errors`) through react-i18next with i18next-icu. Keys are typed from the English catalogue, so a missing key fails `npm run typecheck`, and `test/catalogues.test.ts` checks every locale for missing or extra keys, empty values, invalid ICU, and mismatched variables. API errors are rendered from `error.code`, with the English `message` only for codes the catalogue lacks. Captured event data is never translated. Dates and numbers use `Intl`; layouts use logical properties.

## Themes and palette

Light and dark themes are defined once as CSS variables in `src/index.css` (shadcn/ui's token approach). The palette is the calm, low-glare look of developer tools:

| Role | Light | Dark |
| --- | --- | --- |
| Background | `#ffffff` | `#0f1115` |
| Surfaces, sidebar, code | `#f6f7f9` | `#171a21` |
| Borders | `#e4e6eb` | `#262a33` |
| Text | `#16181d` | `#e6e8ee` |
| Secondary text | `#5b6170` | `#9aa1ae` |
| Accent: primary actions, links, focus, selection only | `#4f46e5` | `#818cf8` |
| Severity `debug` / `info` / `warning` / `error` / `fatal` | `#6b7280` / `#2563eb` / `#b45309` / `#dc2626` / `#a21caf` | `#8b919e` / `#60a5fa` / `#fbbf24` / `#f87171` / `#e879f9` |
| Success, resolved | `#15803d` | `#4ade80` |

Neutrals carry the UI; color is the exception. Severity, status, and key badges have a soft tint, a colored dot or icon, and their text label in the foreground color, so color is never the only signal and text contrast never depends on the hue. Stack traces use the system monospace stack on the code surface: app frames at full contrast with the function name emphasized, library frames dimmed, and positions in secondary text, with no syntax colors.

`test/contrast.test.ts` reads the tokens from `src/index.css` and checks, for both themes, 4.5:1 for every text pair (text and secondary text on every surface, button text, links, error text, and text on each tinted badge) and 3:1 for focus rings, field borders, and status colors (WCAG 2.2, 1.4.3 and 1.4.11). Change a token and the test tells you if it falls short. The theme follows the operating system until the user picks System, Light, or Dark in the toggle; the choice is kept in `localStorage` (`jekimo.theme`) for that browser. `public/theme.js` applies it before the first paint, so the page never flashes the wrong theme; it is a file rather than an inline script so the Content-Security-Policy keeps `script-src 'self'`.

## Code layout

- `src/app/` — providers, routes, and the not-found page.
- `src/features/<area>/` — `auth`, `projects` (shell, switcher, permissions), `issues`, `settings`, `members`, `security`, `audit`, `theme`.
- `src/components/` — shared states (empty, loading, error) and `ui/` components.
- `src/lib/` — the API client, i18n, `Intl` formatting, query keys, and error messages.
- `src/types/` and `src/constants/` — declarations, per "Code organization" in [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Development

```bash
npm run dev -w @jekimo/web      # Vite on http://localhost:5173, proxying /api to http://127.0.0.1:8080
npm run build -w @jekimo/web    # dist/
npm test -- apps/web
```

The dev server proxies `/api` to `JEKIMO_DEV_API_URL` (default `http://127.0.0.1:8080`), so run the API first, for example with the dev Compose stack ([docs/local-development.md](../../docs/local-development.md)). Open `http://localhost:5173`: the API's session cookie is `Secure`, which browsers accept over plain HTTP only on `localhost`.

## Image

`apps/web/Dockerfile` builds `ghcr.io/bigbimbs/jekimo-web`: the built files served by Caddy on port 8080 as a non-root user, with a Content-Security-Policy that allows only the instance's own origin, long-lived caching for hashed assets, and `index.html` for every other path. It has no secrets and no database access. In production the front Caddy (`deploy/docker-compose/Caddyfile`) sends `/api/*` and `/healthz` to the API and everything else to this container. A deployment can add routes by mounting `*.caddy` files into `/etc/caddy/conf.d/`; the dev stack uses that to proxy `/api` to the API.

```bash
docker build -f apps/web/Dockerfile -t jekimo-web .
```

## Two-factor authentication

The account menu links to **Account security** and, for instance admins, **Users**, **Invitations**, and **Audit log**. Unenrolled users on an enforced instance are routed to `/security`; the API also rejects their project and administration requests. Authenticator setup and recovery codes stay in component state only and leave memory when the page or result is closed. QR images are generated locally by the bundled `qrcode` library. See [two-factor-authentication.md](../../docs/two-factor-authentication.md) for operator configuration and recovery.
