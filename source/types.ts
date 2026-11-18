import type { XOTemplateVariableIdentifier } from '@xo-cash/types';

/** Actions exposed by the XO Inheritance Vault template. */
export type VaultAction = 'createVault' | 'poke' | 'claim' | 'reclaim' | 'updateBeneficiary';

/**
 * The immutable and quasi-immutable state carried by one vault covenant.
 *
 * Everything except `vaultSatoshis` is committed into the P2SH32 address: two
 * vaults that differ in the owner key, the beneficiary, the period or the
 * label are different addresses.
 */
export type VaultState = {
    /** Locking script paid on a beneficiary claim. */
    beneficiaryLockingScript: string;
    /** Blocks the vault must remain untouched before a claim is valid. */
    periodBlocks: bigint;
    /** Free-form bytes committed into the address. */
    label: string;
    /** Informational balance mirror. The authoritative balance is the UTXO value. */
    vaultSatoshis: bigint;
};

/** Fixed miner fee taken by every spend, inlined into the covenant. */
export const VAULT_FEE_SATOSHIS = 1_500n;

/** Dust floor for a payout output. Not separately enforced on-chain. */
export const DUST_SATOSHIS = 546n;

/** Poke: the vault output value after one renewal. */
export function computePokeValue(vaultSatoshis: bigint): bigint {
    return requirePayout(vaultSatoshis, 'poke');
}

/** Claim: what the beneficiary receives (vault minus the fixed fee). */
export function computeClaimValue(vaultSatoshis: bigint): bigint {
    return requirePayout(vaultSatoshis, 'claim');
}

/** Reclaim: what the owner receives (vault minus the fixed fee). */
export function computeReclaimValue(vaultSatoshis: bigint): bigint {
    return requirePayout(vaultSatoshis, 'reclaim');
}

/** updateBeneficiary: the balance carried into the next vault covenant. */
export function computeUpdateValue(vaultSatoshis: bigint): bigint {
    return requirePayout(vaultSatoshis, 'updateBeneficiary');
}

function requirePayout(vaultSatoshis: bigint, action: VaultAction): bigint {
    if (vaultSatoshis < VAULT_FEE_SATOSHIS + DUST_SATOSHIS) {
        throw new Error(`vault balance ${vaultSatoshis} cannot cover the ${VAULT_FEE_SATOSHIS} sat fee plus the ${DUST_SATOSHIS} sat dust floor for ${action}`);
    }
    return vaultSatoshis - VAULT_FEE_SATOSHIS;
}

/**
 * BIP68 block-based relative-locktime check, mirrored off-chain.
 *
 * A transaction may be included in a block at height `H` only when
 * `H - coinHeight >= periodBlocks`. With the chain tip at `tipHeight`, the next
 * candidate block is `tipHeight + 1`, so a claim becomes valid when
 * `tipHeight + 1 >= coinHeight + periodBlocks`.
 */
export function blocksUntilClaim(params: {
    /** Height of the block that confirmed the covenant UTXO. */
    covenantBlockHeight: number;
    /** Current chain tip height. */
    tipHeight: number;
    periodBlocks: bigint;
}): bigint {
    const { covenantBlockHeight, tipHeight, periodBlocks } = params;
    const due = BigInt(covenantBlockHeight) + periodBlocks;
    const next = BigInt(tipHeight) + 1n;
    return due > next ? due - next : 0n;
}

/** True when the covenant UTXO is old enough for a claim (next block would satisfy CSV). */
export function isClaimable(params: {
    covenantBlockHeight: number;
    tipHeight: number;
    periodBlocks: bigint;
}): boolean {
    return blocksUntilClaim(params) === 0n;
}

/** UTF-8 label bytes, as the template's `bytes` variable expects them. */
export function labelToBytes(label: string): Uint8Array {
    return new TextEncoder().encode(label);
}

/** Hex encoding of the UTF-8 label, for CashASM variable substitution. */
export function labelToHex(label: string): string {
    return Buffer.from(labelToBytes(label)).toString('hex');
}

/** Renders a committed label back to text for logs and docs. */
export function labelFromHex(hex: string): string {
    return new TextDecoder().decode(Buffer.from(hex, 'hex'));
}

/** Variable identifiers that every follow-up action must provide. */
export const VAULT_FOLLOW_UP_VARIABLES: readonly XOTemplateVariableIdentifier[] = [
    'beneficiaryLockingScript',
    'periodBlocks',
    'label',
    'vaultSatoshis',
];
