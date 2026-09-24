"use strict";

const express = require("express");
const { main } = require("./sync-gbp-prices");

const app = express();
app.use(express.json());

app.all("*", (req, res) => {
	main()
		.then((summary) => {
			console.log("\nSync summary: " + JSON.stringify(summary));
			res.status(200).json({ status: "ok", summary });
		})
		.catch((err) => {
			console.log(err);
			res.status(500).json({ status: "error", message: err.message });
		});
});

module.exports = app;
