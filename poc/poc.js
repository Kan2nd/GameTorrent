#!/usr/bin/env node
/**
 * GameTorrent Phase 1 PoC — CLI
 *
 * Thin wrapper around pipeline.js (shared with ../webui): parses CLI args,
 * wires up console output, exits with the right code. All actual
 * download/scan/extract/verify/launch logic lives in pipeline.js.
 *
 * Two modes:
 *   --magnet "<uri>" / --url "<direct-download-url>" ...   direct mode, all params on the CLI
 *   --game <id>                 catalog mode, reads ../catalog/catalog.json
 *                                + ../config/emulators.json for that game id
 *
 * Examples:
 *   node poc.js --magnet "magnet:?xt=urn:btih:...&dn=Sintel" \
 *       --select "*.mp4" --dest sintel-test --dry-run
 *
 *   node poc.js --game tobu-tobu-girl --launch
 *
 * Malware checks (see docs/POC.md for setup):
 *   ClamAV scan runs on the raw downloaded files if `clamscan` is on PATH;
 *   if it's missing this is a skipped-with-warning, not a hard failure,
 *   unless --require-scan is passed. VirusTotal hash lookup (hash only,
 *   never the file itself) runs if VT_API_KEY is set in the environment.
 *   Either check finding a real threat aborts the pipeline — there is no
 *   override flag for that, by design.
 *
 * Safety default: without --launch, the resolved emulator command is
 * printed but NOT executed.
 */

'use strict';

const { EventEmitter } = require('events');
const pipeline = require('./pipeline');

function parseArgs(argv) {
  const args = { selectPatterns: [], extraArgs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--magnet': args.magnetUri = argv[++i]; break;
      case '--url': args.directUrl = argv[++i]; break;
      case '--torrent': args.torrentUrl = argv[++i]; break;
      case '--game': args.gameId = argv[++i]; break;
      case '--select': args.selectPatterns.push(argv[++i]); break;
      case '--platform': args.platform = argv[++i]; break;
      case '--dest': args.destSubfolder = argv[++i]; break;
      case '--archive': args.archiveFormat = argv[++i]; break;
      case '--rom': args.romFile = argv[++i]; break;
      case '--sha256': args.sha256 = argv[++i]; break;
      case '--emulator': args.emulatorId = argv[++i]; break;
      case '--launch': args.launch = true; break;
      case '--dry-run': args.launch = false; break;
      case '--skip-scan': args.skipScan = true; break;
      case '--require-scan': args.requireScan = true; break;
      case '--no-vt': args.noVt = true; break;
      default:
        console.warn(`Unknown arg: ${a}`);
    }
  }
  return args;
}

function buildJob(args) {
  if (args.gameId) return pipeline.buildJobFromGameId(args.gameId);

  return pipeline.buildJobFromParams({
    magnetUri: args.magnetUri,
    directUrl: args.directUrl,
    selectPatterns: args.selectPatterns,
    platform: args.platform,
    destSubfolder: args.destSubfolder,
    archiveFormat: args.archiveFormat,
    romFile: args.romFile,
    sha256: args.sha256,
    emulatorId: args.emulatorId,
    extraArgs: args.extraArgs,
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const job = buildJob(args);

  const emitter = new EventEmitter();
  let progressShown = false;

  emitter.on('progress', (p) => {
    process.stdout.write(`\r  progress: ${(p * 100).toFixed(1)}%`);
    progressShown = true;
  });
  emitter.on('log', (msg) => {
    if (progressShown) { process.stdout.write('\n'); progressShown = false; }
    console.log(msg);
  });

  await pipeline.runJob(job, {
    skipScan: args.skipScan,
    requireScan: args.requireScan,
    noVt: args.noVt,
    launch: args.launch,
  }, emitter);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\nError: ${err.message}`);
    process.exit(1);
  });
