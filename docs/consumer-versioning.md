# Consumer Versioning Model for Reusable Workflows

**Author**: Abdoul Hamid COULIBALY
**Date**: 2026-10-22
**Status**: proposed

Downstream consumers reference this platform's `@main` branch directly, with zero
tag-based release contract. This document defines one: versioning, release/rollout,
and migration.

This document defines the contract by which downstream repositories consume the reusable
workflows in this repo. It is a policy statement, not a description of current automation
(see [Not yet automated](#5-not-yet-automated)).

## 1. Current state (facts)

- Downstream templates reference reusable workflows exclusively at `@main`:
  `grep -rn '@main' shared-files/` returns **20 references today** across 9 template files
  (`pr.yml.njk`, `release.yml.njk`, `pr_open.yml.njk`, `pr_close.yml.njk`,
  `release_created-golang.yml.njk`, `project_composite.yml.njk`, and the three
  `common/golang/*.tmpl` composites). An earlier count was 22; the delta is
  drift in `release.yml.njk`, which itself shows why unpinned consumption is unstable.
- `git tag -l` returns **no output** (zero local tags) and
  `git ls-remote --tags origin` returns **no output** (exit 0): the remote publishes no tags.
- `sync.yml` propagates templates to **15 unique downstream repositories**.

**Blast radius**: every merge to `main` is an immediate, silent release to all 15 repos.
A single broken job change alters the behavior of every downstream PR, release, and
project-management pipeline at once, with no staging point and no pin a consumer can hold.

## 2. Proposed contract

### Tag scheme

- Releases are **annotated semver tags on `main`**: `vMAJOR.MINOR.PATCH`.
- A tag is a *released platform version*. Until tagged, `main` is platform-development
  territory: usable by this repo's own CI, not for downstream reference.
- Tags are immutable once published: never force-move or delete a published tag.

### Consumer reference form

Downstream templates reference the **major tag** (float within major, like actions do):

```yaml
uses: orange-cloudavenue/workflows/.github/workflows/pr_conventional_commits.yml@v1
```

Pinning to a full `@vX.Y.Z` is permitted for repos that want maximum stability; `@main`
is not permitted once migration is complete.

### What counts as which bump

| Bump | Consumer-visible meaning | Examples |
|---|---|---|
| **major** | Existing pipelines may break or change behavior without input changes | removing/renaming a workflow file; removing or renaming an `on.workflow_call.inputs` entry; changing an input's type or default in a way that changes behavior; changing job outputs semantics |
| **minor** | Additive, opt-in | new reusable workflow; new optional input with backward-compatible default; new job in a composite template that does not alter existing jobs |
| **patch** | Fix that preserves the interface | bug fix inside a job, dependency bump, error-message fix |

Rule of thumb: if a downstream repo can pull the new version **without editing its own
`.github/workflows/` files or seeing changed pipeline behavior**, it is minor or patch.

## 3. Release and rollout flow

All steps below are **manual policy** for now (see §5):

1. **Develop** on `main` as today. Merges to `main` no longer imply rollout.
2. **Tag**: a maintainer with repo write access decides a cut is ready and creates
   `git tag -a vX.Y.Z -m "..."` on the chosen `main` commit, then `git push origin vX.Y.Z`.
   Minor/patch cuts may bundle any number of merged PRs; a major cut requires the
   migration notes to be written first (changelog entry describing breaking changes).
3. **Bump templates**: update the `@main` references under `shared-files/` to `@vX`
   (or the full pin) in one PR to this repo, merged to `main`.
4. **Propagate**: `sync.yml` (`repo-file-sync-action`) renders the templates into the
   15 downstream repos as usual — the synced files now carry the tag reference.
5. **Staged rollout order** (via sync groups, one wave per sync run):
   1. `terraform-module-template` (template repo — canary)
   2. one low-traffic generic repo (e.g. `orange-cloudavenue.github.io`)
   3. remaining terraform modules and generic repos
   4. go SDKs / plugin-framework libs
   5. `terraform-provider-cloudavenue` last (highest traffic)
   Between waves: open a throwaway PR in the canary repo and confirm the pipeline runs.
6. **Rollback**: retag is forbidden; instead push a new patch/minor tag from a reverted
   commit (`git revert` on `main`, tag `vX.Y.(Z+1)`), bump templates back to the safe
   pin if needed, and re-run sync. Because consumers pin `@vX`, an alternative fast path
   for a bad minor is to land the revert on `main` and sync the previous known-good
   template state — but a new tag is the auditable way.

## 4. Migration from `@main` to tags

Ordered, lowest risk first. Each step is reversible independently.

1. **Cut `v1.0.0`** at the current `main` commit. Behaviorally identical to what
   downstream already consumes — zero-risk anchor.
2. **Switch templates in this repo**: replace the 20 `@main` references in
   `shared-files/**` with `@v1` in one PR. Add a CI check (extend `ci_validate.yml`)
   that fails on any `@main` reference under `shared-files/`.
3. **Canary sync**: run sync for `terraform-module-template` only; open a test PR there;
   verify `pr.yml` runs green against `@v1`.
4. **Roll the remaining sync groups** wave by wave (§3.5), verifying one pipeline per repo.
5. **Freeze**: after the last wave, the CI check from step 2 makes `@main` in
   `shared-files/` a hard failure, so the contract cannot silently regress.
6. **First real release** after migration becomes the first `v1.0.1`/`v1.1.0` cut,
   exercising the flow end to end.

## 5. Not yet automated

This document proposes policy; the following do **not** exist today and are deliberately
out of scope for this change:

- Automated tag creation on release (no "release this repo" workflow exists).
- Tag/protection rules (no immutable-tag enforcement, no branch protection gating tags).
- Verification that sync actually propagated a given tag to all 15 repos (no drift report).
- The `@main` lint from migration step 2 (proposed, not implemented).
- Automated canary pipeline checks between rollout waves.

Until these exist, the release engineer's discipline is the control.
