#!/usr/bin/env node
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
 *   - cf_current_exchange_rate_dollar_to_gbp Current Exchange Rate (Dollar to GBP)
 *   - cf_currency_ex_rate_dollar_to_gbp      Currency Ex Rate (Dollar to GBP) - Import
 *                                             (used as a fallback if the "current" rate
 *                                             field is blank on a record)
 *
 * Target: Items module, field "rate" (the org's base/selling currency is GBP).
 *
 * For each Item Attribute record:
 *   gbp_price = round(usd_price * exchange_rate, PRECISION)
 * and that value is written to the linked item's `rate` field, unless it already
 * matches (skip) or --dry-run is set (report only).
 *
 * If more than one Item Attribute record links to the same item, the most recently
 * modified record wins; conflicts are logged.
 *
 * ---------------------------------------------------------------------------
 * Required environment variables (self-client / server-based Zoho OAuth app):
 *   ZOHO_ORGANIZATION_ID   Zoho Inventory organization id
 *   ZOHO_CLIENT_ID
 *   ZOHO_CLIENT_SECRET
 *   ZOHO_REFRESH_TOKEN     Refresh token issued with scopes covering
 *                          ZohoInventory.items.READ, ZohoInventory.items.UPDATE and
 *                          the custom-module read scope for cm_jewellery_item.
 *
 * Optional environment variables:
 *   ZOHO_API_DOMAIN        Default: https://www.zohoapis.eu   (Henig Diamonds is EU DC)
 *   ZOHO_ACCOUNTS_DOMAIN   Default: https://accounts.zoho.eu
 *
 * Usage:
 *   node scripts/sync-gbp-prices.js [--dry-run] [--force]
 *     [--module=cm_jewellery_item]
 *     [--lookup-field=cf_jewellery_item]
 *     [--price-field=cf_sales_price]
 *     [--rate-field=cf_current_exchange_rate_dollar_to_gbp]
 *     [--fallback-rate-field=cf_currency_ex_rate_dollar_to_gbp]
 *     [--precision=2] [--page-size=200] [--delay-ms=250]
 *
 *   --dry-run   Compute and log what would change without writing to Zoho.
 *   --force     Write even when the computed price already matches the item's rate.
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

    dryRun: args['dry-run'] ?? args.dryRun,
    force: args.force ?? false,
    moduleName: args.module || 'cm_jewellery_item',
    lookupField: args['lookup-field'] || 'cf_jewellery_item',
    priceField: args['price-field'] || 'cf_sales_price',
    rateField: args['rate-field'] || 'cf_current_exchange_rate_dollar_to_gbp',
    fallbackRateField: args['fallback-rate-field'] || 'cf_currency_ex_rate_dollar_to_gbp',
    precision: Number(args.precision ?? 2),
    pageSize: Number(args['page-size'] ?? 200),
    delayMs: Number(args['delay-ms'] ?? 250),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function round(value, precision) {
  const factor = 10 ** precision;
  return Math.round((value + Number.EPSILON) * factor) / factor;
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

  async getItem(itemId) {
    const json = await this.request(`items/${itemId}`);
    return json.item;
  }

  async updateItemRate(itemId, name, rate) {
    return this.request(`items/${itemId}`, {
      method: 'PUT',
      body: { name, rate },
    });
  }
}

function resolveExchangeRate(record, config) {
  const primary = toNumber(record[config.rateField]);
  if (primary && primary > 0) return primary;
  const fallback = toNumber(record[config.fallbackRateField]);
  if (fallback && fallback > 0) return fallback;
  return null;
}

function pickLatestPerItem(records, config) {
  const byItem = new Map();
  for (const record of records) {
    const itemId = record[config.lookupField];
    if (!itemId) continue;

    const usdPrice = toNumber(record[config.priceField]);
    const exchangeRate = resolveExchangeRate(record, config);
    if (usdPrice === null || usdPrice <= 0 || exchangeRate === null) continue;

    const gbpPrice = round(usdPrice * exchangeRate, config.precision);
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

  console.log(
    `Fetching "${config.moduleName}" records ` +
    `(price field: ${config.priceField}, rate field: ${config.rateField})...`
  );
  const records = await client.listAllCustomModuleRecords(config.moduleName, config.pageSize);
  console.log(`Fetched ${records.length} record(s).`);

  const updatesByItem = pickLatestPerItem(records, config);
  console.log(`${updatesByItem.size} distinct item(s) have a computable GBP price.`);

  const summary = {
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
    const unchanged = !config.force && Math.abs(currentRate - update.gbpPrice) < 10 ** -config.precision / 2;

    const line =
      `item ${update.itemId} (${item.name}): USD ${update.usdPrice} x ${update.exchangeRate} ` +
      `= £${update.gbpPrice} (current £${currentRate})`;

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

    try {
      await client.updateItemRate(update.itemId, item.name, update.gbpPrice);
      console.log(`[updated] ${line}`);
      summary.updated += 1;
    } catch (err) {
      console.error(`[error] failed to update item ${update.itemId}: ${err.message}`);
      summary.errors += 1;
    }

    await sleep(config.delayMs);
  }

  console.log('\nSummary:', summary);
  if (summary.errors > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.stack || err.message || err);
  process.exitCode = 1;
});
