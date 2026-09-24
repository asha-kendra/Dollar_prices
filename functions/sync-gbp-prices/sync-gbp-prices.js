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
 *   - cf_status                              Item status ("Available" / "On Hold")
 *
 * The USD->GBP exchange rate is fetched live from the fixer.io API (one call per
 * run, applied to every record) rather than read from a field on the record.
 * The call requests base=GBP, symbols=USD; this requires a fixer.io plan that
 * honors a non-EUR base currency (the free plan ignores `base` and always
 * responds in EUR, which would break this).
 *
 * Target: Items module
 *   - "rate" (the org's base/selling currency is GBP)
 *   - custom field "cf_status" (written via the custom_fields array, since Zoho
 *     Inventory's Items API exposes custom fields that way rather than as flat
 *     top-level properties)
 *
 * For each Item Attribute record:
 *   gbp_price = round_to_nearest(usd_price * exchange_rate, ROUND_TO)
 * i.e. the raw converted price is rounded to the nearest multiple of ROUND_TO
 * (default: 5, so sales prices land on whole £5 steps: 5, 10, 15, ...), and that
 * value is written to the linked item's `rate` field, unless it already matches
 * (skip) or --dry-run is set (report only). The record's status field is copied
 * across the same way, but only when its value is one of ITEM_STATUS_VALUES -
 * anything else is left untouched on the item.
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
 *   ITEM_STATUS_VALUES     Comma-separated list of status values that are valid to
 *                          write to the item's status field. Default: "Available,On Hold".
 *                          Add more values here (e.g. "Available,On Hold,Reserved")
 *                          without any code change.
 *
 * CLI usage:
 *   node scripts/sync-gbp-prices.js [--dry-run] [--force]
 *     [--module=cm_jewellery_item]
 *     [--lookup-field=cf_jewellery_item]
 *     [--price-field=cf_sales_price]
 *     [--status-field=cf_status]
 *     [--round-to=5] [--page-size=200] [--delay-ms=250]
 *
 *   --dry-run   Compute and log what would change without writing to Zoho.
 *   --force     Write even when the computed price/status already match the item.
 *   --round-to  Round the computed GBP sales price to the nearest multiple of this
 *               value (default: 5). Use 0 or 1 to disable rounding to whole pounds.
 *
 * Requires Node.js 18+ (built-in fetch).
 * ---------------------------------------------------------------------------
 */

'use strict';

function parseArgs(argv) {
  const args = { dryRun: false, force: false };
  for (const raw of argv) {
    if (raw === '--dry-run') { args.dryRun = true; continue; }
    if (raw === '--force') { args.force = true; continue; }
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
    force: args.force ?? false,
    moduleName: args.module || 'cm_jewellery_item',
    lookupField: args['lookup-field'] || 'cf_jewellery_item',
    priceField: args['price-field'] || 'cf_sales_price',
    statusField: args['status-field'] || 'cf_status',
    allowedStatuses: (process.env.ITEM_STATUS_VALUES || 'Available,On Hold')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
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

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Zoho Inventory's Items API exposes custom fields via a `custom_fields` array
// ({ api_name, value, ... }) rather than as flat top-level properties.
function getItemCustomFieldValue(item, apiName) {
  const fields = item.custom_fields;
  if (!Array.isArray(fields)) return null;
  const match = fields.find((f) => f.api_name === apiName);
  return match ? match.value : null;
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

  async getItem(itemId) {
    const json = await this.request(`items/${itemId}`);
    return json.item;
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

    const rawStatus = record[config.statusField];
    const status = config.allowedStatuses.includes(rawStatus) ? rawStatus : null;
    if (rawStatus && status === null) {
      console.warn(
        `[status] record ${record.module_record_id} has status "${rawStatus}", ` +
        `which is not in ITEM_STATUS_VALUES (${config.allowedStatuses.join(', ')}); leaving item status untouched.`
      );
    }

    const candidate = {
      itemId,
      recordId: record.module_record_id,
      recordName: record.record_name,
      usdPrice,
      exchangeRate,
      gbpPrice,
      status,
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

  const exchangeRate = await fetchFixerUsdToGbpRate(config);
  console.log(`Live USD->GBP exchange rate from fixer.io: ${exchangeRate}`);

  console.log(
    `Fetching "${config.moduleName}" records (price field: ${config.priceField})...`
  );
  const records = await client.listAllCustomModuleRecords(config.moduleName, config.pageSize);
  console.log(`Fetched ${records.length} record(s).`);

  const updatesByItem = pickLatestPerItem(records, config, exchangeRate);
  console.log(`${updatesByItem.size} distinct item(s) have a computable GBP price.`);

  const summary = {
    exchangeRate,
    scanned: updatesByItem.size,
    updated: 0,
    skippedUnchanged: 0,
    skippedItemMissing: 0,
    errors: 0,
  };

  for (const update of updatesByItem.values()) {
    let item;
    try {
      item = await client.getItem(update.itemId);
    } catch (err) {
      console.error(`[error] could not fetch item ${update.itemId}: ${err.message}`);
      summary.skippedItemMissing += 1;
      continue;
    }

    const currentRate = toNumber(item.rate) ?? 0;
    const currentStatus = getItemCustomFieldValue(item, config.statusField);

    const rateUnchanged = Math.abs(currentRate - update.gbpPrice) < 0.005;
    const statusUnchanged = update.status === null || update.status === currentStatus;
    const unchanged = !config.force && rateUnchanged && statusUnchanged;

    const line =
      `item ${update.itemId} (${item.name}): USD ${update.usdPrice} x ${update.exchangeRate} ` +
      `= £${update.gbpPrice} (current £${currentRate})` +
      (update.status !== null ? `, status "${currentStatus ?? '(unset)'}" -> "${update.status}"` : '');

    if (unchanged) {
      console.log(`[skip:unchanged] ${line}`);
      summary.skippedUnchanged += 1;
      continue;
    }

    if (config.dryRun) {
      console.log(`[dry-run] would update ${line}`);
      summary.updated += 1;
      continue;
    }

    const body = { name: item.name, rate: update.gbpPrice };
    if (update.status !== null) {
      body.custom_fields = [{ api_name: config.statusField, value: update.status }];
    }

    try {
      await client.updateItem(update.itemId, body);
      console.log(`[updated] ${line}`);
      summary.updated += 1;
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
