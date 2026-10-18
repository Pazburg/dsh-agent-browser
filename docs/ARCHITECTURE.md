# Architecture

This document describes how `dsh-agent-browser` is put together and how its two
halves talk to each other. It is aimed at contributors and at users who want to
understand the trust boundaries before letting an agent drive a browser.

## The two halves

DSH loads a plugin bundle in two places, and the split is enforced by DSH rather
than chosen by this plugin:

| Half | File | Runs in | Can do | Cannot do |
|---|---|---|---|---|
| **Host** | `index.js` | `dsh-desktop-host` subprocess | register tools, register an HTTP route, queue commands, persist allowlist/screenshots | touch the page, access the DOM, launch a browser |
| **Client** | `client.js` | DSH renderer (web UI) | register a right-sidebar tab, own the Electron `<webview>`, execute page scripts, capture screenshots | register tools, read the Host's filesystem directly |

Consequently every browser action is a round trip:

1. the agent calls a **Host** tool;
2. the Host enqueues a command and awaits its result;
3. the **Client** panel polls the command queue, executes it in the webview and
   posts the result back;
4. the Host resolves the pending tool promise.

## DSH contracts used

### Host half

`index.js` exports `name`, `inject = ['tools']` and `apply(ctx, config)`.
`apply()` uses:

- `ctx.inject(['webServer'], scope => scope.webServer.register(route))` — registers
  one prefix route `/dsh-agent-browser/*` (route name, kind `prefix`, path, handler).
- `ctx.tools.register({ name, description, parameters, output, execute })` — six
  tools. DSH requires each tool to declare `output: { schema, render }`; this
  plugin uses `schema: {}` (unconstrained JSON) and a single text renderer, because
  results are raw panel receipts. Missing `output` makes DSH throw during
  registration, so registration is wrapped: on failure it saves the error and
  registers a single degraded `browser_panel` tool that reports the problem.

### Client half

`client.js` starts with:

```js
window.__ModuleLoader__.load({
  id: '@local/dsh-agent-browser',
  factory(require) { /* React + plugin definition */ },
})
```

Inside it registers an `agent-browser` tab in the right sidebar and obtains a
webview through DSH's lease API (`globalThis.dshDesktop.browser.acquire()` /
lease-based guest). The lease guarantees the webview is created by the DSH main
process with the hardened web preferences (`nodeIntegration: false`,
`contextIsolation: true`, `sandbox: true`, applied by DSH itself; tested with DSH
0.2.1-rc.2). The tab uses `keepMounted` semantics:
switching tabs or collapsing the sidebar does not destroy the guest.

## Host state

```
state = {
  token,            // randomUUID, claimed by the panel
  claimed,          // bool
  commands: [],     // queue: { id, kind, payload, at }
  pending: Map,     // id -> { command, resolve, timer }
  allowlist: [],    // loaded from $DSH_HOME/agent-browser/allowlist.json
  policy,           // 'free' | 'confirm' (from config.openPolicy; default confirm)
  portalHosts,      // from config.portalBridgeHosts (default empty)
  lastPollAt,       // panel heartbeat
  page,             // last page reported by the panel (display only)
  shotDir,          // optional config.shotDir
}
```

Freshness: a panel is considered connected if it polled within the last 5 s.
Commands enqueued while the panel is stale fail fast with a hint to open the tab.
Command timeout defaults to 180 s.

## HTTP protocol

All routes are under `/dsh-agent-browser`; responses are JSON. Except for
`claim`/`reclaim`, every request must carry the header
`x-dsh-agent-browser-token: <token>`; otherwise the response is `403`.

| Method | Path | Body / query | Response |
|---|---|---|---|
| POST | `/claim` | — | `200 {token, allowlist}`; `409` if already claimed |
| POST | `/reclaim` | — | `200 {token, allowlist}` (rotates the token, invalidates the old one) |
| GET | `/poll` | — | `200 {commands, allowlist, policy, portalHosts, panel: true}`; updates heartbeat |
| POST | `/result` | `{id, ok, value?, error?, page?}` | `200 {settled}`; resolves the pending tool promise |
| GET | `/allowed?url=…` | — | `200 {allowed: boolean}` (always true in `free` mode) |
| GET | `/allowlist` | — | `200 {patterns: string[]}` |
| POST | `/allowlist` | `{action: 'add'|'remove'|'set', pattern}` | `200 {patterns}` |

