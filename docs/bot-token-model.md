# Bot / Token Operating Model

**Author**: Abdoul Hamid COULIBALY
**Date**: 2026-10-22
**Status**: proposed

Documents the maintenance-bot/token operating model: credential inventory, commit
identity attribution, risks, and a proposed duty-per-token split.
Everything below Section 1 is FACT with `file:line` evidence; Sections 3-4 are PROPOSAL.

## 1. Credential inventory (FACT)

| Credential | Type | Used by | Operations performed | Commit/push identity |
|---|---|---|---|---|
| `SYNC_PAT` | PAT | `.github/workflows/sync.yml:23` (via `sync.yml.njk` group sync); `.github/workflows/fix_license_headers.yml:61` | Repo-wide file sync pushes to downstream repos; license-header fix branch + PR creation | `cloudavenue-sync-bot` / `205752564+cloudavenue-bot@users.noreply.github.com` (`sync.yml:26-27`) |
| `RELEASE_CI_PAT` | PAT | `shared-files/github-actions/release.yml.njk:28,60,72,84,99,110`; `shared-files/github-actions/pr_close.yml.njk:25` | Tag existence check, tag creation, release-notes generation, GitHub Release publishing (terraform-provider variant also gets `GPG_PRIVATE_KEY`/`PASSPHRASE`/`METRICS_*` at `release.yml.njk:85-88`), CHANGELOG version bump, and post-merge CHANGELOG regeneration pushed to `main` | Per-workflow: `cloudavenue-release-bot` (`changelog_generate-new-version.yml:53-55`) or `github-actions[bot]` (`changelog_generate-changelog.yml:32-34`) |
| `PR_CI_PAT` | PAT | `shared-files/github-actions/pr.yml.njk:36,43`; `shared-files/github-actions/project_composite.yml.njk:21` | PR size labeling, conventional-commit check comments, GitHub Project board item creation for issues/PRs | No commits (comments/labels/project items only) |
| `GITHUB_TOKEN` (implicit) | Ephemeral OIDC | `shared-files/github-actions/pr.yml.njk:25`; `shared-files/github-actions/labeler.yml.njk:33`; `.github/workflows/pr_conventional_commits.yml:24`; `.github/workflows/pr_label_size.yml:35`; doc publishing (`doc_publish.yml:64` `mkdocs gh-deploy`, no explicit token input) | Changelog snippet commit on dependabot PR branches; label sync; check comments; docs push to `gh-pages` | Per-workflow, see Section 2 |
| `METRICS_TOKEN`, `GPG_PRIVATE_KEY`, `PASSPHRASE` | Service/gpg secrets | `shared-files/github-actions/release.yml.njk:85-88` → `.github/workflows/release_publish-terraform-provider.yml:61-62,79-82` | Release metrics shipping; GPG signing of release artifacts | n/a (not git identities) |

`release.yml.njk:112-119` (`publish-doc`) wires **no** token into `doc_publish.yml`;
that job pushes via the run's implicit `GITHUB_TOKEN`.

## 2. Commit identities found (FACT)

| Identity string | Where set | Backing credential (effective) |
|---|---|---|
| `cloudavenue-sync-bot` + `205752564+cloudavenue-bot@…` | `sync.yml:26-27` | `SYNC_PAT` |
| `cloudavenue-docs-bot` + `205752564+cloudavenue-bot@…` | `doc_publish.yml:51-52` | implicit `GITHUB_TOKEN` |
| `cloudavenue-release-bot` + `205752564+cloudavenue-bot@…` | `changelog_generate-new-version.yml:53-55` | `RELEASE_CI_PAT` (via `release.yml.njk:110`) |
| `dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>` | `changelog_dependabot.yml:45-47` | `GITHUB_TOKEN` (via `pr.yml.njk:25`) |
| `github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>` | `changelog_generate-changelog.yml:32-34` | `RELEASE_CI_PAT` (via `pr_close.yml.njk:25`) |
| `github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>` | `pr_license.yml:56-58` | run-scoped token (`contents: write`, `pr_license.yml:15-17`) |

The last three rows write GitHub-owned bot identities (`dependabot[bot]`,
`github-actions[bot]`) into commits whose capability actually comes from this org's
workflows and PATs — this is finding **M7**, recorded here as current policy, not endorsed.

## 3. Risk summary (FACT-derived)

- **Concentration (M6)**: one `RELEASE_CI_PAT` spans the whole release chain — tags,
  releases, GPG-adjacent publishing, and write pushes to `main` after PR close. A leak
  exposes tag + release + `main` content history simultaneously.
- `SYNC_PAT` alone can write to **every downstream repo** in the sync matrix; blast
  radius is org-wide, not repo-scoped.
- `PR_CI_PAT` is the lowest-risk credential (labels/comments/project) but is shared
  between the PR gate and the project board — different duties, same secret.
- **Attribution (M7)**: commits authored as `github-actions[bot]` / `dependabot[bot]`
  are indistinguishable in history from genuine GitHub-owned automation, so auditing
  "who mutated `main`" cannot be answered from author metadata alone. `pr_close.yml.njk`
  runs on `pull_request_target`, i.e. a PAT-backed job pushing to `main` under a
  GitHub-owned identity.

## 4. Proposed model (PROPOSAL)

### 4.1 Duty-per-token split

| Duty | Token | Minimal scopes | Rotates |
|---|---|---|---|
| Downstream file sync | `SYNC_PAT` (finest-grain, repo-limited per sync group where possible) | Contents: RW on synced repos only | 90 days |
| Release: tags + GitHub Releases | `RELEASE_CI_PAT` | Contents: RW, Discussions: RW; **no** blanket org access | 90 days |
| Post-merge changelog on `main` | `CHANGELOG_CI_PAT` (new, split from release) | Contents: RW | 90 days |
| PR checks (labels, comments, project) | `PR_CI_PAT` | Contents: R, Pull requests: RW, Issues: RW, Projects: RW | 180 days |
| Docs publish | stay on `GITHUB_TOKEN` | Contents: RW (run-scoped) | automatic |

Fine-grained PATs scoped per-repository wherever the sync matrix allows; short-lived
GitHub App installation tokens are the preferred end-state over any long-lived PAT.

### 4.2 Attribution policy

- Recommendation: stop writing `github-actions[bot]` / `dependabot[bot]` author strings
  from org-token-backed jobs (`changelog_generate-changelog.yml:32-34`,
  `changelog_dependabot.yml:45-47`, `pr_license.yml:56-58`); use the org-owned
  `cloudavenue-*-bot` identities instead.
- Rule: the author identity must match the credential that actually authorized the
  push; one visible bot account per duty (`cloudavenue-sync-bot`,
  `cloudavenue-release-bot`, `cloudavenue-docs-bot`, proposed `cloudavenue-changelog-bot`).
- Where GitHub-identity spoofing exists only to skip self-triggering workflows, replace
  with explicit `[skip ci]` conventions or `workflow_run` chaining and record the reason.

## 5. Not yet changed

Documentation only. In this branch: no workflow, template, or secret was modified; the
impersonating author configs of Section 2 remain live behavior on `main`; the token
split of Section 4.1 requires new secrets + repo admin action and is not implemented.
