#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8080;
const DEFAULT_API = "https://api.lakebed.app";
const CACHE_DIR = join(homedir(), ".lakebed-proxy");
const CAPSULE_DIR = join(CACHE_DIR, "capsule");
const STATE_PATH = join(CACHE_DIR, "state.json");
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

function usage(exitCode = 0) {
  const command = process.argv[1] ? `node ${process.argv[1]}` : "lakebed-proxy";
  console.log(`Usage:
  lakebed-proxy run [--host 127.0.0.1] [--port 8080] [--api https://api.lakebed.app]

Flags:
  --host <host>  Host to bind. Defaults to ${DEFAULT_HOST}.
  --port <port>  Port to bind. Defaults to ${DEFAULT_PORT}.
  --api <url>    Lakebed API URL. Defaults to ${DEFAULT_API}.
  --help         Show this help.

GitHub:
  pnpm dlx github:<owner>/lakebed-proxy run

Direct:
  ${command} run`);
  process.exit(exitCode);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function quoteShell(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

function nowIso() {
  return new Date().toISOString();
}

async function readJson(path, fallback = null) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runCommand(command, args, { stdio = "pipe" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio });
    let stdout = "";
    let stderr = "";

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr += String(chunk);
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(`${command} ${args.join(" ")} failed with exit code ${code}${stderr ? `\n${stderr}` : ""}`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

async function runLakebed(args, { inherit = false } = {}) {
  return runCommand("pnpm", ["dlx", "lakebed", ...args], { stdio: inherit ? "inherit" : "pipe" });
}

async function deployCapsule(api) {
  const { stdout } = await runLakebed(["deploy", CAPSULE_DIR, "--api", api, "--json"]);
  return JSON.parse(stdout);
}

async function claimStatus(api) {
  const { stdout } = await runLakebed(["claim", CAPSULE_DIR, "--api", api, "--json"]);
  return JSON.parse(stdout);
}

async function openClaimFlow(api, claimUrl) {
  console.log("\nThis Lakebed deploy must be claimed before it can proxy outbound HTTP.");
  console.log(`Claim URL: ${claimUrl}`);
  console.log("Opening the Lakebed claim page...");
  try {
    await runLakebed(["claim", CAPSULE_DIR, "--api", api], { inherit: true });
  } catch (error) {
    console.log("Could not open the browser automatically. Open the claim URL above, then return here.");
  }
}

async function ensureClaimedDeploy(previousState, api) {
  await writeGeneratedCapsule();

  console.log("Deploying Lakebed proxy route...");
  let deployed = await deployCapsule(api);
  let changed = Boolean(previousState?.url && deployed.url && previousState.url !== deployed.url);
  if (changed) {
    console.log(`Lakebed proxy URL changed: ${previousState.url} -> ${deployed.url}`);
  }

  let finalDeploy = deployed;
  if (deployed.claimRequired || !deployed.claimed) {
    const claim = await claimStatus(api);
    if (!claim.claimed) {
      await openClaimFlow(api, claim.claimUrl || deployed.claimUrl);
      console.log("Waiting for Lakebed claim to complete...");
      for (;;) {
        const status = await claimStatus(api);
        if (status.claimed) {
          console.log("Lakebed deploy claimed.");
          break;
        }
        await sleep(3000);
      }
    }

    console.log("Redeploying claimed Lakebed proxy route so outbound fetch is enabled...");
    finalDeploy = await deployCapsule(api);
    if (previousState?.url && finalDeploy.url && previousState.url !== finalDeploy.url && !changed) {
      changed = true;
      console.log(`Lakebed proxy URL changed: ${previousState.url} -> ${finalDeploy.url}`);
    }
  }

  const state = {
    api,
    claimed: Boolean(finalDeploy.claimed ?? true),
    deployId: finalDeploy.deployId,
    updatedAt: nowIso(),
    url: finalDeploy.url,
    urlChanged: changed
  };
  await writeJson(STATE_PATH, state);
  return state;
}

function capsuleServerSource() {
  return `import { boolean, capsule, mutation, string, table } from "lakebed/server";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

function normalizeHeaderLines(headers) {
  const out = {};
  for (const [rawName, rawValue] of Object.entries(headers || {})) {
    const name = String(rawName).trim().toLowerCase();
    if (!name || HOP_BY_HOP_HEADERS.has(name) || name === "host") {
      continue;
    }
    const value = Array.isArray(rawValue) ? rawValue.join(", ") : String(rawValue ?? "");
    out[name] = value;
  }
  return out;
}

function headersToObject(headers) {
  const out = {};
  if (typeof headers.forEach === "function") {
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (typeof headers.entries === "function") {
    for (const [key, value] of headers.entries()) {
      out[key] = value;
    }
  }
  return out;
}

function toBase64(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function failure(message, status = 502) {
  return {
    ok: false,
    status,
    statusText: "Bad Gateway",
    headers: { "content-type": "text/plain; charset=utf-8" },
    bodyBase64: toBase64(new TextEncoder().encode(message)),
    error: message,
    finalUrl: "",
    durationMs: 0
  };
}

export default capsule({
  name: "lakebed-proxy-route",

  schema: {
    relays: table({
      ok: boolean(),
      method: string(),
      url: string(),
      status: string(),
      error: string()
    })
  },

  mutations: {
    relay: mutation(async (ctx, request) => {
      const started = Date.now();
      const method = String(request?.method || "GET").toUpperCase();
      const url = String(request?.url || "").slice(0, 4096);

      let target;
      try {
        target = new URL(url);
      } catch {
        return failure("Invalid absolute target URL.", 400);
      }

      if (target.protocol !== "http:" && target.protocol !== "https:") {
        return failure("Only http and https URLs are supported.", 400);
      }

      try {
        const bodyBase64 = typeof request?.bodyBase64 === "string" ? request.bodyBase64 : "";
        const bodyBytes = bodyBase64 ? Uint8Array.from(atob(bodyBase64), (char) => char.charCodeAt(0)) : undefined;
        const response = await fetch(target.toString(), {
          method,
          headers: normalizeHeaderLines(request?.headers),
          body: method === "GET" || method === "HEAD" ? undefined : bodyBytes
        });
        const body = method === "HEAD" ? new Uint8Array() : new Uint8Array(await response.arrayBuffer());
        const result = {
          ok: response.ok,
          status: response.status,
          statusText: response.statusText || "",
          headers: headersToObject(response.headers),
          bodyBase64: toBase64(body),
          error: "",
          finalUrl: response.url,
          durationMs: Date.now() - started
        };
        ctx.db.relays.insert({
          ok: result.ok,
          method,
          url: target.toString(),
          status: String(result.status),
          error: ""
        });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Lakebed relay failed.";
        ctx.db.relays.insert({
          ok: false,
          method,
          url: target.toString(),
          status: "0",
          error: message
        });
        return { ...failure(message), finalUrl: target.toString(), durationMs: Date.now() - started };
      }
    })
  }
});
`;
}

function capsuleClientSource() {
  return `export function App() {
  return (
    <main className="min-h-screen bg-black px-6 py-10 text-white">
      <section className="mx-auto max-w-2xl border border-neutral-800 bg-neutral-950 p-6">
        <p className="font-mono text-xs uppercase tracking-[0.2em] text-emerald-300">lakebed proxy</p>
        <h1 className="mt-3 text-3xl font-semibold">Proxy route is deployed</h1>
        <p className="mt-3 text-neutral-400">Keep the local lakebed-proxy CLI running and configure macOS to use the printed HTTP and HTTPS proxy endpoints.</p>
      </section>
    </main>
  );
}
`;
}

async function writeGeneratedCapsule() {
  await mkdir(join(CAPSULE_DIR, "server"), { recursive: true });
  await mkdir(join(CAPSULE_DIR, "client"), { recursive: true });
  await writeFile(join(CAPSULE_DIR, "server", "index.ts"), capsuleServerSource());
  await writeFile(join(CAPSULE_DIR, "client", "index.tsx"), capsuleClientSource());
  await writeFile(
    join(CAPSULE_DIR, "AGENTS.md"),
    "# Generated Lakebed Proxy Capsule\n\nThis directory is managed by `lakebed-proxy run`. Do not edit it by hand.\n"
  );
  await writeFile(
    join(CAPSULE_DIR, "README.md"),
    "# Generated Lakebed Proxy Capsule\n\nThis capsule exposes the server-side relay route used by the local lakebed-proxy CLI.\n"
  );
}

function parseProxyTarget(req) {
  try {
    const parsed = new URL(req.url);
    if (parsed.protocol !== "http:") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function collectRequestBody(req, maxBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body is too large for Lakebed relay."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function cleanRequestHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(key) || key === "host") {
      continue;
    }
    out[key] = Array.isArray(value) ? value.join(", ") : String(value ?? "");
  }
  return out;
}

function writePlain(res, status, message) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "content-length": Buffer.byteLength(message) });
  res.end(message);
}

