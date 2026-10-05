#!/usr/bin/env node
/**
 * CLI entry point for the CRM GBP price sync. The implementation lives in
 * functions/sync-gbp-prices-crm/sync-gbp-prices-crm.js so it can be shared
 * with the Zoho Catalyst Advanced I/O function deployed from that same
 * folder (functions/sync-gbp-prices-crm/index.js). See that file for full
 * documentation on required environment variables, CLI flags and the
 * conversion logic.
 */

'use strict';

require('../functions/sync-gbp-prices-crm/sync-gbp-prices-crm')
  .main()
  .then((summary) => {
    if (summary.errors > 0) process.exitCode = 1;
  })
  .catch((err) => {
    console.error(err.stack || err.message || err);
    process.exitCode = 1;
  });
