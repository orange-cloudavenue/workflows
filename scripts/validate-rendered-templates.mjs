#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 Orange
// SPDX-License-Identifier: Mozilla Public License 2.0
//
// This software is distributed under the MPL-2.0 license.
// the text of which is available at https://www.mozilla.org/en-US/MPL/2.0/
// or see the "LICENSE" file for more details.

// Render-and-validate every shipped template variant.
//
// The matrix is derived from sync.yml itself: for every sync group and every
// file entry with `template:` truthy, the template is rendered with that
// entry's real variable values (golang, terraform_provider, ...), exactly as
// repo-file-sync-action would render it downstream. When a template reads
// `repo.name`, one variant per repository in the group is rendered so that
// repo-conditional branches are covered too.
//
// Validations performed:
//   * every sync.yml source exists (hard failure, no warning-only);
//   * every .njk/.tmpl file compiles (Nunjucks parse);
//   * {% include %} chains are fully resolved at render time (missing
//     include sources are hard failures);
//   * rendered .yml/.yaml output is parsed as YAML;
//   * rendered workflows (dest .github/workflows/*) and the hub's own
//     .github/workflows/*.yml are checked for:
//       - every `needs:` target existing in the same workflow;
//       - local reusable-workflow references (`./.github/workflows/...` and
//         `orange-cloudavenue/workflows/.github/workflows/...@ref`) pointing
//         at a workflow that exists in this repository.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const nunjucks = require('nunjucks');
const yaml = require('js-yaml');

const HUB = 'orange-cloudavenue/workflows';
const RE_HUB_REF = new RegExp(`^${HUB}/(\\.github/workflows/[^@]+)@\\S+$`);

// Nunjucks reports the root cause (e.g. "template not found: x") on a
// continuation line: collapse it so each error stays one actionable line.
const oneLine = (message) => message.replace(/\s*\n\s*/g, ' — ').trim();
const firstLine = (message) => message.split('\n')[0];

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

function createPaths(repoRoot) {
  return {
    root: repoRoot,
    abs: (...parts) => path.join(repoRoot, ...parts),
    rel: (p) => path.relative(repoRoot, p).split(path.sep).join('/'),
  };
}

// Mirrors repo-file-sync-action's nunjucks configuration (src/helpers.js:
// autoescape/trimBlocks/lstripBlocks all true) so CI validates exactly the
// artifacts shipped downstream.
function createEnv(root) {
  return new nunjucks.Environment(new nunjucks.FileSystemLoader([root]), {
    autoescape: true,
    trimBlocks: true,
    lstripBlocks: true,
  });
}

function collectTemplateFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...collectTemplateFiles(full));
    else if (/\.(njk|tmpl)$/.test(entry)) found.push(full);
  }
  return found;
}

function listHubWorkflows(abs) {
  const dir = abs('.github/workflows');
  if (!existsSync(dir)) return new Set();
  return new Set(
    readdirSync(dir)
      .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
      .map((f) => `.github/workflows/${f}`)
  );
}

// ---------------------------------------------------------------------------
// Compile check: every template in shared-files must parse.
// ---------------------------------------------------------------------------

