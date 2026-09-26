// Live test against a real phone. Usage: node live.mjs <server.mjs> <outdir>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs"; import path from "node:path";
const [server, outDir] = process.argv.slice(2);
const t = new StdioClientTransport({ command: process.execPath, args: [server], env: { ...process.env }, stderr: "inherit" });
const c = new Client({ name: "live", version: "0" }); await c.connect(t);
const call = async (name, args = {}) => {
  const t0 = Date.now(); const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  const txt = r.content.filter((x) => x.type === "text").map((x) => x.text).join("\n");
  const img = r.content.find((x) => x.type === "image");
  if (img) fs.writeFileSync(path.join(outDir, `live-${name}-${Date.now()}.jpg`), Buffer.from(img.data, "base64"));
  console.log(`\n== ${name} ${JSON.stringify(args)} ${r.isError ? "ERROR" : "ok"} ${Date.now() - t0}ms${img ? ` [img ${Math.round(img.data.length * 0.75 / 1024)}KB]` : ""}\n${txt.slice(0, 2500)}`);
};
const arg = process.argv[4] || "[]"; const list = JSON.parse(arg.endsWith(".json") ? fs.readFileSync(arg, "utf8").replace(/^\uFEFF/, "") : arg);
for (const [n, a] of list) await call(n, a);
await c.close(); process.exit(0);
