# AGENTS.md — orange-cloudavenue/workflows

## Purpose

Centralized GitHub Actions workflows for Orange CloudAvenue projects.
This repo is the **source of truth** for reusable workflows and Nunjucks templates.
It is **not** a sync target — `sync.yml` distributes templates to 13+ downstream repos.

## Structure

```
.github/workflows/          # Reusable workflows (workflow_call)
shared-files/
  github-actions/           # Nunjucks templates synced to target repos
    *.yml.njk               # Composite workflow templates
  license/
    licenserc.yaml.njk      # License header config (MPL-2.0)
sync.yml                    # Repo-file-sync-action configuration
.plumber.yaml               # Plumber CI/CD security scanner config
```

## Key Rules

### Action Pinning
- All third-party actions must be pinned by **commit SHA**, not tags
- Use `gh api repos/<owner>/<repo>/commits/<tag> --jq '.sha'` to get SHAs
- Update to latest versions when pinning — don't just SHA-pin old refs
- `actions/*` and `github/*` are trusted by Plumber, no SHA required

### Trusted Actions
- New third-party actions must be added to `.plumber.yaml` `trustedGithubActions`
- See existing entries for format — group by category, one owner per line
- If Plumber flags `ISSUE-713`, add the owner to the allowlist

### Nunjucks Templates
- Templates use `{% if golang %}` / `{% if terraform_provider %}` conditionals
- Always wrap Go-specific jobs in `{% if golang %}...{% endif %}`
- Use `{% raw %}` / `{% endraw %}` for GitHub Actions `${{ }}` expressions
- Template name `project.yml.njk` was renamed to `project_composite.yml.njk` to avoid collision with reusable `project.yml`

### Concrete Workflows
- `.github/workflows/` contains **only reusable workflows** (`workflow_call`)
- Do **not** create composite workflows here — they belong in templates only
- This repo runs its own CI via the concrete files, not via sync

### License Headers
- All source files must have MPL-2.0 SPDX headers
- Use `license-eye` or `reuse-annotate` to add headers
- Year format: `2024` or `2020-2024` (creation year, not modification year)

### Plumber
- Runs on PR and push to `main`
- Threshold: `min-score: A` (LOW findings don't fail the gate)
- Config is minimal GitHub-only — no GitLab controls
- `branchMustBeProtected` is disabled (can't fix from config)

## Adding a New Reusable Workflow

1. Create `.github/workflows/<name>.yml` with `workflow_call` trigger
2. Add inputs/outputs/required secrets as needed
3. If Go-specific, also create `shared-files/github-actions/<name>.yml.njk` with `{% if golang %}` wrapper
4. Add template to `sync.yml` under appropriate group(s)
5. Pin all third-party actions by SHA
6. Run `plumber analyze` to verify

## Adding a New Template

1. Create `shared-files/github-actions/<name>.yml.njk`
2. Include header: `{% include '../common/header.yml.tmpl' %}`
3. Use `{% raw %}` for GitHub Actions expressions
4. Add conditional blocks for repo types (`golang`, `terraform_provider`)
5. Add to `sync.yml` under appropriate group(s)
6. Do **not** create a concrete copy in `.github/workflows/`

## Sync Groups

| Group | Repos | golang | terraform_provider |
|---|---|---|---|
| ALL Golang repositories | Go repos | true | false |
| Generic golang | Go repos | true | false |
| Generic repositories | Non-Go repos | false | false |
| Generic terraform modules | Terraform modules | false | true |
| Generic terraform | Terraform repos | false | true |

## CI/CD Security

- Plumber scans all workflows on PR/push
- Dependabot monitors action versions (`dependabot.yml`)
- After Dependabot updates a tag ref, manually convert to SHA pin
- Never commit secrets or tokens

## Gotchas

- `project.yml` (reusable) and `project_composite.yml.njk` (template) have different names — don't confuse them
- `go_license-check` only runs in Go repos (`{% if golang %}` in `pr.yml.njk`)
- `release_created-golang.yml.njk` is Go-only — don't create a concrete copy for this repo
- `doc_publish.yml` only runs when `mkdocs.yml` exists — no `workflow_dispatch` bypass
