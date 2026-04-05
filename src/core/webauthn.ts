/**
 * WebAuthn / Passkey support for Reef.
 *
 * Provider-agnostic: works with YubiKey, 1Password, Chrome, Firefox,
 * iCloud Keychain, or any FIDO2/WebAuthn-compliant authenticator.
 *
 * Supports multi-root: multiple passkeys can be registered. Each is
 * an independent trust root. Policy governs quorum for add/revoke.
 *
 * Public keys are stored in the principal registry alongside AGENTS.md
 * and propagated to children through the trust tree.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import type {
  AuthenticatorTransportFuture,
  Base64URLString,
  CredentialDeviceType,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/server";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PasskeyCredential {
  id: Base64URLString;
  publicKey: string; // base64url-encoded
  counter: number;
  deviceType: CredentialDeviceType;
  backedUp: boolean;
  transports?: AuthenticatorTransportFuture[];
  providerHint?: string; // "1password", "yubikey", "chrome", etc. — cosmetic
  registeredAt: number; // epoch ms
  label?: string; // user-assigned name
}

export interface PrincipalRegistry {
  schema: 1;
  operatorName?: string;
  credentials: PasskeyCredential[];
  policy: {
    /** Minimum credentials to verify identity (normal auth) */
    verifyMin: number;
    /** Minimum credentials to add a new root */
    addRootMin: number;
    /** Minimum credentials to revoke a root */
    revokeMin: number;
  };
  pendingChallenge?: string; // transient, not persisted to children
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

const REGISTRY_PATH = "data/principal-registry.json";

export function readRegistry(): PrincipalRegistry {
  try {
    if (existsSync(REGISTRY_PATH)) {
      return JSON.parse(readFileSync(REGISTRY_PATH, "utf-8"));
    }
  } catch {}
  return {
    schema: 1,
    credentials: [],
    policy: { verifyMin: 1, addRootMin: 1, revokeMin: 1 },
  };
}

export function writeRegistry(reg: PrincipalRegistry): void {
  if (!existsSync("data")) mkdirSync("data", { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2));
}

/**
 * Export the registry for propagation to children.
 * Strips transient fields (pendingChallenge).
 */
export function exportableRegistry(reg: PrincipalRegistry): PrincipalRegistry {
  const { pendingChallenge: _, ...clean } = reg;
  return clean;
}

// ---------------------------------------------------------------------------
// Relying Party config — derived from environment
// ---------------------------------------------------------------------------

function rpConfig() {
  const vmId = process.env.VERS_VM_ID || "localhost";
  const rpID = process.env.REEF_WEBAUTHN_RP_ID || `${vmId}.vm.vers.sh`;
  const rpName = process.env.REEF_WEBAUTHN_RP_NAME || "Reef Fleet";
  const origin = process.env.REEF_WEBAUTHN_ORIGIN || `https://${rpID}:3000`;
  return { rpID, rpName, origin };
}

// ---------------------------------------------------------------------------
// Registration (adding a new passkey root)
// ---------------------------------------------------------------------------

