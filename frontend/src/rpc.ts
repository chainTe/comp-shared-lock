import { ccc } from "@ckb-ccc/shell";

export const client = new ccc.ClientPublicTestnet();

export const MESSAGE_FEE_RATE = 3600n;
export const HISTORY_LIMIT = 50;
export const MIN_CELL_CAPACITY = 61n * 10n ** 8n; // 61 CKB in shannon
export const PENDING_POLL_INTERVAL_MS = 4000;
export const RETRY_DELAYS_MS = [500, 1000, 2000];
export const EXPLORER_TX_URL = "https://pudge.explorer.nervos.org/transaction/";
