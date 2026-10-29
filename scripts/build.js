#!/usr/bin/env node
/*
 * Steward build script.
 *
 * Concatenates every JS file under src/ (in deterministic, prefix-driven order)
 * into a single bundle at build/user_steward.js. Output is a plain script — no
 * modules, no transpilation — because the target runtime (Adobe AIR 32) does
 * not support ES modules.
 *
 * Load order:
 *   1. src/kernel/<NN>_*.js   (lexicographic, numeric prefix drives order)
 *   2. src/core/**\/*.js       (lexicographic per directory)
 *   3. src/modules/**\/*.js    (lexicographic per directory)
 *   4. src/vendor/**\/*.js     (lexicographic, optional)
 *
 * Usage:
 *   node scripts/build.js
 *   STEWARD_VERSION=0.1.0 node scripts/build.js
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { minify } = require("terser");
const loadOrder = require("../tests/load-order");
const version = require("./version");

const REPO_ROOT = path.resolve(__dirname, "..");
const BUILD_DIR = path.join(REPO_ROOT, "build");
const OUTPUT_FILE = path.join(BUILD_DIR, "user_steward.js");

const SECTION_NAMES = ["kernel", "core", "modules", "vendor"];

function collectFiles(sectionName) {
	return loadOrder
		.collect([sectionName], REPO_ROOT)
		.map(function (rel) { return path.join(REPO_ROOT, rel); });
}

function gitShortSha() {
	try {
		return execSync("git rev-parse --short HEAD", {
			cwd: REPO_ROOT,
			stdio: ["ignore", "pipe", "ignore"],
		})
			.toString()
			.trim();
	} catch (e) {
		return "unknown";
	}
}

function isoDate() {
	return new Date().toISOString().slice(0, 10);
}

function banner(version, sha, date, fileCount, byteCount) {
	return [
		"/*",
		" * Steward v" + version,
		" * Built " + date + " from commit " + sha,
		" * Files: " + fileCount + "  Size: " + byteCount + " bytes",
		" *",
		" * Modular automation framework for The Settlers Online.",
		" * Source: https://github.com/rknall/steward",
		" * License: GPL-3.0-or-later",
		" *",
		" * THIS FILE IS GENERATED. Do not edit by hand — change source under",
		" * src/ and run `npm run build`.",
		" */",
		"",
	].join("\n");
}

async function build() {
	if (!fs.existsSync(BUILD_DIR)) fs.mkdirSync(BUILD_DIR, { recursive: true });

	const parts = [];
	let totalFiles = 0;

	for (let i = 0; i < SECTION_NAMES.length; i++) {
		const sectionName = SECTION_NAMES[i];
		const files = collectFiles(sectionName);
		if (files.length === 0) continue;

		parts.push("/* ===== " + sectionName + " ===== */");
		for (let j = 0; j < files.length; j++) {
			const rel = path.relative(REPO_ROOT, files[j]);
			const body = fs.readFileSync(files[j], "utf8").replace(/\r\n/g, "\n");
			parts.push("/* --- " + rel + " --- */");
			parts.push(body.endsWith("\n") ? body : body + "\n");
			totalFiles++;
		}
	}

	const v = version.read(REPO_ROOT);
	const body = version.inject(parts.join("\n"), v);

	let finalCode = body;

	// Terser pass — every transform option disabled. compress and mangle
	// off so no rewrites; beautify on so the output keeps newlines (a
	// single-line bundle hits a parser limit in AIR 32). ecma:5 prevents
	// any ES6+ output shape. Net effect: comments and excess whitespace
	// stripped, code structure preserved.
	try {
		const minified = await minify(body, {
			ecma: 5,
			mangle: true,
			compress: true,
			format: {
				comments: false,
				beautify: false,
                indent_level: 0, // prevent AIR 32 parser limit
                max_line_len: 1000, // prevent AIR 32 parser limit
                quote_keys: true
			},
		});
		finalCode = minified.code;
	} catch (err) {
		console.error("Minification failed, using raw body:", err);
	}

	const sha = gitShortSha();
	const date = isoDate();
	const head = banner(
		v,
		sha,
		date,
		totalFiles,
		Buffer.byteLength(finalCode, "utf8"),
	);
	fs.writeFileSync(OUTPUT_FILE, head + finalCode, "utf8");

	process.stdout.write(
		"Steward built: " +
			path.relative(REPO_ROOT, OUTPUT_FILE) +
			" (" +
			totalFiles +
			" files, " +
			Buffer.byteLength(head + finalCode, "utf8") +
			" bytes, v" +
			v +
			" / " +
			sha +
			")\n",
	);
}

build();
