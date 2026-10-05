/**
 * sync-gbp-prices-crm.js
 *
 * Same logic as functions/sync-gbp-prices/sync-gbp-prices.js (the Zoho Inventory
 * version), applied to Zoho CRM instead. In CRM everything lives on ONE module -
 * the Products module - rather than being split across Items + cm_jewellery_item,
 * so there's no separate lookup/matching step: the USD price is read and the GBP
 * price is written on the exact same record.
 *
 * Products module field mapping (confirmed via ZohoCRM_getFields against the live
 * "Henig Diamonds" CRM):
 *   - Status                              picklist, values include "Available",
 *                                          "On Hold", "Sold", "Rejected", etc. -
 *                                          same role as Inventory's cf_status.
 *   - Sales_Price                         "Selling Price ($)" - the USD price.
 *   - Unit_Price                          "Selling Price (GBP)" - the field this
 *                                          script writes the converted price to.
 *   - Carats_Units_Total                  carat/unit total, used for Main_Total.
 *   - Main_Total                          "Selling Total (GBP)" = Unit_Price *
 *                                          Carats_Units_Total.
 *   - Current_Rate_USD_to_GBP             text field; the live exchange rate used
 *                                          is written here every run.
 *   - Product_Code / Product_Name         identifiers, used for logging only.
 *
 * The USD->GBP exchange rate is fetched live from the fixer.io API, exactly as in
 * the Inventory version (base=GBP, symbols=USD, inverted since the response gives
 * "USD per £1").
 *
 * Steps, in order:
 *   1. Query Products via COQL for records whose Status is one of
 *      ITEM_STATUS_VALUES and whose Sales_Price is set and > 0 - this single
 *      server-side query replaces Inventory's separate "fetch eligible items"
 *      and "fetch USD price" steps, since both live on the same record here.
 *   2. Compute gbp_price = round_to_nearest(sales_price * exchange_rate, ROUND_TO)
 *      and main_total = round_currency(gbp_price * carats_units_total).
 *   3. Bulk-update Products: Unit_Price, Main_Total (skipped if no carat total),
 *      and Current_Rate_USD_to_GBP, in batches of up to 100 records per Zoho CRM
 *      API call (CRM's record update endpoint accepts an array of up to 100).
 *      Written EVERY run, same as the Inventory version - never skipped as
 *      "unchanged". Use --dry-run to preview without writing.
 *
 * NOTE: COQL's offset-based pagination is only reliable up to ~2000 records per
 * query in Zoho CRM. If your Products catalog has more eligible+priced records
 * than that, this will need an additional partitioning strategy (e.g. querying
 * by Modified_Time windows) - not implemented here since it wasn't needed for
 * the Inventory org's current scale.
 *
 * This file is shared by two entry points:
 *   - scripts/sync-gbp-prices-crm.js           CLI usage
 *   - functions/sync-gbp-prices-crm/index.js   Zoho Catalyst Advanced I/O handler
 *
 * ---------------------------------------------------------------------------
 * Required environment variables (self-client / server-based Zoho OAuth app):
 *   ZOHO_CRM_CLIENT_ID
 *   ZOHO_CRM_CLIENT_SECRET
 *   ZOHO_CRM_REFRESH_TOKEN     Refresh token issued with scopes covering reading
 *                              and updating the Products module and running COQL
 *                              queries, e.g.:
 *                                ZohoCRM.modules.products.READ,
 *                                ZohoCRM.modules.products.UPDATE,
 *                                ZohoCRM.coql.READ
 *                              If that's insufficient, fall back to the broader
 *                              ZohoCRM.modules.ALL,ZohoCRM.coql.READ.
 *   FIXER_API_KEY              API key from https://fixer.io used to fetch the
 *                              live USD->GBP exchange rate.
 *
 * Optional environment variables:
 *   ZOHO_CRM_API_DOMAIN        Default: https://www.zohoapis.eu
 *   ZOHO_CRM_ACCOUNTS_DOMAIN   Default: https://accounts.zoho.eu
 *   ZOHO_CRM_API_VERSION       Default: v2
 *   FIXER_API_BASE             Default: https://data.fixer.io/api
 *   CRM_MODULE                 Default: "Products"
 *   CRM_STATUS_FIELD           Default: "Status"
 *   ITEM_STATUS_VALUES         Comma-separated list of Status values eligible for
 *                              a price update. Default: "Available,On Hold".
 *   CRM_PRICE_FIELD            Default: "Sales_Price" (USD source field)
 *   CRM_RATE_FIELD             Default: "Unit_Price" (GBP target field)
 *   CRM_CARAT_FIELD            Default: "Carats_Units_Total"
 *   CRM_MAIN_TOTAL_FIELD       Default: "Main_Total"
 *   CRM_EXCHANGE_RATE_FIELD    Default: "Current_Rate_USD_to_GBP"
 *   CRM_SKU_FIELD              Default: "Product_Code"
 *   CRM_NAME_FIELD             Default: "Product_Name"
 *   ITEM_LIMIT                 Cap on how many eligible+priced records to process,
 *                              for testing. Default: 0 (no limit) - applied as a
 *                              COQL LIMIT clause directly in the query.
 *   CONCURRENCY                How many 100-record update batches run at once.
 *                              Default: 0, meaning unbounded (all batches fire at
 *                              once); request()'s 429 retry/backoff absorbs rate
 *                              limiting. Set a positive number to cap it.
 *
 * CLI usage:
 *   node scripts/sync-gbp-prices-crm.js [--dry-run]
 *     [--module=Products] [--status-field=Status] [--price-field=Sales_Price]
 *     [--rate-field=Unit_Price] [--carat-field=Carats_Units_Total]
 *     [--main-total-field=Main_Total]
 *     [--exchange-rate-field=Current_Rate_USD_to_GBP]
 *     [--sku-field=Product_Code] [--name-field=Product_Name]
 *     [--limit=10] [--round-to=5] [--page-size=200] [--delay-ms=250]
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
    clientId: requireEnv('ZOHO_CRM_CLIENT_ID'),
    clientSecret: requireEnv('ZOHO_CRM_CLIENT_SECRET'),
    refreshToken: requireEnv('ZOHO_CRM_REFRESH_TOKEN'),
    apiDomain: (process.env.ZOHO_CRM_API_DOMAIN || 'https://www.zohoapis.eu').replace(/\/$/, ''),
    accountsDomain: (process.env.ZOHO_CRM_ACCOUNTS_DOMAIN || 'https://accounts.zoho.eu').replace(/\/$/, ''),
    apiVersion: process.env.ZOHO_CRM_API_VERSION || 'v2',
    fixerApiKey: requireEnv('FIXER_API_KEY'),
    fixerApiBase: (process.env.FIXER_API_BASE || 'https://data.fixer.io/api').replace(/\/$/, ''),

    dryRun: args['dry-run'] ?? args.dryRun,
    moduleName: args.module || process.env.CRM_MODULE || 'Products',
    statusField: args['status-field'] || process.env.CRM_STATUS_FIELD || 'Status',
    allowedStatuses: (process.env.ITEM_STATUS_VALUES || 'Available,On Hold')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    priceField: args['price-field'] || process.env.CRM_PRICE_FIELD || 'Sales_Price',
    rateField: args['rate-field'] || process.env.CRM_RATE_FIELD || 'Unit_Price',
    caratField: args['carat-field'] || process.env.CRM_CARAT_FIELD || 'Carats_Units_Total',
    mainTotalField: args['main-total-field'] || process.env.CRM_MAIN_TOTAL_FIELD || 'Main_Total',
    exchangeRateField: args['exchange-rate-field'] || process.env.CRM_EXCHANGE_RATE_FIELD || 'Current_Rate_USD_to_GBP',
    skuField: args['sku-field'] || process.env.CRM_SKU_FIELD || 'Product_Code',
    nameField: args['name-field'] || process.env.CRM_NAME_FIELD || 'Product_Name',
    limit: Number(args.limit ?? process.env.ITEM_LIMIT ?? 0),
    concurrency: Number(args.concurrency ?? process.env.CONCURRENCY ?? 0),
    roundTo: Number(args['round-to'] ?? 5),
    pageSize: Number(args['page-size'] ?? 200),
    delayMs: Number(args['delay-ms'] ?? 250),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Same bounded-concurrency runner as the Inventory version - 0/falsy means
// unbounded (every batch fires at once).
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

// Escapes a value for safe use inside a single-quoted COQL string literal.
function coqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

class CrmClient {
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
    this.accessTokenExpiresAt = Date.now() + (Number(body.expires_in || 3600) - 60) * 1000;
    return this.accessToken;
  }

  async request(path, { method = 'GET', body } = {}, attempt = 1) {
    const token = await this.getAccessToken();
    const url = `${this.config.apiDomain}/crm/${this.config.apiVersion}/${path}`;

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
      return this.request(path, { method, body }, attempt + 1);
    }

    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Non-JSON response from ${method} ${path}: ${text.slice(0, 500)}`);
    }

    if (!res.ok) {
      throw new Error(`Zoho CRM API error on ${method} ${path}: ${JSON.stringify(json)}`);
    }
    return json;
  }

  // Fetches eligible+priced records in one place via COQL, replacing both the
  // "fetch eligible items" and "fetch USD price" steps from the Inventory
  // version, since both live on the same Products record here.
  async queryEligibleProducts(config) {
    const fields = [
      'id', config.nameField, config.skuField, config.priceField,
      config.rateField, config.caratField, config.statusField,
    ];
    const statusList = config.allowedStatuses.map(coqlString).join(', ');
    const whereClause = `${config.statusField} in (${statusList}) and ${config.priceField} > 0`;

    const records = [];
    let offset = 0;
    for (;;) {
      const pageLimit = config.limit ? Math.min(config.pageSize, config.limit - records.length) : config.pageSize;
      if (config.limit && pageLimit <= 0) break;

      const query = `select ${fields.join(', ')} from ${config.moduleName} where ${whereClause} limit ${pageLimit} offset ${offset}`;
      const json = await this.request('coql', { method: 'POST', body: { select_query: query } });
      const pageRecords = json.data || [];
      records.push(...pageRecords);

      if (config.limit && records.length >= config.limit) return records.slice(0, config.limit);
      if (!json.info || !json.info.more_records) break;
      offset += pageRecords.length;
      await sleep(config.delayMs);
    }
    return records;
  }

  // Zoho CRM's record update endpoint accepts an array of up to 100 records
  // per call, so batches - not individual per-record PUTs - do the writing.
  async updateProductsBatch(moduleName, batch) {
    return this.request(moduleName, { method: 'PUT', body: { data: batch } });
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

  const usdPerGbp = toNumber((body.rates || {}).USD);
  if (!usdPerGbp) {
    throw new Error(`fixer.io response missing USD rate: ${JSON.stringify(body)}`);
  }
  return 1 / usdPerGbp;
}

async function main() {
  const config = loadConfig();
  const client = new CrmClient(config);

  // Step 1: query eligible, priced Products in one COQL call (per page).
  console.log(
    `Querying ${config.moduleName} where ${config.statusField} in [${config.allowedStatuses.join(', ')}] ` +
    `and ${config.priceField} > 0` + (config.limit ? ` (limit ${config.limit})` : '') + '...'
  );
  const records = await client.queryEligibleProducts(config);
  console.log(`${records.length} eligible, priced record(s) found.`);
  const eligibleSkus = records.map((r) => r[config.skuField]);
  console.log(`SKUs: ${eligibleSkus.join(', ') || '(none)'}`);

  // Step 2: compute gbp_price and main_total for each record.
  const exchangeRate = await fetchFixerUsdToGbpRate(config);
  console.log(`Live USD->GBP exchange rate from fixer.io: ${exchangeRate}`);

  const summary = {
    exchangeRate,
    scanned: records.length,
    eligibleSkus,
    updated: 0,
    errors: 0,
    updatedSkus: [],
  };

  const computed = records.map((record) => {
    const usdPrice = toNumber(record[config.priceField]);
    const caratTotal = toNumber(record[config.caratField]);
    const gbpPrice = roundToNearest(usdPrice * exchangeRate, config.roundTo);
    const mainTotal = caratTotal !== null ? roundCurrency(gbpPrice * caratTotal) : null;
    if (caratTotal === null) {
      console.warn(
        `[warn] record ${record.id} (${record[config.skuField]}) has no ${config.caratField}; ` +
        `leaving ${config.mainTotalField} untouched.`
      );
    }
    return { record, usdPrice, caratTotal, gbpPrice, mainTotal };
  });

  // Step 3: write rate/main_total/exchange_rate back, in batches of up to 100
  // records per Zoho CRM API call, batches running with bounded concurrency.
  const batches = [];
  for (let i = 0; i < computed.length; i += 100) {
    batches.push(computed.slice(i, i + 100));
  }

  await mapWithConcurrency(batches, config.concurrency, async (batch) => {
    const payload = batch.map(({ record, gbpPrice, mainTotal }) => {
      const entry = {
        id: record.id,
        [config.rateField]: gbpPrice,
        [config.exchangeRateField]: String(exchangeRate),
      };
      if (mainTotal !== null) entry[config.mainTotalField] = mainTotal;
      return entry;
    });

    for (const { record, usdPrice, gbpPrice, mainTotal } of batch) {
      const line =
        `record ${record.id} (${record[config.nameField]}, SKU ${record[config.skuField]}): ` +
        `USD ${usdPrice} x ${exchangeRate} = £${gbpPrice} (current £${toNumber(record[config.rateField]) ?? 0})` +
        (mainTotal !== null ? `, ${config.mainTotalField} -> £${mainTotal}` : '');
      console.log(config.dryRun ? `[dry-run] would update ${line}` : `[updating] ${line}`);
    }

    if (config.dryRun) {
      summary.updated += batch.length;
      summary.updatedSkus.push(...batch.map(({ record }) => record[config.skuField]));
      return;
    }

    try {
      const result = await client.updateProductsBatch(config.moduleName, payload);
      const results = result.data || [];
      results.forEach((r, i) => {
        if (r.status === 'success') {
          summary.updated += 1;
          summary.updatedSkus.push(batch[i].record[config.skuField]);
        } else {
          console.error(`[error] failed to update record ${batch[i].record.id}: ${JSON.stringify(r)}`);
          summary.errors += 1;
        }
      });
    } catch (err) {
      console.error(`[error] batch update failed: ${err.message}`);
      summary.errors += batch.length;
    }
  });

  console.log('\nSummary:', summary);
  return summary;
}

module.exports = { main };
