/**
 * sync-gbp-prices-crm-staged.js
 *
 * Two-phase version of the CRM GBP sync, using a Catalyst Data Store table
 * (GbpSyncStaging) as a buffer between reading from CRM and writing back to
 * it, so each Catalyst invocation does less work and is less likely to hit
 * the ~35s EXECUTION_TIME_EXCEEDED ceiling than doing fetch+compute+write in
 * one shot (confirmed hit in production on the non-staged CRM version).
 *
 * Phase "fetch": COQL-queries eligible Products page by page (limit 200 -
 * this org's confirmed real cap, not COQL's documented 2000 max), computes
 * gbp_price/main_total for each record using one exchange rate fetched at
 * the very start of the whole run, and inserts the computed rows into
 * GbpSyncStaging (written=false). Self-chains to the next page until COQL
 * reports no more records, then moves to phase "writeback".
 *
 * Phase "writeback": reads up to WRITEBACK_BATCH (default 500) rows from
 * GbpSyncStaging where written=false, bulk-updates CRM Products in batches
 * of 100 (Zoho's hard cap for a single update call), then marks those
 * staging rows written=true. Self-chains until a hop finds 0 unwritten rows.
 *
 * Still subject to Zoho's org-level "requests per minute" cap (confirmed via
 * a code 44 error on the Inventory API, but it's an org-wide limit, not
 * specific to one Zoho product), so the same throttle used elsewhere in this
 * project (pause every REQUESTS_PER_BREAK calls) is applied here too.
 *
 * NOTE: the zcatalyst-sdk-node calls in here (catalyst.initialize(req),
 * .zcql().executeZCQLQuery(), .datastore().table().insertRow()/updateRow())
 * could not be verified outside a live Catalyst execution context - unlike
 * the rest of this project's code, which was tested locally with a mocked
 * fetch(). If a method name/shape here is wrong, the live error message
 * will say so and it can be corrected from that.
 *
 * Required environment variables (same CRM-scoped self-client as
 * crm_dollar_to_GBP / crm_dollar_to_GBP_staged):
 *   ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET, ZOHO_REFRESH_TOKEN, FIXER_API_KEY
 * Optional (defaults shown):
 *   ZOHO_API_DOMAIN=https://www.zohoapis.eu
 *   ZOHO_ACCOUNTS_DOMAIN=https://accounts.zoho.eu
 *   CRM_API_VERSION=v2
 *   FIXER_API_BASE=https://data.fixer.io/api
 *   CRM_MODULE=Products, CRM_STATUS_FIELD=Status,
 *   ITEM_STATUS_VALUES=Available,On Hold
 *   CRM_PRICE_FIELD=Sales_Price, CRM_RATE_FIELD=Unit_Price,
 *   CRM_CARAT_FIELD=Carats_Units_Total, CRM_MAIN_TOTAL_FIELD=Main_Total,
 *   CRM_EXCHANGE_RATE_FIELD=Current_Rate_USD_to_GBP,
 *   CRM_SKU_FIELD=Product_Code, CRM_NAME_FIELD=Product_Name
 *   ROUND_TO=5, FETCH_PAGE_SIZE=200, WRITEBACK_BATCH=500, CONCURRENCY=10
 *   REQUESTS_PER_BREAK=100, BREAK_MS=25000
 *   STAGING_TABLE=GbpSyncStaging
 * ---------------------------------------------------------------------------
 */

