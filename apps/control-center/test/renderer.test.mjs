import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(appRoot, "dist");

const bridgeSource = String.raw`
(() => {
  const calls = [];
  const subagents = { mode: "all", enabled: [], disabled: [], efforts: {}, proofs: {} };
  const selectedModel = {
    slug: "deepseek/deepseek-chat",
    displayName: "DeepSeek Chat",
    description: "Selected route used by the renderer fixture.",
    provider: "deepseek",
    enabled: true,
    visible: true,
    multiAgentVersion: "v1",
    subagentCertification: "v1",
    reasoningLevels: ["low", "medium", "high"],
    contextWindow: 128000,
    inputModalities: ["text"],
  };
  const target = {
    target: "codex",
    configured: true,
    active: true,
    enabledProviders: ["deepseek"],
    providers: [
      { id: "deepseek", displayName: "DeepSeek", kind: "api" },
      { id: "kilo-free", displayName: "Kilo Free", kind: "anonymous" },
    ],
    models: [selectedModel],
    modelSettings: {
      subagents,
      picker: { hidden: [], visible: [selectedModel.slug], hasExplicitVisibility: true },
      localModels: {},
      visionBridge: { enabled: false },
    },
  };
  const snapshot = {
    targets: { codex: target },
    catalog: {
      source: "codex-router",
      configured: true,
      enabledProviders: ["deepseek"],
      models: [selectedModel],
      picker: { hidden: [], visible: [selectedModel.slug], hasExplicitVisibility: true },
      subagents,
    },
    chatgptSession: { sharing: "disabled", session: "unavailable", present: false },
  };
  const providers = {
    providers: [
      {
        id: "deepseek",
        displayName: "DeepSeek",
        kind: "api",
        configured: true,
        action: "ready",
        credentialLabel: "DeepSeek API key",
        catalogSources: [{ id: "deepseek", displayName: "DeepSeek", kind: "models-endpoint" }],
      },
      {
        id: "kilo-free",
        displayName: "Kilo Free",
        kind: "anonymous",
        configured: true,
        action: "anonymous",
        credentialLabel: "No API key",
        catalogSources: [{ id: "kilo-free", displayName: "Kilo Free", kind: "models-endpoint" }],
      },
    ],
  };

  const record = (name, ...args) => calls.push({ name, args });
  const catalog = (providerId) => {
    record("discoverProviderModels", providerId);
    if (providerId === "kilo-free") {
      return {
        provider: providerId,
        discovered: ["kilo-unselected-free"],
        registered: [],
        unregistered: ["kilo-unselected-free"],
        addable: ["kilo-unselected-free"],
        blocked: {},
        unavailable: [],
        free: ["kilo-unselected-free"],
      };
    }
    return {
      provider: providerId,
      discovered: ["catalog-addable", "blocked-preview"],
      registered: [],
      unregistered: ["catalog-addable", "blocked-preview"],
      addable: ["catalog-addable"],
      blocked: { "blocked-preview": "No certified protocol route is available." },
      unavailable: [],
      contextLengths: { "catalog-addable": 200000, "blocked-preview": 128000 },
      fetchedAt: "2026-08-24T00:00:00.000Z",
    };
  };

  window.routerControl = Object.freeze({
    platform: navigator.platform.toLowerCase().includes("mac") ? "darwin" : "linux",
    getSnapshot: async () => snapshot,
    getProviders: async () => providers,
    getPresence: async () => ({ mode: "always" }),
    getHealth: async () => ({ ok: true, activity: { state: "idle", active: [], activeCount: 0 } }),
    getAccountUsage: async () => ({}),
    getProviderUsage: async () => ({ providers: [] }),
    discoverProviderModels: async (providerId) => catalog(providerId),
    addProviderModels: async (providerId, modelIds) => {
      record("addProviderModels", providerId, [...modelIds]);
      return { ok: true };
    },
    setPickerModels: async (showAll) => {
      record("setPickerModels", showAll);
      return { ok: true };
    },
    setPickerModel: async () => ({ ok: true }),
    setProviderEnabled: async () => ({ ok: true }),
    setSubagentModel: async () => ({ ok: true }),
    setSubagentEffort: async () => ({ ok: true }),
    onOperation: () => () => {},
  });
  window.routerControlTest = Object.freeze({
    calls: () => calls.map((call) => ({ name: call.name, args: call.args })),
  });
})();
`;

