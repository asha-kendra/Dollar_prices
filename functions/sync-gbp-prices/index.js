"use strict";

const express = require("express");
const { runBatch } = require("./sync-gbp-prices");

const app = express();
app.use(express.json());

app.all("*", (req, res) => {
	const cursor = {
		statusIndex: req.query.statusIndex,
		page: req.query.page,
		exchangeRate: req.query.exchangeRate,
	};
	runBatch(cursor)
		.then(({ summary, next }) => {
			console.log("\nBatch summary: " + JSON.stringify({ summary, next }));
			res.status(200).json({ status: "ok", summary, next });
		})
		.catch((err) => {
			console.log(err);
			res.status(500).json({ status: "error", message: err.message });
		});
});

module.exports = app;