'use strict';

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function loadConfig() {
  return {
    clientId: requireEnv('ZOHO_CLIENT_ID'),
    clientSecret: requireEnv('ZOHO_CLIENT_SECRET'),
    refreshToken: requireEnv('ZOHO_REFRESH_TOKEN'),
    apiDomain: (process.env.ZOHO_API_DOMAIN || 'https://www.zohoapis.eu').replace(/\/$/, ''),
    accountsDomain: (process.env.ZOHO_ACCOUNTS_DOMAIN || 'https://accounts.zoho.eu').replace(/\/$/, ''),
    apiVersion: process.env.CRM_API_VERSION || 'v2',
    fixerApiKey: requireEnv('FIXER_API_KEY'),
    fixerApiBase: (process.env.FIXER_API_BASE || 'https://data.fixer.io/api').replace(/\/$/, ''),

    moduleName: process.env.CRM_MODULE || 'Products',
    statusField: process.env.CRM_STATUS_FIELD || 'Status',
    allowedStatuses: (process.env.ITEM_STATUS_VALUES || 'Available,On Hold')
      .split(',').map((s) => s.trim()).filter(Boolean),
    priceField: process.env.CRM_PRICE_FIELD || 'Sales_Price',
    rateField: process.env.CRM_RATE_FIELD || 'Unit_Price',
    caratField: process.env.CRM_CARAT_FIELD || 'Carats_Units_Total',
    mainTotalField: process.env.CRM_MAIN_TOTAL_FIELD || 'Main_Total',
    exchangeRateField: process.env.CRM_EXCHANGE_RATE_FIELD || 'Current_Rate_USD_to_GBP',
    skuField: process.env.CRM_SKU_FIELD || 'Product_Code',
    nameField: process.env.CRM_NAME_FIELD || 'Product_Name',

    roundTo: Number(process.env.ROUND_TO ?? 5),
    fetchPageSize: Number(process.env.FETCH_PAGE_SIZE ?? 200),
    writebackBatch: Number(process.env.WRITEBACK_BATCH ?? 500),
    concurrency: Number(process.env.CONCURRENCY ?? 10),

    requestsPerBreak: Number(process.env.REQUESTS_PER_BREAK ?? 100),
    breakMs: Number(process.env.BREAK_MS ?? 25000),

    stagingTable: process.env.STAGING_TABLE || 'GbpSyncStaging',
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function coqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

let totalApiCalls = 0;
let cachedAccessToken = null;
let cachedAccessTokenExpiresAt = 0;

class CrmClient {
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
    cachedAccessTokenExpiresAt = Date.now() + (Number(body.expires_in || 3600) - 60) * 1000;
    return cachedAccessToken;
  }

  async request(path, { method = 'GET', body } = {}, attempt = 1) {
    totalApiCalls += 1;
    if (totalApiCalls % this.config.requestsPerBreak === 0) {
      console.log(`[throttle] ${totalApiCalls} CRM API call(s) made - pausing ${this.config.breakMs}ms.`);
      await sleep(this.config.breakMs);
    }

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

    // Org-wide per-minute lockout, confirmed on the Inventory API - the cap
    // is per organization, not per product, so treat it the same way here.
    if (json.code === 44 && attempt <= 5) {
      console.log(`[throttle] org-level rate limit hit (code 44) on attempt ${attempt} - backing off ${attempt * 60}s.`);
      await sleep(attempt * 60000);
      return this.request(path, { method, body }, attempt + 1);
    }

    if (!res.ok) {
      throw new Error(`Zoho CRM API error on ${method} ${path}: ${JSON.stringify(json)}`);
    }
    return json;
  }

  async queryEligibleProductsPage(config, offset) {
    const fields = [
      'id', config.nameField, config.skuField, config.priceField,
      config.rateField, config.caratField, config.statusField,
    ];
    const statusList = config.allowedStatuses.map(coqlString).join(', ');
    const whereClause = `${config.statusField} in (${statusList}) and ${config.priceField} > 0`;
    const query = `select ${fields.join(', ')} from ${config.moduleName} where ${whereClause} limit ${offset}, ${config.fetchPageSize}`;
    const json = await this.request('coql', { method: 'POST', body: { select_query: query } });
    const records = json.data || [];
    const hasMore = !!(json.info && json.info.more_records);
    return { records, hasMore };
  }

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

// ---- Catalyst Data Store helpers (zcatalyst-sdk-node) ----
// Confirmed against the actual installed zcatalyst-sdk-node@2.5.1 type
// definitions: Table has insertRows(rowArr)/updateRows(rows) bulk methods
// (not just single-row insertRow/updateRow), and ZCQL.executeZCQLQuery(sql)
// returns one { [tableName]: {...fields} } object per row. Chunked at 200
// per call as a precaution since the SDK's own per-call cap isn't stated in
// its types; this is less certain than the rest of this file, which was
// checked directly against the library's .d.ts files.
async function stagingInsertRows(catalystApp, config, rows) {
  if (rows.length === 0) return;
  const table = catalystApp.datastore().table(config.stagingTable);
  const chunks = [];
  for (let i = 0; i < rows.length; i += 200) chunks.push(rows.slice(i, i + 200));
  await mapWithConcurrency(chunks, config.concurrency, (chunk) => table.insertRows(chunk));
}

async function stagingFetchUnwrittenBatch(catalystApp, config) {
  const query =
    `select ROWID, record_id, product_name, product_code, gbp_price, main_total, has_main_total, exchange_rate ` +
    `from ${config.stagingTable} where written = false limit ${config.writebackBatch}`;
  const rows = await catalystApp.zcql().executeZCQLQuery(query);
  // executeZCQLQuery returns one object per row, each keyed by table name -
  // unwrap that so callers just get plain row objects.
  return rows.map((r) => r[config.stagingTable] || r);
}

async function stagingMarkWritten(catalystApp, config, rowIds) {
  if (rowIds.length === 0) return;
  const table = catalystApp.datastore().table(config.stagingTable);
  const rows = rowIds.map((rowId) => ({ ROWID: rowId, written: true }));
  const chunks = [];
  for (let i = 0; i < rows.length; i += 200) chunks.push(rows.slice(i, i + 200));
  await mapWithConcurrency(chunks, config.concurrency, (chunk) => table.updateRows(chunk));
}

async function stagingTruncate(catalystApp, config) {
  await catalystApp.zcql().executeZCQLQuery(`delete from ${config.stagingTable} where ROWID != 0`);
}

// ---- Phase 1: fetch from CRM, compute, store in the staging table ----
async function runFetchPhase(catalystApp, cursor) {
  const config = loadConfig();
  const offset = Number(cursor.offset ?? 0);
  const isFreshRun = offset === 0 && !cursor.exchangeRate;
  const exchangeRate = cursor.exchangeRate
    ? Number(cursor.exchangeRate)
    : await fetchFixerUsdToGbpRate(config);

  if (isFreshRun) {
    console.log(`[fetch] fresh run starting - clearing staging table "${config.stagingTable}".`);
    await stagingTruncate(catalystApp, config);
  }

  const client = new CrmClient(config);
  console.log(`[fetch] offset=${offset}, exchangeRate=${exchangeRate}`);
  const { records, hasMore } = await client.queryEligibleProductsPage(config, offset);
  console.log(`[fetch] fetched ${records.length} record(s), hasMore=${hasMore}`);

  const stagingRows = records.map((record) => {
    const usdPrice = toNumber(record[config.priceField]);
    const caratTotal = toNumber(record[config.caratField]);
    const gbpPrice = roundToNearest(usdPrice * exchangeRate, config.roundTo);
    const hasMainTotal = caratTotal !== null;
    const mainTotal = hasMainTotal ? roundCurrency(gbpPrice * caratTotal) : 0;
    return {
      record_id: record.id,
      product_name: record[config.nameField] || '',
      product_code: record[config.skuField] || '',
      gbp_price: gbpPrice,
      main_total: mainTotal,
      has_main_total: hasMainTotal,
      exchange_rate: exchangeRate,
      written: false,
    };
  });

  await stagingInsertRows(catalystApp, config, stagingRows);
  console.log(`[fetch] stored ${stagingRows.length} computed row(s) in "${config.stagingTable}".`);

  const summary = { phase: 'fetch', offset, fetched: records.length, stored: stagingRows.length, exchangeRate };

  if (hasMore) {
    return { summary, next: { phase: 'fetch', offset: offset + records.length, exchangeRate } };
  }
  return { summary, next: { phase: 'writeback' } };
}

// ---- Phase 2: read unwritten rows from staging, bulk-update CRM ----
async function runWritebackPhase(catalystApp) {
  const config = loadConfig();
  const client = new CrmClient(config);

  const stagedRows = await stagingFetchUnwrittenBatch(catalystApp, config);
  console.log(`[writeback] ${stagedRows.length} unwritten staged row(s) fetched.`);

  const summary = { phase: 'writeback', scanned: stagedRows.length, updated: 0, errors: 0, updatedSkus: [] };

  if (stagedRows.length === 0) {
    return { summary, next: null };
  }

  const batches = [];
  for (let i = 0; i < stagedRows.length; i += 100) {
    batches.push(stagedRows.slice(i, i + 100));
  }

  await mapWithConcurrency(batches, config.concurrency, async (batch) => {
    const payload = batch.map((row) => {
      const entry = {
        id: row.record_id,
        [config.rateField]: row.gbp_price,
        [config.exchangeRateField]: String(row.exchange_rate),
      };
      if (row.has_main_total) entry[config.mainTotalField] = row.main_total;
      return entry;
    });

    try {
      const result = await client.updateProductsBatch(config.moduleName, payload);
      const results = result.data || [];
      const writtenRowIds = [];
      results.forEach((r, i) => {
        if (r.status === 'success') {
          summary.updated += 1;
          summary.updatedSkus.push(batch[i].product_code);
          writtenRowIds.push(batch[i].ROWID);
        } else {
          console.error(`[error] failed to update record ${batch[i].record_id}: ${JSON.stringify(r)}`);
          summary.errors += 1;
        }
      });
      await stagingMarkWritten(catalystApp, config, writtenRowIds);
    } catch (err) {
      console.error(`[error] batch update failed: ${err.message}`);
      summary.errors += batch.length;
    }
  });

  // There may be more unwritten rows beyond this batch - the caller chains
  // to another writeback hop, which naturally stops once a hop finds 0 rows.
  return { summary, next: { phase: 'writeback' } };
}

async function runPhase(catalystApp, cursor) {
  const phase = cursor.phase || 'fetch';
  if (phase === 'writeback') return runWritebackPhase(catalystApp);
  return runFetchPhase(catalystApp, cursor);
}

module.exports = { runPhase, loadConfig, roundToNearest, roundCurrency, toNumber };
