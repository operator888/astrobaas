#!/usr/bin/env node
/**
 * The CHANGELOG keeps its release history.
 *
 * A branch cut before a release, merged back after it with "take mine" on the
 * CHANGELOG conflict, silently rolls the file back: the release header vanishes
 * and that release's entries reappear under [Unreleased], while everything
 * merged in between disappears. It happened on 2026-09-29 (#113/#118 dropped the
 * [0.1.4] header and four entries) and nothing noticed, because nothing reads
 * the CHANGELOG. Now something does.
 *
 * Run with:  node tests/changelog.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

let pass = 0;
let fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error(`✗ ${n}`); } };

const releases = [...log.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
check(`the version in package.json (${version}) has its own section — a merge that drops it rolls the history back`,
  releases.includes(version));
check('there is exactly one [Unreleased] section, and it comes first',
  (log.match(/^## \[Unreleased\]/gm) ?? []).length === 1 && log.indexOf('## [Unreleased]') < log.search(/^## \[\d/m));
const cmp = (a, b) => a.split('.').map(Number).reduce((r, x, i) => r || x - Number(b.split('.')[i]), 0);
check('releases are listed newest first, each once',
  releases.every((v, i) => i === 0 || cmp(releases[i - 1], v) > 0));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
