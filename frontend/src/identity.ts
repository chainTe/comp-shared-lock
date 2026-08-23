import { ccc, SignersController } from "@ckb-ccc/ccc";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { client } from "./rpc";
import { toast } from "./views/common";
import type { SigningIdentity } from "./types";

const KEY_STORAGE_KEY = "comp-identity-key";

let walletSigner: ccc.Signer | undefined;
let walletAddress: string | undefined;
let inBrowserKey: Uint8Array | undefined;
let inBrowserPublicKey: string | undefined;

export type WalletPurpose = "message" | "transaction";

export function anonymousIdentity(): SigningIdentity {
  return {
    mode: "anonymous",
    publicKey: null,
    label: "Anonymous",
  };
}

function derivePublicKeyFromKey(key: Uint8Array): string {
  return ccc.hexFrom(secp256k1.getPublicKey(key, true));
}

function signWithKey(key: Uint8Array, digest: ccc.BytesLike): string {
  const sig = secp256k1.sign(ccc.bytesFrom(digest), key, { prehash: false });
  const sigBytes = ccc.bytesConcat(
    sig.toCompactRawBytes(),
    new Uint8Array([sig.recovery ?? 0]),
  );
  return ccc.hexFrom(sigBytes);
}

export function loadInBrowserIdentity(): SigningIdentity {
  let keyHex = localStorage.getItem(KEY_STORAGE_KEY);
  if (!keyHex) {
    keyHex = ccc.hexFrom(secp256k1.utils.randomSecretKey());
    localStorage.setItem(KEY_STORAGE_KEY, keyHex);
  }
  const key = ccc.bytesFrom(keyHex);
  inBrowserKey = key;
  inBrowserPublicKey = derivePublicKeyFromKey(key);

  return {
    mode: "key",
    publicKey: inBrowserPublicKey,
    label: truncateIdentity(inBrowserPublicKey),
    signDigest: async (digest) => {
      if (!inBrowserKey) throw new Error("browser key not loaded");
      return signWithKey(inBrowserKey, digest);
    },
  };
}

export function initInBrowserPublicKey(): void {
  const keyHex = localStorage.getItem(KEY_STORAGE_KEY);
  if (keyHex) {
    inBrowserKey = ccc.bytesFrom(keyHex);
    inBrowserPublicKey = derivePublicKeyFromKey(inBrowserKey);
  }
}

export function inBrowserIdentity(): SigningIdentity {
  if (!inBrowserKey) {
    return loadInBrowserIdentity();
  }
  return {
    mode: "key",
    publicKey: inBrowserPublicKey ?? null,
    label: inBrowserPublicKey ? truncateIdentity(inBrowserPublicKey) : "Browser Key",
    signDigest: async (digest) => {
      if (!inBrowserKey) throw new Error("browser key not loaded");
      return signWithKey(inBrowserKey, digest);
    },
  };
}

export async function readyInBrowserIdentity(): Promise<SigningIdentity> {
  if (!inBrowserKey) {
    loadInBrowserIdentity();
  }
  if (!inBrowserPublicKey) {
    if (!inBrowserKey) throw new Error("browser key not loaded");
    inBrowserPublicKey = derivePublicKeyFromKey(inBrowserKey);
  }
  return inBrowserIdentity();
}

export function isWalletConnected(): boolean {
  return walletSigner !== undefined;
}

export function getConnectedWalletAddress(): string | undefined {
  return walletAddress;
}

export function findWalletSigner(
  wallets: ccc.WalletWithSigners[],
  purpose: WalletPurpose,
): ccc.Signer | undefined {
  for (const wallet of wallets) {
    for (const { signer } of wallet.signers) {
      if (signer.type !== ccc.SignerType.CKB) continue;

      // COMP v0.2 message authorship is verified by the contract as a raw
      // 65-byte secp256k1 recoverable signature. JoyID signs messages with
      // WebAuthn (ES256/RSA) and returns a JSON envelope, so it is valid for
      // transaction funding but not for this message-signature slot.
      if (
        purpose === "message" &&
        signer.signType !== ccc.SignerSignType.CkbSecp256k1
      ) {
        continue;
      }

      return signer;
    }
  }
}

