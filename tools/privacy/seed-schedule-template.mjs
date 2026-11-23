#!/usr/bin/env node
/**
 * Publishes the PRIVATE schedule template from this machine into the existing
 * Cloudflare D1 database through the authenticated Worker API.
 *
 * It never prints the access token and never deletes anything: an existing
 * template is only replaced with --force (optimistic version check on the server).
 *
 * Required environment (do not commit these values):
 *   JARVIS_API_URL   https://jarvis-routine-api.demo.workers.dev
 *   JARVIS_APP_TOKEN the same APP_ACCESS_TOKEN configured as a Worker secret
 *
 * Usage:
 *   node tools/privacy/seed-schedule-template.mjs           # seed or verify
 *   node tools/privacy/seed-schedule-template.mjs --force   # replace existing
 *   node tools/privacy/seed-schedule-template.mjs --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..', '..');
const templatePath = path.join(root, 'private', 'schedule-template.v1.json');
const args = process.argv.slice(2);
const force = args.includes('--force');
const dryRun = args.includes('--dry-run');

function die(msg) {
  console.error('SEED FAILED:', msg);
  process.exit(1);
}

if (!fs.existsSync(templatePath)) die('private/schedule-template.v1.json missing — run node tools/privacy/extract-schedule.mjs');
const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
const payload = { plans: template.plans, habits: template.habitList };
const blocks = payload.plans.flat(2).length;
if (blocks !== 392) die(`private template has ${blocks} blocks, expected 392`);
if (!payload.habits.length) die('private template has no habits');
const body = JSON.stringify({ payload, expectedVersion: 0 });
const digest = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
console.log(`template ready: ${blocks} blocks, ${payload.habits.length} habits, sha256 ${digest.slice(0, 16)}…`);

if (dryRun) {
  console.log('dry run: nothing sent');
  process.exit(0);
}

const apiUrl = (process.env.JARVIS_API_URL || '').replace(/\/+$/, '');
const token = process.env.JARVIS_APP_TOKEN || '';
if (!apiUrl.startsWith('https://')) die('set JARVIS_API_URL to the https Worker origin');
if (token.length < 24) die('set JARVIS_APP_TOKEN (APP_ACCESS_TOKEN) — it is never printed');

const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };

async function request(method, pathname, body) {
  const res = await fetch(apiUrl + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch {}
  return { status: res.status, data };
}

const current = await request('GET', '/api/schedule-template');
if (current.status === 200) {
  const remoteBlocks = (current.data?.payload?.plans || []).flat(2).length;
  console.log(`server already has template version ${current.data?.version} with ${remoteBlocks} blocks`);
  if (!force) {
    console.log('nothing to do (use --force to replace the stored template)');
    process.exit(0);
  }
  const replaced = await request('POST', '/api/schedule-template', { payload, expectedVersion: Number(current.data.version) || 0 });
  if (replaced.status !== 200) die(`replace failed: HTTP ${replaced.status} ${replaced.data?.error || ''}`);
  console.log('template replaced, new version', replaced.data.version);
} else if (current.status === 404) {
  const created = await request('POST', '/api/schedule-template', { payload, expectedVersion: 0 });
  if (created.status !== 200) die(`seed failed: HTTP ${created.status} ${created.data?.error || ''}`);
  console.log('template seeded, version', created.data.version, 'blocks', created.data.blocks);
} else if (current.status === 401) {
  die('401 Unauthorized — JARVIS_APP_TOKEN does not match the Worker secret');
} else {
  die(`unexpected GET /api/schedule-template status ${current.status}`);
}

const verify = await request('GET', '/api/schedule-template');
if (verify.status !== 200) die(`verification failed: HTTP ${verify.status}`);
const verifiedBlocks = (verify.data?.payload?.plans || []).flat(2).length;
if (verifiedBlocks !== 392) die(`verification failed: server reports ${verifiedBlocks} blocks`);
const verifiedDigest = crypto.createHash('sha256').update(JSON.stringify({ plans: verify.data.payload.plans, habits: verify.data.payload.habits })).digest('hex');
if (verifiedDigest !== digest) die('verification failed: stored template differs from the local private backup');
console.log(`verified: server returns ${verifiedBlocks} blocks, digest matches local backup`);