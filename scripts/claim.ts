import { decodeTransaction, hexToBin } from '@bitauth/libauth';
import { serializeInvitation } from '@xo-cash/utils';
import { computeClaimValue } from '../source/index.js';
import { writeArtifact } from './lib/artifacts.js';
import { optionalEnv } from './lib/config.js';
import { archiveAllInvitations, openEngine, stopEngine } from './lib/engine.js';
import { appendHistory, saveRecord } from './lib/record.js';
import { broadcastWithRetry, followUpVariables, logAge, requireRecord, vaultInput } from './lib/vault.js';
import { verifyInvitationTransaction } from './verify-tx.js';

/**
 * `claim`: the beneficiary takes the whole balance once the vault has been
 * untouched for `periodBlocks`.
 *
 * There is **no signature** in this transaction. The covenant checks
 * (a) the input's BIP68 age, (b) that there is exactly one input and one
 * output, (c) that output 0 pays the committed beneficiary script, and
 * (d) that output 0 is exactly `vaultSatoshis - 1500`. Anyone may broadcast it;
 * only the beneficiary can be paid.
 *
 * Run it from the beneficiary's own wallet if you want to prove that no owner
 * key is involved: this script only needs the public vault record.
 */
const vaultName = optionalEnv('VAULT_NAME') ?? 'A';
const record = requireRecord(vaultName);
const vaultSatoshis = BigInt(record.vaultSatoshis);
const payout = computeClaimValue(vaultSatoshis);

const { engine, templateIdentifier } = await openEngine();
try {
    await archiveAllInvitations(engine);
    const template = await engine.getTemplate(templateIdentifier);
    if (!template) throw new Error('template missing');
    const claimIntent = template.lockingScripts.vaultScript.roles?.beneficiary.actions?.find((intent) => intent.action === 'claim');
    if (!claimIntent) throw new Error('claim intent missing');

    console.log('template', templateIdentifier);
    console.log('vault', record.vaultAddress, 'balance', String(vaultSatoshis));
    console.log('beneficiary', record.beneficiaryAddress, 'receives', String(payout));
    await logAge(engine, record);

    const created = await engine.createInvitation({
        templateIdentifier,
        actionIdentifier: 'claim',
        intent: claimIntent,
        variables: followUpVariables(record, 'beneficiary'),
        inputs: [
            // Relative locktime: the claiming transaction's nSequence must be at
            // least periodBlocks, and the network only relays it once the coin
            // is that old. See docs/ARCHITECTURE.md §3.
            vaultInput(record, 'claimInput', record.periodBlocks),
        ],
    });
    const invitationIdentifier = created.invitation.invitationIdentifier;

    await engine.appendInvitation(invitationIdentifier, {
        templateIdentifier,
        actionIdentifier: 'claim',
        outputs: [{ outputIdentifier: 'beneficiaryPayoutOutput' }],
    });

    // A claim carries no signature, but the engine still has to compile and
    // append the unlocking script, and `signInvitation` is the only call that
    // does that: for a signature-free spend it just adds `<1> <redeem>`.
    // See docs/FINDINGS.md item 2.
    const ownInputs = await engine.listOwnInputIndexes(invitationIdentifier);
    console.log('own inputs to sign', JSON.stringify(ownInputs));
    for (const inputIndex of ownInputs) {
        await engine.signInvitation(invitationIdentifier, inputIndex);
    }
    const builtClaim = await engine.buildInvitationTransactionFromMergedCommit(invitationIdentifier);
    const decodedClaim = decodeTransaction(hexToBin(builtClaim.serializedTransaction));
    if (typeof decodedClaim !== 'string') {
        console.log('unlocking script of input 0:', `${decodedClaim.inputs[0].unlockingBytecode.length} bytes, selector only, no signature`);
    }

    const preview = await verifyInvitationTransaction(engine, invitationIdentifier, 0);
    console.log('preview txid', preview.transactionHash, 'size', preview.transactionByteLength);
    console.log('missing', JSON.stringify(await engine.listMissingRequirements(invitationIdentifier), (_key, value) => typeof value === 'bigint' ? value.toString() : value));

    const stored = await engine.getInvitation(invitationIdentifier);
    if (!stored) throw new Error('stored invitation missing');
    console.log('invitation', writeArtifact(`claim-${vaultName}-invitation.json`, serializeInvitation(stored.invitation)));

    const txid = await broadcastWithRetry({ engine, invitationIdentifier, retryOnCsv: true });
    if (txid !== '') {
        console.log('BROADCAST_TXID', txid);
        appendHistory(record, 'claim', txid, `beneficiary received ${payout} sats`);
        // The covenant UTXO is spent: the record stays for the archive, marked closed.
        record.status = 'claimed';
        saveRecord(record);
        console.log('CLAIMED', String(payout), 'to', record.beneficiaryAddress);
    }
} finally {
    await stopEngine(engine);
}
