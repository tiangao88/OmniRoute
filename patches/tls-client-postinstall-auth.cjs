// Adds an Authorization header (when TLS_CLIENT_GITHUB_TOKEN is set) to the
// tls-client-node postinstall's GitHub Releases API fetch.
//
// Fork-side mitigation for the unauthenticated 60 req/h per-IP rate limit on
// api.github.com that makes the postinstall fetch flaky on shared CI runners
// (upstream #7802). The token is the workflow run's own short-lived
// GITHUB_TOKEN supplied as a build-arg; it is consumed only inside the builder
// stage and never reaches the final image. When upstream fixes #7802 properly
// this patcher can be dropped.
const fs = require("fs");

const HDR = JSON.stringify("Authorization");
const ENVNAME = JSON.stringify("TLS_CLIENT_GITHUB_TOKEN");
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

const extra =
  "\n            " + HDR + ": process.env[ENVNAME]" +
  "\n                ? `Bearer ${process.env[ENVNAME]}`" +
  "\n                : undefined,";

s = s.replace(NEEDLE, NEEDLE + extra);
fs.writeFileSync(p, s);
console.log("[patch-tls-client] header wired into postinstall fetch");
