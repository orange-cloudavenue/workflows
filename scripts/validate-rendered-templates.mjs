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
//   * every .njk/.tmpl file compiles (Nunjucks parse, replaces brace-count
//     heuristics);
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

const repoRoot = path.resolve(process.argv[2] || process.cwd());
const HUB = 'orange-cloudavenue/workflows';

const errors = [];
const variants = [];
const fail = (msg) => errors.push(msg);

const abs = (...parts) => path.join(repoRoot, ...parts);
const rel = (p) => path.relative(repoRoot, p).split(path.sep).join('/');
// Nunjucks puts the real reason (e.g. "template not found: x") on a
// continuation line: keep it in a single actionable error line.
const oneLine = (m) => m.replace(/\s*\n\s*/g, ' — ').trim();

// Must mirror repo-file-sync-action's nunjucks configuration exactly
// (src/helpers.js: `nunjucks.configure({ autoescape: true, trimBlocks: true,
// lstripBlocks: true })`), otherwise CI validates artifacts that are not the
// ones shipped downstream.
const env = new nunjucks.Environment(new nunjucks.FileSystemLoader([repoRoot]), {
  autoescape: true,
  trimBlocks: true,
  lstripBlocks: true,
});

// ---------------------------------------------------------------------------
// 1. Syntax-compile every template in shared-files (supersedes brace checks).
// ---------------------------------------------------------------------------
function collectTemplates(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectTemplates(full));
    else if (/\.(njk|tmpl)$/.test(entry)) out.push(full);
  }
  return out;
}

