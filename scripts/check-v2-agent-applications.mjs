import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_APPLICATIONS_ROOT = path.join(ROOT, "v2_agent");
const REQUIRED_CHECKS = Object.freeze([
  "streaming",
  "toolCall",
  "encryptedRelay",
  "markerReturn",
  "sameThreadFollowUp",
]);
const APPLICATION_STATUSES = new Set(["draft", "accepted", "rejected"]);
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9._-]*$/i;

function fail(message) {
  throw new Error(`v2-agent application: ${message}`);
}

function directories(root) {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name)
    .sort();
}

function secretLike(value) {
  // Evidence is intentionally summaries and metadata. A proof must never turn
  // into a durable copy of an API key, bearer capability, or decrypted task.
  return /(?:\b(?:sk|rk|sess|token)_[a-z0-9_-]{12,}\b|authorization\s*:\s*bearer|bearer\s+[a-z0-9._-]{16,})/i.test(value);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    fail(`${file}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
}

function checkPass(check, label) {
  if (!check || check.outcome !== "pass") fail(`${label} must record outcome: "pass"`);
  if (!Number.isInteger(check.status) || check.status < 200 || check.status > 299) {
    fail(`${label} must record a successful HTTP status`);
  }
  if (!Number.isFinite(Date.parse(check.observedAt || ""))) {
    fail(`${label} must record an ISO observedAt timestamp`);
  }
}

function checkAcceptedProof(proof, location) {
  if (!Array.isArray(proof.officialSources) || proof.officialSources.length === 0 ||
      proof.officialSources.some((source) => typeof source !== "string" || !/^https:\/\//.test(source))) {
    fail(`${location}: accepted applications need one or more HTTPS officialSources`);
  }
  for (const key of REQUIRED_CHECKS) checkPass(proof.checks?.[key], `${location}: checks.${key}`);
  if (!Number.isFinite(Date.parse(proof.testedAt || ""))) {
    fail(`${location}: accepted applications need an ISO testedAt timestamp`);
  }
  if (typeof proof.routerVersion !== "string" || !proof.routerVersion.trim()) {
    fail(`${location}: accepted applications need routerVersion`);
  }
}

export function validateV2AgentApplications(applicationsRoot = DEFAULT_APPLICATIONS_ROOT) {
  const applications = [];
  for (const provider of directories(applicationsRoot)) {
    if (!SAFE_SEGMENT.test(provider)) fail(`invalid provider directory ${provider}`);
    const providerRoot = path.join(applicationsRoot, provider);
    for (const model of directories(providerRoot)) {
      if (!SAFE_SEGMENT.test(model)) fail(`invalid model directory ${provider}/${model}`);
      const location = `${provider}/${model}`;
      const root = path.join(providerRoot, model);
      const markdown = path.join(root, "proof.md");
      const json = path.join(root, "proof.json");
      if (!existsSync(markdown) || !statSync(markdown).isFile()) fail(`${location} is missing proof.md`);
      if (!existsSync(json) || !statSync(json).isFile()) fail(`${location} is missing proof.json`);
      const markdownText = readFileSync(markdown, "utf8");
      if (!markdownText.includes("## Evidence")) fail(`${location}: proof.md needs an Evidence section`);
      const proof = readJson(json);
      if (proof?.version !== 1) fail(`${location}: proof.json version must be 1`);
      if (proof.provider !== provider || proof.model !== model) {
        fail(`${location}: proof.json provider and model must match its directory`);
      }
      if (typeof proof.slug !== "string" || !proof.slug.includes("/")) {
        fail(`${location}: proof.json needs the exact routed slug`);
      }
      if (!APPLICATION_STATUSES.has(proof.status)) fail(`${location}: invalid status`);
      const serialized = `${markdownText}\n${JSON.stringify(proof)}`;
      if (secretLike(serialized)) fail(`${location}: proof artifacts must not contain credentials or bearer values`);
      if (proof.status === "accepted") checkAcceptedProof(proof, location);
      applications.push({ provider, model, slug: proof.slug, status: proof.status });
    }
  }
  return applications;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const applications = validateV2AgentApplications(process.argv[2] || DEFAULT_APPLICATIONS_ROOT);
  process.stdout.write(`v2-agent applications valid (${applications.length})\n`);
}
