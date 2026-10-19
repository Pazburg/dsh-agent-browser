# dsh-agent-browser

**Give your DSH agent a browser, right beside the conversation.**

[![CI](https://github.com/Pazburg/dsh-agent-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/Pazburg/dsh-agent-browser/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

`dsh-agent-browser` adds a browser panel to the DSH (DeepSeek Harness) desktop app. Your agent can read pages, fill forms, work with code editors, take screenshots, and click controls through six browser tools. You can watch the page and interact with it in the same sidebar.

The panel uses a Chromium webview inside DSH, separate from your everyday browser and its profile. Filling and clicking are separate operations: a click requires an explicit `click: true` tool argument.

> **Experimental.** Developed against DSH Desktop `0.2.1-rc.2` on Windows. The plugin depends on internal DSH APIs, so compatibility with other releases needs verification. The panel UI and tool descriptions are currently in Chinese.

[Chinese README](README.zh-CN.md) · [Architecture](docs/ARCHITECTURE.md) · [Security](SECURITY.md) · [Changelog](CHANGELOG.md)

## What you can do

- **Read pages with structure.** Get the URL, title, visible text, editable fields, forms, buttons, and links, including content in same-origin iframes.
- **Fill forms and editors.** Work with text inputs, textareas, dropdowns, contenteditable elements, and supported CodeMirror, Monaco, and Ace editors.
- **Click when requested.** Select radio buttons, toggle checkboxes, follow links, or press buttons with `click: true`.
- **Check the result visually.** Save a PNG screenshot of the current page.
- **Browse alongside the agent.** Use back/forward, reload/stop, page zoom, find-in-page, and recent URLs in the panel.

For example, ask your agent:

> Read the current page and summarize the form fields.

> Fill the message field with this draft, then take a screenshot for review.

> Select the requested option, click Continue, and read the next page.

## Quick start

### Install on Windows

Start DSH Desktop at least once so its desktop profile exists, then **fully quit DSH**, including its tray process.

Clone this repository or download and extract its ZIP. From the repository folder, double-click `install.cmd`, or run:

```powershell
git clone https://github.com/Pazburg/dsh-agent-browser.git
cd dsh-agent-browser
.\install.cmd
```

The installer copies the plugin into:

```text
%USERPROFILE%\.dsh\profiles\desktop\node_modules\@local\dsh-agent-browser\
```

It registers the bundle in the desktop profile, backs up an existing installation, and preserves an existing `cordis.patch.yml` configuration. Installation requires no build step or runtime dependency installation.

For a custom profile:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -ProfileDir C:\path\to\desktop-profile
```

### Open your first page

1. Restart DSH and open **AI Browser** in the right sidebar. In the current UI, the tab is labeled **AI 浏览器**; it is also available from the sidebar's **+** menu.
2. Enter a URL in the panel. If the site requires a login, sign in yourself.
3. Ask the agent to read the current page or fill a field.
4. When an agent navigation needs approval, choose **Allow** in the panel to continue.

The default `confirm` policy asks before opening URLs outside the allowlist. URLs you enter directly in the panel do not require that approval.

**Login sessions last only for the current DSH run.** Recent URLs are remembered, but the browser's in-memory cookies and logins are discarded when DSH exits.

### Manual installation

With DSH fully closed:

1. Create the plugin directory shown above.
2. Copy `index.js`, `client.js`, `package.json`, and `cordis.patch.yml` into it.
3. Add `"@local/dsh-agent-browser"` to the `dsh.profile.bundles` array in `%USERPROFILE%\.dsh\profiles\desktop\package.json`.
4. Restart DSH.

Keep the `@local/dsh-agent-browser` package name consistent with the bundle registration. This is a local DSH plugin; the package is intentionally marked `private`.

### Update or uninstall

To update, fully quit DSH, run `install.cmd` from the updated repository, and restart DSH. Your installed configuration is preserved; review [CHANGELOG.md](CHANGELOG.md) for configuration changes.

To uninstall, fully quit DSH and run `uninstall.cmd`. To disable the plugin, remove its entry from `dsh.profile.bundles` and restart DSH.

## Browser tools

Tools are registered with the DSH agent and return JSON results. Start with `browser_panel` to check the panel connection.

| Tool | What it does | Parameters |
| --- | --- | --- |
| `browser_panel` | Reports connection status, the current page, the allowlist, and pending commands. | None |
| `browser_open` | Opens an HTTP or HTTPS URL, applying the navigation policy. | `url` |
| `browser_read` | Returns page text and structured lists of fields, forms, buttons, and links. | None |
| `browser_fill` | Fills a field, selects a dropdown option, or explicitly clicks a supported control. | `selector` or `index`; `text`, `click`, `framePath`, `replace` |
| `browser_screenshot` | Saves a PNG of the current page and returns its file path. | None |
| `browser_allowlist` | Lists, adds, or removes navigation rules in `confirm` mode; reports status in `free` mode. | `action`, `pattern` |

### Fill and click examples

These illustrate agent tool calls. Use selectors and indices returned by `browser_read` for the actual page.

```javascript
// Inspect the page before choosing a target.
browser_read({})

// Fill a text field. Existing input/textarea content is replaced by default.
browser_fill({ selector: '#message', text: 'Hello from DSH.' })

// Target an editable field by its zero-based index instead.
browser_fill({ index: 0, text: 'Hello from DSH.' })

// Select a dropdown option by its value or displayed text.
browser_fill({ selector: '#language', text: 'English' })

// Request a click explicitly.
browser_fill({ selector: '#continue', click: true })

// Set a checkbox state; leave it alone if already checked.
browser_fill({ selector: '#remember-choice', click: true, text: 'true' })

// Capture the page for review.
browser_screenshot({})
```

Use a unique CSS `selector` or an editable element's zero-based `index`. Buttons and links are addressed by selector. Indices form one global list across the page and its same-origin iframes; pass the returned `framePath` to scope a selector to an iframe or validate an index's frame.

`replace` defaults to `true` for inputs and textareas. Rich editors and contenteditable elements replace their content regardless of this option. Password/file fields, disabled or detached controls, and ambiguous selectors are rejected. Read the page again after navigation or a page update before reusing a target.

The plugin does not press Enter or call `form.submit()` / `requestSubmit()`. An explicit click on a submit button can still submit a form or navigate. Filling inputs and dropdowns dispatches input/change events, so the site's own autosave or validation may run.

## Configuration

Edit `cordis.patch.yml` in the **installed plugin directory**, then restart DSH. Reinstalling preserves that file.

```yaml
- insert:
    - id: dsh-agent-browser
      name: '@local/dsh-agent-browser'
      config:
        openPolicy: confirm

        # Optional rules for URLs that can open without a prompt.
        # allowlist:
        #   - example.com
        #   - https://app.example.com/workspace/

        # Optional screenshot directory.
        # shotDir: C:\path\to\screenshots

        # Optional support for portals that open a blank window
        # and write a form into it.
        # portalBridgeHosts:
        #   - portal.example.com
```

| Setting | Behavior |
| --- | --- |
| `openPolicy: confirm` | Default, including when omitted. URLs outside the allowlist require approval in the panel. |
| `openPolicy: free` | Opens any HTTP/HTTPS URL without a confirmation prompt; disables allowlist controls. |
| `allowlist` | Preloads domain or URL-prefix rules in `confirm` mode. |
| `shotDir` | Overrides the default screenshot output directory. |
| `portalBridgeHosts` | Enables the portal bridge for matching hosts and their subdomains. Blank-window form flows become a visible Continue button that must be clicked. |

### Allowlist rules and saved data

- A **domain rule**, such as `example.com`, matches that host and its subdomains. It does not match `notexample.com`.
- A **URL-prefix rule**, such as `https://app.example.com/workspace/`, matches that prefix within the same origin. A different scheme, host, or port does not match. Prefix matching is literal; include a trailing `/` when you want a directory prefix.

Panel-managed allowlist entries are saved to `$DSH_HOME/agent-browser/allowlist.json`. Screenshots default to `$DSH_HOME/agent-browser/shots/`. Without `DSH_HOME`, these paths use `~/.dsh/agent-browser/`.

## Compatibility and limitations

| Area | Current behavior |
| --- | --- |
| Host application | Requires DSH Desktop and its `dshDesktop.browser` API. DSH opened in a regular browser cannot provide the panel's webview. |
| Interface language | Panel labels and agent tool descriptions are currently Chinese. |
| Login persistence | Cookies and logins are lost when DSH exits. |
| Screenshots | Keep the DSH window visible and the AI Browser tab in the foreground. Minimized or obscured windows can prevent capture. |
| Iframes | Reading and filling support same-origin frames only. Panel keyboard shortcuts are bridged in the top document. |
| Clicks | Synthetic clicks may be rejected by sites that require trusted user activation. |
| Retries | Click deduplication is held in memory for the controller session. Check page state before repeating a submit-like action. |
| DSH restrictions | The documented host environment blocks downloads, denies camera/microphone/location/notification requests, cancels JavaScript dialogs, and does not support HTTP Basic authentication. |

If tools are unavailable or the panel is disconnected, fully restart DSH, open the sidebar tab, and check `browser_panel`. Registration failures are reported there. For screenshot failures, restore the window and bring the tab to the foreground before retrying.

## Security model

The plugin redacts password and file input values from structured reads and refuses to fill those fields. Their value lengths may still be returned. This is field-level filtering: page text and ordinary fields remain readable by the agent.

The default navigation policy requires approval for URLs outside the allowlist. **`click: true` is an explicit tool argument, not a separate human approval prompt for each click.** Page content can still influence an agent through prompt injection, and accepted clicks can have real effects on the site.

DSH creates and isolates the browser webview. The plugin's host and panel communicate through a token-protected local HTTP queue; the local account and DSH runtime are trusted. See [SECURITY.md](SECURITY.md) for the full boundaries and vulnerability reporting process.

## Development

The runtime consists of plain ESM JavaScript with no runtime dependencies or build step. Development requires Node.js 20+; CI runs on Windows with Node.js 22 and 24.

```powershell
npm install
npm test
```

`npm install` adds the development dependency `@mixmark-io/domino`. The test command runs host, client, and guest-DOM self-tests; the guest-DOM suite skips if that dependency is missing. Self-tests do not replace validation in a real DSH desktop window.

| File | Role |
| --- | --- |
| `index.js` | Host plugin: tools, command queue, navigation policy, and screenshot storage. |
| `client.js` | Sidebar panel: webview, page inspection, field interaction, and command execution. |
| `cordis.patch.yml` | Bundle registration and configuration. |
| `selftest.mjs` | Host and HTTP route tests. |
| `client-selftest.mjs` | Panel controller and browser bridge tests. |
| `guest-dom-selftest.mjs` | Tests for injected page-reading and interaction scripts. |

The host queues commands, the panel polls and executes them in the webview, and results return to the agent. See [Architecture](docs/ARCHITECTURE.md) for the protocol, [Contributing](CONTRIBUTING.md) for development guidance, and the [audit summary](docs/AUDIT-SUMMARY.md) for the internal review behind the initial public release.

## License

[MIT](LICENSE). An independent project, unaffiliated with DeepSeek or the DSH project.
