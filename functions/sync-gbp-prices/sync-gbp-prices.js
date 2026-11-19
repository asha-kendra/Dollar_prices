/**
 * sync-gbp-prices.js
 *
 * Updates the GBP sales price ("rate") of Items in Zoho Inventory (Henig-Inventory
 * connector / org "Henig Diamonds Ltd") from the USD prices held on the linked
 * "Item Attribute" custom module (api name: cm_jewellery_item).
 *
 * Source module: cm_jewellery_item ("Item Attributes")
 *   - cf_jewellery_item                      lookup -> Items module item_id
 *   - cf_sales_price                         Sales Price / Selling PPC (USD)
 *
 * The USD->GBP exchange rate is fetched live from the fixer.io API (one call per
 * run, applied to every record) rather than read from a field on the record.
 * The call requests base=GBP, symbols=USD; this requires a fixer.io plan that
 * honors a non-EUR base currency (the free plan ignores `base` and always
 * responds in EUR, which would break this).
 *
 * Target: Items module
 *   - "rate" (the org's base/selling currency is GBP)
 *   - custom field cf_main_total = rate * cf_carat_total (confirmed against a
 *     live item: rate 2045 x cf_carat_total 1.01 = cf_main_total 2065.45)
 * Also writes back to every cm_jewellery_item record used in the conversion:
 *   - cf_current_exchange_rate_dollar_to_gbp = the live fixer.io rate used this
 *     run, so the record reflects what rate its price was converted with -
 *     regardless of whether the linked item passed the status filter below.
 *
 * Steps, in order:
 *   1. Fetch items whose CURRENT `cf_status` custom field is one of
 *      ITEM_STATUS_VALUES, using cf_status as a direct server-side search filter
 *      on the Items list endpoint (bulk, paginated - no per-item GET calls).
 *      This also gives us each eligible item's current name/rate/cf_carat_total.
 *      cf_status is purely a filter here; this script never writes it. Items
 *      with any other status (Sold, Rejected, Faulty, etc.) or no status set
 *      are never touched.
 *   2. Fetch the USD sales price for each item from the linked cm_jewellery_item
 *      ("Item Attributes") record.
 *   3. Compute gbp_price = round_to_nearest(usd_price * exchange_rate, ROUND_TO)
 *      i.e. the raw converted price rounded to the nearest multiple of ROUND_TO
 *      (default: 5, so sales prices land on whole £5 steps: 5, 10, 15, ...), and
 *      main_total = round_currency(gbp_price * cf_carat_total). Also writes the
 *      live exchange rate back onto each cm_jewellery_item record used (see above).
 *   4. Write gbp_price to the item's `rate` field, and main_total to
 *      cf_main_total (skipped if the item has no cf_carat_total), in the Items
 *      module - only for items that passed the status filter in step 1. Written
 *      EVERY run; the current value is never compared/skipped, since this runs
 *      daily against a live exchange rate that can genuinely round back to the
 *      same GBP price. Use --dry-run to preview without writing.
 *
 * If more than one Item Attribute record links to the same item, the most recently
 * modified record wins; conflicts are logged.
 *
 * This file is shared by two entry points, which run the sync differently:
 *   - scripts/sync-gbp-prices.js          CLI usage - calls main(), which does
 *                                         the ENTIRE catalog in one run. Fine
 *                                         here since there's no execution time
 *                                         limit on a plain `node` process.
 *   - functions/sync-gbp-prices/index.js  Zoho Catalyst Advanced I/O handler -
 *                                         calls runBatch(cursor) instead, which
 *                                         processes only ONE page (<= pageSize
 *                                         items) of ONE status value per call,
 *                                         because a serverless function has a
 *                                         hard execution time limit that a
 *                                         full-catalog run exceeds once there
 *                                         are thousands of eligible+priced
 *                                         items (confirmed in production, as
 *                                         was unbounded concurrency making
 *                                         things WORSE - see CONCURRENCY below).
 *                                         index.js self-chains through the
 *                                         `next` cursor runBatch() returns -
 *                                         after each page it fires an
 *                                         unawaited request to its own URL for
 *                                         the next page, then responds to its
 *                                         own caller immediately. So a single
 *                                         external trigger (e.g. one call a day
 *                                         from a Zoho Inventory schedule) walks
 *                                         the entire catalog via many quick,
 *                                         independent invocations chained
 *                                         together, without the external
 *                                         caller needing to loop itself. See
 *                                         index.js and runBatch()'s own doc
 *                                         comment below for the mechanics.
 *
 * ---------------------------------------------------------------------------
 * Required environment variables (self-client / server-based Zoho OAuth app):
 *   ZOHO_ORGANIZATION_ID   Zoho Inventory organization id
 *   ZOHO_CLIENT_ID
 *   ZOHO_CLIENT_SECRET
 *   ZOHO_REFRESH_TOKEN     Refresh token issued with scopes covering
 *                          ZohoInventory.items.READ, ZohoInventory.items.UPDATE and
 *                          the custom-module read scope for cm_jewellery_item.
 *   FIXER_API_KEY          API key from https://fixer.io used to fetch the live
 *                          USD->GBP exchange rate.
 *
 * Optional environment variables:
 *   ZOHO_API_DOMAIN        Default: https://www.zohoapis.eu   (Henig Diamonds is EU DC)
 *   ZOHO_ACCOUNTS_DOMAIN   Default: https://accounts.zoho.eu
 *   FIXER_API_BASE         Default: https://data.fixer.io/api
 *   ITEM_STATUS_FIELD      Items-module custom field API name read to decide whether
 *                          an item is eligible for repricing. Default: "cf_status".
 *   ITEM_STATUS_VALUES     Comma-separated list of ITEM_STATUS_FIELD values that are
 *                          eligible for a price update. Default: "Available,On Hold".
 *                          Items with any other status (or no status set) are
 *                          skipped. Add more values here (e.g. "Available,On Hold,
 *                          Reserved") without any code change.
 *   CARAT_FIELD            Items-module custom field holding the carat total used to
 *                          compute cf_main_total. Default: "cf_carat_total".
 *   MAIN_TOTAL_FIELD       Items-module custom field the computed main total is
 *                          written to. Default: "cf_main_total".
 *   EXCHANGE_RATE_FIELD    cm_jewellery_item custom field the live fixer.io rate is
 *                          written to on every record used this run. Default:
 *                          "cf_current_exchange_rate_dollar_to_gbp".
 *   ITEM_LIMIT             Cap on how many eligible items to process, for testing
 *                          (e.g. "10"). Default: 0 (no limit). When set, step 1
 *                          stops as soon as this many eligible items are found,
 *                          and step 2 looks up each one's cm_jewellery_item
 *                          record directly (via the lookup field, one call per
 *                          item) instead of bulk-fetching the whole module - the
 *                          summary's updatedSkus lists exactly which SKUs changed.
 *   CONCURRENCY            How many items' price-lookup/update calls run at once
 *                          (step 2's per-item lookups when ITEM_LIMIT is set, and
 *                          step 4's updates always; also used by runBatch()).
 *                          Default: 10. Confirmed in production that unbounded
 *                          concurrency (every item's call at once) is actively
 *                          harmful, not just unnecessary - it caused
 *                          EXECUTION_TIME_EXCEEDED even for a single ~200-item
 *                          page, almost certainly a 429 retry storm and/or
 *                          socket/memory contention from hundreds of
 *                          simultaneous requests in a memory-constrained
 *                          serverless function. 10 keeps both well-behaved;
 *                          raise it cautiously if you've confirmed it's safe
 *                          for your Zoho plan's rate limits.
 *
 * Also read directly by functions/sync-gbp-prices/index.js (not loadConfig
 * above) for the self-chaining behavior described near the top of this file:
 *   SELF_INVOKE_URL        Override for the URL index.js calls itself at for
 *                          the next hop. Default: derived from the incoming
 *                          request's own protocol/host/path, which should be
 *                          correct as-is - only set this if that's wrong in
 *                          your environment.
 *   MAX_CHAIN_HOPS         Safety cap on how many self-triggered hops one
 *                          external call is allowed to chain through, in case
 *                          `next` somehow never becomes null. Default: 200.
 *
 * CLI usage:
 *   node scripts/sync-gbp-prices.js [--dry-run]
 *     [--module=cm_jewellery_item]
 *     [--lookup-field=cf_jewellery_item]
 *     [--price-field=cf_sales_price]
 *     [--status-field=cf_status]
 *     [--carat-field=cf_carat_total]
 *     [--main-total-field=cf_main_total]
 *     [--exchange-rate-field=cf_current_exchange_rate_dollar_to_gbp]
 *     [--limit=10]
 *     [--round-to=5] [--page-size=100] [--delay-ms=250]
 *
 *   --dry-run            Compute and log what would change without writing to Zoho.
 *   --status-field       Same as ITEM_STATUS_FIELD above; this flag takes precedence
 *                        over the env var when both are set.
 *   --carat-field        Same as CARAT_FIELD above.
 *   --main-total-field   Same as MAIN_TOTAL_FIELD above.
 *   --exchange-rate-field Same as EXCHANGE_RATE_FIELD above.
 *   --limit              Same as ITEM_LIMIT above.
 *   --round-to         Round the computed GBP sales price to the nearest multiple of
 *                      this value (default: 5). Use 0 or 1 to disable rounding to
 *                      whole pounds.
 *
 * Requires Node.js 18+ (built-in fetch).
 * ---------------------------------------------------------------------------
 */

