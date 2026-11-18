import assert from 'node:assert/strict';
import test from 'node:test';
import { generateTemplateIdentifier, parseTemplate, serializeTemplate } from '@xo-cash/utils';
import {
    VAULT_FEE_SATOSHIS,
    blocksUntilClaim,
    computeClaimValue,
    computePokeValue,
    computeReclaimValue,
    computeUpdateValue,
    inheritanceVaultTemplate,
    isClaimable,
    labelFromHex,
    labelToHex,
} from '../source/index.js';

const parsed = parseTemplate(inheritanceVaultTemplate);

test('parseTemplate exposes all five actions', () => {
    assert.deepEqual(
        Object.keys(parsed.actions).sort(),
        ['claim', 'createVault', 'poke', 'reclaim', 'updateBeneficiary'],
    );
});

test('the template identifier is stable across parse and serialization', () => {
    const first = generateTemplateIdentifier(parsed);
    const reparsed = parseTemplate(serializeTemplate(parsed));
    assert.equal(generateTemplateIdentifier(reparsed), first);
});

test('each unlocking script ends with its numeric selector', () => {
    for (const [selector, unlock] of [[1, 'unlockClaim'], [2, 'unlockPoke'], [3, 'unlockReclaim'], [4, 'unlockUpdate']] as const) {
        assert.match(parsed.scripts[unlock], new RegExp(`<${selector}>$`), `${unlock} must end with selector ${selector}`);
    }
});

test('the covenant has a four-way selector: claim, poke, reclaim, update', () => {
    const redeem = parsed.scripts.vaultRedeemBytecode;
    assert.match(redeem, /OP_DUP OP_1 OP_NUMEQUAL OP_IF OP_DROP enforceClaim OP_ELSE/);
    assert.match(redeem, /OP_DUP OP_2 OP_NUMEQUAL OP_IF OP_DROP enforcePoke/);
    assert.match(redeem, /OP_DUP OP_3 OP_NUMEQUAL OP_IF OP_DROP enforceReclaim/);
    assert.match(redeem, /OP_4 OP_NUMEQUALVERIFY enforceUpdate/);
});

test('only the claim branch carries the relative-locktime gate', () => {
    assert.match(parsed.scripts.enforceClaim, /^enforceAge /);
    assert.doesNotMatch(parsed.scripts.enforcePoke, /enforceAge/);
    assert.doesNotMatch(parsed.scripts.enforceReclaim, /enforceAge/);
    assert.doesNotMatch(parsed.scripts.enforceUpdate, /enforceAge/);
});

test('the poke branch pins output 0 to the input bytecode and to input-minus-fee', () => {
    assert.match(parsed.scripts.enforcePoke, /enforcePokeDestination/);
    assert.equal(
        parsed.scripts.enforcePokeDestination,
        'OP_0 OP_OUTPUTBYTECODE OP_INPUTINDEX OP_UTXOBYTECODE OP_EQUALVERIFY',
    );
    assert.match(parsed.scripts.enforcePokeValue, /OP_INPUTINDEX OP_UTXOVALUE OP_BIN2NUM <1500> OP_SUB OP_NUMEQUALVERIFY$/);
});

test('the claim branch cannot require a secret', () => {
    assert.deepEqual(parsed.actions.claim?.roles?.beneficiary?.requirements?.secrets ?? [], []);
    const script = parsed.lockingScripts.vaultScript;
    assert.deepEqual(script.roles?.beneficiary?.state?.secrets ?? [], []);
    assert.deepEqual(
        (script.roles?.beneficiary?.actions ?? []).map((intent) => intent.action),
        ['claim'],
    );
});

test('owner follow-up actions all need the ownerKey secret and the committed state', () => {
    const owner = parsed.lockingScripts.vaultScript.roles?.owner;
    assert.deepEqual(owner?.state?.secrets, ['ownerKey']);
    assert.deepEqual(
        (owner?.actions ?? []).map((intent) => intent.action),
        ['poke', 'reclaim', 'updateBeneficiary'],
    );
    for (const action of ['poke', 'reclaim', 'updateBeneficiary'] as const) {
        const required = parsed.actions[action]?.roles?.owner?.requirements?.variables ?? [];
        for (const variable of ['vaultSatoshis', 'periodBlocks', 'beneficiaryLockingScript', 'label']) {
            assert.ok(required.includes(variable), `${action} must require ${variable}`);
        }
    }
});

test('createVault generates ownerKey and commits the beneficiary, period and label', () => {
    const start = parsed.start.find((intent) => intent.action === 'createVault');
    assert.ok(start);
    assert.deepEqual(start.generate, ['ownerKey']);
    assert.deepEqual(
        parsed.actions.createVault?.roles?.owner?.requirements?.variables,
        ['vaultSatoshis', 'periodBlocks', 'beneficiaryLockingScript', 'label'],
    );
});

test('the fee constant matches the value inlined in every branch', () => {
    const constant = parsed.constants?.pokeFeeSatoshis;
    assert.ok(constant);
    assert.equal(constant.type, 'satoshis');
    assert.equal(constant.value, VAULT_FEE_SATOSHIS);
    for (const script of ['enforceClaimValue', 'enforcePokeValue', 'enforceSpendValue'] as const) {
        assert.match(parsed.scripts[script], new RegExp(`<${VAULT_FEE_SATOSHIS}>`), `${script} must inline the fee`);
    }
});

test('payout helpers subtract exactly one fixed fee and reject dust', () => {
    assert.equal(computeClaimValue(100_000n), 98_500n);
    assert.equal(computePokeValue(100_000n), 98_500n);
    assert.equal(computeReclaimValue(100_000n), 98_500n);
    assert.equal(computeUpdateValue(100_000n), 98_500n);
    assert.throws(() => computeClaimValue(1_700n), /cannot cover/);
});

test('blocksUntilClaim mirrors BIP68 arithmetic', () => {
    // Created at height 100, period 3: a claim may land in block 103.
    assert.equal(blocksUntilClaim({ covenantBlockHeight: 100, tipHeight: 100, periodBlocks: 3n }), 2n);
    assert.equal(blocksUntilClaim({ covenantBlockHeight: 100, tipHeight: 101, periodBlocks: 3n }), 1n);
    assert.equal(blocksUntilClaim({ covenantBlockHeight: 100, tipHeight: 102, periodBlocks: 3n }), 0n);
    assert.equal(blocksUntilClaim({ covenantBlockHeight: 100, tipHeight: 105, periodBlocks: 3n }), 0n);
    assert.equal(isClaimable({ covenantBlockHeight: 100, tipHeight: 102, periodBlocks: 3n }), true);
    assert.equal(isClaimable({ covenantBlockHeight: 100, tipHeight: 101, periodBlocks: 3n }), false);
});

test('the label round-trips through hex and is committed as raw UTF-8 bytes', () => {
    assert.equal(labelToHex('for-alice'), Buffer.from('for-alice', 'utf8').toString('hex'));
    assert.equal(labelFromHex(labelToHex('for-alice-2031')), 'for-alice-2031');
    assert.match(parsed.scripts.commitLabel, /^<label> OP_DROP$/);
    assert.equal(parsed.variables?.label?.type, 'bytes');
});
