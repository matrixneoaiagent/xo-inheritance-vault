import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ARTIFACTS_DIR } from './config.js';

/**
 * One vault, as it exists on Chipnet. Written by `create`, updated by every
 * follow-up action. This is the single source of truth the scripts share, so a
 * reproduction run never has to copy values between terminal lines by hand.
 */
export type VaultRecord = {
    name: string;
    templateIdentifier: string;
    label: string;
    labelHex: string;
    periodBlocks: number;
    beneficiaryLockingScript: string;
    beneficiaryAddress: string;
    vaultLockingBytecode: string;
    /** The redeem script, as recompiled from the template (public data). */
    redeemScript?: string;
    /** The owner public key committed in the covenant (public data). */
    ownerPublicKey?: string;
    vaultScriptHash: string;
    vaultAddress: string;
    vaultSatoshis: string;
    outpointTransactionHash: string;
    outpointIndex: number;
    /** Confirmed height of the current covenant UTXO, when known. */
    covenantBlockHeight?: number;
    /** Lifecycle state of the vault. `open` is the only state with a live UTXO. */
    status: 'open' | 'claimed' | 'reclaimed' | 'updated';
    history: Array<{
        action: string;
        txid: string;
        at: string;
        note?: string;
    }>;
};

export function recordPath(name: string): string {
    return resolve(ARTIFACTS_DIR, `vault-${name}.json`);
}

export function loadRecord(name: string): VaultRecord {
    try {
        return JSON.parse(readFileSync(recordPath(name), 'utf8')) as VaultRecord;
    } catch (error) {
        throw new Error(`cannot read vault record ${recordPath(name)}: ${(error as Error).message}`);
    }
}

export function saveRecord(record: VaultRecord): string {
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
    const path = recordPath(record.name);
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
    return path;
}

/** Records one confirmed on-chain step on the vault's history. */
export function appendHistory(record: VaultRecord, action: string, txid: string, note?: string): void {
    record.history.push({ action, txid, at: new Date().toISOString(), ...(note === undefined ? {} : { note }) });
}
