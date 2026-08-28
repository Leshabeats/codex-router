import { randomBytes } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

import { assertCallerSecret } from "./caller-auth.mjs";
import { protectPrivateFile } from "./file-security.mjs";

function removeIfPresent(target) {
  if (existsSync(target)) unlinkSync(target);
}

export async function rotateCallerCapability({
  secretPath,
  generateSecret = () => randomBytes(48).toString("base64url"),
  protect = protectPrivateFile,
  apply = async () => {},
  verify = async () => {},
} = {}) {
  const previousSecret = assertCallerSecret(readFileSync(secretPath, "utf8").trim());
  const currentSecret = assertCallerSecret(String(generateSecret()).trim());
  if (currentSecret === previousSecret) {
    throw new Error("Caller capability rotation generated the existing key.");
  }

  const nonce = `${process.pid}.${Date.now()}`;
  const temporary = `${secretPath}.rotate-new.${nonce}`;
  const backup = `${secretPath}.rotate-rollback.${nonce}`;
  writeFileSync(temporary, `${currentSecret}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  protect(temporary);
  let backupPresent = false;
  let newSecretLive = false;
  try {
    renameSync(secretPath, backup);
    backupPresent = true;
    protect(backup);
    renameSync(temporary, secretPath);
    newSecretLive = true;
    protect(secretPath);

    await apply();
    await verify({ previousSecret, currentSecret });

    unlinkSync(backup);
    backupPresent = false;
    return { rotated: true };
  } catch (error) {
    let rollbackError;
    try {
      if (newSecretLive) removeIfPresent(secretPath);
      if (backupPresent && existsSync(backup)) {
        renameSync(backup, secretPath);
        backupPresent = false;
        protect(secretPath);
      }
      if (newSecretLive) await apply();
    } catch (caught) {
      rollbackError = caught;
    }

    removeIfPresent(temporary);
    if (rollbackError) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        { cause: error },
      );
    }
    throw error;
  } finally {
    removeIfPresent(temporary);
  }
}