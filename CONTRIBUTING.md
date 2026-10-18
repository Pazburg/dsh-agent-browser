# Contributing

Thanks for taking a look! This is a small, dependency-free DSH desktop plugin;
contributions of bug reports, docs and focused patches are welcome.

## Ground rules

- **Privacy first.** Do not add telemetry, analytics, update pings or any network
  call that is not directly serving the user's browser request. Do not log page
  contents, tokens, cookies or credentials.
- **No secret or personal data in the repo.** Use `example.com` in tests and
  docs. Never commit real intranet URLs, access tokens, session ids or local
  absolute paths.
- **The security boundaries are the product.** A change that fills password/file
  fields, presses Enter, calls `form.submit()`, clicks without `click: true`, or
  disables the `confirm` gate should be rejected.
- **The plugin must stay loadable by DSH** with zero runtime dependencies. Test
  dependencies belong in `devDependencies` only.
- **Commit metadata is public.** Configure a neutral author identity before
  committing; see [docs/PUBLISHING.md](docs/PUBLISHING.md).

## Development setup

Requirements: Windows (for the install scripts; the Node tests are portable),
Node.js 22+ recommended (20 still works) and a DSH desktop installation (0.2.x)
for end-to-end checks.

```powershell
git clone <this-repo>
cd dsh-agent-browser
npm install            # installs the optional test dependency (domino)
npm test               # host + client + guest-DOM self-tests
```

If `npm install` is not possible, the guest-DOM test will `SKIP`; the other two
suites still run.

## Testing

- `node selftest.mjs` — Host half: real HTTP route, token, policies, tools,
  parameter validation, screenshot PNG, redirect/`allowed` checks.
- `node client-selftest.mjs` — Client half: controller with a fake DOM/bridge/
  fetch: registration, consent gate, token 409 recovery, popup/navigation
  takeover, dedupe, iframe scripts, zoom/find/back/forward.
- `node guest-dom-selftest.mjs` — executes the real `READ_SRC`/`fillSrc` scripts
  inside a DOM (`@mixmark-io/domino`): redaction, disabled handling, explicit
  click, select, unique selectors, index/framePath checks.

Before opening a PR: `npm test` must pass, and the change should be exercised in
a real DSH window when it touches the Client half or DSH APIs.

## Installing a development build

1. Fully quit DSH.
2. Run `install.cmd` (or `install.ps1`) from this repository. It copies the
   runtime files into your DSH profile and registers the bundle, preserving an
   existing `cordis.patch.yml` configuration.
3. Start DSH, open the "AI Browser" tab in the right sidebar, and test.
4. For a clean test, pass a non-default profile to the installer:
   `.\install.ps1 -ProfileDir C:\path\to\test-profile` (the script does not read
   `DSH_PROFILE`/`DSH_HOME`).

## Code style

- Plain ESM JavaScript, no build step, no runtime dependencies.
- Match the existing style (2-space indent, no semicolons, single quotes).
- Keep comments clear and free of personal or environment details. User-facing
  strings and tool descriptions are currently Chinese; keep new strings
  consistent with the surrounding file (English docs are provided separately).
  A fully English UI is a future task.
- PowerShell scripts must stay **ASCII-only** (Windows PowerShell 5.1 reads
  BOM-less UTF-8 as ANSI).

## PR checklist

- [ ] `npm test` passes.
- [ ] No real domains, local paths, tokens, credentials or personal data added.
- [ ] Security boundaries documented in `SECURITY.md` still hold.
- [ ] `CHANGELOG.md` updated for user-visible changes.
- [ ] Real-DSH behaviour verified (or clearly stated as untested).
