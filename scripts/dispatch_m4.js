#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const { dispatcher } = require('../src/dispatcher');

async function main() {
  console.log('--- Runner Milestone M4: Sequential WhatsApp Dispatch ---');
  const results = await dispatcher.dispatch();
  const outPath = path.join(__dirname, '..', '.agents', 'teamwork', 'worker_m4', 'dispatch_results.json');
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf8');
  console.log(`Results saved to: ${outPath}`);
}

main().catch(err => {
  console.error('Fatal error in runner:', err);
  process.exit(1);
});