function bufferToBase64(buffer) {
  return Buffer.from(buffer).toString("base64");
}

function base64ToBuffer(value) {
  return Buffer.from(String(value || ""), "base64");
}

function responseHeadersFromRelay(headers, body) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const key = name.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(key) && key !== "content-length") {
      out[name] = String(value);
    }
  }
  out["content-length"] = String(body.length);
  return out;
}

class LakebedMutationClient {
  constructor(deployUrl) {
    this.deployUrl = deployUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.connecting = null;
  }

  wsUrl() {
    const url = new URL(this.deployUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/__lakebed/ws";
    url.search = "";
    return url.toString();
  }

  async connect() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return this.ws;
    }
    if (this.connecting) {
      return this.connecting;
    }

    this.connecting = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl());
      const cleanup = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onError);
      };
      const onOpen = () => {
        cleanup();
        this.ws = ws;
        this.connecting = null;
        resolve(ws);
      };
      const onError = () => {
        cleanup();
        this.connecting = null;
        reject(new Error("Unable to connect to Lakebed proxy route."));
      };
      ws.addEventListener("open", onOpen, { once: true });
      ws.addEventListener("error", onError, { once: true });
      ws.addEventListener("message", (event) => this.onMessage(event));
      ws.addEventListener("close", () => {
        if (this.ws === ws) {
          this.ws = null;
        }
        for (const { reject: rejectPending } of this.pending.values()) {
          rejectPending(new Error("Lakebed proxy route connection closed."));
        }
        this.pending.clear();
      });
    });

    return this.connecting;
  }

  onMessage(event) {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (!message.id || !this.pending.has(message.id)) {
      return;
    }
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(message.error || "Lakebed mutation failed."));
    }
  }

  async runMutation(name, args) {
    const ws = await this.connect();
    const id = this.nextId++;
    const payload = JSON.stringify({ id, op: "mutation.run", name, args });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Lakebed relay timed out."));
      }, 30000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        }
      });
      ws.send(payload);
    });
  }
}

