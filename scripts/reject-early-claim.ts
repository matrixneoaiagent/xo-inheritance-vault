import { serializeInvitation } from '@xo-cash/utils';
import { blocksUntilClaim } from '../source/index.js';
import { writeArtifact } from './lib/artifacts.js';
import { isBroadcast, optionalEnv } from './lib/config.js';
import { archiveAllInvitations, openEngine, stopEngine } from './lib/engine.js';
import { logAge, requireRecord, followUpVariables, vaultInput } from './lib/vault.js';
import { expectInvitationTransactionRejected, verifyInvitationTransaction } from './verify-tx.js';

/**
 * Negative test: a claim attempted **before** the vault is old enough.
 *
 * Two layers are demonstrated:
 *
 *  1. Script level (libauth VM, offline): building the claim with an nSequence
 *     below `periodBlocks` makes OP_CHECKSEQUENCEVERIFY fail. The covenant
 *     cannot be tricked by a spender choosing a smaller relative locktime.
 *  2. Network level (real Chipnet broadcast): the correctly-formed claim
 *     (`nSequence == periodBlocks`) passes the local VM -- the script has no
 *     chain context -- but a node refuses it as `non-BIP68-final` until the
 *     covenant coin is genuinely `periodBlocks` old.
 *
 * The script refuses to broadcast if the vault is already claimable, so it can
 * never accidentally hand the inheritance over.
 */
const vaultName = optionalEnv('VAULT_NAME') ?? 'A';
const record = requireRecord(vaultName);

const { engine, templateIdentifier } = await openEngine();
try {
    await archiveAllInvitations(engine);
    const template = await engine.getTemplate(templateIdentifier);
    if (!template) throw new Error('template missing');
    const claimIntent = template.lockingScripts.vaultScript.roles?.beneficiary.actions?.find((intent) => intent.action === 'claim');
    if (!claimIntent) throw new Error('claim intent missing');

    // `logAge` also fills in the covenant's confirmation height when the record
    // does not have it yet, which is what the safety check below needs.
    await logAge(engine, record);
    const status = await engine.getChainStatus();
    const height = record.covenantBlockHeight;
    if (height !== undefined) {
        const remaining = blocksUntilClaim({ covenantBlockHeight: height, tipHeight: status.currentHeight, periodBlocks: BigInt(record.periodBlocks) });
        console.log('blocks until claimable', String(remaining));
        if (remaining === 0n) throw new Error('vault is already claimable: refusing to run the early-claim test');
    } else {
        console.log('covenant height unknown: the safety check cannot run, use a vault with a long period');
    }

    async function buildClaim(sequenceNumber: number): Promise<string> {
        const created = await engine.createInvitation({
            templateIdentifier,
            actionIdentifier: 'claim',
            intent: claimIntent!,
            variables: followUpVariables(record, 'beneficiary'),
            inputs: [vaultInput(record, 'claimInput', sequenceNumber)],
        });
        const invitationIdentifier = created.invitation.invitationIdentifier;
        await engine.appendInvitation(invitationIdentifier, {
            templateIdentifier,
            actionIdentifier: 'claim',
            outputs: [{ outputIdentifier: 'beneficiaryPayoutOutput' }],
        });
        // No signature is involved, but this call is what compiles and appends
        // the template's unlocking script (FINDINGS 2).
        for (const inputIndex of await engine.listOwnInputIndexes(invitationIdentifier)) {
            await engine.signInvitation(invitationIdentifier, inputIndex);
        }
        return invitationIdentifier;
    }

    /* 1. Script-level rejection: nSequence below the committed period. */
    const shortSequence = Math.max(1, record.periodBlocks - 1);
    const shortInvitation = await buildClaim(shortSequence);
    const scriptReason = await expectInvitationTransactionRejected(engine, shortInvitation, 0);
    console.log('SCRIPT_LEVEL_REJECTED (nSequence', shortSequence, '<', record.periodBlocks, ')', scriptReason);
    const shortStored = await engine.getInvitation(shortInvitation);
    if (shortStored) {
        console.log('invitation', writeArtifact(`claim-too-early-script-${vaultName}-invitation.json`, serializeInvitation(shortStored.invitation)));
    }
    // Release the reservation on the vault UTXO before building the next claim.
    await engine.archiveInvitation(shortInvitation);

    /* 2. Network-level rejection: correct sequence, coin not old enough. */
    const claimInvitation = await buildClaim(record.periodBlocks);
    const preview = await verifyInvitationTransaction(engine, claimInvitation, 0);
    console.log('VM_OK for the correctly-formed claim (the script has no chain context):', preview.transactionHash);

    const stored = await engine.getInvitation(claimInvitation);
    if (stored) {
        console.log('invitation', writeArtifact(`claim-too-early-network-${vaultName}-invitation.json`, serializeInvitation(stored.invitation)));
    }

    let networkReason = '(not attempted)';
    if (isBroadcast()) {
        try {
            const result = await engine.executeAction(claimInvitation, { broadcastTransaction: true });
            // If this happens the vault was NOT early: treat it as a failed test.
            networkReason = `UNEXPECTED: broadcast accepted, txid ${result.builtTransaction.transactionHash}`;
            console.log('UNEXPECTED_BROADCAST_ACCEPTED', networkReason);
        } catch (error) {
            networkReason = (error as Error).message;
            console.log('NETWORK_REJECTED (expected)', networkReason);
        }
    } else {
        console.log('DRY_RUN (set BROADCAST=1 for the real network rejection)');
    }

    console.log('reasons', writeArtifact(`claim-too-early-${vaultName}-reason.txt`, `nSequence ${shortSequence} (below the committed period): ${scriptReason}\n` +
        `nSequence ${record.periodBlocks} before the coin aged: ${networkReason}\n`));
} finally {
    await stopEngine(engine);
}