Command kinds produced by the tools: `open`, `read`, `fill`, `screenshot`
(`status` exists in the wire protocol for compatibility). A command stays in the
queue until its result arrives; the Client retransmits only the receipt, not the
action, which is how at-most-once click semantics are approximated within a
controller session.

## Tool → command mapping

| Tool | Command | Payload |
|---|---|---|
| `browser_open` | `open` | `{url, trusted, policy}` |
| `browser_read` | `read` | `{}` |
| `browser_fill` (fill) | `fill` | `{text, click:false, selector, index, framePath?, replace}` |
| `browser_fill` (click) | `fill` | `{text, click:true, selector/index, framePath?}` |
| `browser_screenshot` | `screenshot` | `{}` |
| `browser_allowlist` | — (Host-local) | allowlist file + config |

`browser_panel` is also Host-local.

## Client execution

The controller in `client.js`:

- **polls** `/poll` every 500 ms, claims a token on startup (one automatic
  retry if another window holds it, then offers a manual "claim again" button);
- renders the tab: URL bar, back/forward, reload/stop, zoom, find-in-page,
  recent URLs, allowlist section and consent cards;
- executes commands by injecting scripts into the webview via
  `webview.executeJavaScript`:
  - `READ_SRC` — collects page metadata, editable elements, forms, buttons and
    links; redacts password/file values; recurses into same-origin iframes and
    assigns a global flat `index` across documents;
  - `fillSrc` — fills values or performs the explicit click; validates target
    identity, disabled state, `framePath`/index consistency and selector
    uniqueness;
  - the **portal bridge** — injected on configured `portalBridgeHosts`; captures
    `window.open('')`-style blank-window forms and shows a visible "continue"
    button instead of submitting automatically;
  - the **key bridge** — handles zoom/find/reload/back/forward shortcuts in the
    controller even while focus is inside the page;
- handles the **confirm** policy: navigation requests and popups outside the
  allowlist surface a consent card; the Host's `/allowed` answer is
  authoritative;
- caches executed command results for receipt retries and dedupes clicks within
  the controller session;
- captures screenshots with `webview.capturePage()`.

## Security boundaries

- The Host never sees page content except through tool results, and the Client
  never registers tools.
- The local HTTP channel is protected by a random per-run token and lives behind
  DSH's web server (Host/Origin validation). It is not a network service. The
  token is not a defense against a hostile local process that can already reach
  the loopback port: /claim and /reclaim are first-come by design.
- The webview is sandboxed by DSH's lease implementation; the plugin never
  creates a BrowserWindow or uses an external browser.
- Password/file values are filtered in the injected page scripts, not only in
  the model-facing description.
- Clicking requires `click: true`; there is no path from reading a page to
  clicking it implicitly, and no Enter/submit API is called.

## Extension points

- **New read fields**: extend `READ_SRC` in `client.js` and the renderer; add a
  regression to `guest-dom-selftest.mjs`.
- **New command kind**: add it to the Client command switch, the Host tool that
  enqueues it, and `client-selftest.mjs`.
- **New config option**: read it in `apply()` (Host) or forward it in `/poll`
  (Client), document it in `cordis.patch.yml` and both READMEs.
- Keep the invariants in [SECURITY.md](../SECURITY.md) intact: no implicit
  submission, no credential plaintext, no click without `click: true`.

## Compatibility notes

DSH's plugin API is not yet a frozen public API. This release was developed
against DSH `0.2.1-rc.2` (Electron 44, Node 24) and the corresponding kernel
contracts (`window.__ModuleLoader__.load`, `ctx.tools.register` with required
`output`, prefix `webServer` routes, right-sidebar tab registration and the
`dshDesktop.browser` lease). If a DSH upgrade changes those contracts the plugin
may fail to load or register; check the registration diagnostic returned by
`browser_panel` and the DSH host log.
