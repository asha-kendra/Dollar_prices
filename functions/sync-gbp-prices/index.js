"use strict";

const express = require("express");
const { runBatch } = require("./sync-gbp-prices");

const app = express();
app.use(express.json());

// How many self-triggered hops a single incoming call is allowed to chain
// through before giving up (safety net against a runaway chain if `next`
// somehow never becomes null). ~7,700 Available items / 100 per page is
// ~78 hops for that status alone, so 200 leaves plenty of margin.
const MAX_HOPS = Number(process.env.MAX_CHAIN_HOPS || 200);

function buildNextUrl(req, cursor, hop) {
	const base = process.env.SELF_INVOKE_URL || `${req.protocol}://${req.get("host")}${req.baseUrl}${req.path}`;
	const url = new URL(base);
	url.searchParams.set("statusIndex", cursor.statusIndex);
	url.searchParams.set("page", cursor.page);
	url.searchParams.set("exchangeRate", cursor.exchangeRate);
	url.searchParams.set("hop", hop);
	return url.toString();
}

app.all("*", (req, res) => {
	const hop = Number(req.query.hop ?? 0);
	const cursor = {
		statusIndex: req.query.statusIndex,
		page: req.query.page,
		exchangeRate: req.query.exchangeRate,
	};

	runBatch(cursor)
		.then(async ({ summary, next }) => {
			console.log("\nBatch summary: " + JSON.stringify({ hop, summary, next }));

			let chained = false;
			if (next && hop < MAX_HOPS) {
				const nextUrl = buildNextUrl(req, next, hop + 1);
				console.log(`[chain] hop ${hop} -> triggering hop ${hop + 1}: ${nextUrl}`);
				const chainPromise = fetch(nextUrl).catch((err) => {
					console.error(`[chain] trigger for hop ${hop + 1} failed: ${err.message}`);
				});
				// Don't wait for the next hop to finish (that would just move the
				// execution-time problem back to this invocation) - only give it a
				// brief window to actually leave the socket before we respond and
				// this container potentially gets frozen/reclaimed.
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
