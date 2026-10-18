# dsh-agent-browser

[![CI](https://github.com/Pazburg/dsh-agent-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/Pazburg/dsh-agent-browser/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A **controlled, agent-facing browser panel** for the [DSH (DeepSeek Harness)](https://github.com/deepseek-ai) desktop app. It gives an LLM agent six small tools to open pages, read them, fill inputs, take screenshots and — only when explicitly requested — click controls. The browser lives inside DSH's right sidebar; it never touches your normal browser, never presses <kbd>Enter</kbd> and never calls `form.submit()`.

> **Status: experimental.** Built and tested against DSH desktop `0.2.1-rc.2` (Electron 44 / Node 24) on Windows. The plugin talks to DSH-internal APIs that may change between DSH releases; pin a DSH version you have tested.

---

## Highlights

- **Works inside DSH.** A real Chromium `<webview>` in a right-sidebar tab (`kind = agent-browser`), driven through DSH's own lease API — no separate browser window, no external browser profile.
- **Read / fill / screenshot.** Page text, editable elements (input, textarea, select, contenteditable, CodeMirror, Monaco, Ace), forms with radio/checkbox metadata, buttons and links.
- **Explicit click only.** `browser_fill({ click: true, ... })` is the *only* way to click. Without it, radio/checkbox/button/link targets are rejected. No Enter key, no `form.submit()`, no implicit submit.
- **Credentials stay out of the loop.** `password` and `file` fields are never filled, and `browser_read` never returns their plaintext — flat `editables` entries expose only `valueLength`, while form text controls also set `redacted: true`. Same for same-origin iframes.
- **Same-origin iframes supported.** The global `index` numbering is consistent across nested documents; `framePath` scopes selectors and validates indices.
- **Safer default policy.** Ships with `openPolicy: confirm`: URLs outside the allowlist require you to click **Allow** in the panel. A `free` mode is available for trusted/local-only workflows.
- **Honest state reporting.** Disabled/detached controls, cancelled clicks and failed receipts are reported as errors — never as fake success.
- **Zero runtime dependencies.** Two plain ESM files plus a manifest; tests use a DOM implementation only as a dev dependency.

## How it works

```
┌─ DSH window ──────────────────────────────────────────────────────┐
│                                           │ right sidebar          │
│                                           │ ┌────────────────────┐ │
│   normal DSH chat                         │ │ ← ↻ [url......] ↵  │ │
│                                           │ │ title · host/path  │ │
│                                           │ │ ┌────────────────┐ │ │
│                                           │ │ │    webview     │ │ │
│                                           │ │ └────────────────┘ │ │
│                                           │ │ allowlist (collapsible) │
│                                           │ └────────────────────┘ │
└───────────────────────────────────────────────────────────────────┘
        ▲                                        │
        │ tool calls (open/read/fill/screenshot) │ polls every 500 ms
        │                                        ▼
   Host plugin (dsh-desktop-host subprocess)  ──HTTP── /dsh-agent-browser/*
```

DSH separates the two halves: the **Host** half (`index.js`) runs in the `dsh-desktop-host` subprocess and cannot touch the page; the **Client** half (`client.js`) runs in the DSH renderer and owns the `<webview>`. They communicate through a token-protected HTTP command queue polled every 500 ms. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the protocol.

**Interface language:** the panel UI and the model-facing tool descriptions are currently Chinese; this README and the docs are English, with a Chinese companion at [README.zh-CN.md](README.zh-CN.md).

## Requirements

- DSH desktop app **0.2.x** (developed against `0.2.1-rc.2`) — only the desktop window exposes `dshDesktop.browser`; opening DSH in a normal browser cannot create the controlled webview.
- Windows for the provided `install.cmd` / `install.ps1` helpers. Manual installation works on any platform DSH supports; the Node self-tests are portable.
- Node.js **20+** for development and tests; CI runs 22/24 (the plugin itself runs inside DSH's Node).

## Install

### One-click (Windows, from the repo root)

1. Fully quit the DSH desktop app (tray → **Quit**; closing the window may only hide it).
2. Double-click **`install.cmd`**.
3. Start DSH again, open the right sidebar and pick the **AI Browser** tab (or simply let the agent use the browser once — it opens the tab itself).

The installer copies the runtime files to:

```
%USERPROFILE%\.dsh\profiles\desktop\node_modules\@local\dsh-agent-browser\
```

backs up an existing plugin folder to `…\profiles\desktop\agent-browser-backups\install-<timestamp>\`, preserves an existing `cordis.patch.yml` (your configuration), registers `@local/dsh-agent-browser` in `…\profiles\desktop\package.json` → `dsh.profile.bundles`, and rolls the manifest back if validation fails.

### Manual install

1. Quit DSH.
2. Copy `index.js`, `client.js`, `package.json`, `cordis.patch.yml` (and optionally `README.md`, `CHANGELOG.md`) into
   `%USERPROFILE%\.dsh\profiles\desktop\node_modules\@local\dsh-agent-browser\`.
3. Add `"@local/dsh-agent-browser"` to the `dsh.profile.bundles` array of
   `%USERPROFILE%\.dsh\profiles\desktop\package.json`.
4. Restart DSH.

> The `@local/` package scope is a DSH convention for locally installed plugin bundles. Keep it unless you also change the bundle registration and client module id consistently.
>
> The installer accepts `-ProfileDir <path>` for a non-default profile (for example an isolated test profile). This is a DSH plugin, not an npm package; `private: true` in `package.json` is intentional.

### Uninstall

Fully quit DSH, then run `uninstall.cmd` (removes the bundle entry and the plugin folder). Or, to just disable it, remove `@local/dsh-agent-browser` from `dsh.profile.bundles` and restart DSH.

## First run

1. Restart DSH. The **AI Browser** tab appears in the right sidebar (you can also open it via the sidebar's **+** picker).
2. In the panel, type the page URL you want the agent to work on and open it once (user-initiated navigation does not need the allowlist).
3. Sign in to the site **yourself** in the panel if it needs a login. The internal browser partition is in-memory: it survives for the current DSH run and is discarded when DSH exits (DSH behaviour, not a plugin setting).
4. Ask the agent to read/fill. In `confirm` mode, URLs outside the allowlist show an **Allow / Not now** prompt before loading.

## Configuration

Configuration lives in the bundle patch `cordis.patch.yml` of the installed plugin. Edit that file and restart DSH. If `openPolicy` is omitted entirely, the plugin falls back to `confirm` (safe default).

```yaml
- insert:
    - id: dsh-agent-browser
      name: '@local/dsh-agent-browser'
      config:
        # confirm (default) = ask before loading non-allowlisted URLs
        # free             = open any http/https URL directly (allowlist UI disabled)
        openPolicy: confirm

        # Optional: hosts (suffix match, subdomains included) where the
        # "portal click bridge" is injected. Useful for intranet portals that
        # window.open('') and then write a form into the blank window.
        # portalBridgeHosts:
        #   - example.com

        # Optional: preload allowlist entries (confirm mode only).
        # allowlist:
        #   - example.com
        #   - https://intranet.example.com/app

        # Optional: screenshot output directory.
        # shotDir: C:\Users\you\Pictures\dsh-shots
```

The plugin stores runtime data in `$DSH_HOME/agent-browser/` (normally `~/.dsh/agent-browser/`):

- `allowlist.json` — allowlist entries added from the panel,
- `shots/` — default screenshot directory.

### Allowlist rules

- Domain rule: `example.com` — matches the host itself and all subdomains (`app.example.com`, `deep.sub.example.com`).
- URL prefix rule: `https://app.example.com/path` — matches URLs starting with that prefix.
- Domain rules reject suffix tricking (`notexample.com` will not match `example.com`). URL-prefix rules are **origin-scoped**: a rule for `https://example.com` will not match `https://example.com.evil.com` or another port. Invalid entries are refused.

## Tools

All tools are registered on the DSH Host and return JSON (rendered as text for the model).

| Tool | Purpose | Key parameters |
|---|---|---|
| `browser_panel` | Panel connectivity/status, current page, allowlist, pending commands. Call it before browser work. | — |
| `browser_open` | Open an http/https URL in the panel. In `confirm` mode a non-allowlisted URL asks the user first. | `url` |
| `browser_read` | Read the current page: URL, title, visible text (truncated), editable elements, `forms` (radio/checkbox groups), `buttons`, `links`, `framePath` for same-origin iframes. Password/file values are redacted. | — |
| `browser_fill` | Fill text into inputs/editors, or click a control when `click: true`. Default: fill only, no Enter, no click, no submit. | `text`, `click`, `selector`, `index`, `framePath`, `replace` |
| `browser_screenshot` | Capture the panel page as PNG and return its path. Requires the DSH window and the AI Browser tab to be visible. | — |
| `browser_allowlist` | In `confirm` mode: list/add/remove allowlist rules. In `free` mode it is read-only status. | `action`, `pattern` |

### `browser_fill` details

- **Fill:** `browser_fill({ selector: '#code', text: '...' })` or `browser_fill({ index: 3, text: '...' })`.
- **Click:** `browser_fill({ selector: '#submitBtn', click: true })`. For radios you may pass `text: 'B'` to validate the option value; for checkboxes, omit `text` to toggle once or pass the strings `'true'`/`'false'` to set a target state.
- **Indexing:** `index` is the global flat number returned by `browser_read`, consistent across same-origin iframes. `framePath` scopes a `selector` to a iframe and validates an `index`.
- **`replace`:** clears `input`/`textarea` before filling; it is ignored for `contenteditable` and rich editors (CodeMirror/Monaco/Ace).
- **Rejected:** password/file fields, disabled or detached controls, non-unique selectors, clicks requested without `click: true`.
- **Synthetic events:** clicks are synthetic (`isTrusted = false`). Sites that require real user activation may ignore them; this is a browser boundary, not something a plugin can fake.

## Security model

At a glance (details in [SECURITY.md](SECURITY.md)):

- Credentials: password/file never filled, never returned in plaintext.
- No implicit actions: no Enter key, no `form.submit()`/`requestSubmit()`, no click without `click: true`.
- URL gating: `confirm` mode by default; allowlist rules are explicit.
- Local channel: the Host↔Client route requires a random token claimed by the panel (403 otherwise); the route goes through DSH's web server with its Host/Origin checks. This protects against accidental or cross-origin delivery, **not** against a hostile local process that can already reach DSH's loopback server (claim/reclaim are first-come by design); treat your local account as trusted.
- Isolation: the webview is created through DSH's browser lease. DSH (tested with 0.2.1-rc.2) applies `nodeIntegration: false`, `contextIsolation: true` and `sandbox: true`; the plugin never creates a BrowserWindow and never touches external browsers. These web preferences are DSH-owned, not set by this repository.
- **Prompt injection is still possible.** A malicious page can try to talk the agent into clicking or navigating. Use `confirm` mode on untrusted pages and keep an eye on the panel while the agent works.

## Known limitations

1. **DSH desktop only.** No `dshDesktop.browser` in a normal browser tab, so the controlled webview cannot be created there.
2. **Login state does not survive a DSH restart.** The internal browser uses an in-memory partition. URLs you visited are remembered by the plugin (recent list / last page), but cookies and logins are not. Log in again after restarting.
3. **Screenshots need a visible window.** `webview.capturePage()` fails when the DSH window is minimized/occluded or the AI Browser tab is not in the foreground; the tool retries once and returns an actionable message.
4. **Same-origin iframes only.** Cross-origin iframes cannot be read/filled — a webview security boundary. The keyboard bridge is injected into the top document only, so panel shortcuts do not work while focus is inside any iframe (same-origin included).
5. **Synthetic clicks** may be ignored by sites that check `isTrusted` or require real user activation.
6. **DSH host limitations** apply: downloads are blocked, camera/location/notifications/microphone requests are denied, `alert`/`confirm`/`prompt` are cancelled, HTTP Basic auth fails, drag-and-drop navigation is disabled, and developer tools are unavailable in packaged builds.
7. **Submit consequences are real.** A `click: true` on a submit button/link can cause a native navigation or POST. That is the explicit action the caller asked for; verify the page afterwards.
8. **In-memory dedupe.** Click deduplication for receipt retries is per controller session; a full page reload or DSH restart loses it. Check page state after submit-like actions.

## Development

```powershell
npm install        # dev dependency: @mixmark-io/domino (only for the guest-DOM test)
npm test           # host + client + guest-DOM self-tests
```

Individual suites:

- `node selftest.mjs` — Host half (real HTTP route, token, policies, tools, parameter validation, screenshot PNG, `/allowed`).
- `node client-selftest.mjs` — Client half (controller with fake DOM/bridge/fetch; consent gate, token 409 recovery, popup/navigation takeover, dedupe, iframe scripts, zoom/find/back/forward).
- `node guest-dom-selftest.mjs` — executes the real `READ_SRC`/`fillSrc` scripts in a DOM; `SKIP`s cleanly if domino is not installed.

CI runs all three suites on Node 22/24 (Windows). See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution flow.

## Project layout

```
dsh-agent-browser/
├── index.js                 # Host half: tools, HTTP route, command queue, allowlist
├── client.js                # Client half: sidebar tab, webview, command execution
├── cordis.patch.yml         # DSH bundle patch + configuration
├── package.json             # DSH plugin manifest (exports, dsh.client, dsh.bundle)
├── selftest.mjs             # Host self-test
├── client-selftest.mjs      # Client self-test
├── guest-dom-selftest.mjs   # DOM-level self-test for the injected scripts
├── .github/workflows/ci.yml # CI (Node 22/24, Windows)
├── install.ps1 / install.cmd
├── uninstall.ps1 / uninstall.cmd
├── docs/
│   ├── ARCHITECTURE.md      # components, protocol, security boundaries
│   ├── AUDIT-SUMMARY.md     # what the 1.1.x security review found/fixed
│   └── PUBLISHING.md        # GitHub publishing checklist
├── CHANGELOG.md
├── SECURITY.md
└── CONTRIBUTING.md
```

## Version history and audit

`1.1.1` is the first public release. It includes fixes from an internal audit of `1.1.0` (password side channel, implicit portal submission, forced checked state, confirm-policy bypass, duplicate click on receipt retry, iframe scoping and test-honesty issues). See [CHANGELOG.md](CHANGELOG.md) and [docs/AUDIT-SUMMARY.md](docs/AUDIT-SUMMARY.md).

## License

[MIT](LICENSE).

## Disclaimer

This project is not affiliated with or endorsed by DeepSeek, the DSH project or any website you use it with. Browser automation can interact with third-party sites and may violate their terms of service; use it only on sites and accounts where you have permission. The software is provided "as is" without warranty.