async function handleHttpProxy(req, res, lakebedClient) {
  const started = Date.now();
  const target = parseProxyTarget(req);
  if (!target) {
    writePlain(res, 400, "Expected an absolute http:// URL in proxy request.\n");
    return;
  }

  try {
    const body = await collectRequestBody(req);
    const result = await lakebedClient.runMutation("relay", [
      {
        method: req.method,
        url: target.toString(),
        headers: cleanRequestHeaders(req.headers),
        bodyBase64: bufferToBase64(body)
      }
    ]);
    const responseBody = base64ToBuffer(result.bodyBase64);
    res.writeHead(Number(result.status) || 502, result.statusText || undefined, responseHeadersFromRelay(result.headers, responseBody));
    res.end(responseBody);
    console.log(`${req.method} ${target} -> ${result.status}${result.error ? ` ${result.error}` : ""} ${Date.now() - started}ms lakebed`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Lakebed relay failed.";
    writePlain(res, 502, `${message}\n`);
    console.log(`${req.method} ${target} -> 502 ${message} ${Date.now() - started}ms lakebed`);
  }
}

function handleConnect(req, clientSocket, head) {
  const started = Date.now();
  const [host, portText = "443"] = String(req.url || "").split(":");
  const port = Number(portText);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    clientSocket.destroy();
    return;
  }

  const upstream = net.connect(port, host, () => {
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) {
      upstream.write(head);
    }
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
    console.log(`CONNECT ${host}:${port} -> tunnel ${Date.now() - started}ms local`);
  });

  upstream.on("error", (error) => {
    if (!clientSocket.destroyed) {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      clientSocket.destroy();
    }
    console.log(`CONNECT ${host}:${port} -> 502 ${error.message} ${Date.now() - started}ms local`);
  });
}

