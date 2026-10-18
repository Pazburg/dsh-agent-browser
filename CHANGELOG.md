# Changelog

All notable changes to this project are documented here. The format is loosely
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## 1.1.1 — 2026-10-18

Security and reliability fixes found by an internal audit of 1.1.0, plus
public-release hardening:

- **Privacy**: `browser_read` no longer returns password values through the
  `problemId` path; only hidden problem IDs are read now.
- **Allowlist hardening**: URL-prefix allowlist rules are origin-scoped, so a rule
  for `https://example.com` cannot match `https://example.com.evil.com` or another
  port. A missing `openPolicy` now defaults to `confirm` instead of `free`.
- **No implicit submission**: portal/blank-window forms are prepared behind a
  visible "continue" button and submitted only by an explicit `click:true`.
  Repeated `close`/pseudo-submit calls prepare the form once and never call the
  native submit API.
- **Click state honesty**: if a page cancels a radio/checkbox click or removes
  the target, the tool now reports an error instead of forcing `checked`.
  Checkboxes without `text` really toggle once; specifying a target state is
  idempotent. Disabled `fieldset` inheritance is honoured.
- **`confirm` policy bypass fixed**: navigation initiated from `console`
  messages now goes through the same free/confirm decision as `browser_open`.
- **At-most-once click on receipt retry**: results are cached per controller
  session, so a failed result POST only retransmits the receipt instead of
  executing the click again.
- **iframe correctness**: fill uses the target document's editing commands and
  event constructors; cross-document global `index` mapping is unchanged.
- **Degraded registration diagnostics**: a failure in the first or a later tool
  registration is reported by `browser_panel` without registering duplicates.
- **Test honesty**: screenshot assertions check the command id and exactly two
  `capturePage` calls.

## 1.1.0 — 2026-10-18

- `browser_read` redacts `password`/`file` fields (only `valueLength`, no
  plaintext, `redacted: true`).
- Clicking is an explicit `browser_fill({ click: true })` parameter; there is no
  separate click/submit tool, no Enter key and no `form.submit()` call.
- Disabled controls and detached nodes are rejected instead of silently
  "succeeding".
- Unified global `index` semantics across same-origin iframes; `framePath` is
  used for selector scoping and index consistency checks.
- Screenshot failures while the window is minimized/occluded return an
  actionable retry message instead of a raw `UnknownVizError`.
- UI additions: forms/radio/checkbox/button/link metadata in `browser_read`,
  `select` support, page zoom, find-in-page, back/forward, recent URLs and
  persisted last page.

## 1.0.0 — 2026-10-17

- First working version: sidebar "AI Browser" tab inside DSH, six `browser_*`
  tools (open/read/fill/screenshot/panel/allowlist), lease-based Electron
  `<webview>`, Host↔Client HTTP polling, free/confirm URL policy and allowlist.
