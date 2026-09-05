// Fork-side mitigation for upstream #7802: tls-client-node's postinstall
// fetches its native binary from the GitHub Releases API WITHOUT auth; that
// endpoint is rate-limited to 60 req/h per IP on shared CI runners and flakes
// builds. This patcher wires a Bearer token (from the TLS_CLIENT_GITHUB_TOKEN
// env, provided via buildx secret mount) into the postinstall's fetch. When
// upstream fixes #7802 properly, drop this patcher.
const fs = require("fs");

const HDR = JSON.stringify("Authorization");
const ENVNAME = JSON.stringify("TLS_CLIENT_GITHUB_TOKEN");
const ENVEXPR = "process.env[" + ENVNAME + "]";
const p = "node_modules/tls-client-node/scripts/postinstall.js";
let s = fs.readFileSync(p, "utf8");

if (s.includes(HDR + ":")) {
  console.log("[patch-tls-client] already patched, skipping");
  process.exit(0);
}

const NEEDLE = '"User-Agent": "tls-client-node",';
if (!s.includes(NEEDLE)) {
  console.error("[patch-tls-client] needle not found - postinstall format changed upstream, aborting so the build fails loudly");
  process.exit(1);
}

// NOTE: the injected expression must be self-contained — it runs inside
// postinstall.js, which does NOT see this file's constants. The env var name
// is inlined as a literal via ENVEXPR.
const extra =
  "\n            " + HDR + ": " + ENVEXPR +
  "\n                ? `Bearer ${" + ENVEXPR + "}`" +
  "\n                : undefined,";

s = s.replace(NEEDLE, NEEDLE + extra);
fs.writeFileSync(p, s);
console.log("[patch-tls-client] header wired into postinstall fetch");
