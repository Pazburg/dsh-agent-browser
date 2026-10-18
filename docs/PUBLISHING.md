# Publishing this repository on GitHub

This repository is published at <https://github.com/Pazburg/dsh-agent-browser>.
It is intentionally self-contained; the steps below show how it was published
(and how to re-publish under another account or a fork).

## 1. Create the repository

Create an empty repository on GitHub named **`dsh-agent-browser`** (no README,
no `.gitignore`, no license — this tree already has them). Do not initialise it
with a template, otherwise the first push will conflict.

## 2. Set a neutral commit identity before pushing

Commit metadata is public. The initial commit in this tree was created with a
neutral identity (`Pazburg <296104153+Pazburg@users.noreply.github.com>`), but
your machine-wide `git config` may contain your real name and email. If you
amend the commit or commit again, verify what will be published:

```powershell
git config --local user.name "Pazburg"
git config --local user.email "296104153+Pazburg@users.noreply.github.com"
git commit --amend --reset-author --no-edit
git log --format='%an <%ae> | %cn <%ce>'
```

- Replace the placeholder with the name and GitHub noreply address you want to
  publish under (`<id>+<username>@users.noreply.github.com`).
- `git config --local` only affects this repository; `--global` affects all
  commits on the machine.
- To scrub the old objects locally (not needed for the push itself, but keeps the
  local clone tidy):

  ```powershell
  git reflog expire --expire=now --all
  git gc --prune=now
  ```

## 3. Push

```powershell
cd <path-to-this-folder>
git remote add origin https://github.com/<your-account>/dsh-agent-browser.git
git branch -M main
git push -u origin main
```

`gh` users can do the same with:

```powershell
gh repo create dsh-agent-browser --public --source . --remote origin --push
```

## 4. Finish the metadata

- **package.json** — optionally add your repository URL (the package is marked
  `private: true` because it is a DSH plugin, not an npm package):

  ```json
  "repository": { "type": "git", "url": "https://github.com/<your-account>/dsh-agent-browser.git" },
  ```

- **README badges** — optionally add at the top:

  ```markdown
  [![CI](https://github.com/<your-account>/dsh-agent-browser/actions/workflows/ci.yml/badge.svg)](https://github.com/<your-account>/dsh-agent-browser/actions/workflows/ci.yml)
  [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
  ```

- **Repository settings** — description, topics (`dsh`, `deepseek-harness`,
  `browser-automation`, `electron`, `agent`), and enable *Private vulnerability
  reporting* under Security (the address used by [SECURITY.md](../SECURITY.md)).
- **Author / copyright** — `package.json` and `LICENSE` currently use the
  placeholder name `Pazburg`; change it to the name you want to publish under.

## 5. Before the first public push

```powershell
npm test                                                    # all three suites must pass
git status --short                                          # node_modules must be untracked/ignored
git log --format='%an <%ae> | %cn <%ce>'                    # no real name/email in commit metadata
git grep -n -I -E 'C:\\Users|D:\\|token|secret|password'    # working-tree sanity check
```

If you publish a release, attach a source ZIP and (optionally) a `SHA256SUMS`
file for the files you distribute. Never attach a configured
`cordis.patch.yml` containing private intranet URLs or allowlist entries.
