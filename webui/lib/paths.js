'use strict';

const path = require('path');

/**
 * Where the app keeps its state. Defaults to webui/data (the PVC mount in k8s, a named volume in
 * the old Docker setup). GT_DATA_DIR overrides it so tests can run against a throwaway folder
 * without touching real data.
 */
const DATA_DIR = path.resolve(process.env.GT_DATA_DIR || path.join(__dirname, '..', 'data'));

module.exports = { DATA_DIR };
