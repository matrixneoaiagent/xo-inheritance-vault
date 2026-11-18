import { serializeInvitation } from '@xo-cash/utils';
import { computePokeValue } from '../source/index.js';
import { writeArtifact } from './lib/artifacts.js';
import { optionalEnv } from './lib/config.js';
import { archiveAllInvitations, openEngine, stopEngine } from './lib/engine.js';
import { appendHistory } from './lib/record.js';
import { broadcastWithRetry, followUpVariables, logAge, refreshVaultUtxo, requireRecord, vaultInput } from './lib/vault.js';
import { verifyInvitationTransaction } from './verify-tx.js';

/**
 * `poke`: the owner's proof of liveness.
 *
 * The covenant input is spent straight back into the identical covenant
 * bytecode (same address), minus the fixed poke fee. Nothing else may be
 * created: the covenant requires exactly one output whose locking bytecode
 * equals the input's. Because the new output is a new coin, its BIP68 age
 * restarts at the block that confirms this transaction.
 */
const vaultName = optionalEnv('VAULT_NAME') ?? 'A';
const record = requireRecord(vaultName);
const vaultSatoshis = BigInt(record.vaultSatoshis);
const newBalance = computePokeValue(vaultSatoshis);

const { engine, templateIdentifier } = await openEngine();
try {
    await archiveAllInvitations(engine);
    const template = await engine.getTemplate(templateIdentifier);
    if (!template) throw new Error('template missing');
    const pokeIntent = template.lockingScripts.vaultScript.roles?.owner.actions?.find((intent) => intent.action === 'poke');
    if (!pokeIntent) throw new Error('poke intent missing');

    console.log('template', templateIdentifier);
    console.log('vault', record.vaultAddress, 'balance', String(vaultSatoshis), '->', String(newBalance), 'after the fixed fee');
    await logAge(engine, record);

    const created = await engine.createInvitation({
        templateIdentifier,
        actionIdentifier: 'poke',
        intent: pokeIntent,
        variables: followUpVariables(record, 'owner'),
        // No relative locktime: a poke is valid at any age, and using the final
        // sequence number makes sure the poke itself never waits for the gate.
        inputs: [vaultInput(record, 'pokeInput', 0xffffffff)],
    });
    const invitationIdentifier = created.invitation.invitationIdentifier;

    await engine.appendInvitation(invitationIdentifier, {
        templateIdentifier,
        actionIdentifier: 'poke',
        outputs: [{ outputIdentifier: 'renewedVaultOutput' }],
    });

    for (const inputIndex of await engine.listOwnInputIndexes(invitationIdentifier)) {
        await engine.signInvitation(invitationIdentifier, inputIndex);
    }

    const preview = await verifyInvitationTransaction(engine, invitationIdentifier, 0);
    console.log('preview txid', preview.transactionHash, 'size', preview.transactionByteLength);
    console.log('missing', JSON.stringify(await engine.listMissingRequirements(invitationIdentifier), (_key, value) => typeof value === 'bigint' ? value.toString() : value));

    const stored = await engine.getInvitation(invitationIdentifier);
    if (!stored) throw new Error('stored invitation missing');
    console.log('invitation', writeArtifact(`poke-${vaultName}-invitation.json`, serializeInvitation(stored.invitation)));

    const txid = await broadcastWithRetry({ engine, invitationIdentifier });
    if (txid !== '') {
        console.log('BROADCAST_TXID', txid);
        appendHistory(record, 'poke', txid, `balance ${vaultSatoshis} -> ${newBalance}`);
        await refreshVaultUtxo(engine, record, txid, newBalance);
        console.log('NEW_BALANCE', String(newBalance), 'NEW_OUTPOINT', `${txid}:0`);
    }
} finally {
    await stopEngine(engine);
}
