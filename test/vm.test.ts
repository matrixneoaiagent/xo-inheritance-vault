import assert from 'node:assert/strict';
import test from 'node:test';
import { VAULT_FEE_SATOSHIS } from '../source/index.js';
import {
    SELECTOR_POKE,
    SELECTOR_RECLAIM,
    SELECTOR_UPDATE,
    buildTestCovenant,
    evaluateClaim,
    evaluateOwnerSpend,
    p2pkhForPrivateKeyByte,
    p2sh32LockingScript,
} from './helpers/covenant.js';

const FEE = VAULT_FEE_SATOSHIS;
const PERIOD = 2n;
const VAULT = 100_000n;

/* ------------------------------------------------------------------ */
/* Address                                                             */
/* ------------------------------------------------------------------ */

test('period, label and beneficiary all change the P2SH32 address', () => {
    const base = buildTestCovenant({ periodBlocks: 2n, label: 'vault' });
    const otherPeriod = buildTestCovenant({ periodBlocks: 3n, label: 'vault' });
    const otherLabel = buildTestCovenant({ periodBlocks: 2n, label: 'vault-2' });
    const otherBeneficiary = buildTestCovenant({ periodBlocks: 2n, label: 'vault', beneficiaryByte: 3 });
    const otherOwner = buildTestCovenant({ periodBlocks: 2n, label: 'vault', ownerByte: 4 });

    for (const [name, other] of Object.entries({ otherPeriod, otherLabel, otherBeneficiary, otherOwner })) {
        assert.notDeepEqual(base.redeem, other.redeem, `${name} must change the redeem script`);
        assert.notDeepEqual(base.p2sh32, other.p2sh32, `${name} must change the address`);
    }
});

/* ------------------------------------------------------------------ */
/* claim                                                               */
/* ------------------------------------------------------------------ */

test('claim: beneficiary takes the whole balance after the period, with no signature', () => {
    const covenant = buildTestCovenant({ periodBlocks: PERIOD });
    const result = evaluateClaim({
        covenant,
        inputValueSatoshis: VAULT,
        sequenceNumber: Number(PERIOD),
        outputs: [
            { lockingBytecode: covenant.beneficiaryLockingScript, valueSatoshis: VAULT - FEE },
        ],
    });
    assert.equal(result.success, true, result.reason ?? '');
});

test('claim: rejected before the relative locktime has elapsed', () => {
    const covenant = buildTestCovenant({ periodBlocks: 5n });
    const result = evaluateClaim({
        covenant,
        inputValueSatoshis: VAULT,
        sequenceNumber: 4, // one block short of the committed period of 5
        outputs: [
            { lockingBytecode: covenant.beneficiaryLockingScript, valueSatoshis: VAULT - FEE },
        ],
    });
    assert.equal(result.success, false);
    assert.match(result.reason ?? '', /CHECKSEQUENCEVERIFY|non-final|sequence/i);
});

test('claim: rejected when the money goes anywhere but the committed beneficiary', () => {
    const covenant = buildTestCovenant({ periodBlocks: PERIOD });
    const result = evaluateClaim({
        covenant,
        inputValueSatoshis: VAULT,
        sequenceNumber: Number(PERIOD),
        outputs: [
            { lockingBytecode: p2pkhForPrivateKeyByte(9), valueSatoshis: VAULT - FEE },
        ],
    });
    assert.equal(result.success, false);
    assert.match(result.reason ?? '', /OP_VERIFY|OP_EQUALVERIFY/);
});

test('claim: rejected when the beneficiary is short-changed (a hidden fee skim)', () => {
    const covenant = buildTestCovenant({ periodBlocks: PERIOD });
    const result = evaluateClaim({
        covenant,
        inputValueSatoshis: VAULT,
        sequenceNumber: Number(PERIOD),
        outputs: [
            // 1 satoshi less than the covenant promises: a miner-fee skim.
            { lockingBytecode: covenant.beneficiaryLockingScript, valueSatoshis: VAULT - FEE - 1n },
        ],
    });
    assert.equal(result.success, false);
    // The claim branch ends in OP_NUMEQUAL, so a value mismatch leaves `false`.
    assert.match(result.reason ?? '', /non-truthy|OP_VERIFY|OP_NUMEQUAL/);
});

test('claim: rejected when the claim adds a second output (e.g. a finder\'s fee)', () => {
    const covenant = buildTestCovenant({ periodBlocks: PERIOD });
    const result = evaluateClaim({
        covenant,
        inputValueSatoshis: VAULT,
        sequenceNumber: Number(PERIOD),
        outputs: [
            { lockingBytecode: covenant.beneficiaryLockingScript, valueSatoshis: VAULT - FEE },
            { lockingBytecode: p2pkhForPrivateKeyByte(9), valueSatoshis: 1_000n },
        ],
    });
    assert.equal(result.success, false);
    assert.match(result.reason ?? '', /OP_VERIFY|OP_NUMEQUALVERIFY/);
});

/* ------------------------------------------------------------------ */
/* poke                                                                */
/* ------------------------------------------------------------------ */

test('poke: owner-signed spend back to the identical script resets the age', () => {
    const covenant = buildTestCovenant({ periodBlocks: PERIOD });
    const result = evaluateOwnerSpend({
        covenant,
        inputValueSatoshis: VAULT,
        outputs: [
            { lockingBytecode: covenant.p2sh32, valueSatoshis: VAULT - FEE },
        ],
        selector: SELECTOR_POKE,
    });
    assert.equal(result.success, true, result.reason ?? '');
});