'use strict';

function parseArgs(argv) {
  const args = { dryRun: false };
  for (const raw of argv) {
    if (raw === '--dry-run') { args.dryRun = true; continue; }
    const match = /^--([a-z-]+)=(.*)$/.exec(raw);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function loadConfig() {
  const args = parseArgs(process.argv.slice(2));
  return {
    organizationId: requireEnv('ZOHO_ORGANIZATION_ID'),
    clientId: requireEnv('ZOHO_CLIENT_ID'),
    clientSecret: requireEnv('ZOHO_CLIENT_SECRET'),
    refreshToken: requireEnv('ZOHO_REFRESH_TOKEN'),
    apiDomain: (process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.eu').replace(/\/$/, ''),
    accountsDomain: (process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.eu').replace(/\/$/, ''),
    fixerApiKey: requireEnv('FIXER_API_KEY'),
    fixerApiBase: (process.env.FIXER_API_BASE || 'https://data.fixer.io/api').replace(/\/$/, ''),

    dryRun: args['dry-run'] ?? args.dryRun,
    moduleName: args.module || 'cm_jewellery_item',
    lookupField: args['lookup-field'] || 'cf_jewellery_item',
    priceField: args['price-field'] || 'cf_sales_price',
    statusField: args['status-field'] || process.env.ITEM_STATUS_FIELD || 'cf_status',
    allowedStatuses: (process.env.ITEM_STATUS_VALUES || 'Available,On Hold')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    caratField: args['carat-field'] || process.env.CARAT_FIELD || 'cf_carat_total',
    mainTotalField: args['main-total-field'] || process.env.MAIN_TOTAL_FIELD || 'cf_main_total',
    exchangeRateField: args['exchange-rate-field'] || process.env.EXCHANGE_RATE_FIELD || 'cf_current_exchange_rate_dollar_to_gbp',
    limit: Number(args.limit ?? process.env.ITEM_LIMIT ?? 0),
    // Confirmed in production: unbounded concurrency (every item's call fired
    // at once) caused EXECUTION_TIME_EXCEEDED even for a single ~200-item page -
    // likely a 429 retry storm and/or socket/memory contention from hundreds
    // of simultaneous requests in a 256MB function. 10 at a time is gentle on
    // both.
    concurrency: Number(args.concurrency ?? process.env.CONCURRENCY ?? 10),
    roundTo: Number(args['round-to'] ?? 5),
    pageSize: Number(args['page-size'] ?? process.env.PAGE_SIZE ?? 100),
    delayMs: Number(args['delay-ms'] ?? 250),
    // Confirmed in production: Zoho returns {"code":44,"message":"...exceeded
    // the maximum number of requests per minute that can originate from an
    // organization."} once the ORG (not just this script) crosses its own
    // per-minute request cap. Pausing every requestsPerBreak calls keeps the
    // whole run's throughput under that cap instead of bursting as fast as
    // possible.
    requestsPerBreak: Number(args['requests-per-break'] ?? process.env.REQUESTS_PER_BREAK ?? 100),
    breakMs: Number(args['break-ms'] ?? process.env.BREAK_MS ?? 25000),
  };
}

let totalApiCalls = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Runs worker(item) over items with at most `concurrency` in flight at once
// (0 or falsy means unbounded - run every item at once), preserving each
// result at its original index. A modest bounded concurrency (default 10) is
// what actually keeps a run inside a serverless function's execution time
// limit - confirmed in production that unbounded (firing hundreds of
// requests at once) made things WORSE, not better, triggering
// EXECUTION_TIME_EXCEEDED even for a single ~200-item page.
async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runNext() {
    for (;;) {
      const index = nextIndex++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }
  const workers = concurrency > 0 ? Math.min(concurrency, items.length) : items.length;
  await Promise.all(Array.from({ length: workers }, runNext));
  return results;
}

function roundToNearest(value, multiple) {
  if (!multiple || multiple <= 0) return value;
  return Math.round(value / multiple) * multiple;
}

function roundCurrency(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Module-scope (not per-ZohoClient-instance) so the token survives across
// invocations on the same warm container. runBatch() creates a brand new
// ZohoClient on every call - one per page/hop - so an instance-level cache
// bought nothing: every single hop was refreshing the OAuth token from
// scratch. Confirmed in production: running enough hops in quick succession
// this way tripped Zoho's own abuse lockout on the refresh_token endpoint
// ("You have made too many requests continuously"), independent of which
// mechanism (Catalyst self-chain or an external Deluge loop) drives the
// hops - access tokens are valid for ~1 hour and should be reused, not
// refreshed per call.
let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;

class ZohoClient {
  constructor(config) {
    this.config = config;
  }

  async getAccessToken() {
    if (cachedAccessToken && Date.now() < cachedAccessTokenExpiresAt) {
      return cachedAccessToken;
    }
    const { accountsDomain, clientId, clientSecret, refreshToken } = this.config;
    const url = new URL(`${accountsDomain}/oauth/v2/token`);
    url.searchParams.set('refresh_token', refreshToken);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('client_secret', clientSecret);
    url.searchParams.set('grant_type', 'refresh_token');

    const res = await fetch(url, { method: 'POST' });
    const body = await res.json();
    if (!res.ok || !body.access_token) {
      throw new Error(`Failed to refresh Zoho access token: ${JSON.stringify(body)}`);
    }
    cachedAccessToken = body.access_token;
    // Refresh a little early to avoid edge-of-expiry failures mid-run.
    cachedAccessTokenExpiresAt = Date.now() + (Number(body.expires_in || 3600) - 60) * 1000;
    return cachedAccessToken;
  }

  async request(path, { method = 'GET', query = {}, body } = {}, attempt = 1) {
    totalApiCalls += 1;
    if (totalApiCalls % this.config.requestsPerBreak === 0) {
      console.log(`[throttle] ${totalApiCalls} API call(s) made - pausing ${this.config.breakMs}ms to stay under the org's per-minute request cap.`);
      await sleep(this.config.breakMs);
    }

    const token = await this.getAccessToken();
    const url = new URL(`${this.config.apiDomain}/inventory/v1/${path}`);
    url.searchParams.set('organization_id', this.config.organizationId);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, value);
    }

    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Zoho-oauthtoken ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 429 && attempt <= 5) {
      const retryAfter = Number(res.headers.get('retry-after') || 2) * 1000;
      await sleep(retryAfter * attempt);
      return this.request(path, { method, query, body }, attempt + 1);
    }

    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Non-JSON response from ${method} ${path}: ${text.slice(0, 500)}`);
    }

    // code 44: org-wide "exceeded the maximum number of requests per minute"
    // lockout - confirmed in production. Distinct from the per-request 429
    // above; back off much longer since this is a whole-organization cooldown,
    // not a single endpoint's rate limit.
    if (json.code === 44 && attempt <= 5) {
      console.log(`[throttle] org-level rate limit hit (code 44) on attempt ${attempt} - backing off ${attempt * 60}s.`);
      await sleep(attempt * 60000);
      return this.request(path, { method, query, body }, attempt + 1);
    }

    if (!res.ok || (typeof json.code === 'number' && json.code !== 0)) {
      throw new Error(`Zoho API error on ${method} ${path}: ${JSON.stringify(json)}`);
    }
    return json;
  }

  async listAllCustomModuleRecords(moduleName, perPage) {
    const records = [];
    let page = 1;
    for (;;) {
      const json = await this.request(moduleName, {
        query: { page, per_page: perPage, sort_column: 'last_modified_time', sort_order: 'D' },
      });
      const pageRecords = json.module_records || json[moduleName] || [];
      records.push(...pageRecords);
      const hasMore = json.page_context && json.page_context.has_more_page;
      if (!hasMore) break;
      page += 1;
      await sleep(this.config.delayMs);
    }
    return records;
  }

  async listItemsByStatus(statusField, statusValue, perPage, limit) {
    const items = [];
    let page = 1;
    for (;;) {
      const json = await this.request('items', {
        query: { page, per_page: perPage, [statusField]: statusValue },
      });
      const pageItems = json.items || [];
      items.push(...pageItems);
      if (limit && items.length >= limit) return items.slice(0, limit);
      const hasMore = json.page_context && json.page_context.has_more_page;
      if (!hasMore) break;
      page += 1;
      await sleep(this.config.delayMs);
    }
    return items;
  }

  // Fetches exactly one page - used by runBatch() so a single HTTP call to the
  // Catalyst function only ever does a small, fast, bounded amount of work
  // (see runBatch's doc comment for why).
  async listItemsByStatusPage(statusField, statusValue, page, perPage) {
    const json = await this.request('items', {
      query: { page, per_page: perPage, [statusField]: statusValue },
    });
    const items = json.items || [];
    const hasMore = !!(json.page_context && json.page_context.has_more_page);
    return { items, hasMore };
  }

  // Looks up the single most-recently-modified custom module record whose
  // lookup field matches lookupValue, via the same direct field filter used
  // for cf_status. Used for --limit runs so we don't have to bulk-fetch the
  // whole module just to find a handful of specific items' records.
  async findCustomModuleRecordByLookup(moduleName, lookupField, lookupValue) {
    const json = await this.request(moduleName, {
      query: { per_page: 1, [lookupField]: lookupValue, sort_column: 'last_modified_time', sort_order: 'D' },
    });
    const records = json.module_records || json[moduleName] || [];
    return records[0] || null;
  }

  async updateItem(itemId, body) {
    return this.request(`items/${itemId}`, {
      method: 'PUT',
      body,
    });
  }

  async updateCustomModuleRecord(moduleName, recordId, body) {
    return this.request(`${moduleName}/${recordId}`, {
      method: 'PUT',
      body,
    });
  }
}

async function fetchFixerUsdToGbpRate(config) {
  const url = new URL(`${config.fixerApiBase}/latest`);
  url.searchParams.set('access_key', config.fixerApiKey);
  url.searchParams.set('base', 'GBP');
  url.searchParams.set('symbols', 'USD');

  const res = await fetch(url);
  const body = await res.json();
  if (!res.ok || !body.success) {
    throw new Error(`fixer.io API error: ${JSON.stringify(body.error || body)}`);
  }

  // rates.USD is "USD per 1 GBP" (base=GBP), so invert it to convert a USD
  // price into GBP: gbpPrice = usdPrice / usdPerGbp.
  const usdPerGbp = toNumber((body.rates || {}).USD);
  if (!usdPerGbp) {
    throw new Error(`fixer.io response missing USD rate: ${JSON.stringify(body)}`);
  }
  return 1 / usdPerGbp;
}

function pickLatestPerItem(records, config, exchangeRate) {
  const byItem = new Map();
  for (const record of records) {
    const itemId = record[config.lookupField];
    if (!itemId) continue;

    const usdPrice = toNumber(record[config.priceField]);
    if (usdPrice === null || usdPrice <= 0) continue;

    const gbpPrice = roundToNearest(usdPrice * exchangeRate, config.roundTo);

    const candidate = {
      itemId,
      recordId: record.module_record_id,
      recordName: record.record_name,
      usdPrice,
      exchangeRate,
      gbpPrice,
      lastModified: record.last_modified_time || record.created_time || '',
    };

    const existing = byItem.get(itemId);
    if (!existing) {
      byItem.set(itemId, candidate);
      continue;
    }
    if (candidate.lastModified > existing.lastModified) {
      if (existing.gbpPrice !== candidate.gbpPrice) {
        console.warn(
          `[conflict] item ${itemId}: record ${existing.recordId} (£${existing.gbpPrice}) ` +
          `superseded by more recent record ${candidate.recordId} (£${candidate.gbpPrice})`
        );
      }
      byItem.set(itemId, candidate);
    }
  }
  return byItem;
}

async function main() {
  const config = loadConfig();
  const client = new ZohoClient(config);

  // Step 1: fetch items based on status (bulk, paginated - gives us each
  // eligible item's current name/rate too, so no per-item GET is needed later).
  // When --limit is set, stop as soon as that many eligible items are found.
  console.log(
    `Fetching items with ${config.statusField} in [${config.allowedStatuses.join(', ')}]` +
    (config.limit ? ` (limit ${config.limit})` : '') + '...'
  );
  const eligibleItems = new Map();
  for (const status of config.allowedStatuses) {
    if (config.limit && eligibleItems.size >= config.limit) break;
    const remaining = config.limit ? config.limit - eligibleItems.size : 0;
    const items = await client.listItemsByStatus(config.statusField, status, config.pageSize, remaining);
    console.log(`  ${status}: ${items.length} item(s)`);
    for (const item of items) {
      if (config.limit && eligibleItems.size >= config.limit) break;
      eligibleItems.set(item.item_id, {
        name: item.name,
        sku: item.sku,
        rate: toNumber(item.rate) ?? 0,
        status,
        caratTotal: toNumber(item[config.caratField]),
      });
    }
  }
  console.log(`${eligibleItems.size} eligible item(s) total.`);
  const eligibleSkus = [...eligibleItems.values()].map((i) => i.sku);
  console.log(`Eligible SKUs: ${eligibleSkus.join(', ') || '(none)'}`);

  // Step 2: get the USD ("dollar") price for each item from the linked
  // cm_jewellery_item ("Item Attributes") record. For a --limit run, look up
  // each eligible item's record directly instead of bulk-fetching the whole
  // module (which could be many thousands of records).
  let records;
  if (config.limit) {
    console.log(
      `Looking up "${config.moduleName}" records for ${eligibleItems.size} item(s) ` +
      `(concurrency ${config.concurrency || 'unbounded'})...`
    );
    const found = await mapWithConcurrency([...eligibleItems], config.concurrency, async ([itemId, item]) => {
      const record = await client.findCustomModuleRecordByLookup(config.moduleName, config.lookupField, itemId);
      console.log(
        `  SKU ${item.sku} (item ${itemId}): ` +
        (record ? `record ${record.module_record_id} found, cf_sales_price="${record[config.priceField]}"` : 'NO matching cm_jewellery_item record')
      );
      return record;
    });
    records = found.filter(Boolean);
  } else {
    console.log(
      `Fetching "${config.moduleName}" records (price field: ${config.priceField})...`
    );
    records = await client.listAllCustomModuleRecords(config.moduleName, config.pageSize);
  }
  console.log(`Fetched ${records.length} record(s).`);

  // Step 3: compute the GBP price for each item (also resolves conflicts when
  // more than one record links to the same item).
  const exchangeRate = await fetchFixerUsdToGbpRate(config);
  console.log(`Live USD->GBP exchange rate from fixer.io: ${exchangeRate}`);
  const updatesByItem = pickLatestPerItem(records, config, exchangeRate);
  console.log(`${updatesByItem.size} distinct item(s) have a computable GBP price.`);

  const summary = {
    exchangeRate,
    eligibleItems: eligibleItems.size,
    eligibleSkus,
    scanned: updatesByItem.size,
    updated: 0,
    skippedNotEligible: 0,
    errors: 0,
    updatedSkus: [],
    exchangeRateRecordsUpdated: 0,
    exchangeRateRecordErrors: 0,
  };

  // Step 3b: write the live exchange rate back onto every cm_jewellery_item
  // record used above, regardless of the linked item's status eligibility -
  // it documents what rate this record's price was last converted with. Runs
  // independently of (and concurrently with) step 4's item updates below.
  const exchangeRateWrites = mapWithConcurrency([...updatesByItem.values()], config.concurrency, async (update) => {
    if (config.dryRun) {
      console.log(`[dry-run] would set ${config.exchangeRateField}=${exchangeRate} on record ${update.recordId}`);
      summary.exchangeRateRecordsUpdated += 1;
      return;
    }
    try {
      await client.updateCustomModuleRecord(config.moduleName, update.recordId, {
        record_name: update.recordName,
        [config.exchangeRateField]: exchangeRate,
      });
      summary.exchangeRateRecordsUpdated += 1;
    } catch (err) {
      console.error(`[error] failed to set ${config.exchangeRateField} on record ${update.recordId}: ${err.message}`);
      summary.exchangeRateRecordErrors += 1;
    }
  });

  // Step 4: update the rate in the Items module, only for items that passed
  // the status filter in step 1. Runs with bounded concurrency (see
  // mapWithConcurrency) rather than one item at a time, to stay inside a
  // serverless function's execution time limit.
  await mapWithConcurrency([...updatesByItem.values()], config.concurrency, async (update) => {
    const item = eligibleItems.get(update.itemId);
    if (!item) {
      summary.skippedNotEligible += 1;
      return;
    }

    // cf_main_total = rate * carat total (confirmed against a live item:
    // rate 2045 x cf_carat_total 1.01 = cf_main_total 2065.45).
    const mainTotal = item.caratTotal !== null ? roundCurrency(update.gbpPrice * item.caratTotal) : null;
    if (item.caratTotal === null) {
      console.warn(
        `[warn] item ${update.itemId} (${item.name}) has no ${config.caratField}; ` +
        `leaving ${config.mainTotalField} untouched.`
      );
    }

    const line =
      `item ${update.itemId} (${item.name}, SKU ${item.sku}): USD ${update.usdPrice} x ${update.exchangeRate} ` +
      `= £${update.gbpPrice} (current £${item.rate}, status "${item.status}")` +
      (mainTotal !== null ? `, ${config.mainTotalField} -> £${mainTotal}` : '');

    if (config.dryRun) {
      console.log(`[dry-run] would update ${line}`);
      summary.updated += 1;
      summary.updatedSkus.push(item.sku);
      return;
    }

    const body = { name: item.name, rate: update.gbpPrice };
    if (mainTotal !== null) {
      body.custom_fields = [{ api_name: config.mainTotalField, value: mainTotal }];
    }

    try {
      await client.updateItem(update.itemId, body);
      console.log(`[updated] ${line}`);
      summary.updated += 1;
      summary.updatedSkus.push(item.sku);
    } catch (err) {
      console.error(`[error] failed to update item ${update.itemId}: ${err.message}`);
      summary.errors += 1;
    }
  });

  await exchangeRateWrites;

  console.log('\nSummary:', summary);
  return summary;
}

// runBatch() processes exactly ONE page (<= pageSize items) of ONE status
// value, then returns. It exists because main() - which processes the whole
// catalog in one call - cannot finish inside a serverless function's
// execution time limit (confirmed in production: EXECUTION_TIME_EXCEEDED /
// a 408 from the caller) once there are thousands of eligible+priced items.
//
// This function itself does NOT loop or chain - it's deliberately just "do
// one bounded page." The chaining (triggering the next page, repeating until
// `next` is null) is index.js's job: it self-invokes with the returned
// cursor after each call. That split is what lets a single external trigger
// (one call a day from Zoho Inventory) walk the whole catalog without that
// external caller needing any looping logic of its own - every individual
// HTTP call, whether the first or the two-hundredth, only ever does a small,
// bounded amount of work (one page's worth of lookups/updates, run
// concurrently) and finishes well inside the execution time limit.
//
// cursor: { statusIndex, page, exchangeRate }
//   - statusIndex: which entry in config.allowedStatuses to read from.
//   - page: which page (of config.pageSize items) within that status.
//   - exchangeRate: the rate to reuse for this whole run (fetched fresh on
//     the first call when omitted, then passed through on every subsequent
//     call so the entire day's run converts at one consistent rate instead
//     of a slightly different one on every page).
async function runBatch(cursor = {}) {
  const config = loadConfig();
  const client = new ZohoClient(config);

  const statusIndex = Number(cursor.statusIndex ?? 0);
  const page = Number(cursor.page ?? 1);
  const exchangeRate = cursor.exchangeRate ? Number(cursor.exchangeRate) : await fetchFixerUsdToGbpRate(config);

  const statusValue = config.allowedStatuses[statusIndex];
  const summary = {
    exchangeRate,
    statusValue: statusValue || null,
    statusIndex,
    page,
    scanned: 0,
    updated: 0,
    skippedNotEligible: 0,
    errors: 0,
    updatedSkus: [],
    exchangeRateRecordsUpdated: 0,
    exchangeRateRecordErrors: 0,
  };

  if (!statusValue) {
    console.log('[batch] no more statuses to process - done.');
    return { summary, next: null };
  }

  console.log(`[batch] status="${statusValue}" (index ${statusIndex}) page=${page}, exchangeRate=${exchangeRate}`);
  const { items, hasMore } = await client.listItemsByStatusPage(config.statusField, statusValue, page, config.pageSize);
  console.log(`[batch] fetched ${items.length} item(s) (hasMore=${hasMore})`);

  const eligibleItems = new Map();
  for (const item of items) {
    eligibleItems.set(item.item_id, {
      name: item.name,
      sku: item.sku,
      rate: toNumber(item.rate) ?? 0,
      status: statusValue,
      caratTotal: toNumber(item[config.caratField]),
    });
  }

  if (eligibleItems.size > 0) {
    const found = await mapWithConcurrency([...eligibleItems], config.concurrency, async ([itemId]) =>
      client.findCustomModuleRecordByLookup(config.moduleName, config.lookupField, itemId)
    );
    const records = found.filter(Boolean);
    summary.scanned = records.length;

    const updatesByItem = pickLatestPerItem(records, config, exchangeRate);

    const exchangeRateWrites = mapWithConcurrency([...updatesByItem.values()], config.concurrency, async (update) => {
      if (config.dryRun) {
        summary.exchangeRateRecordsUpdated += 1;
        return;
      }
      try {
        await client.updateCustomModuleRecord(config.moduleName, update.recordId, {
          record_name: update.recordName,
          [config.exchangeRateField]: exchangeRate,
        });
        summary.exchangeRateRecordsUpdated += 1;
      } catch (err) {
        console.error(`[error] failed to set ${config.exchangeRateField} on record ${update.recordId}: ${err.message}`);
        summary.exchangeRateRecordErrors += 1;
      }
    });

    await mapWithConcurrency([...updatesByItem.values()], config.concurrency, async (update) => {
      const item = eligibleItems.get(update.itemId);
      if (!item) {
        summary.skippedNotEligible += 1;
        return;
      }

      const mainTotal = item.caratTotal !== null ? roundCurrency(update.gbpPrice * item.caratTotal) : null;
      const line =
        `item ${update.itemId} (${item.name}, SKU ${item.sku}): USD ${update.usdPrice} x ${update.exchangeRate} ` +
        `= £${update.gbpPrice} (current £${item.rate}, status "${item.status}")` +
        (mainTotal !== null ? `, ${config.mainTotalField} -> £${mainTotal}` : '');

      if (config.dryRun) {
        console.log(`[batch][dry-run] would update ${line}`);
        summary.updated += 1;
        summary.updatedSkus.push(item.sku);
        return;
      }

      const body = { name: item.name, rate: update.gbpPrice };
      if (mainTotal !== null) {
        body.custom_fields = [{ api_name: config.mainTotalField, value: mainTotal }];
      }

      try {
        await client.updateItem(update.itemId, body);
        console.log(`[batch][updated] ${line}`);
        summary.updated += 1;
        summary.updatedSkus.push(item.sku);
      } catch (err) {
        console.error(`[error] failed to update item ${update.itemId}: ${err.message}`);
        summary.errors += 1;
      }
    });

    await exchangeRateWrites;
  }

  const next = hasMore
    ? { statusIndex, page: page + 1, exchangeRate }
    : statusIndex + 1 < config.allowedStatuses.length
      ? { statusIndex: statusIndex + 1, page: 1, exchangeRate }
      : null;

  console.log('[batch] summary:', summary, 'next:', next);
  return { summary, next };
}

module.exports = { main, runBatch };
