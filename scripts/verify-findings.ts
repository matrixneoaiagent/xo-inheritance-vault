import { decodeTransaction, hexToBin } from '@bitauth/libauth';
import { compileCashAssemblyString, parseTemplate } from '@xo-cash/utils';
import { inheritanceVaultTemplate, labelToHex } from '../source/index.js';
import { archiveAllInvitations, openEngine, stopEngine } from './lib/engine.js';
import { loadRecord } from './lib/record.js';
import { compileVaultScript, followUpVariables, vaultInput } from './lib/vault.js';
import { expectInvitationTransactionRejected } from './verify-tx.js';

/**
 * Reproduces, in one run, the engine behaviours documented in
 * docs/FINDINGS.md. Every check prints the observed value; nothing is
 * broadcast. Run it against an existing vault record:
 *
 *   VAULT_NAME=A node --import tsx scripts/verify-findings.ts
 */
const vaultName = process.env.VAULT_NAME ?? 'A';
const record = loadRecord(vaultName);
const parsed = parseTemplate(inheritanceVaultTemplate);

console.log('== FINDING 8: constants are not visible inside compiled scripts ==');
try {
    compileCashAssemblyString({
        cashAssemblyText: 'enforcePokeValueWithConstant',
        variables: {
            periodBlocks: BigInt(record.periodBlocks),
            label: hexToBin(record.labelHex),
            beneficiaryLockingScript: hexToBin(record.beneficiaryLockingScript),
        },
        templateVariables: parsed.variables,
        templateScripts: {
            ...parsed.scripts,
            enforcePokeValueWithConstant:
                'OP_0 OP_OUTPUTVALUE OP_BIN2NUM OP_INPUTINDEX OP_UTXOVALUE OP_BIN2NUM <pokeFeeSatoshis> OP_SUB OP_NUMEQUALVERIFY',
        },
        evaluationDecodeMode: 'hex',
    });
    console.log('UNEXPECTED: <pokeFeeSatoshis> compiled even though constants are not meant to resolve here');
} catch (error) {
    console.log('observed:', (error as Error).message.split('\n')[0]);
}

console.log('\n== FINDING 7: a hex-looking text label is silently decoded as bytes ==');
const labelAsText = 'cafe';
const asUtf8 = compileVaultScript({
    ownerPublicKeyHex: record.ownerPublicKey!,
    periodBlocks: record.periodBlocks,
    labelHex: labelToHex(labelAsText), // 63616665 == "cafe" in UTF-8
    beneficiaryLockingScript: record.beneficiaryLockingScript,
});
const asHexGuess = compileVaultScript({
    ownerPublicKeyHex: record.ownerPublicKey!,
    periodBlocks: record.periodBlocks,
    labelHex: 'cafe', // what the engine would commit for the string "cafe"
    beneficiaryLockingScript: record.beneficiaryLockingScript,
});
console.log('label "cafe" as UTF-8 (labelToHex)  ->', asUtf8.p2sh32Hex.slice(0, 20), '…');
console.log('label "cafe" read as hex             ->', asHexGuess.p2sh32Hex.slice(0, 20), '…');
console.log('same address?', asUtf8.p2sh32Hex === asHexGuess.p2sh32Hex);

