#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const raysRoot = path.join(repoRoot, 'apps', 'rays-games', 'server');
const contextRoot = path.join(repoRoot, 'apps', 'context-clues', 'server');
const allowlistPath = path.join(repoRoot, '.maintenance', 'server-sync-allowlist.json');

const criticalScopes = [
  'server.js',
  'game',
  'similarity',
  'stats'
];

function toPosix(p) {
  return p.split(path.sep).join('/');
}

async function readAllowlist() {
  const raw = await fs.readFile(allowlistPath, 'utf8');
  const parsed = JSON.parse(raw);

  const toSet = (list, field) => new Set((list ?? []).map((item) => item[field]));

  return {
    allowedDivergence: toSet(parsed.allowedDivergence, 'path'),
    allowedContextOnly: toSet(parsed.allowedContextOnly, 'path'),
    allowedRaysOnly: toSet(parsed.allowedRaysOnly, 'path')
  };
}

async function walkFiles(baseDir, relativePath = '') {
  const absolute = path.join(baseDir, relativePath);
  const stats = await fs.stat(absolute);

  if (stats.isFile()) {
    return [toPosix(relativePath)];
  }

  const entries = await fs.readdir(absolute, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const nextRel = path.join(relativePath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(baseDir, nextRel));
    } else if (entry.isFile()) {
      files.push(toPosix(nextRel));
    }
  }

  return files;
}

async function collectCriticalFiles(rootDir) {
  const files = new Set();

  for (const scope of criticalScopes) {
    const scopePath = path.join(rootDir, scope);
    const scopeStats = await fs.stat(scopePath);

    if (scopeStats.isFile()) {
      files.add(toPosix(scope));
      continue;
    }

    const scopedFiles = await walkFiles(rootDir, scope);
    for (const file of scopedFiles) {
      files.add(file);
    }
  }

  return files;
}

async function contentDiffers(a, b) {
  const [aContent, bContent] = await Promise.all([
    fs.readFile(a),
    fs.readFile(b)
  ]);
  return !aContent.equals(bContent);
}

async function main() {
  const allowlist = await readAllowlist();
  const raysFiles = await collectCriticalFiles(raysRoot);
  const contextFiles = await collectCriticalFiles(contextRoot);

  const errors = [];
  const warnings = [];

  for (const relPath of [...raysFiles].sort()) {
    const raysFile = path.join(raysRoot, relPath);
    const contextFile = path.join(contextRoot, relPath);

    let contextStat = null;
    try {
      contextStat = await fs.stat(contextFile);
    } catch {
      contextStat = null;
    }

    if (!contextStat) {
      if (!allowlist.allowedRaysOnly.has(relPath)) {
        errors.push(`Missing in apps/context-clues/server: ${relPath}`);
      }
      continue;
    }

    const differs = await contentDiffers(raysFile, contextFile);
    if (differs) {
      if (allowlist.allowedDivergence.has(relPath)) {
        warnings.push(`Allowed divergence: ${relPath}`);
      } else {
        errors.push(`Unexpected divergence: ${relPath}`);
      }
    }
  }

  for (const relPath of [...contextFiles].sort()) {
    if (raysFiles.has(relPath)) continue;
    if (allowlist.allowedContextOnly.has(relPath)) {
      warnings.push(`Allowed context-only file: ${relPath}`);
    } else {
      errors.push(`Unexpected context-only critical file: ${relPath}`);
    }
  }

  if (warnings.length) {
    console.log('Server sync warnings (allowlisted):');
    for (const warning of warnings) {
      console.log(`  - ${warning}`);
    }
    console.log('');
  }

  if (errors.length) {
    console.error('Server sync check failed:');
    for (const error of errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log('Server sync check passed: critical files are aligned or explicitly allowlisted.');
}

main().catch((error) => {
  console.error('Unable to run server sync check.');
  console.error(error);
  process.exit(1);
});
