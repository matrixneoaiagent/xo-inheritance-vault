import { serializeInvitation } from '@xo-cash/utils';
import { computeReclaimValue } from '../source/index.js';
import { writeArtifact } from './lib/artifacts.js';
import { optionalEnv } from './lib/config.js';
import { archiveAllInvitations, ensureDefaultPolicies, openEngine, stopEngine } from './lib/engine.js';
import { appendHistory, saveRecord } from './lib/record.js';
import { broadcastWithRetry, followUpVariables, logAge, requireRecord, vaultInput } from './lib/vault.js';
import { verifyInvitationTransaction } from './verify-tx.js';

/**
 * `reclaim`: the owner cancels the inheritance and takes the balance at any
 * age. No waiting period and no beneficiary cooperation.
 *
 * The destination is chosen at spend time (`OWNER_PAYOUT_SCRIPT`), exactly like
 * CashScript's `reclaim()`: a destination baked into the covenant would be
 * frozen forever, and the owner must be able to sweep to a new wallet.
 */
const vaultName = optionalEnv('VAULT_NAME') ?? 'A';
const record = requireRecord(vaultName);
const vaultSatoshis = BigInt(record.vaultSatoshis);
const payout = computeReclaimValue(vaultSatoshis);

const { engine, templateIdentifier } = await openEngine();
try {
    await ensureDefaultPolicies(engine);
    await archiveAllInvitations(engine);
    const template = await engine.getTemplate(templateIdentifier);
    if (!template) throw new Error('template missing');
    const reclaimIntent = template.lockingScripts.vaultScript.roles?.owner.actions?.find((intent) => intent.action === 'reclaim');
    if (!reclaimIntent) throw new Error('reclaim intent missing');

    const payoutScript = optionalEnv('OWNER_PAYOUT_SCRIPT') ?? await engine.generateLockingBytecodeFromDefaultPolicy('receive');

    console.log('template', templateIdentifier);
    console.log('vault', record.vaultAddress, 'balance', String(vaultSatoshis));
    console.log('owner receives', String(payout), 'to', payoutScript);
    await logAge(engine, record);
    console.log('reclaim ignores the liveness period entirely: no relative locktime is used.');

    const created = await engine.createInvitation({
        templateIdentifier,
        actionIdentifier: 'reclaim',
        intent: reclaimIntent,
        variables: followUpVariables(record, 'owner', [
            { variableIdentifier: 'ownerPayoutLockingScript', roleIdentifier: 'owner', value: payoutScript },
        ]),
        inputs: [vaultInput(record, 'reclaimInput', 0xffffffff)],
    });
    const invitationIdentifier = created.invitation.invitationIdentifier;

    await engine.appendInvitation(invitationIdentifier, {
        templateIdentifier,
        actionIdentifier: 'reclaim',
        outputs: [{ outputIdentifier: 'ownerPayoutOutput' }],
    });

    for (const inputIndex of await engine.listOwnInputIndexes(invitationIdentifier)) {
        await engine.signInvitation(invitationIdentifier, inputIndex);
    }

    const preview = await verifyInvitationTransaction(engine, invitationIdentifier, 0);
    console.log('preview txid', preview.transactionHash, 'size', preview.transactionByteLength);
    console.log('missing', JSON.stringify(await engine.listMissingRequirements(invitationIdentifier), (_key, value) => typeof value === 'bigint' ? value.toString() : value));

    const stored = await engine.getInvitation(invitationIdentifier);
    if (!stored) throw new Error('stored invitation missing');
    console.log('invitation', writeArtifact(`reclaim-${vaultName}-invitation.json`, serializeInvitation(stored.invitation)));

    const txid = await broadcastWithRetry({ engine, invitationIdentifier });
    if (txid !== '') {
        console.log('BROADCAST_TXID', txid);
        appendHistory(record, 'reclaim', txid, `owner received ${payout} sats`);
        record.status = 'reclaimed';
        saveRecord(record);
        console.log('RECLAIMED', String(payout));
    }
} finally {
    await stopEngine(engine);
}