function startProxyServer({ host, port, deployUrl }) {
  const lakebedClient = new LakebedMutationClient(deployUrl);
  const server = createServer((req, res) => {
    void handleHttpProxy(req, res, lakebedClient);
  });
  server.on("connect", handleConnect);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function execFileText(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 2000 }, (error, stdout) => {
      resolve(error ? "" : String(stdout));
    });
  });
}

async function detectMacNetworkService() {
  if (process.platform !== "darwin") {
    return null;
  }
  const route = await execFileText("route", ["-n", "get", "default"]);
  const iface = route.match(/interface: ([^\s]+)/)?.[1];
  const hardware = await execFileText("networksetup", ["-listallhardwareports"]);
  if (!iface || !hardware) {
    return null;
  }
  const blocks = hardware.split(/\n\n+/);
  for (const block of blocks) {
    const device = block.match(/Device: ([^\s]+)/)?.[1];
    const service = block.match(/Hardware Port: (.+)/)?.[1];
    if (device === iface && service) {
      return service.trim();
    }
  }
  return null;
}

async function printReadyInstructions({ deployId, deployUrl, urlChanged, host, port }) {
  const service = await detectMacNetworkService();
  const serviceLabel = service || "<service>";
  const quotedService = quoteShell(serviceLabel);

  console.log("\nLakebed proxy is serving.");
  console.log(`Deploy ID:  ${deployId}`);
  console.log(`Deploy URL: ${deployUrl}`);
  console.log(`URL changed this run: ${urlChanged ? "yes" : "no"}`);
  console.log("");
  console.log(`HTTP Proxy:  ${host}:${port}`);
  console.log(`HTTPS Proxy: ${host}:${port}`);
  console.log("");
  if (!service) {
    console.log("I could not detect your active macOS network service. Replace <service> below with something like Wi-Fi.");
    console.log("List services with: networksetup -listallnetworkservices");
    console.log("");
  }
  console.log("Enable macOS proxies:");
  console.log(`  networksetup -setwebproxy ${quotedService} ${host} ${port}`);
  console.log(`  networksetup -setsecurewebproxy ${quotedService} ${host} ${port}`);
  console.log("");
  console.log("Disable macOS proxies:");
  console.log(`  networksetup -setwebproxystate ${quotedService} off`);
  console.log(`  networksetup -setsecurewebproxystate ${quotedService} off`);
  console.log("");
  console.log("HTTP requests go through Lakebed. HTTPS uses a local CONNECT tunnel.");
  console.log("Press Ctrl-C to stop the local proxy.");
}

function readFlagValue(args, index, flag) {
  const arg = args[index];
  const prefix = `${flag}=`;
  if (arg.startsWith(prefix)) {
    return { consumed: 1, value: arg.slice(prefix.length) };
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return { consumed: 2, value };
}

function parseRunOptions(args) {
  const options = {
    api: DEFAULT_API,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT
  };

  for (let index = 0; index < args.length;) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      usage(0);
    }
    if (arg === "--host" || arg.startsWith("--host=")) {
      const parsed = readFlagValue(args, index, "--host");
      options.host = parsed.value;
      index += parsed.consumed;
      continue;
    }
    if (arg === "--port" || arg.startsWith("--port=")) {
      const parsed = readFlagValue(args, index, "--port");
      const port = Number(parsed.value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("--port must be a valid TCP port.");
      }
      options.port = port;
      index += parsed.consumed;
      continue;
    }
    if (arg === "--api" || arg.startsWith("--api=")) {
      const parsed = readFlagValue(args, index, "--api");
      try {
        options.api = new URL(parsed.value).toString().replace(/\/+$/, "");
      } catch {
        throw new Error("--api must be a valid URL.");
      }
      index += parsed.consumed;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (!options.host) {
    throw new Error("--host cannot be empty.");
  }

  return options;
}

async function run(options) {
  const { api, host, port } = options;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("--port must be a valid TCP port.");
  }

  const previousState = await readJson(STATE_PATH);
  const state = await ensureClaimedDeploy(previousState, api);
  await startProxyServer({ host, port, deployUrl: state.url });
  await printReadyInstructions({ deployId: state.deployId, deployUrl: state.url, urlChanged: state.urlChanged, host, port });
}

async function main() {
  const [, , command, ...rest] = process.argv;
  if (command === "--help" || command === "-h") {
    usage(0);
  }
  if (command !== "run") {
    usage(command ? 1 : 0);
  }
  await run(parseRunOptions(rest));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