function compileAll(env, templateFiles, { rel }) {
  const errors = [];
  for (const file of templateFiles) {
    try {
      // Compiles (and fails on syntax errors) without rendering.
      new nunjucks.Template(readFileSync(file, 'utf8'), env, rel(file));
    } catch (e) {
      errors.push(`template syntax error in ${rel(file)}: ${e.message}`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Matrix: one entry per (sync group, templated file entry, repo variant).
// ---------------------------------------------------------------------------

function buildMatrix({ abs }) {
  const errors = [];
  const syncConfig = yaml.load(readFileSync(abs('sync.yml'), 'utf8'), { filename: 'sync.yml' });
  const groups = syncConfig?.group;
  // Fatal: nothing can be rendered without the group list.
  if (!Array.isArray(groups)) {
    return { variants: [], errors: ['sync.yml: no `group:` list found'], fatal: true };
  }

  const variants = [];
  groups.forEach((group, gi) => {
    const groupLabel = `group ${gi + 1}`;
    const repos = String(group.repos ?? '')
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean);

    for (const entry of group.files ?? []) {
      const source = entry.source;
      const dest = entry.dest;
      if (!source || !dest) {
        errors.push(`${groupLabel}: file entry missing source/dest: ${JSON.stringify(entry)}`);
        continue;
      }
      if (!existsSync(abs(source))) {
        errors.push(`${groupLabel}: sync source does not exist: ${source}`);
        continue;
      }
      // Directory or plain-file copies: existence is the whole check.
      if (source.endsWith('/') || !statSync(abs(source)).isFile()) continue;

      const tmpl = entry.template;
      if (!tmpl) continue; // template: false/absent → plain copy

      const baseCtx = typeof tmpl === 'object' ? tmpl : {};
      const srcText = readFileSync(abs(source), 'utf8');
      const repoVariants = srcText.includes('repo.name') ? repos.map((r) => r.split('/').pop()) : [null];

      for (const repoName of repoVariants) {
        const ctx = { ...baseCtx };
        if (repoName !== null) ctx.repo = { name: repoName };
        variants.push({
          label: `${groupLabel} [${source} -> ${dest}] ctx=${JSON.stringify(ctx)}`,
          source,
          dest,
          ctx,
        });
      }
    }
  });
  return { variants, errors, fatal: false };
}

// Templates under shared-files/github-actions/ that no sync group references
// are still rendered with an empty context so they never rot silently.
function coverageVariants(templateFiles, { rel }, matrixSources) {
  const extra = [];
  const notes = [];
  for (const file of templateFiles) {
    const source = rel(file);
    if (!source.startsWith('shared-files/github-actions/') || !source.endsWith('.njk')) continue;
    if (matrixSources.has(source)) continue;
    notes.push(`NOTE: ${source} is not referenced by any sync.yml group; rendering with empty context`);
    extra.push({
      label: `unreferenced [${source}] ctx={}`,
      source,
      dest: `.github/workflows/${path.basename(source, '.njk')}`,
      ctx: {},
    });
  }
  return { extra, notes };
}

// ---------------------------------------------------------------------------
// Workflow graph checks: needs targets and reusable-workflow references.
// ---------------------------------------------------------------------------

function jobUsesRefs(job) {
  const refs = [];
  if (typeof job?.uses === 'string') refs.push(job.uses);
  if (Array.isArray(job?.steps)) {
    for (const step of job.steps) {
      if (typeof step?.uses === 'string') refs.push(step.uses);
    }
  }
  return refs;
}

function workflowGraphErrors(doc, label, hubWorkflows, { abs }) {
  const errors = [];
  const jobs = doc?.jobs;
  if (!jobs || typeof jobs !== 'object') return errors;
  const jobNames = new Set(Object.keys(jobs));

  for (const [name, job] of Object.entries(jobs)) {
    const needs =
      typeof job?.needs === 'string' ? [job.needs] : Array.isArray(job?.needs) ? job.needs : [];
    for (const target of needs) {
      if (!jobNames.has(target)) {
        errors.push(`${label}: job '${name}' needs unknown job '${target}'`);
      }
    }

    for (const ref of jobUsesRefs(job)) {
      const hubRef = ref.match(RE_HUB_REF);
      if (ref.startsWith('./') && ref.includes('.github/workflows/')) {
        if (!existsSync(abs(ref.replace(/^\.\//, '')))) {
          errors.push(`${label}: job '${name}' references missing local workflow '${ref}'`);
        }
      } else if (hubRef && !hubWorkflows.has(hubRef[1])) {
        errors.push(
          `${label}: job '${name}' references '${HUB}/${hubRef[1]}' which does not exist in this repository`
        );
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Rendered-output validation, by destination file type.
// ---------------------------------------------------------------------------

function validateRenderedYaml(rendered, dest, label, workflowCheck) {
  const errors = [];
  let doc;
  try {
    doc = yaml.load(rendered, { filename: label });
  } catch (e) {
    errors.push(`${label}: rendered output is invalid YAML: ${firstLine(e.message)}`);
    return errors;
  }
  if (doc === undefined || doc === null) {
    errors.push(`${label}: rendered output is empty after YAML parse`);
    return errors;
  }
  if (dest.startsWith('.github/workflows/')) errors.push(...workflowCheck(doc, label));
  return errors;
}

function validateRendered(rendered, dest, label, workflowCheck) {
  if (/\.(ya?ml)$/.test(dest)) return validateRenderedYaml(rendered, dest, label, workflowCheck);
  if (dest.endsWith('.json')) {
    // VS Code settings are JSONC (comment header + trailing commas):
    // render-success is the contract here, strict JSON.parse would be wrong.
    return rendered.trim() ? [] : [`${label}: rendered output is empty`];
  }
  return [];
}

function renderAndValidate(env, variants, validate) {
  const errors = [];
  for (const { label, source, dest, ctx } of variants) {
    let rendered;
    try {
      rendered = env.render(source, ctx);
    } catch (e) {
      errors.push(`${label}: render failed: ${oneLine(e.message)}`);
      continue;
    }
    errors.push(...validate(rendered, dest, label));
  }
  return errors;
}

// ---------------------------------------------------------------------------
// The hub's own concrete workflows get the same graph checks.
// ---------------------------------------------------------------------------

function checkHubWorkflows(hubWorkflows, { abs }, workflowCheck) {
  const errors = [];
  for (const wf of hubWorkflows) {
    try {
      const doc = yaml.load(readFileSync(abs(wf), 'utf8'), { filename: wf });
      errors.push(...workflowCheck(doc, wf));
    } catch (e) {
      errors.push(`${wf}: invalid YAML: ${firstLine(e.message)}`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function reportSummary(templateCount, variantLabels, hubCount, errors) {
  console.log(`Templates compiled:  ${templateCount}`);
  console.log(`Rendered variants:   ${variantLabels.length}`);
  for (const label of variantLabels) console.log(`  - ${label}`);
  console.log(`Hub workflows:       ${hubCount}`);

  if (errors.length > 0) {
    console.error(`\n${errors.length} error(s):`);
    for (const e of errors) console.error(`  ERROR: ${e}`);
    return 1;
  }
  console.log('\nAll template variants rendered and validated successfully');
  return 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const paths = createPaths(path.resolve(process.argv[2] || process.cwd()));
  const { abs, rel } = paths;
  const env = createEnv(paths.root);
  const errors = [];

  const templateFiles = collectTemplateFiles(abs('shared-files'));
  errors.push(...compileAll(env, templateFiles, paths));

  const hubWorkflows = listHubWorkflows(abs);
  const workflowCheck = (doc, label) => workflowGraphErrors(doc, label, hubWorkflows, paths);

  const { variants: matrix, errors: matrixErrors, fatal } = buildMatrix(paths);
  if (fatal) {
    console.error(matrixErrors.join('\n'));
    return 1;
  }
  errors.push(...matrixErrors);

  const matrixSources = new Set(matrix.map((v) => v.source));
  const { extra: unreferenced, notes } = coverageVariants(templateFiles, paths, matrixSources);
  for (const note of notes) console.log(note);

  const variants = [...matrix, ...unreferenced];
  errors.push(...renderAndValidate(env, variants, (r, d, l) => validateRendered(r, d, l, workflowCheck)));
  errors.push(...checkHubWorkflows(hubWorkflows, paths, workflowCheck));

  return reportSummary(templateFiles.length, variants.map((v) => v.label), hubWorkflows.size, errors);
}

process.exit(main());
