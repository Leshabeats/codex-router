import { PROVIDER_CREDENTIAL_STORE_PATH } from "./paths.mjs";
import {
  addCredentialReference,
  readProviderCredentialStore,
  removeCredentialReference,
} from "./provider-credential-store.mjs";
import { PROVIDERS } from "./model-registry.mjs";
import {
  getProviderApiKeyPool,
  setProviderApiKeyPaused,
  setProviderApiKeyPoolPolicy,
  upsertProviderApiKey,
} from "./provider-api-key-pool.mjs";

function canonicalProvider(providerId) {
  const provider = PROVIDERS.get(providerId);
  if (!provider?.credential) throw new Error(`Unknown API-key provider: ${providerId}`);
  return provider.variantOf || provider.id;
}

function storedCredential(providerId, credentialId, credentialStorePath) {
  const provider = canonicalProvider(providerId);
  const credential = readProviderCredentialStore(credentialStorePath).credentials.find(
    (entry) => entry.id === credentialId,
  );
  if (!credential || credential.providerId !== provider || credential.kind !== "api_key") {
    throw new Error(`Credential ${credentialId} is not an API key for ${provider}.`);
  }
  if (credential.state !== "active") {
    throw new Error(`Credential ${credentialId} is not active.`);
  }
  return { provider, credential };
}

export async function addStoredCredentialToPool(
  providerId,
  credentialId,
  { credentialStorePath = PROVIDER_CREDENTIAL_STORE_PATH, poolStatePath } = {},
) {
  const { provider } = storedCredential(providerId, credentialId, credentialStorePath);
  return upsertProviderApiKey(provider, { id: credentialId }, { filePath: poolStatePath });
}

export async function addEnvironmentCredentialToPool(
  providerId,
  environmentName,
  { credentialStorePath = PROVIDER_CREDENTIAL_STORE_PATH, poolStatePath } = {},
) {
  const provider = canonicalProvider(providerId);
  const credential = addCredentialReference({
    providerId: provider,
    kind: "api_key",
    secretRef: { type: "environment", name: environmentName },
  }, credentialStorePath);
  try {
    const poolCredential = await upsertProviderApiKey(
      provider,
      { id: credential.id },
      { filePath: poolStatePath },
    );
    return { credential: { id: credential.id, providerId: provider }, poolCredential };
  } catch (error) {
    removeCredentialReference(credential.id, credentialStorePath);
    throw error;
  }
}

export async function setStoredCredentialPoolState(providerId, credentialId, paused, options = {}) {
  const provider = canonicalProvider(providerId);
  return setProviderApiKeyPaused(provider, credentialId, paused, { filePath: options.poolStatePath });
}

export async function setStoredCredentialPoolPolicy(providerId, strategy, options = {}) {
  const provider = canonicalProvider(providerId);
  return setProviderApiKeyPoolPolicy(provider, { strategy }, { filePath: options.poolStatePath });
}

export function storedCredentialPoolStatus(providerId, options = {}) {
  return getProviderApiKeyPool(canonicalProvider(providerId), { filePath: options.poolStatePath });
}
