import { readFileSync } from 'node:fs';
import { deserializeInvitation, serializeInvitation } from '@xo-cash/utils';
import { optionalEnv, requireEnv } from './lib/config.js';
import { archiveAllInvitations, openEngine, stopEngine } from './lib/engine.js';

/**
 * Second half of the beneficiary hand-off demonstrated in docs/FINDINGS.md 3.
 *
 * A wallet that does not track the vault cannot build a claim, because the
 * engine refuses to compile an unlocking script for an input it does not own
 * (even though the covenant needs no signature). It *can* execute an
 * invitation that somebody else already completed: this script joins the
 * invitation with its own role and broadcasts the transaction the owner's
 * wallet assembled.
 *
 *   INVITATION_FILE=artifacts/claim-A-invitation.json \
 *   XO_WALLET=/path/to/beneficiary-wallet.json \
 *   XO_DB_PATH=.xo-data-beneficiary \
 *   ROLE=beneficiary BROADCAST=1 node --import tsx scripts/broadcast-invitation.ts
 */
const path = requireEnv('INVITATION_FILE');
const role = requireEnv('ROLE');
const invitation = deserializeInvitation(readFileSync(path, 'utf8'));

const { engine } = await openEngine();
try {
    await archiveAllInvitations(engine);
    const stored = await engine.acceptInvitation(invitation, { roleIdentifier: role });
    const invitationIdentifier = stored.invitation.invitationIdentifier;
    console.log('joined invitation', invitationIdentifier, 'as', role);
    console.log('missing', JSON.stringify(await engine.listMissingRequirements(invitationIdentifier), (_key, value) => typeof value === 'bigint' ? value.toString() : value));
    if (optionalEnv('SHOW_TX') === '1') {
        const preview = await engine.buildInvitationTransactionFromMergedCommit(invitationIdentifier);
        console.log('preview txid', preview.transactionHash, 'size', preview.transactionByteLength);
    }
    if (process.env.BROADCAST === '1') {
        const attempts = Number(process.env.MAX_RETRIES ?? '1');
        const delay = Number(process.env.RETRY_DELAY_SECONDS ?? '60');
        for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
            try {
                const result = await engine.executeAction(invitationIdentifier, { broadcastTransaction: true });
                console.log('BROADCAST_TXID', result.builtTransaction.transactionHash);
                break;
            } catch (error) {
                const message = (error as Error).message;
                const retryable = /non-BIP68-final|non-final/.test(message);
                if (!retryable || attempt === attempts) throw error;
                console.log(`attempt ${attempt}/${attempts} rejected (${message.replace(/\s+/g, ' ').slice(-80)}); waiting ${delay}s`);
                await new Promise((resolve) => setTimeout(resolve, delay * 1_000));
            }
        }
    } else {
        console.log('DRY_RUN (set BROADCAST=1 to send)');
    }
    const latest = await engine.getInvitation(invitationIdentifier);
    if (latest) console.log('invitation after execution', serializeInvitation(latest.invitation).length, 'chars');
} finally {
    await stopEngine(engine);
}