console.log('\n== FINDING 12: selectable:false is honoured for Electrum-ingested UTXOs ==');
const { engine, templateIdentifier } = await openEngine();
try {
    await archiveAllInvitations(engine);
    const spendable = await engine.listSpendableUnspentOutputs();
    const vaultUtxo = spendable.find(
        (utxo) => utxo.outpointTransactionHash === record.outpointTransactionHash && utxo.outpointIndex === record.outpointIndex,
    );
    console.log('vault outpoint', `${record.outpointTransactionHash}:${record.outpointIndex}`);
    console.log('vault script hash', record.vaultScriptHash);
    console.log('vault UTXO in listSpendableUnspentOutputs()?', vaultUtxo !== undefined, vaultUtxo === undefined ? '' : `(selectable=${vaultUtxo.selectable})`);

    console.log('\n== FINDING 6: a template input nSequence is resolved only when the invitation sets none ==');
    const template = await engine.getTemplate(templateIdentifier);
    if (!template) throw new Error('template missing');
    const claimIntent = template.lockingScripts.vaultScript.roles?.beneficiary.actions?.find((intent) => intent.action === 'claim');
    if (!claimIntent) throw new Error('claim intent missing');

    // Deliberately omit `sequenceNumber` on the invitation input and decode the
    // built transaction: the template declares none, so the engine's default wins.
    const created = await engine.createInvitation({
        templateIdentifier,
        actionIdentifier: 'claim',
        intent: claimIntent,
        variables: followUpVariables(record, 'beneficiary'),
        inputs: [vaultInput(record, 'claimInput', 0xffffffff)],
    });
    const noSequence = created.invitation.invitationIdentifier;
    await engine.appendInvitation(noSequence, {
        templateIdentifier,
        actionIdentifier: 'claim',
        outputs: [{ outputIdentifier: 'beneficiaryPayoutOutput' }],
    });
    const built = await engine.buildInvitationTransactionFromMergedCommit(noSequence);
    const decoded = decodeTransaction(hexToBin(built.serializedTransaction));
    if (typeof decoded === 'string') throw new Error(decoded);
    console.log('nSequence passed on the invitation input: 0xffffffff');
    console.log('nSequence in the built transaction        :', `0x${decoded.inputs[0].sequenceNumber.toString(16)}`);
    await engine.archiveInvitation(noSequence);

    // Now omit the sequence number entirely: the engine falls back to the
    // template input's declared value, which this template does not set, so 0.
    const createdDefault = await engine.createInvitation({
        templateIdentifier,
        actionIdentifier: 'claim',
        intent: claimIntent,
        variables: followUpVariables(record, 'beneficiary'),
        inputs: [{
            inputIdentifier: 'claimInput',
            outpointTransactionHash: hexToBin(record.outpointTransactionHash),
            outpointIndex: record.outpointIndex,
        }],
    });
    const defaultIdentifier = createdDefault.invitation.invitationIdentifier;
    await engine.appendInvitation(defaultIdentifier, {
        templateIdentifier,
        actionIdentifier: 'claim',
        outputs: [{ outputIdentifier: 'beneficiaryPayoutOutput' }],
    });
    const defaultBuilt = await engine.buildInvitationTransactionFromMergedCommit(defaultIdentifier);
    const defaultDecoded = decodeTransaction(hexToBin(defaultBuilt.serializedTransaction));
    if (typeof defaultDecoded !== 'string') {
        console.log('nSequence with no value anywhere      :', `0x${defaultDecoded.inputs[0].sequenceNumber.toString(16)}`, '(0 disables the relative locktime)');
    }
    await engine.archiveInvitation(defaultIdentifier);

    console.log('\n== FINDING 14: an explicit output value overrides the template expression ==');
    const drained = await engine.createInvitation({
        templateIdentifier,
        actionIdentifier: 'claim',
        intent: claimIntent,
        variables: followUpVariables(record, 'beneficiary'),
        inputs: [vaultInput(record, 'claimInput', record.periodBlocks)],
    });
    const drainedIdentifier = drained.invitation.invitationIdentifier;
    const vaultSatoshis = BigInt(record.vaultSatoshis);
    await engine.appendInvitation(drainedIdentifier, {
        templateIdentifier,
        actionIdentifier: 'claim',
        outputs: [{ outputIdentifier: 'beneficiaryPayoutOutput', valueSatoshis: vaultSatoshis - 2_500n }],
    });
    const drainedBuilt = await engine.buildInvitationTransactionFromMergedCommit(drainedIdentifier);
    const drainedDecoded = decodeTransaction(hexToBin(drainedBuilt.serializedTransaction));
    if (typeof drainedDecoded === 'string') throw new Error(drainedDecoded);
    console.log('template expression would pay', String(vaultSatoshis - 1_500n), 'sats');
    console.log('built transaction pays        ', String(drainedDecoded.outputs[0].valueSatoshis), 'sats (no warning, no error)');
    // Sign first: without an unlocking script the VM would fail for the wrong reason.
    for (const inputIndex of await engine.listOwnInputIndexes(drainedIdentifier)) {
        await engine.signInvitation(drainedIdentifier, inputIndex);
    }
    const reason = await expectInvitationTransactionRejected(engine, drainedIdentifier, 0);
    console.log('the covenant still rejects it:', reason);
    await engine.archiveInvitation(drainedIdentifier);
} finally {
    await stopEngine(engine);
}
