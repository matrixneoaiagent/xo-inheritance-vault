import { serializeInvitation } from '@xo-cash/utils';
import { hexToBin, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { computeUpdateValue, labelToHex } from '../source/index.js';
import { writeArtifact } from './lib/artifacts.js';
import { optionalEnv, optionalInt } from './lib/config.js';
import { archiveAllInvitations, openEngine, stopEngine } from './lib/engine.js';
import { appendHistory, saveRecord } from './lib/record.js';
import { broadcastWithRetry, compileVaultScript, followUpVariables, logAge, refreshVaultUtxo, requireRecord, vaultInput } from './lib/vault.js';
import { verifyInvitationTransaction } from './verify-tx.js';

/**
 * `updateBeneficiary`: the owner hands the vault to a different beneficiary
 * (and/or a different period and label) by spending it into a *new* vault
 * covenant.
 *
 * The balance carries over minus the fixed fee, and the new vault starts a
 * fresh BIP68 age. The owner still holds the same key, so the same account can
 * keep poking the new vault.
 */
const vaultName = optionalEnv('VAULT_NAME') ?? 'A';
const record = requireRecord(vaultName);
const vaultSatoshis = BigInt(record.vaultSatoshis);
const newBalance = computeUpdateValue(vaultSatoshis);

const newBeneficiaryScript = optionalEnv('NEW_BENEFICIARY_SCRIPT') ?? record.beneficiaryLockingScript;
const newPeriodBlocks = optionalInt('NEW_PERIOD_BLOCKS') ?? record.periodBlocks + 1;
const newLabel = optionalEnv('NEW_LABEL') ?? `${record.label}-next`;
if (!/^[0-9a-f]+$/.test(newBeneficiaryScript)) throw new Error('NEW_BENEFICIARY_SCRIPT must be lowercase hex');
if (labelToHex(newLabel).length === 0) throw new Error('NEW_LABEL must not be empty');
if (record.ownerPublicKey === undefined) throw new Error('record has no ownerPublicKey: run create first with the current scripts/create.ts');

const next = compileVaultScript({
    ownerPublicKeyHex: record.ownerPublicKey,
    periodBlocks: newPeriodBlocks,
    labelHex: labelToHex(newLabel),
    beneficiaryLockingScript: newBeneficiaryScript,
});
const nextAddress = lockingBytecodeToCashAddress({ bytecode: hexToBin(next.p2sh32Hex), prefix: 'bchtest' });
if (typeof nextAddress === 'string') throw new Error(nextAddress);

const { engine, templateIdentifier } = await openEngine();
try {
    await archiveAllInvitations(engine);
    const template = await engine.getTemplate(templateIdentifier);
    if (!template) throw new Error('template missing');
    const updateIntent = template.lockingScripts.vaultScript.roles?.owner.actions?.find((intent) => intent.action === 'updateBeneficiary');
    if (!updateIntent) throw new Error('updateBeneficiary intent missing');

    console.log('template', templateIdentifier);
    console.log('vault', record.vaultAddress, 'balance', String(vaultSatoshis), '-> next vault', String(newBalance));
    console.log('next vault', nextAddress.address, 'period', newPeriodBlocks, 'label', JSON.stringify(newLabel));
    await logAge(engine, record);

    const created = await engine.createInvitation({
        templateIdentifier,
        actionIdentifier: 'updateBeneficiary',
        intent: updateIntent,
        variables: followUpVariables(record, 'owner', [
            { variableIdentifier: 'nextVaultLockingScript', roleIdentifier: 'owner', value: next.p2sh32Hex },
        ]),
        inputs: [vaultInput(record, 'updateInput', 0xffffffff)],
    });
    const invitationIdentifier = created.invitation.invitationIdentifier;

    await engine.appendInvitation(invitationIdentifier, {
        templateIdentifier,
        actionIdentifier: 'updateBeneficiary',
        outputs: [{ outputIdentifier: 'nextVaultOutput' }],
    });

    for (const inputIndex of await engine.listOwnInputIndexes(invitationIdentifier)) {
        await engine.signInvitation(invitationIdentifier, inputIndex);
    }

    const preview = await verifyInvitationTransaction(engine, invitationIdentifier, 0);
    console.log('preview txid', preview.transactionHash, 'size', preview.transactionByteLength);
    console.log('missing', JSON.stringify(await engine.listMissingRequirements(invitationIdentifier), (_key, value) => typeof value === 'bigint' ? value.toString() : value));

    const stored = await engine.getInvitation(invitationIdentifier);
    if (!stored) throw new Error('stored invitation missing');
    console.log('invitation', writeArtifact(`updateBeneficiary-${vaultName}-invitation.json`, serializeInvitation(stored.invitation)));

    const txid = await broadcastWithRetry({ engine, invitationIdentifier });
    if (txid !== '') {
        console.log('BROADCAST_TXID', txid);
        appendHistory(record, 'updateBeneficiary', txid, `${record.vaultAddress} -> ${nextAddress.address}`);
        // The record now tracks the new vault: same owner key, new beneficiary.
        const nextBeneficiaryAddress = lockingBytecodeToCashAddress({ bytecode: hexToBin(newBeneficiaryScript), prefix: 'bchtest' });
        if (typeof nextBeneficiaryAddress === 'string') throw new Error(nextBeneficiaryAddress);
        record.beneficiaryLockingScript = newBeneficiaryScript;
        record.beneficiaryAddress = nextBeneficiaryAddress.address;
        record.periodBlocks = newPeriodBlocks;
        record.label = newLabel;
        record.labelHex = labelToHex(newLabel);
        record.redeemScript = next.redeemHex;
        record.vaultLockingBytecode = next.p2sh32Hex;
        record.vaultAddress = nextAddress.address;
        record.vaultScriptHash = (await engine.listScriptHashes())
            .find((entry) => entry.lockingBytecode.toLowerCase() === next.p2sh32Hex.toLowerCase())?.scriptHash ?? '';
        // A new coin means a new age: never carry the old height forward.
        delete record.covenantBlockHeight;
        record.status = 'open';
        await refreshVaultUtxo(engine, record, txid, newBalance);
        saveRecord(record);
        console.log('NEXT_VAULT', nextAddress.address, 'balance', String(newBalance));
    }
} finally {
    await stopEngine(engine);
}