const allTemplates = collectTemplates(abs('shared-files'));
for (const file of allTemplates) {
  try {
    // Compiles (and fails on syntax errors) without rendering.
    new nunjucks.Template(readFileSync(file, 'utf8'), env, rel(file));
  } catch (e) {
    fail(`template syntax error in ${rel(file)}: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 2. Workflow-graph checks (rendered variants + hub's own workflows).
// ---------------------------------------------------------------------------
const hubWorkflows = new Set(
  existsSync(abs('.github/workflows'))
    ? readdirSync(abs('.github/workflows'))
        .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
        .map((f) => `.github/workflows/${f}`)
    : []
);

const RE_HUB_REF = new RegExp(`^${HUB}/(\\.github/workflows/[^@]+)@\\S+$`);

function checkWorkflowDoc(doc, label) {
  const jobs = doc?.jobs;
  if (!jobs || typeof jobs !== 'object') return;
  const jobNames = new Set(Object.keys(jobs));

  for (const [name, job] of Object.entries(jobs)) {
    // needs: targets must exist in the same workflow.
    const needs =
      typeof job?.needs === 'string'
        ? [job.needs]
        : Array.isArray(job?.needs)
          ? job.needs
          : [];
    for (const target of needs) {
      if (!jobNames.has(target)) {
        fail(`${label}: job '${name}' needs unknown job '${target}'`);
      }
    }

    // Job-level reusable-workflow references (workflow_call).
    const refs = [];
    if (typeof job?.uses === 'string') refs.push(job.uses);
    if (Array.isArray(job?.steps)) {
      for (const step of job.steps) {
        if (typeof step?.uses === 'string') refs.push(step.uses);
      }
    }
    for (const ref of refs) {
      const local = ref.match(/^\.\//);
      const hub = ref.match(RE_HUB_REF);
      if (local && ref.includes('.github/workflows/')) {
        const target = ref.replace(/^\.\//, '');
        if (!existsSync(abs(target))) {
          fail(`${label}: job '${name}' references missing local workflow '${ref}'`);
        }
      } else if (hub) {
        if (!hubWorkflows.has(hub[1])) {
          fail(
            `${label}: job '${name}' references '${HUB}/${hub[1]}' which does not exist in this repository`
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Validate one rendered output according to its destination file type.
// ---------------------------------------------------------------------------
function validateRendered(rendered, dest, label) {
  if (/\.(ya?ml)$/.test(dest)) {
    let doc;
    try {
      doc = yaml.load(rendered, { filename: label });
    } catch (e) {
      fail(`${label}: rendered output is invalid YAML: ${e.message.split('\n')[0]}`);
      return;
    }
    if (doc === undefined || doc === null) {
      fail(`${label}: rendered output is empty after YAML parse`);
      return;
    }
    if (dest.startsWith('.github/workflows/')) checkWorkflowDoc(doc, label);
  } else if (dest.endsWith('.json')) {
    // VS Code settings are JSONC (comment header + trailing commas):
    // render-success is the contract here, strict JSON.parse would be wrong.
    if (!rendered.trim()) fail(`${label}: rendered output is empty`);
  }
}

// ---------------------------------------------------------------------------
// 4. Build the matrix from sync.yml and render every variant.
// ---------------------------------------------------------------------------
const syncConfig = yaml.load(readFileSync(abs('sync.yml'), 'utf8'), { filename: 'sync.yml' });
const groups = syncConfig?.group;
if (!Array.isArray(groups)) {
  console.error('sync.yml: no `group:` list found');
  process.exit(1);
}

const renderedSources = new Set();

groups.forEach((group, gi) => {
  const label = `group ${gi + 1}`;
  const repos = String(group.repos ?? '')
    .split('\n')
    .map((r) => r.trim())
    .filter(Boolean);

  for (const entry of group.files ?? []) {
    const source = entry.source;
    const dest = entry.dest;
    if (!source || !dest) {
      fail(`${label}: file entry missing source/dest: ${JSON.stringify(entry)}`);
      continue;
    }
    if (!existsSync(abs(source))) {
      fail(`${label}: sync source does not exist: ${source}`);
      continue;
    }
    // Directory or plain-file copies: existence is the whole check.
    if (source.endsWith('/') || !statSync(abs(source)).isFile()) continue;

    const tmpl = entry.template;
    if (!tmpl) continue; // template: false/absent → plain copy
    renderedSources.add(source);

    const baseCtx = typeof tmpl === 'object' ? tmpl : {};
    const srcText = readFileSync(abs(source), 'utf8');
    const repoVariants = srcText.includes('repo.name') ? repos.map((r) => r.split('/').pop()) : [null];

    for (const repoName of repoVariants) {
      const ctx = { ...baseCtx };
      if (repoName !== null) ctx.repo = { name: repoName };
      const variantLabel = `${label} [${source} -> ${dest}] ctx=${JSON.stringify(ctx)}`;
      variants.push(variantLabel);
      let rendered;
      try {
        rendered = env.render(source, ctx);
      } catch (e) {
        fail(`${variantLabel}: render failed: ${oneLine(e.message)}`);
        continue;
      }
      validateRendered(rendered, dest, variantLabel);
    }
  }
});

// Every template under shared-files/github-actions/ must be covered by at
// least one sync group. Unreferenced ones are still rendered with an empty
// context so they never rot silently.
for (const file of allTemplates) {
  const r = rel(file);
  if (!r.startsWith('shared-files/github-actions/') || !r.endsWith('.njk')) continue;
  if (renderedSources.has(r)) continue;
  const variantLabel = `unreferenced [${r}] ctx={}`;
  variants.push(variantLabel);
  console.log(`NOTE: ${r} is not referenced by any sync.yml group; rendering with empty context`);
  try {
    const rendered = env.render(r, {});
    validateRendered(rendered, `.github/workflows/${path.basename(r, '.njk')}`, variantLabel);
  } catch (e) {
    fail(`${variantLabel}: render failed: ${oneLine(e.message)}`);
  }
}

// ---------------------------------------------------------------------------
// 5. The hub's own concrete workflows get the same graph checks.
// ---------------------------------------------------------------------------
for (const wf of hubWorkflows) {
  const label = wf;
  let doc;
  try {
    doc = yaml.load(readFileSync(abs(wf), 'utf8'), { filename: wf });
  } catch (e) {
    fail(`${label}: invalid YAML: ${e.message.split('\n')[0]}`);
    continue;
  }
  checkWorkflowDoc(doc, label);
}

// ---------------------------------------------------------------------------
// Report.
// ---------------------------------------------------------------------------
console.log(`Templates compiled:  ${allTemplates.length}`);
console.log(`Rendered variants:   ${variants.length}`);
for (const v of variants) console.log(`  - ${v}`);
console.log(`Hub workflows:       ${hubWorkflows.size}`);

if (errors.length > 0) {
  console.error(`\n${errors.length} error(s):`);
  for (const e of errors) console.error(`  ERROR: ${e}`);
  process.exit(1);
}
console.log('\nAll template variants rendered and validated successfully');
