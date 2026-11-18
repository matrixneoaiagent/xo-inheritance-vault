import type { Engine } from '@xo-cash/engine';
import type { XOInvitationVariable } from '@xo-cash/types';
import { binToHex, flattenBinArray, hash256, hexToBin } from '@bitauth/libauth';
import { compileCashAssemblyString, parseTemplate } from '@xo-cash/utils';
import { inheritanceVaultTemplate } from '../../source/index.js';
import { isBroadcast, maxRetries, retryDelaySeconds } from './config.js';
import { loadRecord, saveRecord, type VaultRecord } from './record.js';

/** The role that holds the follow-up authority for the vault output. */
export type VaultRole = 'owner' | 'beneficiary';

/** Builds the variable list every follow-up action must provide, in role order. */
export function followUpVariables(record: VaultRecord, role: VaultRole, extra: XOInvitationVariable[] = []): XOInvitationVariable[] {
    return [
        { variableIdentifier: 'vaultSatoshis', roleIdentifier: role, value: BigInt(record.vaultSatoshis) },
        { variableIdentifier: 'periodBlocks', roleIdentifier: role, value: record.periodBlocks },
        { variableIdentifier: 'beneficiaryLockingScript', roleIdentifier: role, value: record.beneficiaryLockingScript },
        { variableIdentifier: 'label', roleIdentifier: role, value: record.labelHex },
        ...extra,
    ];
}

/** The covenant input, as every follow-up action references it. */
export function vaultInput(record: VaultRecord, inputIdentifier: string, sequenceNumber: number) {
    return {
        inputIdentifier,
        outpointTransactionHash: hexToBin(record.outpointTransactionHash),
        outpointIndex: record.outpointIndex,
        sequenceNumber,
    };
}

/**
 * Refreshes the record's view of the covenant UTXO after an action: new
 * outpoint, new balance and (when Electrum has caught up) the confirmation
 * height that the BIP68 age is measured from.
 */
export async function refreshVaultUtxo(engine: Engine, record: VaultRecord, txid: string, valueSatoshis: bigint): Promise<void> {
    record.outpointTransactionHash = txid;
    record.outpointIndex = 0;
    record.vaultSatoshis = String(valueSatoshis);
    try {
        const utxo = (await engine.listUnspentOutputs()).find(
            (candidate) => candidate.outpointTransactionHash === txid && candidate.outpointIndex === 0,
        );
        // Electrum sometimes reports 0 for a freshly mined output; only a real
        // height is usable for the BIP68 age (FINDINGS 10).
        if (utxo?.minedAtHeight !== undefined && utxo.minedAtHeight > 0) record.covenantBlockHeight = utxo.minedAtHeight;
    } catch (error) {
        console.log('utxo refresh skipped', (error as Error).message);
    }
    saveRecord(record);
}

/**
 * Prints the chain height and the covenant's confirmation height. The height is
 * looked up from storage when the record does not have it yet, because Electrum
 * only reports `minedAtHeight` once the transaction is indexed.
 */
export async function logAge(engine: Engine, record: VaultRecord): Promise<void> {
    if (record.covenantBlockHeight === undefined) {
        try {
            const utxo = (await engine.listUnspentOutputs()).find(
                (candidate) => candidate.outpointTransactionHash === record.outpointTransactionHash
                    && candidate.outpointIndex === record.outpointIndex,
            );
            if (utxo?.minedAtHeight !== undefined && utxo.minedAtHeight > 0) {
                record.covenantBlockHeight = utxo.minedAtHeight;
                saveRecord(record);
            }
        } catch (error) {
            console.log('height lookup skipped', (error as Error).message);
        }
    }
    const status = await engine.getChainStatus();
    const height = record.covenantBlockHeight;
    console.log('chain tip', status.currentHeight, 'covenant height', height ?? 'unknown', 'period', record.periodBlocks);
    if (height !== undefined) {
        const age = status.currentHeight - height;
        console.log('covenant age', age, 'blocks (claim needs', record.periodBlocks, ')');
    }
}

/**
 * Broadcasts, retrying while the network reports the CSV gate as not yet
 * satisfied. Chipnet nodes were observed to reject a correctly-built,
 * correctly-signed relative-locktime spend as `non-BIP68-final` for longer
 * than the naive confirmation count suggests (docs/FINDINGS.md item 1), so a
 * retry loop is part of the reproduction, not a workaround for a template bug.
 */
export async function broadcastWithRetry(params: {
    engine: Engine;
    invitationIdentifier: string;
    retryOnCsv?: boolean;
}): Promise<string> {
    const { engine, invitationIdentifier, retryOnCsv = false } = params;
    if (!isBroadcast()) {
        console.log('DRY_RUN (set BROADCAST=1 to send)');
        return '';
    }
    const attempts = Math.max(1, maxRetries());
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const result = await engine.executeAction(invitationIdentifier, { broadcastTransaction: true });
            return result.builtTransaction.transactionHash;
        } catch (error) {
            const message = (error as Error).message;
            const csvNotYet = /non-BIP68-final|non-final|64/.test(message);
            const last = attempt === attempts;
            if (!retryOnCsv || !csvNotYet || last) throw error;
            console.log(`attempt ${attempt}/${attempts} rejected (${message.trim()}); waiting ${retryDelaySeconds()}s`);
            await sleep(retryDelaySeconds() * 1_000);
        }
    }
    throw new Error('unreachable');
}

function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Loads a record and fails early with a readable message. */
export function requireRecord(name: string): VaultRecord {
    return loadRecord(name);
}

/* ------------------------------------------------------------------ */
/* Off-chain covenant compilation                                      */
/* ------------------------------------------------------------------ */

/**
 * Compiles the vault covenant exactly the way the engine does, from the
 * template's own CashASM, and returns both the redeem script and its P2SH32
 * locking script. Used to audit the address the engine produced and to build
 * the *next* vault script for `updateBeneficiary` (the engine has no API for
 * "compile this template's script with different variable values").
 */
export function compileVaultScript(params: {
    ownerPublicKeyHex: string;
    periodBlocks: number;
    labelHex: string;
    beneficiaryLockingScript: string;
}): { redeemHex: string; p2sh32Hex: string } {
    const parsed = parseTemplate(inheritanceVaultTemplate);
    const scripts: Record<string, string> = {
        ...parsed.scripts,
        ownerPublicKey: `<0x${params.ownerPublicKeyHex}>`,
    };
    const redeemHex = compileCashAssemblyString({
        cashAssemblyText: parsed.scripts.vaultRedeemBytecode,
        variables: {
            periodBlocks: BigInt(params.periodBlocks),
            label: hexToBin(params.labelHex),
            beneficiaryLockingScript: hexToBin(params.beneficiaryLockingScript),
        },
        templateVariables: parsed.variables,
        templateScripts: scripts,
        evaluationDecodeMode: 'hex',
    });
    const p2sh32Hex = binToHex(flattenBinArray([
        Uint8Array.of(0xaa),
        Uint8Array.of(0x20),
        hash256(hexToBin(redeemHex)),
        Uint8Array.of(0x87),
    ]));
    return { redeemHex, p2sh32Hex };
}
