import { ccc } from "@ckb-ccc/shell";

const CHANNEL_PREFIX = "comp-channel-";
const LOCAL_CHANNEL_NAMES_KEY = "comp-channel-names";

export interface ChannelMetadata {
  protocol: "comp";
  version: 1;
  type: "channel";
  name: string;
  slug: string;
}

export const KNOWN_CHANNELS: Record<string, string> = {
  // Deployed General channel on testnet
  "0x3bf471b16283375362945f60972e6dd4a998db34b53623457dcaa800b6a42726": "General",
  // Placeholder illustrative channels for v0.1 (no cells yet unless created)
  "0x0000000000000000000000000000000000000000000000000000000000000aaa": "General Demo",
  "0x0000000000000000000000000000000000000000000000000000000000000bbb": "CKB Security",
  "0x0000000000000000000000000000000000000000000000000000000000000ccc": "AI",
  "0x263b341b07e11e287668ba408ff67842bd370a179107d33d149e86ea76d59ec8": "Gas Pool",
};

export function channelSlug(name: string): string {
  const displayName = name.normalize("NFKC").trim();
  if (!displayName) throw new Error("channel name is required");
  if (Array.from(displayName).length > 64) {
    throw new Error("channel name must be 64 characters or fewer");
  }

  const slug = displayName
    .toLocaleLowerCase("en-US")
    .replace(/[’']/g, "")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "");

  if (!slug) throw new Error("channel name must contain a letter or number");
  return slug;
}

export function channelHashFromName(name: string): string {
  const preimage = `${CHANNEL_PREFIX}${channelSlug(name)}`;
  return ccc.hexFrom(ccc.hashCkb(ccc.bytesFrom(preimage, "utf8")));
}

export function channelMetadata(name: string): ChannelMetadata {
  const displayName = name.normalize("NFKC").trim();
  return {
    protocol: "comp",
    version: 1,
    type: "channel",
    name: displayName,
    slug: channelSlug(displayName),
  };
}

export function encodeChannelMetadata(name: string): string {
  return ccc.hexFrom(ccc.bytesFrom(JSON.stringify(channelMetadata(name)), "utf8"));
}

export function parseChannelMetadata(outputData: string): ChannelMetadata | undefined {
  if (!outputData || outputData === "0x") return;
  try {
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(ccc.bytesFrom(outputData)),
    ) as Partial<ChannelMetadata>;
    if (
      value.protocol !== "comp" ||
      value.version !== 1 ||
      value.type !== "channel" ||
      typeof value.name !== "string" ||
      typeof value.slug !== "string" ||
      channelSlug(value.name) !== value.slug
    ) {
      return;
    }
    return value as ChannelMetadata;
  } catch {
    return;
  }
}

function localChannelNames(): Record<string, string> {
  if (typeof localStorage === "undefined") return {};
  try {
    const value = JSON.parse(localStorage.getItem(LOCAL_CHANNEL_NAMES_KEY) ?? "{}") as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const names: Record<string, string> = {};
    for (const [hash, name] of Object.entries(value)) {
      if (/^0x[0-9a-f]{64}$/i.test(hash) && typeof name === "string") {
        names[hash.toLowerCase()] = name;
      }
    }
    return names;
  } catch {
    return {};
  }
}

export function rememberChannelName(hash: string, name: string): void {
  if (typeof localStorage === "undefined") return;
  const names = localChannelNames();
  names[hash.toLowerCase()] = name.normalize("NFKC").trim();
  localStorage.setItem(LOCAL_CHANNEL_NAMES_KEY, JSON.stringify(names));
}

export function channelName(hash: string, outputData: string[] = []): string {
  const normalizedHash = hash.toLowerCase();
  const known = KNOWN_CHANNELS[normalizedHash];
  if (known) return known;

  for (const data of outputData) {
    const metadata = parseChannelMetadata(data);
    if (metadata && channelHashFromName(metadata.name).toLowerCase() === normalizedHash) {
      return metadata.name;
    }
  }

  return localChannelNames()[normalizedHash] ?? `Channel ${hash.slice(0, 8)}…${hash.slice(-4)}`;
}
