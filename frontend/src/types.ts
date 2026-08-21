import { ccc } from "@ckb-ccc/shell";

export interface CompMessage {
  public_key: string | null;
  /** Read-only compatibility for messages created by the old witness schema. */
  address?: string | null;
  signature: string | null;
  extensions: {
    protocol: string;
    version: number;
    type: string;
    payload: unknown;
  };
}

export interface CompCell {
  outPoint: ccc.OutPoint;
  cellOutput: ccc.CellOutput;
  outputData: string;
  channelHash: string;
  maxFee: bigint;
}

export interface Channel {
  hash: string;
  name: string;
  maxFee: bigint;
  cells: CompCell[];
  totalCapacity: bigint;
}

export interface Message {
  txHash: string;
  status: "pending" | "confirmed";
  blockNumber?: bigint;
  timestamp?: bigint;
  author: string;
  payload: string;
  capacityDelta?: bigint;
  inputCapacity?: bigint;
  outputCapacity?: bigint;
}

export interface ChannelState {
  channel: Channel;
  liveCells: CompCell[];
  availableCells: CompCell[];
  confirmed: Message[];
  pending: Message[];
  confirmedLimit: number;
  hasMoreConfirmed: boolean;
}

export interface SigningIdentity {
  mode: "anonymous" | "wallet" | "key";
  publicKey: string | null;
  label: string;
  signDigest?: (digest: ccc.BytesLike) => Promise<string>;
}

export interface DeploymentConfig {
  network: string;
  codeHash: string;
  hashType: ccc.HashType;
  contractOutPoint: {
    txHash: string;
    index: string;
  };
  sharedCell?: {
    outPoint?: {
      txHash: string;
      index: string;
    };
    lockArgs: string;
    channelHash: string;
    maxFeeShannon: string;
  };
}
