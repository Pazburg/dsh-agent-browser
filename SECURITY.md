# Security policy

## Supported versions

| Version | Status |
|---|---|
| 1.1.x | supported |
| < 1.1.0 | please upgrade |

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities)
(Security → Advisories → Report a vulnerability) on this repository, or contact
the maintainer directly. Include:

- affected version and DSH version,
- a minimal reproduction (page HTML / steps / tool calls),
- the impact you believe it has,
- whether the issue also affects the installed plugin or only the test suite.

We will acknowledge reports as soon as possible and credit reporters unless
asked otherwise.

## What this plugin tries to guarantee

This is a **single-user desktop plugin** that gives an LLM agent a limited,
auditable browser. Its security model is deliberately narrow:

- **No credential handling.** `password` and `file` inputs are never filled, and
  `browser_read` never returns their plaintext: flat editable entries expose only
  `valueLength`, form text controls additionally set `redacted: true`. This holds
  for the top document and same-origin iframes.
- **No implicit actions.** The plugin never presses Enter, never calls
  `form.submit()` / `requestSubmit()`, and never clicks unless the tool call
  explicitly passes `click: true`. There is no separate click or submit tool.
- **Explicit click only.** `browser_fill({ click: true, ... })` is the only way to
  click a radio/checkbox/button/link; without it those controls are rejected.
  Disabled/detached controls are rejected.
- **URL gating.** With `openPolicy: confirm` (the shipped default; a missing key
  also falls back to `confirm`), URLs outside the allowlist require an interactive
  "Allow" click in the DSH panel before they load. `free` mode is available for
  trusted, local-only workflows but removes this gate — use it with care.
  Domain rules reject suffix tricking; URL-prefix rules are origin-scoped.
- **Local token.** The Host↔Client HTTP channel is protected by a random token
  claimed by the panel; requests without it are rejected (403). The route is
  served through DSH's web server, which applies Host/Origin checks. This
  protects against accidental or cross-origin command delivery; it does **not**
  defend against a hostile local process that can already reach DSH's loopback
  server (`/claim` and `/reclaim` are first-come by design). The local user
  account is assumed trusted.
- **Browser isolation.** The webview is created through DSH's browser lease.
  DSH (tested with 0.2.1-rc.2) applies `nodeIntegration: false`,
  `contextIsolation: true` and `sandbox: true`; these web preferences are
  DSH-owned, not set by this repository. The plugin never creates a BrowserWindow
  and never touches your regular browser or its profile.

## What this plugin does *not* protect against

- **Prompt injection.** Web pages are untrusted input. A malicious page can try
  to convince the agent to read data, click buttons or navigate elsewhere. The
  plugin's explicit-click rule limits accidental actions, but it cannot make an
  agent immune to manipulation. Use `confirm` mode on untrusted pages and watch
  the panel while the agent works.
- **Malicious websites themselves.** The webview is Chromium; a page exploit is
  a Chromium/Electron issue, not something this plugin can fix.
- **Synthetic click trust.** Clicks are injected events (`isTrusted=false`).
  Sites that require real user activation may reject them; sites that accept
  them will see them as agent actions.
- **Post-click consequences.** Clicking a submit button or link can perform a
  native navigation/POST. That is by design when the tool call explicitly asks
  for it; verify the page result afterwards.
- **Compromised DSH or OS.** The plugin runs inside DSH and trusts the DSH
  runtime, its session, and the local user account.

## Safe defaults

- Keep `openPolicy: confirm` unless you have a specific reason not to.
- Do not add broad allowlist rules such as `com` or `*`.
- Treat agent sessions that can use the browser like a user sitting at the
  keyboard: only run them on pages you are willing to let them read and click.
- The internal browser partition is in-memory: closing DSH discards cookies and
  logins (that is DSH behaviour, not a plugin setting). Re-authenticate each run.
