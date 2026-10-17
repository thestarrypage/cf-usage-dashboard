#!/usr/bin/env node
// One-command setup: sign in, deploy (creates the KV namespace), then set the two secrets.
//
//   npm run setup
//   npm run setup -- -c wrangler.local.jsonc     # use your own config file
//
// Extra arguments are passed to every wrangler command.

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const extra = process.argv.slice(2);
const env = { ...process.env };
const rl = createInterface({ input: stdin, output: stdout });

async function ask(question, fallback = "y") {
	const answer = (await rl.question(`${question} [${fallback === "y" ? "Y/n" : "y/N"}] `)).trim().toLowerCase();
	return (answer || fallback) === "y";
}

function wrangler(args, { quiet = false } = {}) {
	const res = spawnSync("npx", ["wrangler", ...args, ...extra], {
		stdio: quiet ? "pipe" : "inherit",
		env,
		shell: process.platform === "win32",
		encoding: "utf8",
	});
	return { ok: res.status === 0, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

function step(n, text) {
	console.log(`\n\x1b[1m${n}. ${text}\x1b[0m`);
}

try {
	console.log("Cloudflare usage dashboard – setup");

	// An API token in the environment overrides `wrangler login`. A read-only analytics
	// token can't deploy, so offer to ignore it for this run.
	if (env.CLOUDFLARE_API_TOKEN) {
		console.log("\nCLOUDFLARE_API_TOKEN is set in your environment, so Wrangler will deploy with that token.");
		console.log("It needs Workers Scripts: Edit and Workers KV Storage: Edit.");
		if (await ask("Ignore it for this setup and use your browser login instead?")) delete env.CLOUDFLARE_API_TOKEN;
	}

	step(1, "Checking your Cloudflare login");
	const who = wrangler(["whoami"], { quiet: true });
	if (!who.ok || /not authenticated/i.test(who.out)) {
		console.log("Not signed in – opening the browser to log in.");
		if (!wrangler(["login"]).ok) throw new Error("wrangler login failed");
	} else {
		console.log("Signed in.");
	}

	step(2, "Deploying the Worker (creates the CAPS KV namespace on first deploy)");
	if (!wrangler(["deploy"]).ok) throw new Error("wrangler deploy failed");

	step(3, "Secrets");
	console.log("CF_API_TOKEN: an API token with Account Analytics Read, Zone Analytics Read and Zone Read");
	console.log("(optional: Zone Settings Read for Spectrum IPv4 counts). Create one at");
	console.log("https://dash.cloudflare.com/profile/api-tokens");
	if (await ask("Set CF_API_TOKEN now?")) wrangler(["secret", "put", "CF_API_TOKEN"]);
	console.log("\nDASHBOARD_PASSWORD: the password for the dashboard (any username works).");
	if (await ask("Set DASHBOARD_PASSWORD now?")) wrangler(["secret", "put", "DASHBOARD_PASSWORD"]);

	console.log("\n\x1b[32mDone.\x1b[0m Open the workers.dev URL printed by the deploy step and sign in with");
	console.log("any username and your DASHBOARD_PASSWORD. Set caps and alerts under \"Caps & alerts\".");
} catch (err) {
	console.error(`\n\x1b[31mSetup stopped:\x1b[0m ${err.message}`);
	process.exitCode = 1;
} finally {
	rl.close();
}
