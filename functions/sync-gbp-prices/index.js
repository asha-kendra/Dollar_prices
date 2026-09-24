/**
 * Zoho Catalyst Advanced I/O function entry point.
 * Intended to be triggered by the Catalyst Job Scheduler (cron) rather than
 * called directly, so it ignores the request body/query and just runs the
 * sync. No external npm dependencies, so nothing needs to be installed after
 * the zip is extracted.
 */

'use strict';

const { main } = require('./sync-gbp-prices');

module.exports = (context, req, res) => {
  main()
    .then((summary) => {
      res.write(JSON.stringify({ status: 'ok', summary }));
      res.end();
    })
    .catch((err) => {
      console.error(err.stack || err.message || err);
      res.write(JSON.stringify({ status: 'error', message: err.message }));
      res.end();
    });
};