export async function startRegistration(
  operatorName: string,
  hint?: string,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const { rpID, rpName } = rpConfig();
  const reg = readRegistry();

  // Map hint to authenticatorAttachment for broader compatibility,
  // and pass hint through for Level 3 browsers
  const authenticatorAttachment =
    hint === "security-key"
      ? ("cross-platform" as const)
      : hint === "client-device"
        ? ("platform" as const)
        : undefined;

  const genOpts: any = {
    rpName,
    rpID,
    userName: operatorName,
    userDisplayName: operatorName,
    excludeCredentials: reg.credentials.map((c) => ({
      id: c.id,
      transports: c.transports,
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
      ...(authenticatorAttachment ? { authenticatorAttachment } : {}),
    },
    attestationType: "direct",
  };

  const options: any = await generateRegistrationOptions(genOpts);

  // Inject Level 3 hints for browsers that support them
  if (hint) {
    options.hints = [hint];
  }

  // Store challenge for verification
  reg.pendingChallenge = options.challenge;
  if (operatorName) reg.operatorName = operatorName;
  writeRegistry(reg);

  return options;
}

export async function finishRegistration(
  response: any,
  providerHint?: string,
  label?: string,
): Promise<{ verified: boolean; credential?: PasskeyCredential }> {
  const { rpID, origin } = rpConfig();
  const reg = readRegistry();

  if (!reg.pendingChallenge) {
    return { verified: false };
  }

  // Check quorum for adding new root (if we already have credentials)
  // For the first credential, no quorum needed
  // For subsequent ones, policy.addRootMin existing credentials must have
  // recently authenticated (tracked externally for now)

  let verification: VerifiedRegistrationResponse;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: reg.pendingChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
    });
  } catch (err) {
    console.error("[webauthn] registration verification failed:", err);
    return { verified: false };
  }

  if (!verification.verified || !verification.registrationInfo) {
    return { verified: false };
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

  const passkey: PasskeyCredential = {
    id: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString("base64url"),
    counter: credential.counter,
    deviceType: credentialDeviceType as CredentialDeviceType,
    backedUp: credentialBackedUp,
    transports: (credential.transports as AuthenticatorTransportFuture[]) ?? [],
    providerHint,
    label,
    registeredAt: Date.now(),
  };

  reg.credentials.push(passkey);
  reg.pendingChallenge = undefined;

  // Auto-escalate policy when we have multiple roots
  if (reg.credentials.length >= 2) {
    reg.policy.addRootMin = Math.max(reg.policy.addRootMin, 1);
    reg.policy.revokeMin = Math.max(reg.policy.revokeMin, 1);
  }
  if (reg.credentials.length >= 3) {
    reg.policy.addRootMin = Math.max(reg.policy.addRootMin, 2);
    reg.policy.revokeMin = Math.max(reg.policy.revokeMin, 2);
  }

  writeRegistry(reg);

  return { verified: true, credential: passkey };
}

// ---------------------------------------------------------------------------
// Authentication (proving you're the operator)
// ---------------------------------------------------------------------------

export async function startAuthentication(): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const { rpID } = rpConfig();
  const reg = readRegistry();

  const options = await generateAuthenticationOptions({
    rpID,
    allowCredentials: reg.credentials.map((c) => ({
      id: c.id,
      transports: c.transports,
    })),
    userVerification: "preferred",
  });

  reg.pendingChallenge = options.challenge;
  writeRegistry(reg);

  return options;
}

export async function finishAuthentication(response: any): Promise<{ verified: boolean; credentialId?: string }> {
  const { rpID, origin } = rpConfig();
  const reg = readRegistry();

  if (!reg.pendingChallenge) {
    return { verified: false };
  }

  const matchingCred = reg.credentials.find((c) => c.id === response.id);
  if (!matchingCred) {
    return { verified: false };
  }

  let verification: VerifiedAuthenticationResponse;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: reg.pendingChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: matchingCred.id,
        publicKey: new Uint8Array(Buffer.from(matchingCred.publicKey, "base64url")),
        counter: matchingCred.counter,
        transports: matchingCred.transports,
      },
    });
  } catch (err) {
    console.error("[webauthn] authentication verification failed:", err);
    return { verified: false };
  }

  if (!verification.verified) {
    return { verified: false };
  }

  // Update counter
  matchingCred.counter = verification.authenticationInfo.newCounter;
  reg.pendingChallenge = undefined;
  writeRegistry(reg);

  return { verified: true, credentialId: matchingCred.id };
}

// ---------------------------------------------------------------------------
// Registry management
// ---------------------------------------------------------------------------

export function listCredentials(): PasskeyCredential[] {
  return readRegistry().credentials;
}

export function renameCredential(credentialId: string, label: string): { renamed: boolean } {
  const reg = readRegistry();
  const cred = reg.credentials.find((c) => c.id === credentialId);
  if (!cred) return { renamed: false };
  cred.label = label;
  writeRegistry(reg);
  return { renamed: true };
}

export function removeCredential(credentialId: string): { removed: boolean; remaining: number } {
  const reg = readRegistry();
  const before = reg.credentials.length;
  reg.credentials = reg.credentials.filter((c) => c.id !== credentialId);
  const removed = reg.credentials.length < before;
  if (removed) writeRegistry(reg);
  return { removed, remaining: reg.credentials.length };
}
