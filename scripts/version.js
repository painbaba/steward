/*
 * Release version helper, shared by scripts/build.js and tests/harness.js so
 * the bundle and the tests substitute the version the same way.
 *
 * package.json "version" is the single source; STEWARD_VERSION (set by the
 * release workflow from the tag) takes precedence. Source files carry the
 * quoted TOKEN_LITERAL, which inject() replaces with a JSON-quoted version.
 */

const fs = require("fs");
const path = require("path");

const TOKEN_LITERAL = "'__STEWARD_VERSION__'";

function read(repoRoot) {
	if (process.env.STEWARD_VERSION) return process.env.STEWARD_VERSION;
	try {
		const pkg = JSON.parse(
			fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
		);
		return pkg.version || "0.0.0";
	} catch (e) {
		return "0.0.0";
	}
}

// split/join avoids regex escaping; JSON.stringify keeps a quote in an
// env-provided version from breaking the bundle.
function inject(body, version) {
	return body.split(TOKEN_LITERAL).join(JSON.stringify(String(version)));
}

module.exports = { TOKEN_LITERAL: TOKEN_LITERAL, read: read, inject: inject };
