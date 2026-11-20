"use strict";

const express = require("express");
const catalyst = require("zcatalyst-sdk-node");
const { runPhase } = require("./sync-gbp-prices-crm-staged");

const app = express();
app.use(express.json());

// Safety cap on chained hops, same pattern as the Inventory self-chain
// function. At FETCH_PAGE_SIZE=200 per fetch hop plus however many
// writeback hops it takes to drain the staging table, 500 is generous
// headroom for this org's scale.
const MAX_HOPS = Number(process.env.MAX_CHAIN_HOPS || 500);

function buildNextUrl(req, cursor, hop) {
	// Force https and strip any port - req.protocol can report "http" since
	// Catalyst terminates TLS at its edge and forwards internally over plain
	// HTTP, which previously produced an unreachable "http://host:443/..."
	// fallback URL. Confirmed and fixed on the Inventory self-chain function;
	// applying the same fix here up front.
	let base = process.env.SELF_INVOKE_URL;
	if (!base) {
		const host = req.get("host").replace(/:\d+$/, "");
		base = `https://${host}${req.baseUrl}${req.path}`;
	}
	const url = new URL(base);
	url.searchParams.set("phase", cursor.phase);
	if (cursor.offset !== undefined) url.searchParams.set("offset", cursor.offset);
	if (cursor.exchangeRate !== undefined) url.searchParams.set("exchangeRate", cursor.exchangeRate);
	url.searchParams.set("hop", hop);
	return url.toString();
}

app.all("*", (req, res) => {
	const hop = Number(req.query.hop ?? 0);
	const cursor = {
		phase: req.query.phase,
		offset: req.query.offset,
		exchangeRate: req.query.exchangeRate,
	};

	const catalystApp = catalyst.initialize(req);

	runPhase(catalystApp, cursor)
		.then(async ({ summary, next }) => {
			console.log("\nPhase summary: " + JSON.stringify({ hop, summary, next }));

			let chained = false;
			if (next && hop < MAX_HOPS) {
				const nextUrl = buildNextUrl(req, next, hop + 1);
				console.log(`[chain] hop ${hop} (${summary.phase}) -> triggering hop ${hop + 1} (${next.phase}): ${nextUrl}`);
				const chainPromise = fetch(nextUrl).catch((err) => {
					console.error(`[chain] trigger for hop ${hop + 1} failed: ${err.message}`);
				});
				// Fire-and-forget, but give it a brief window to actually leave
				// the socket before responding and this container potentially
				// gets frozen - same pattern as the Inventory self-chain function.
				await Promise.race([chainPromise, new Promise((resolve) => setTimeout(resolve, 500))]);
				chained = true;
			} else if (next) {
				console.error(`[chain] stopped after ${hop} hop(s) - MAX_HOPS reached, run is incomplete. next=${JSON.stringify(next)}`);
			}

			res.status(200).json({ status: "ok", hop, summary, next, chained });
		})
		.catch((err) => {
			console.log(err);
			res.status(500).json({ status: "error", message: err.message });
		});
});

module.exports = app;
