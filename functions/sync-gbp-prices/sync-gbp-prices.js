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
 *      main_total = round_currency(gbp_price * cf_carat_total).
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
 * This file is shared by two entry points:
 *   - scripts/sync-gbp-prices.js       CLI usage (node scripts/sync-gbp-prices.js ...)
 *   - functions/sync-gbp-prices/index.js  Zoho Catalyst Advanced I/O function handler
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
 *   ITEM_LIMIT             Cap on how many eligible items to process, for testing
 *                          (e.g. "10"). Default: 0 (no limit). When set, step 1
 *                          stops as soon as this many eligible items are found,
 *                          and step 2 looks up each one's cm_jewellery_item
 *                          record directly (via the lookup field, one call per
 *                          item) instead of bulk-fetching the whole module - the
 *                          summary's updatedSkus lists exactly which SKUs changed.
 *
 * CLI usage:
 *   node scripts/sync-gbp-prices.js [--dry-run]
 *     [--module=cm_jewellery_item]
 *     [--lookup-field=cf_jewellery_item]
 *     [--price-field=cf_sales_price]
 *     [--status-field=cf_status]
 *     [--carat-field=cf_carat_total]
 *     [--main-total-field=cf_main_total]
 *     [--limit=10]
 *     [--round-to=5] [--page-size=200] [--delay-ms=250]
 *
 *   --dry-run          Compute and log what would change without writing to Zoho.
 *   --status-field     Same as ITEM_STATUS_FIELD above; this flag takes precedence
 *                      over the env var when both are set.
 *   --carat-field      Same as CARAT_FIELD above.
 *   --main-total-field Same as MAIN_TOTAL_FIELD above.
 *   --limit            Same as ITEM_LIMIT above.
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
    limit: Number(args.limit ?? process.env.ITEM_LIMIT ?? 0),
    roundTo: Number(args['round-to'] ?? 5),
    pageSize: Number(args['page-size'] ?? 200),
    delayMs: Number(args['delay-ms'] ?? 250),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

class ZohoClient {
  constructor(config) {
    this.config = config;
    this.accessToken = null;
    this.accessTokenExpiresAt = 0;
  }

  async getAccessToken() {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) {
      return this.accessToken;
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
    this.accessToken = body.access_token;
    // Refresh a little early to avoid edge-of-expiry failures mid-run.
    this.accessTokenExpiresAt = Date.now() + (Number(body.expires_in || 3600) - 60) * 1000;
    return this.accessToken;
  }

  async request(path, { method = 'GET', query = {}, body } = {}, attempt = 1) {
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
    console.log(`Looking up "${config.moduleName}" records for ${eligibleItems.size} item(s)...`);
    records = [];
    for (const [itemId, item] of eligibleItems) {
      const record = await client.findCustomModuleRecordByLookup(config.moduleName, config.lookupField, itemId);
      console.log(
        `  SKU ${item.sku} (item ${itemId}): ` +
        (record ? `record ${record.module_record_id} found, cf_sales_price="${record[config.priceField]}"` : 'NO matching cm_jewellery_item record')
      );
      if (record) records.push(record);
      await sleep(config.delayMs);
    }
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
  };

  // Step 4: update the rate in the Items module, only for items that passed
  // the status filter in step 1.
  for (const update of updatesByItem.values()) {
    const item = eligibleItems.get(update.itemId);
    if (!item) {
      summary.skippedNotEligible += 1;
      continue;
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
      continue;
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

    await sleep(config.delayMs);
  }

  console.log('\nSummary:', summary);
  return summary;
}

module.exports = { main };
