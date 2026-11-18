/**
 * Discord signs every interaction request with Ed25519.
 * We must reject anything that doesn't verify — Discord also sends deliberately
 * bad signatures when you save the Interactions Endpoint URL, to test this.
 * https://discord.com/developers/docs/interactions/overview#preparing-for-interactions
 */

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("invalid hex");
  }
  const bytes = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export async function verifyDiscordRequest(
  rawBody: string,
  signatureHex: string | null,
  timestamp: string | null,
  publicKeyHex: string,
): Promise<boolean> {
  if (!signatureHex || !timestamp || !publicKeyHex) return false;
  let keyBytes: Uint8Array<ArrayBuffer>;
  let signature: Uint8Array<ArrayBuffer>;
  try {
    keyBytes = hexToBytes(publicKeyHex);
    signature = hexToBytes(signatureHex);
  } catch {
    return false;
  }
  const data = new TextEncoder().encode(timestamp + rawBody);

  // Standard name first; older Workers runtimes only know the "NODE-ED25519" alias.
  const algorithms = [
    { name: "Ed25519" },
    { name: "NODE-ED25519", namedCurve: "NODE-ED25519" },
  ];
  for (const algorithm of algorithms) {
    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey("raw", keyBytes, algorithm, false, ["verify"]);
    } catch {
      continue; // algorithm not supported here, or invalid key
    }
    try {
      return await crypto.subtle.verify(algorithm, key, signature, data);
    } catch {
      return false;
    }
  }
  return false;
}
