#!/usr/bin/env node
// Validates catalog/catalog.json and catalog/feeds/*.json against catalog/catalog.schema.json.
// Run via `npm run validate:catalog`; used by the CI "validate" stage.

const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const root = path.join(__dirname, '..', '..');
const schema = JSON.parse(fs.readFileSync(path.join(root, 'catalog', 'catalog.schema.json'), 'utf8'));

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);
const validate = ajv.compile(schema);

const targets = [path.join(root, 'catalog', 'catalog.json')];
const feedsDir = path.join(root, 'catalog', 'feeds');
if (fs.existsSync(feedsDir)) {
  for (const f of fs.readdirSync(feedsDir)) {
    if (f.endsWith('.json')) targets.push(path.join(feedsDir, f));
  }
}

let hasErrors = false;
for (const file of targets) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (validate(data)) {
    console.log(`OK    ${path.relative(root, file)}`);
  } else {
    hasErrors = true;
    console.error(`FAIL  ${path.relative(root, file)}`);
    for (const err of validate.errors) {
      console.error(`  ${err.instancePath || '/'} ${err.message}`);
    }
  }
}

process.exit(hasErrors ? 1 : 0);