function mimeType(filePath) {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  return "application/octet-stream";
}

function serveRenderer() {
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    if (pathname === "/test-bridge.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(bridgeSource);
      return;
    }
    if (pathname === "/favicon.ico") {
      response.writeHead(204).end();
      return;
    }
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const target = path.resolve(dist, relative);
    if (target !== dist && !target.startsWith(`${dist}${path.sep}`) || !existsSync(target)) {
      response.writeHead(404).end("not found");
      return;
    }
    let contents = readFileSync(target);
    if (relative === "index.html") {
      const html = contents.toString("utf8");
      assert.match(html, /<script type="module"/);
      contents = Buffer.from(
        html.replace('<script type="module"', '<script src="./test-bridge.js"></script><script type="module"'),
      );
    }
    response.writeHead(200, { "content-type": mimeType(target) });
    response.end(contents);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        close: () => new Promise((done) => {
          server.close(done);
          server.closeAllConnections?.();
        }),
      });
    });
  });
}

const chromiumPath = [
  process.env.CODEX_ROUTER_TEST_CHROMIUM,
  chromium.executablePath(),
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe"),
  process.env["PROGRAMFILES(X86)"] && path.join(process.env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe"),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe"),
].find((candidate) => candidate && existsSync(candidate));

test("the production renderer exposes model discovery and picker actions", { timeout: 60_000 }, async () => {
  assert.equal(existsSync(path.join(dist, "index.html")), true, "npm test must build the renderer first");
  assert.ok(chromiumPath, "No Chromium executable is available for the Control Center renderer test.");

  const { url, close } = await serveRenderer();
  const browser = await chromium.launch({
    executablePath: chromiumPath,
    headless: true,
    args: process.platform === "linux" ? ["--no-sandbox"] : [],
  });
  const pageErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 840 } });
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") pageErrors.push(message.text());
    });

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.getByRole("navigation", { name: "Control center sections" }).waitFor();
    await page.getByRole("button", { name: "Models", exact: true }).click();
    await page.locator('input[placeholder="Search all providers"]').waitFor();

    const anonymousRow = page.locator(".pm-provider-row").filter({ hasText: "Kilo Free" });
    await anonymousRow.waitFor();
    assert.equal(await anonymousRow.getAttribute("data-connection"), "setup");
    assert.match(await anonymousRow.innerText(), /not connected/i);

    await page.getByRole("button", { name: "Load connected catalogs", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll("button")]
      .some((button) => button.textContent?.trim() === "Load connected catalogs"));
    const bulkCatalogProviders = await page.evaluate(() => window.routerControlTest.calls()
      .filter((call) => call.name === "discoverProviderModels")
      .map((call) => call.args[0]));
    assert.deepEqual(bulkCatalogProviders, ["deepseek"]);

    const search = page.locator('input[placeholder="Search selected models or loaded catalogs"]');
    await search.fill("catalog-addable");
    const addableRow = page.locator(".pm-catalog-search-row").filter({ hasText: "catalog-addable" });
    await addableRow.waitFor();
    await addableRow.getByRole("button", { name: "Add", exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "addProviderModels"));

    await search.fill("blocked-preview");
    const blockedRow = page.locator(".pm-catalog-search-row").filter({ hasText: "blocked-preview" });
    await blockedRow.waitFor();
    const blockedButton = blockedRow.getByRole("button", { name: "Protocol pending", exact: true });
    assert.equal(await blockedButton.isDisabled(), true);
    assert.equal(
      await blockedRow.locator(".pm-catalog-block-reason").innerText(),
      "No certified protocol route is available.",
    );

    await page.getByRole("button", { name: "Show all", exact: true }).click();
    await page.waitForFunction(() => window.routerControlTest.calls()
      .some((call) => call.name === "setPickerModels" && call.args[0] === true));

    const calls = await page.evaluate(() => window.routerControlTest.calls());
    assert.deepEqual(calls.find((call) => call.name === "addProviderModels")?.args, [
      "deepseek",
      ["catalog-addable"],
    ]);
    assert.equal(calls.some((call) => call.name === "setPickerModels" && call.args[0] === true), true);
    assert.deepEqual(pageErrors, [], `renderer errors: ${pageErrors.join("; ")}`);
  } finally {
    await browser.close();
    await close();
  }
});
