import {
    createVirtualMachineBch,
    encodeDataPush,
    encodeLockingBytecodeP2pkh,
    flattenBinArray,
    generateSigningSerializationBch,
    hash160,
    hash256,
    hexToBin,
    secp256k1,
} from '@bitauth/libauth';
import { compileCashAssemblyString, parseTemplate } from '@xo-cash/utils';
import { inheritanceVaultTemplate, labelToHex } from '../../source/index.js';

/** SIGHASH_ALL | SIGHASH_FORKID. */
export const SIGHASH_ALL_FORKID = 0x41;

/** Claim selector, poke selector, reclaim selector, update selector. */
export const SELECTOR_CLAIM = 0x01;
export const SELECTOR_POKE = 0x02;
export const SELECTOR_RECLAIM = 0x03;
export const SELECTOR_UPDATE = 0x04;

export type TestCovenant = {
    redeem: Uint8Array;
    p2sh32: Uint8Array;
    ownerPrivateKey: Uint8Array;
    ownerPublicKey: Uint8Array;
    beneficiaryLockingScript: Uint8Array;
    periodBlocks: bigint;
    label: string;
};

const parse = parseTemplate(inheritanceVaultTemplate);

function keyFromByte(byte: number): { privateKey: Uint8Array; publicKey: Uint8Array } {
    const privateKey = new Uint8Array(32);
    privateKey[31] = byte;
    const publicKey = secp256k1.derivePublicKeyCompressed(privateKey);
    if (typeof publicKey === 'string') throw new Error(publicKey);
    return { privateKey, publicKey };
}

/**
 * Compiles the real CashASM from `source/inheritance-vault.ts` with concrete
 * test values. Only `ownerPublicKey` is substituted (the template derives it
 * from a secret, which a unit test cannot hold), so every other opcode
 * evaluated below is exactly the bytecode an engine would deploy.
 */
export function buildTestCovenant(options?: {
    periodBlocks?: bigint;
    label?: string;
    ownerByte?: number;
    beneficiaryByte?: number;
}): TestCovenant {
    const owner = keyFromByte(options?.ownerByte ?? 1);
    const beneficiary = keyFromByte(options?.beneficiaryByte ?? 2);
    const periodBlocks = options?.periodBlocks ?? 1n;
    const label = options?.label ?? 'test-vault';
    const beneficiaryLockingScript = encodeLockingBytecodeP2pkh(hash160(beneficiary.publicKey));

    const scripts: Record<string, string> = {
        ...parse.scripts,
        ownerPublicKey: `<0x${Buffer.from(owner.publicKey).toString('hex')}>`,
    };

    const redeemHex = compileCashAssemblyString({
        cashAssemblyText: scripts.vaultRedeemBytecode,
        variables: {
            periodBlocks,
            label: hexToBin(labelToHex(label)),
            beneficiaryLockingScript,
        },
        templateVariables: parse.variables,
        templateScripts: scripts,
        evaluationDecodeMode: 'hex',
    });
    const redeem = hexToBin(redeemHex);
    const p2sh32 = flattenBinArray([
        Uint8Array.of(0xaa), // OP_HASH256
        Uint8Array.of(0x20), // push 32 bytes
        hash256(redeem),
        Uint8Array.of(0x87), // OP_EQUAL
    ]);

    return {
        redeem,
        p2sh32,
        ownerPrivateKey: owner.privateKey,
        ownerPublicKey: owner.publicKey,
        beneficiaryLockingScript,
        periodBlocks,
        label,
    };
}

export type EvaluateResult = {
    success: boolean;
    reason?: string;
};

type Output = { lockingBytecode: Uint8Array; valueSatoshis: bigint };

function evaluate(params: {
    covenant: TestCovenant;
    inputValueSatoshis: bigint;
    sequenceNumber: number;
    outputs: Output[];
    unlockingBytecode: Uint8Array;
}): EvaluateResult {
    const { covenant, inputValueSatoshis, sequenceNumber, outputs, unlockingBytecode } = params;
    const input = {
        outpointTransactionHash: new Uint8Array(32).fill(0x11),
        outpointIndex: 0,
        sequenceNumber,
        unlockingBytecode,
    };
    const transaction = { version: 2, inputs: [ input ], outputs, locktime: 0 };
    const sourceOutputs = [{ lockingBytecode: covenant.p2sh32, valueSatoshis: inputValueSatoshis }];

    const vm = createVirtualMachineBch();
    const state = vm.evaluate({ inputIndex: 0, sourceOutputs, transaction });
    const result = vm.stateSuccess(state);
    return { success: result === true, reason: result === true ? undefined : String(result) };
}

/** Beneficiary claim: selector 0, no signature at all. */
export function evaluateClaim(params: {
    covenant: TestCovenant;
    inputValueSatoshis: bigint;
    sequenceNumber: number;
    outputs: Output[];
}): EvaluateResult {
    return evaluate({
        ...params,
        unlockingBytecode: flattenBinArray([
            Uint8Array.of(0x51), // OP_1: the claim selector
            encodeDataPush(params.covenant.redeem),
        ]),
    });
}

/** Owner-signed branch: selector 1 (poke), 2 (reclaim) or 3 (update). */
export function evaluateOwnerSpend(params: {
    covenant: TestCovenant;
    inputValueSatoshis: bigint;
    sequenceNumber?: number;
    outputs: Output[];
    selector: number;
    signWith?: Uint8Array;
}): EvaluateResult {
    const { covenant, inputValueSatoshis, outputs, selector } = params;
    const input = {
        outpointTransactionHash: new Uint8Array(32).fill(0x22),
        outpointIndex: 0,
        sequenceNumber: params.sequenceNumber ?? 0,
        unlockingBytecode: new Uint8Array(),
    };
    const transaction = { version: 2, inputs: [ input ], outputs, locktime: 0 };
    const sourceOutputs = [{ lockingBytecode: covenant.p2sh32, valueSatoshis: inputValueSatoshis }];

    const signingSerialization = generateSigningSerializationBch(
        { inputIndex: 0, sourceOutputs, transaction },
        { coveredBytecode: covenant.redeem, signingSerializationType: Uint8Array.of(SIGHASH_ALL_FORKID) },
    );
    const signature = secp256k1.signMessageHashSchnorr(
        params.signWith ?? covenant.ownerPrivateKey,
        hash256(signingSerialization),
    );
    if (typeof signature === 'string') throw new Error(signature);

    const unlockingBytecode = flattenBinArray([
        encodeDataPush(flattenBinArray([ signature, Uint8Array.of(SIGHASH_ALL_FORKID) ])),
        Uint8Array.of(0x50 + selector), // OP_1..OP_3 push the selector
        encodeDataPush(covenant.redeem),
    ]);
    const signed = { ...transaction, inputs: [{ ...input, unlockingBytecode }] };
    const vm = createVirtualMachineBch();
    const state = vm.evaluate({ inputIndex: 0, sourceOutputs, transaction: signed });
    const result = vm.stateSuccess(state);
    return { success: result === true, reason: result === true ? undefined : String(result) };
}

export function p2pkhForPrivateKeyByte(byte: number): Uint8Array {
    const { publicKey } = keyFromByte(byte);
    return encodeLockingBytecodeP2pkh(hash160(publicKey));
}

/** Builds the 34-byte P2SH32 locking script for an arbitrary redeem script. */
export function p2sh32LockingScript(redeem: Uint8Array): Uint8Array {
    return flattenBinArray([
        Uint8Array.of(0xaa),
        Uint8Array.of(0x20),
        hash256(redeem),
        Uint8Array.of(0x87),
    ]);
}
