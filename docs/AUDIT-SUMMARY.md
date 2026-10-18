# Audit summary (1.1.x)

`1.1.1` is the first public release. Before publishing, the `1.1.0` code was
reviewed with an adversarial mindset (source review + independent regression
scripts + real-browser checks), and the issues below were fixed. This page is a
sanitized summary; it is not a third-party security audit, and the code is the
authority.

## Findings fixed in 1.1.1

| ID | Finding in 1.1.0 | Fix in 1.1.1 |
|---|---|---|
| F01 | **Password side channel**: the problem identifier was scraped from any matching element, so a `password` input whose name/id matched could leak its value into `browser_read` output. | Only a hidden `problemID` element is used; independent tests confirm no password string appears in the returned JSON. |
| F02 | **Implicit portal submission**: the blank-window portal bridge could auto-submit a form and repeat the POST. | The bridge now only prepares a visible "continue" form; submission happens only through an explicit `click: true` by the user/agent. Repeated close/pseudo-submit calls prepare once and never call the native submit API. |
| F03 | **Forced checked state**: a radio/checkbox click cancelled by the page (or a node removed during the click) was reported as success and `checked` was forced. | State is re-verified after the action; if the target state is not reached, the tool returns an error. Disabled `fieldset` inheritance is honoured (with the `legend` exception). |
| F04 | **Fake checkbox click**: a checkbox click with empty `text` did not really toggle. | Empty `text` toggles exactly once; an explicit target state is idempotent (`clicked: false` when already satisfied). |
| F05 | **`confirm` bypass**: navigation triggered from injected console messages skipped the free/confirm decision. | All navigation goes through the same `handleOpenRequest` path; in `confirm` mode a non-allowlisted URL produces a consent card and does not call `loadURL`. |
| F06 | **Duplicate click on receipt retry**: if the result POST failed, the whole command was re-executed. | Executed results are cached per controller session; retries only retransmit the receipt. (Full page reload/process crash still loses the in-memory cache; this is documented.) |
| F07 | **Docs/tests over-claimed**: screenshots were asserted loosely, iframe tests ran across documents implicitly, mode/click/portal claims were broader than the code. | Docs rewritten; screenshot assertions check the command id and exactly two `capturePage` calls; iframe injection uses the target document's own editing commands and event constructors. |
| R01 | **Degraded tool name collision**: on a late registration failure the fallback could try to re-register `browser_panel`. | The error is saved and reported by the already-registered `browser_panel`; no duplicate registration. |

## What was verified

The release was exercised at several levels. The kernel-contract, real-Chromium
and installer checks below were run by the maintainers in a private verification
environment and are not reproducible from this repository alone; the three
self-test suites are reproducible with `npm test`. Counts are from release time:

- **Host self-test** (`selftest.mjs`): 22 PASS, 0 SKIP, with a real HTTP server,
  real short timeout path, token (403/409), free/confirm policies, consent flow,
  read/fill/click passthrough, parameter validation, screenshot PNG bytes and
  `/allowed` redirect checks.
- **Client self-test** (`client-selftest.mjs`): 32 PASS, running the real
  controller against a fake DOM/bridge/fetch — tab registration, consent gate,
  token 409 recovery, popup/navigation takeover, retransmit-without-re-execute,
  on-demand tab creation, concurrent commands sharing one guest, iframe scripts,
  password redaction and explicit-click script contracts, actionable screenshot
  failure messages, zoom/find/back/forward.
- **Guest DOM self-test** (`guest-dom-selftest.mjs`): 5 PASS, executing the actual
  `READ_SRC` / `fillSrc` scripts inside a DOM (domino), including sensitive-value
  redaction, disabled rejection, checkbox clicking and unique-selector checks.
- **Kernel contract checks**: the plugin's tool manifest was validated against
  the DSH kernel's tool contract (required `output { schema, render }`,
  supported JSON schema subset, duplicate-name behaviour) in an isolated Cordis
  context.
- **Real Chromium checks**: native filling, same-origin iframe handling, native
  click and a portal-style POST were exercised against a local test page in an
  isolated browser profile.
- **Installer/upgrade script checks**: install/upgrade/rollback paths were
  exercised with fake profiles on PowerShell 7 and Windows PowerShell 5.1,
  including "preserve existing `cordis.patch.yml`", idempotency, tampered-package
  rejection and rollback after a partial copy failure.

## What was **not** verified

- Activation in a real DSH window of a different installation: the release was
  prepared without restarting the user's live DSH session. Re-open DSH and
  verify the tab, real-site behaviour, screenshots with a visible window, and
  portal/login flows.
- Behaviour of DSH webview lease/sandbox internals: the isolated Chromium test
  used `--no-sandbox`; production webview security parameters are DSH's, not
  this plugin's.
- Cross-origin iframes, complex multi-instance editors, sites requiring real
  user activation, and pure script-driven popups: explicitly out of scope or
  unsupported.

## Additional hardening during public release

Preparing this public repository surfaced two more issues that are fixed here
(they were not part of the original private audit):

- **Origin-scoped URL-prefix allowlist rules.** A rule such as
  `https://example.com` previously matched `https://example.com.evil.com` or a
  different port because matching was a raw string prefix. Rules are now parsed
  and required to match the target origin before the path prefix is compared.
- **`confirm` by default.** The code used to fall back to `free` when
  `openPolicy` was missing; the fallback is now `confirm`, matching the shipped
  `cordis.patch.yml` and the documentation.

The test suite now covers cross-origin/port URL rules. The initial commit was
also created with a neutral placeholder identity so publishing it does not leak
the maintainer's real name or email.

## Reporting

If you find a security problem, follow [SECURITY.md](../SECURITY.md) and use
GitHub's private vulnerability reporting instead of a public issue.
