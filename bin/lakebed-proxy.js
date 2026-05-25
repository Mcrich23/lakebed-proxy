#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import net from "node:net";
import tls from "node:tls";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8080;
const DEFAULT_API = "https://api.lakebed.app";
const CACHE_DIR = join(homedir(), ".lakebed-proxy");
const CAPSULE_DIR = join(CACHE_DIR, "capsule");
const CA_DIR = join(CACHE_DIR, "ca");
const CERTS_DIR = join(CA_DIR, "certs");
const CA_KEY_PATH = join(CA_DIR, "lakebed-proxy-ca.key");
const CA_CERT_PATH = join(CA_DIR, "lakebed-proxy-ca.crt");
const CA_SERIAL_PATH = join(CA_DIR, "lakebed-proxy-ca.srl");
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
  lakebed-proxy run [--host 127.0.0.1] [--port 8080] [--api https://api.lakebed.app] [--auto]

Flags:
  --host <host>  Host to bind. Defaults to ${DEFAULT_HOST}.
  --port <port>  Port to bind. Defaults to ${DEFAULT_PORT}.
  --api <url>    Lakebed API URL. Defaults to ${DEFAULT_API}.
  --auto         Configure Wi-Fi web proxies while running, then restore them on shutdown.
  --help         Show this help.

GitHub:
  npx github:<owner>/lakebed-proxy run
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

async function fileExists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
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

async function runQuiet(command, args) {
  try {
    return await runCommand(command, args);
  } catch (error) {
    error.command = command;
    error.args = args;
    throw error;
  }
}

async function runOpenSsl(args) {
  return runCommand("openssl", args);
}

async function commandExists(command) {
  try {
    await runCommand("which", [command]);
    return true;
  } catch {
    return false;
  }
}

async function caSha256Fingerprint() {
  const { stdout } = await runOpenSsl(["x509", "-in", CA_CERT_PATH, "-noout", "-fingerprint", "-sha256"]);
  return stdout.trim().replace(/^sha256 Fingerprint=/i, "").replaceAll(":", "").toUpperCase();
}

async function isCaTrusted() {
  if (process.platform !== "darwin") {
    return false;
  }

  const expected = await caSha256Fingerprint();
  const keychains = ["/Library/Keychains/System.keychain", join(homedir(), "Library/Keychains/login.keychain-db")];
  for (const keychain of keychains) {
    try {
      const { stdout } = await runQuiet("security", ["find-certificate", "-a", "-Z", "-c", "lakebed-proxy local MITM CA", keychain]);
      const matches = stdout.match(/SHA-256 hash: ([A-Fa-f0-9]+)/g) || [];
      if (matches.some((line) => line.replace(/^SHA-256 hash: /, "").toUpperCase() === expected)) {
        return true;
      }
    } catch {
      // Missing keychains or no matching cert just mean this CA is not trusted there.
    }
  }
  return false;
}

async function assertCaTrustedForAuto() {
  if (process.platform !== "darwin") {
    throw new Error("--auto is only supported on macOS.");
  }
  if (!(await isCaTrusted())) {
    throw new Error(
      `--auto requires the generated HTTPS MITM CA to be trusted first.\n\nRun:\n  security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db ${quoteShell(CA_CERT_PATH)}\n\nThen rerun lakebed-proxy run --auto.`
    );
  }
}

async function runLakebed(args, { inherit = false } = {}) {
  const stdio = inherit ? "inherit" : "pipe";
  if (await commandExists("pnpm")) {
    return runCommand("pnpm", ["dlx", "lakebed", ...args], { stdio });
  }
  return runCommand("npx", ["-y", "lakebed", ...args], { stdio });
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

function safeCertName(host) {
  return Buffer.from(host.toLowerCase()).toString("base64url");
}

function isIpAddress(host) {
  return net.isIP(host) !== 0;
}

function validateConnectHost(host) {
  if (!host || host.length > 253) {
    return false;
  }
  if (isIpAddress(host)) {
    return true;
  }
  return /^[a-z0-9.-]+$/i.test(host) && !host.startsWith(".") && !host.endsWith(".");
}

async function ensureCa() {
  await mkdir(CA_DIR, { recursive: true });
  await mkdir(CERTS_DIR, { recursive: true });
  if ((await fileExists(CA_KEY_PATH)) && (await fileExists(CA_CERT_PATH))) {
    return;
  }

  console.log("Generating local lakebed-proxy MITM CA...");
  await runOpenSsl(["genrsa", "-out", CA_KEY_PATH, "2048"]);
  await runOpenSsl([
    "req",
    "-x509",
    "-new",
    "-nodes",
    "-key",
    CA_KEY_PATH,
    "-sha256",
    "-days",
    "3650",
    "-subj",
    "/CN=lakebed-proxy local MITM CA",
    "-out",
    CA_CERT_PATH
  ]);
}

function certConfigForHost(host) {
  const altKind = isIpAddress(host) ? "IP" : "DNS";
  return `[req]
distinguished_name=req_distinguished_name
req_extensions=v3_req
prompt=no

[req_distinguished_name]
CN=${host}

[v3_req]
subjectAltName=@alt_names

[alt_names]
${altKind}.1=${host}
`;
}

async function ensureHostCert(host) {
  await ensureCa();
  const name = safeCertName(host);
  const keyPath = join(CERTS_DIR, `${name}.key`);
  const certPath = join(CERTS_DIR, `${name}.crt`);
  const csrPath = join(CERTS_DIR, `${name}.csr`);
  const configPath = join(CERTS_DIR, `${name}.conf`);

  if ((await fileExists(keyPath)) && (await fileExists(certPath))) {
    return { cert: await readFile(certPath), key: await readFile(keyPath) };
  }

  await writeFile(configPath, certConfigForHost(host));
  await runOpenSsl(["genrsa", "-out", keyPath, "2048"]);
  await runOpenSsl(["req", "-new", "-key", keyPath, "-out", csrPath, "-config", configPath]);
  await runOpenSsl([
    "x509",
    "-req",
    "-in",
    csrPath,
    "-CA",
    CA_CERT_PATH,
    "-CAkey",
    CA_KEY_PATH,
    "-CAserial",
    CA_SERIAL_PATH,
    "-CAcreateserial",
    "-out",
    certPath,
    "-days",
    "825",
    "-sha256",
    "-extensions",
    "v3_req",
    "-extfile",
    configPath
  ]);

  return { cert: await readFile(certPath), key: await readFile(keyPath) };
}

async function relayRequestThroughLakebed({ bodyMaxBytes, lakebedClient, protocol, req, res, targetHost }) {
  const started = Date.now();
  const target = protocol === "https:" ? new URL(req.url || "/", `https://${targetHost}`) : parseProxyTarget(req);
  if (!target) {
    writePlain(res, 400, "Expected an absolute http:// URL in proxy request.\n");
    return;
  }

  try {
    const body = await collectRequestBody(req, bodyMaxBytes);
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
  await relayRequestThroughLakebed({
    bodyMaxBytes: 2 * 1024 * 1024,
    lakebedClient,
    protocol: "http:",
    req,
    res,
    targetHost: ""
  });
}

async function handleConnect(req, clientSocket, head, mitmHttpServer) {
  const started = Date.now();
  const [host, portText = "443"] = String(req.url || "").split(":");
  const port = Number(portText);
  if (!validateConnectHost(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    clientSocket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
    clientSocket.destroy();
    return;
  }

  if (port !== 443) {
    clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\nlakebed-proxy MITM only supports CONNECT to port 443.\n");
    clientSocket.destroy();
    console.log(`CONNECT ${host}:${port} -> 403 unsupported port ${Date.now() - started}ms mitm`);
    return;
  }

  try {
    const { cert, key } = await ensureHostCert(host);
    const secureContext = tls.createSecureContext({ cert, key });
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const tlsSocket = new tls.TLSSocket(clientSocket, {
      ALPNProtocols: ["http/1.1"],
      isServer: true,
      secureContext
    });

    tlsSocket.on("error", (error) => {
      console.log(`CONNECT ${host}:${port} -> TLS ${error.message} ${Date.now() - started}ms mitm`);
    });
    if (head?.length) {
      tlsSocket.unshift(head);
    }
    tlsSocket.once("secure", () => {
      tlsSocket.lakebedProxyTargetHost = host;
      mitmHttpServer.emit("connection", tlsSocket);
      console.log(`CONNECT ${host}:${port} -> mitm ${Date.now() - started}ms lakebed`);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create MITM certificate.";
    if (!clientSocket.destroyed) {
      clientSocket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      clientSocket.destroy();
    }
    console.log(`CONNECT ${host}:${port} -> 502 ${message} ${Date.now() - started}ms mitm`);
  }
}

function startProxyServer({ host, port, deployUrl }) {
  const lakebedClient = new LakebedMutationClient(deployUrl);
  const mitmHttpServer = createServer((req, res) => {
    const targetHost = req.socket.lakebedProxyTargetHost;
    void relayRequestThroughLakebed({
      bodyMaxBytes: 2 * 1024 * 1024,
      lakebedClient,
      protocol: "https:",
      req,
      res,
      targetHost
    });
  });
  const server = createServer((req, res) => {
    void handleHttpProxy(req, res, lakebedClient);
  });
  server.on("connect", (req, socket, head) => {
    void handleConnect(req, socket, head, mitmHttpServer);
  });
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

function parseNetworksetupProxy(output) {
  const valueFor = (label) => output.match(new RegExp(`^${label}:\\s*(.*)$`, "m"))?.[1]?.trim() || "";
  return {
    authenticated: /^(1|yes)$/i.test(valueFor("Authenticated Proxy Enabled")),
    enabled: /^yes$/i.test(valueFor("Enabled")),
    port: valueFor("Port"),
    server: valueFor("Server")
  };
}

async function readWifiProxySettings() {
  const [web, secureWeb] = await Promise.all([
    runQuiet("networksetup", ["-getwebproxy", "Wi-Fi"]),
    runQuiet("networksetup", ["-getsecurewebproxy", "Wi-Fi"])
  ]);
  return {
    secureWeb: parseNetworksetupProxy(secureWeb.stdout),
    web: parseNetworksetupProxy(web.stdout)
  };
}

async function applyProxyKind(kind, settings) {
  const command = kind === "secureWeb" ? "-setsecurewebproxy" : "-setwebproxy";
  const stateCommand = kind === "secureWeb" ? "-setsecurewebproxystate" : "-setwebproxystate";
  if (settings.server && settings.port) {
    const args = ["Wi-Fi", settings.server, settings.port];
    if (settings.authenticated) {
      throw new Error("Cannot restore an authenticated Wi-Fi proxy because networksetup does not reveal its password.");
    }
    await runQuiet("networksetup", [command, ...args]);
  }
  await runQuiet("networksetup", [stateCommand, "Wi-Fi", settings.enabled ? "on" : "off"]);
}

async function applyAutoProxy({ host, port }) {
  if (process.platform !== "darwin") {
    throw new Error("--auto is only supported on macOS.");
  }

  const original = await readWifiProxySettings();
  if (original.web.authenticated || original.secureWeb.authenticated) {
    throw new Error("--auto cannot safely restore authenticated Wi-Fi proxy settings because macOS does not reveal proxy passwords.");
  }

  await runQuiet("networksetup", ["-setwebproxy", "Wi-Fi", host, String(port)]);
  await runQuiet("networksetup", ["-setsecurewebproxy", "Wi-Fi", host, String(port)]);
  await runQuiet("networksetup", ["-setwebproxystate", "Wi-Fi", "on"]);
  await runQuiet("networksetup", ["-setsecurewebproxystate", "Wi-Fi", "on"]);
  console.log("Configured Wi-Fi HTTP and HTTPS proxies for lakebed-proxy.");

  let restored = false;
  return async function restoreAutoProxy() {
    if (restored) {
      return;
    }
    restored = true;
    console.log("\nRestoring original Wi-Fi proxy settings...");
    await applyProxyKind("web", original.web);
    await applyProxyKind("secureWeb", original.secureWeb);
    console.log("Original Wi-Fi proxy settings restored.");
  };
}

function installShutdownRestore(restore) {
  let shuttingDown = false;
  const shutdown = async (signalOrCode = 0) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    try {
      await restore();
    } catch (error) {
      console.error(`Failed to restore Wi-Fi proxy settings: ${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(typeof signalOrCode === "number" ? signalOrCode : 0);
  };

  process.once("SIGINT", () => {
    void shutdown(0);
  });
  process.once("SIGTERM", () => {
    void shutdown(0);
  });
  process.once("uncaughtException", (error) => {
    console.error(error);
    void shutdown(1);
  });
  process.once("unhandledRejection", (error) => {
    console.error(error);
    void shutdown(1);
  });
}

async function printReadyInstructions({ auto, deployId, deployUrl, urlChanged, host, port }) {
  const service = auto ? "Wi-Fi" : await detectMacNetworkService();
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
  console.log("Trust the local CA for HTTPS MITM:");
  console.log(`  security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db ${quoteShell(CA_CERT_PATH)}`);
  console.log("");
  if (auto) {
    console.log("--auto is enabled: Wi-Fi proxy settings were applied and will be restored on shutdown.");
    console.log("");
  } else if (!service) {
    console.log("I could not detect your active macOS network service. Replace <service> below with something like Wi-Fi.");
    console.log("List services with: networksetup -listallnetworkservices");
    console.log("");
  }
  if (!auto) {
    console.log("Enable macOS proxies:");
    console.log(`  networksetup -setwebproxy ${quotedService} ${host} ${port}`);
    console.log(`  networksetup -setsecurewebproxy ${quotedService} ${host} ${port}`);
    console.log("");
    console.log("Disable macOS proxies:");
    console.log(`  networksetup -setwebproxystate ${quotedService} off`);
    console.log(`  networksetup -setsecurewebproxystate ${quotedService} off`);
    console.log("");
  }
  console.log("HTTP and HTTPS requests go through Lakebed. HTTPS is decrypted locally with the generated CA.");
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
    auto: false,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT
  };

  for (let index = 0; index < args.length;) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      usage(0);
    }
    if (arg === "--auto") {
      options.auto = true;
      index += 1;
      continue;
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
  const { api, auto, host, port } = options;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("--port must be a valid TCP port.");
  }

  await ensureCa();
  if (auto) {
    await assertCaTrustedForAuto();
  }

  const previousState = await readJson(STATE_PATH);
  const state = await ensureClaimedDeploy(previousState, api);
  const server = await startProxyServer({ host, port, deployUrl: state.url });
  let restore = null;
  try {
    restore = auto ? await applyAutoProxy({ host, port }) : null;
  } catch (error) {
    server.close();
    throw error;
  }
  if (restore) {
    installShutdownRestore(restore);
  }
  await printReadyInstructions({ auto, deployId: state.deployId, deployUrl: state.url, urlChanged: state.urlChanged, host, port });
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