export async function connectWallet(
  purpose: WalletPurpose = "message",
  fallbackToBrowserKey = true,
): Promise<SigningIdentity | undefined> {
  try {
    const controller = new SignersController();
    let wallets: ccc.WalletWithSigners[] | undefined;

    await controller.refresh(client, (w) => {
      wallets = w;
    });

    if (!wallets || wallets.length === 0) {
      if (purpose === "transaction") {
        toast("No CKB transaction signer found.", "err");
        return;
      }
      if (fallbackToBrowserKey) {
        toast("No wallets discovered. Falling back to browser key.", "err");
        return await readyInBrowserIdentity();
      }
      toast("No compatible secp256k1 CKB wallet found.", "err");
      return;
    }

    const signer = findWalletSigner(wallets, purpose);
    if (!signer) {
      if (purpose === "message") {
        if (fallbackToBrowserKey) {
          toast(
            "No secp256k1 CKB wallet found. JoyID WebAuthn signatures do not match the COMP v0.2 message format; using the browser key.",
            "err",
          );
          return await readyInBrowserIdentity();
        }
        toast(
          "No compatible secp256k1 CKB wallet found. The post identity remains Anonymous.",
          "err",
        );
        return;
      }
      toast("No CKB transaction signer found.", "err");
      return;
    }

    await signer.connect();

    const address = await signer.getRecommendedAddress();
    walletSigner = signer;
    walletAddress = address;

    const identity: SigningIdentity = {
      mode: "wallet",
      publicKey: null,
      label: truncateIdentity(address),
    };

    // Transaction-only signers (including JoyID) stay available to the Cell
    // management flow without being routed into COMP's secp256k1 message path.
    if (purpose === "transaction") {
      return identity;
    }

    identity.signDigest = async (digest) => {
      const raw = await signer.signMessageRaw(digest);
      // Validate that it looks like a raw 65-byte recoverable signature.
      const sigBytes = ccc.bytesFrom(raw);
      if (sigBytes.length !== 65) {
        throw new Error(
          `wallet returned ${sigBytes.length}-byte signature; expected 65-byte raw recoverable signature`,
        );
      }
      // Recover the author public key directly. The COMP witness is deliberately
      // independent of any CKB address or lock-script hash.
      try {
        const sig = secp256k1.Signature.fromCompact(sigBytes.slice(0, 64));
        const recovery = sigBytes[64] >= 27 && sigBytes[64] <= 28
          ? sigBytes[64] - 27
          : sigBytes[64];
        if (recovery > 3) throw new Error(`invalid recovery id ${sigBytes[64]}`);
        const recovered = sig
          .addRecoveryBit(recovery)
          .recoverPublicKey(ccc.bytesFrom(digest));
        const recoveredPublicKey = ccc.hexFrom(recovered.toRawBytes(true));
        if (
          identity.publicKey &&
          identity.publicKey.toLowerCase() !== recoveredPublicKey.toLowerCase()
        ) {
          throw new Error("wallet changed its message-signing public key");
        }
        identity.publicKey = recoveredPublicKey;
      } catch (e) {
        throw new Error(
          `wallet signature verification failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return ccc.hexFrom(sigBytes);
    };
    return identity;
  } catch (e) {
    toast(`Wallet connection failed: ${e instanceof Error ? e.message : String(e)}`, "err");
    if (purpose === "message" && fallbackToBrowserKey) {
      return await readyInBrowserIdentity();
    }
    return;
  }
}

export function disconnectWallet() {
  walletSigner = undefined;
  walletAddress = undefined;
}

export function getWalletSigner(): ccc.Signer | undefined {
  return walletSigner;
}

function truncateIdentity(identity: string): string {
  if (identity.length <= 18) return identity;
  return `${identity.slice(0, 10)}…${identity.slice(-6)}`;
}

// Initialize the browser-key public identity lazily on module load.
initInBrowserPublicKey();
