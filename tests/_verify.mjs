/* Verifies the privacy invariant: the personal schedule lives only in private/
   storage, and the public site ships an empty bootstrap. */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'site', 'index.html'), 'utf8');
const templatePath = join(root, 'private', 'schedule-template.v1.json');

const publicBlocks = (html.match(/"id":"p\d/g) || []).length;
console.log('public index.html blocks:', publicBlocks, publicBlocks === 0 ? 'OK' : 'FAIL');

if (!existsSync(templatePath)) {
  console.log('private template: MISSING — run node tools/privacy/extract-schedule.mjs');
  process.exit(1);
}
const template = JSON.parse(readFileSync(templatePath, 'utf8'));
const privateBlocks = template.plans.flat(2).length;
console.log('private template blocks:', privateBlocks, privateBlocks === 392 ? 'OK' : 'FAIL');
console.log('private template habits:', template.habitList.length);
process.exit(publicBlocks === 0 && privateBlocks === 392 ? 0 : 1);