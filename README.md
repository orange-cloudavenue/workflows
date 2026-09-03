# workflows

Centralized GitHub Actions workflows for Orange CloudAvenue repositories.

This repo is the **source of truth** for reusable workflows and Nunjucks templates.
Templates are synced to 13+ downstream repos via `repo-file-sync-action`.

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

## Workflows

### Reusable workflows

- `project.yml` — Add issues/PRs to GitHub projects
- `pr_license.yml` — License header validation and auto-commit
- `pr_auto_assign.yml` — Auto-assign PR author
- `pr_conventional_commits.yml` — Validate PR title follows conventional commits
- `pr_label_size.yml` — Auto-label PRs by size
- `go_license_check.yml` — Go dependency license compliance
- `go_golangci-lint.yml` — Go linting via golangci-lint
- `go_unit_test.yml` — Go unit tests
- `go_unit_test-tf-provider.yml` — Go unit tests for Terraform providers
- `go_report_card.yml` — Go report card
- `go_proxy-refresh.yml` — Go module proxy refresh
- `changelog_validation.yml` — Validate CHANGELOG.md presence
- `changelog_generate-changelog.yml` — Generate changelog from PRs
- `changelog_generate-new-version.yml` — Generate new version changelog
- `changelog_dependabot.yml` — Dependabot changelog updates
- `release_publish-simple-release.yml` — Simple GitHub release
- `release_publish-terraform-provider.yml` — Terraform provider release with GoReleaser
- `release_generate-release-note.yml` — Generate release notes
- `doc_publish.yml` — Publish MkDocs documentation to GitHub Pages
- `tag_check-tag.yml` — Check if tag already exists
- `tag_create-tag.yml` — Create git tag
- `ci_validate.yml` — Validate workflows and templates
- `plumber.yml` — CI/CD security scanning

### Composite templates (synced to target repos)

- `pr.yml.njk` — Full PR pipeline (license, lint, tests, go-license-check for Go repos)
- `pr_open.yml.njk` — PR opened actions
- `pr_close.yml.njk` — PR closed actions
- `release.yml.njk` — Release pipeline
- `labeler.yml.njk` — Auto-label issues/PRs
- `project_composite.yml.njk` — Project management composite

## Sync groups

| Group | Description |
|---|---|
| ALL Golang repositories | Go repos with full CI |
| Generic golang | Go repos without Terraform |
| Generic repositories | Non-Go repos |
| Generic terraform modules | Terraform modules |
| Generic terraform | Terraform repos |

## Security

- All third-party actions are pinned by commit SHA
- Plumber scans workflows on PR/push with `min-score: A`
- Dependabot monitors action versions

## License

MPL-2.0
