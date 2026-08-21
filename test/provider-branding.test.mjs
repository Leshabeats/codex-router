import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("provider and model-maker branding covers remote and local catalog families", async () => {
  const branding = await readFile(new URL("apps/control-center/src/provider-branding.tsx", root), "utf8");
  const sources = await readFile(new URL("apps/control-center/src/assets/providers/SOURCES.md", root), "utf8");
  const local = await readFile(new URL("apps/control-center/src/pages/LocalPage.tsx", root), "utf8");

  for (const asset of ["cognition", "deepreinforce", "kilo", "lmstudio", "poolside", "tencent"]) {
    assert.match(branding, new RegExp(`assets/providers/${asset}\\.svg`), `${asset} logo is not bundled`);
    assert.match(sources, new RegExp(`${asset}\\.svg`), `${asset} source is not recorded`);
  }

  for (const providerId of [
    "devin-cli", "kilo-free", "kimi-api-cn", "lmstudio", "opencode-free",
    "xiaomi-mimo", "zai-api",
  ]) {
    assert.match(branding, new RegExp(`"${providerId}":`), `${providerId} falls back to a monogram`);
  }

  assert.match(branding, /muse spark[^\n]+BRANDS\.meta/);
  assert.match(branding, /ornith[^\n]+BRANDS\.deepreinforce/);
  assert.match(branding, /hy3[^\n]+BRANDS\.tencent/);
  assert.match(branding, /laguna[^\n]+BRANDS\.poolside/);
  assert.match(branding, /export function brandForLocalModel/);
  assert.match(local, /brandForLocalModel/);
  assert.match(local, /<BrandLogo brand=\{brandForLocalModel\(model\)\}/);
  assert.match(sources, /tencent\.com\/tencent-hunyuan-officially-releases-hy3/);
  assert.match(sources, /tencent-web\/assets\/favicon\/safari-pinned-tab\.svg/);
  assert.match(sources, /CognitionAI\/devin-extension[^|]+devin-full-color\.png/);
  assert.match(sources, /ornith-ai\/Ornith-1[^|]+ornith_logo\.png/);
  assert.doesNotMatch(sources, /avatars\.githubusercontent\.com/);
  assert.match(branding, /cognition:[^\n]+name: "Devin"/);
  assert.match(branding, /deepreinforce:[^\n]+name: "Ornith"/);
});