test('poke: a fork of the vault script (different beneficiary) is rejected', () => {
    const covenant = buildTestCovenant({ periodBlocks: PERIOD });
    const forked = buildTestCovenant({ periodBlocks: PERIOD, beneficiaryByte: 7 });
    const result = evaluateOwnerSpend({
        covenant,
        inputValueSatoshis: VAULT,
        outputs: [
            { lockingBytecode: forked.p2sh32, valueSatoshis: VAULT - FEE },
        ],
        selector: SELECTOR_POKE,
    });
    assert.equal(result.success, false);
    assert.match(result.reason ?? '', /OP_VERIFY|OP_EQUALVERIFY/);
});

test('poke: cannot be used to drain the vault (only the fixed fee may leave)', () => {
    const covenant = buildTestCovenant({ periodBlocks: PERIOD });
    const result = evaluateOwnerSpend({
        covenant,
        inputValueSatoshis: VAULT,
        outputs: [
            { lockingBytecode: covenant.p2sh32, valueSatoshis: VAULT - FEE - 10_000n },
        ],
        selector: SELECTOR_POKE,
    });
    assert.equal(result.success, false);
    assert.match(result.reason ?? '', /OP_VERIFY|OP_NUMEQUALVERIFY/);
});

test('poke: a signature from any other key is rejected', () => {
    const covenant = buildTestCovenant({ periodBlocks: PERIOD });
    const result = evaluateOwnerSpend({
        covenant,
        inputValueSatoshis: VAULT,
        outputs: [
            { lockingBytecode: covenant.p2sh32, valueSatoshis: VAULT - FEE },
        ],
        selector: SELECTOR_POKE,
        signWith: new Uint8Array(32).fill(0x09),
    });
    assert.equal(result.success, false);
});

test('poke: the beneficiary cannot poke (it needs the owner key)', () => {
    const covenant = buildTestCovenant({ periodBlocks: PERIOD });
    // A beneficiary-held key signs instead of the owner key.
    const result = evaluateOwnerSpend({
        covenant,
        inputValueSatoshis: VAULT,
        outputs: [
            { lockingBytecode: covenant.p2sh32, valueSatoshis: VAULT - FEE },
        ],
        selector: SELECTOR_POKE,
        signWith: Uint8Array.from({ length: 32 }, (_value, index) => (index === 31 ? 2 : 0)),
    });
    assert.equal(result.success, false);
});

/* ------------------------------------------------------------------ */
/* reclaim                                                             */
/* ------------------------------------------------------------------ */

test('reclaim: the owner exits at any age, to any destination', () => {
    const covenant = buildTestCovenant({ periodBlocks: 1_000_000n });
    const result = evaluateOwnerSpend({
        covenant,
        inputValueSatoshis: VAULT,
        outputs: [
            { lockingBytecode: p2pkhForPrivateKeyByte(42), valueSatoshis: VAULT - FEE },
        ],
        selector: SELECTOR_RECLAIM,
    });
    assert.equal(result.success, true, result.reason ?? '');
});

test('reclaim: rejected with a signature from a different key', () => {
    const covenant = buildTestCovenant({ periodBlocks: PERIOD });
    const result = evaluateOwnerSpend({
        covenant,
        inputValueSatoshis: VAULT,
        outputs: [
            { lockingBytecode: p2pkhForPrivateKeyByte(42), valueSatoshis: VAULT - FEE },
        ],
        selector: SELECTOR_RECLAIM,
        signWith: new Uint8Array(32).fill(0x09),
    });
    assert.equal(result.success, false);
});

test('reclaim: rejected when it tries to leave the beneficiary with nothing but a fee skim', () => {
    const covenant = buildTestCovenant({ periodBlocks: PERIOD });
    const result = evaluateOwnerSpend({
        covenant,
        inputValueSatoshis: VAULT,
        outputs: [
            { lockingBytecode: p2pkhForPrivateKeyByte(42), valueSatoshis: VAULT - FEE - 1n },
        ],
        selector: SELECTOR_RECLAIM,
    });
    assert.equal(result.success, false);
});

/* ------------------------------------------------------------------ */
/* updateBeneficiary                                                   */
/* ------------------------------------------------------------------ */

test('updateBeneficiary: the owner moves the balance into a new vault script', () => {
    const covenant = buildTestCovenant({ periodBlocks: PERIOD });
    const next = buildTestCovenant({ periodBlocks: 144n, beneficiaryByte: 8, label: 'alice' });
    const result = evaluateOwnerSpend({
        covenant,
        inputValueSatoshis: VAULT,
        outputs: [
            { lockingBytecode: next.p2sh32, valueSatoshis: VAULT - FEE },
        ],
        selector: SELECTOR_UPDATE,
    });
    assert.equal(result.success, true, result.reason ?? '');
});

test('an unknown selector (5) is rejected instead of falling through', () => {
    const covenant = buildTestCovenant({ periodBlocks: PERIOD });
    const result = evaluateOwnerSpend({
        covenant,
        inputValueSatoshis: VAULT,
        outputs: [
            { lockingBytecode: covenant.p2sh32, valueSatoshis: VAULT - FEE },
        ],
        selector: 5, // no such branch
    });
    assert.equal(result.success, false);
    assert.match(result.reason ?? '', /OP_VERIFY|OP_NUMEQUALVERIFY/);
});
