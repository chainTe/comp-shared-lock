import { ccc } from "@ckb-ccc/shell";
import type { ChannelKind } from "./types";

const CHANNEL_PREFIX = "comp-channel-";
const LOCAL_CHANNEL_NAMES_KEY = "comp-channel-names";

export interface ChannelMetadata {
  protocol: "comp";
  version: 1;
  type: "channel";
  name: string;
  slug: string;
  /** Added after v1 launch; absent metadata remains readable. */
  kind?: ChannelKind;
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

/** Channels deployed before COMP Wall are text rooms. */
export const KNOWN_CHANNEL_KINDS: Record<string, ChannelKind> = {
  "0x3bf471b16283375362945f60972e6dd4a998db34b53623457dcaa800b6a42726": "chat",
  "0x0000000000000000000000000000000000000000000000000000000000000aaa": "chat",
  "0x0000000000000000000000000000000000000000000000000000000000000bbb": "chat",
  "0x0000000000000000000000000000000000000000000000000000000000000ccc": "chat",
  "0x263b341b07e11e287668ba408ff67842bd370a179107d33d149e86ea76d59ec8": "chat",
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

/**
 * 新的哈希派生：把 kind 也绑进去，避免"同名聊天室 / 同名画布"撞到同一个哈希。
 * 老频道继续用 channelHashFromName 的派生，读取时两种都认。
 */
export function channelHashFor(name: string, kind: ChannelKind): string {
  const preimage = `${CHANNEL_PREFIX}${kind}-${channelSlug(name)}`;
  return ccc.hexFrom(ccc.hashCkb(ccc.bytesFrom(preimage, "utf8")));
}

/** 哈希是否匹配这个名字：旧派生或带 kind 的新派生都算。 */
export function channelHashMatches(hash: string, name: string, kind?: ChannelKind): boolean {
  const normalized = hash.toLowerCase();
  if (channelHashFromName(name).toLowerCase() === normalized) return true;
  if (kind) return channelHashFor(name, kind).toLowerCase() === normalized;
  return channelHashFor(name, "chat").toLowerCase() === normalized
    || channelHashFor(name, "wall").toLowerCase() === normalized;
}

export function channelMetadata(name: string, kind: ChannelKind = "wall"): ChannelMetadata {
  const displayName = name.normalize("NFKC").trim();
  return {
    protocol: "comp",
    version: 1,
    type: "channel",
    name: displayName,
    slug: channelSlug(displayName),
    kind,
  };
}

export function encodeChannelMetadata(name: string, kind: ChannelKind = "wall"): string {
  return ccc.hexFrom(ccc.bytesFrom(JSON.stringify(channelMetadata(name, kind)), "utf8"));
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
      (value.kind !== undefined && value.kind !== "chat" && value.kind !== "wall") ||
      channelSlug(value.name) !== value.slug
    ) {
      return;
    }
    return value as ChannelMetadata;
  } catch {
    return;
  }
}

export function channelKind(hash: string, outputData: string[] = []): ChannelKind | undefined {
  const normalizedHash = hash.toLowerCase();
  const known = KNOWN_CHANNEL_KINDS[normalizedHash];
  if (known) return known;

  for (const data of outputData) {
    const metadata = parseChannelMetadata(data);
    if (
      metadata?.kind
      && channelHashMatches(normalizedHash, metadata.name, metadata.kind)
    ) {
      return metadata.kind;
    }
  }
  return undefined;
}

export function channelRoute(hash: string, kind: ChannelKind): string {
  const segment = kind === "chat" ? "channel" : "wall";
  return `#/${segment}/${encodeURIComponent(hash)}`;
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
    if (metadata && channelHashMatches(normalizedHash, metadata.name, metadata.kind)) {
      return metadata.name;
    }
  }

  return localChannelNames()[normalizedHash] ?? `Channel ${hash.slice(0, 8)}…${hash.slice(-4)}`;
}
