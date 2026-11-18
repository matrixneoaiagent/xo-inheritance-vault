import { DUST_LIMIT_SATOSHIS } from '@xo-cash/engine';
import { hexToBin, lockingBytecodeToCashAddress } from '@bitauth/libauth';
import { serializeInvitation } from '@xo-cash/utils';
import { VAULT_FEE_SATOSHIS, labelToHex } from '../source/index.js';
import { writeArtifact } from './lib/artifacts.js';
import { isBroadcast, optionalBigInt, optionalEnv, optionalInt, requireEnv } from './lib/config.js';
import { archiveAllInvitations, ensureDefaultPolicies, openEngine, stopEngine } from './lib/engine.js';
import { compileVaultScript } from './lib/vault.js';
import { appendHistory, saveRecord, type VaultRecord } from './lib/record.js';
import { verifyInvitationTransaction } from './verify-tx.js';

/**
 * Creates an inheritance vault.
 *
 *   VAULT_SATS         initial balance (default 60000)
 *   PERIOD_BLOCKS      liveness period in blocks (default 3)
 *   LABEL              committed UTF-8 label (default "xo-inheritance-vault")
 *   BENEFICIARY_KEY    WIF/hex private key of the beneficiary -> P2PKH script
 *   BENEFICIARY_SCRIPT alternative: a raw locking script (hex) for the beneficiary
 *   VAULT_NAME         name of the record written to artifacts/ (default "A")
 */
const vaultSatoshis = optionalBigInt('VAULT_SATS') ?? 60_000n;
const periodBlocks = optionalInt('PERIOD_BLOCKS') ?? 3;
const label = optionalEnv('LABEL') ?? 'xo-inheritance-vault';
const vaultName = optionalEnv('VAULT_NAME') ?? 'A';

if (periodBlocks < 1) throw new Error('PERIOD_BLOCKS must be at least 1');
if (vaultSatoshis <= VAULT_FEE_SATOSHIS + BigInt(DUST_LIMIT_SATOSHIS)) throw new Error('VAULT_SATS must exceed the fixed fee plus dust');

const beneficiaryScript = requireEnv('BENEFICIARY_SCRIPT');
if (!/^[0-9a-f]+$/.test(beneficiaryScript)) throw new Error('BENEFICIARY_SCRIPT must be lowercase hex');
if (labelToHex(label).length === 0) throw new Error('LABEL must not be empty: it is committed into the covenant address');

const beneficiaryAddress = lockingBytecodeToCashAddress({ bytecode: hexToBin(beneficiaryScript), prefix: 'bchtest' });
if (typeof beneficiaryAddress === 'string') throw new Error(beneficiaryAddress);

const { engine, templateIdentifier } = await openEngine();
try {
    await ensureDefaultPolicies(engine);
    await archiveAllInvitations(engine);
    const template = await engine.getTemplate(templateIdentifier);
    if (!template) throw new Error('template missing after import');
    const start = template.start.find((intent) => intent.action === 'createVault');
    if (!start) throw new Error('createVault start intent missing');

    console.log('template', templateIdentifier);
    console.log('vault', String(vaultSatoshis), 'sats, period', periodBlocks, 'blocks, label', JSON.stringify(label));
    console.log('beneficiary', beneficiaryAddress.address, beneficiaryScript);

    const created = await engine.createInvitation({
        templateIdentifier,
        actionIdentifier: 'createVault',
        intent: start,
        variables: [
            { variableIdentifier: 'vaultSatoshis', roleIdentifier: 'owner', value: vaultSatoshis },
            { variableIdentifier: 'periodBlocks', roleIdentifier: 'owner', value: periodBlocks },
            { variableIdentifier: 'beneficiaryLockingScript', roleIdentifier: 'owner', value: beneficiaryScript },
            // `bytes` variables are provided as hex text.
            { variableIdentifier: 'label', roleIdentifier: 'owner', value: labelToHex(label) },
        ],
    });
    const invitationIdentifier = created.invitation.invitationIdentifier;

    await engine.appendInvitation(invitationIdentifier, {
        templateIdentifier,
        actionIdentifier: 'createVault',
        outputs: [{ outputIdentifier: 'initialVaultOutput' }],
    });

    // The engine resolves the covenant bytecode for this output; that bytecode
    // is what the record publishes for independent verification.
    const vaultLockingBytecode = await engine.resolveInvitationOutputLockingBytecode(
        invitationIdentifier,
        'initialVaultOutput',
        'owner',
    );
    const vaultAddress = lockingBytecodeToCashAddress({ bytecode: hexToBin(vaultLockingBytecode), prefix: 'bchtest' });
    if (typeof vaultAddress === 'string') throw new Error(vaultAddress);

    const spendable = await engine.listSpendableUnspentOutputs();
    const funding = spendable
        // Never fund a vault from another vault: a covenant output cannot be
        // signed as an ordinary P2PKH input, and `selectable: false` is not
        // honoured for Electrum-ingested UTXOs (FINDINGS 8).
        .filter((utxo) => utxo.templateIdentifier !== templateIdentifier)
        .filter((utxo) => BigInt(utxo.valueSatoshis) > vaultSatoshis + 5_000n)
        .sort((a, b) => Number(BigInt(b.valueSatoshis) - BigInt(a.valueSatoshis)))[0];
    if (!funding) throw new Error('no funding UTXO larger than VAULT_SATS + 5000');
    console.log('funding', funding.outpointTransactionHash, funding.outpointIndex, String(funding.valueSatoshis));

    await engine.appendInvitation(invitationIdentifier, {
        templateIdentifier,
        actionIdentifier: 'createVault',
        inputs: [{
            outpointTransactionHash: hexToBin(funding.outpointTransactionHash),
            outpointIndex: funding.outpointIndex,
        }],
    });

    const changeScript = optionalEnv('FUNDER_CHANGE_SCRIPT') ?? await engine.generateLockingBytecodeFromDefaultPolicy('change');
    const estimatedFee = await engine.estimateTransactionFee(invitationIdentifier);
    const feeSatoshis = optionalBigInt('FEE_SATS') ?? BigInt(Math.max(estimatedFee, Number(VAULT_FEE_SATOSHIS)));
    const fundingValue = BigInt(funding.valueSatoshis);
    const changeSatoshis = fundingValue - vaultSatoshis - feeSatoshis;
    if (changeSatoshis < BigInt(DUST_LIMIT_SATOSHIS)) throw new Error(`change ${changeSatoshis} is below dust; lower VAULT_SATS`);
    await engine.appendInvitation(invitationIdentifier, {
        templateIdentifier,
        actionIdentifier: 'createVault',
        outputs: [{ lockingBytecode: hexToBin(changeScript), valueSatoshis: changeSatoshis }],
    });
    console.log('fee', String(feeSatoshis), 'change', String(changeSatoshis));

    for (const inputIndex of await engine.listOwnInputIndexes(invitationIdentifier)) {
        await engine.signInvitation(invitationIdentifier, inputIndex);
    }

    const preview = await verifyInvitationTransaction(engine, invitationIdentifier, 0);
    const stored = await engine.getInvitation(invitationIdentifier);
    if (!stored) throw new Error('stored invitation missing');
    console.log('invitation', writeArtifact(`createVault-${vaultName}-invitation.json`, serializeInvitation(stored.invitation)));
    console.log('preview txid', preview.transactionHash, 'size', preview.transactionByteLength);
    console.log('VAULT_ADDRESS', vaultAddress.address);
    console.log('VAULT_LOCKING_BYTECODE', vaultLockingBytecode);

    const record: VaultRecord = {
        name: vaultName,
        templateIdentifier,
        label,
        labelHex: labelToHex(label),
        periodBlocks,
        beneficiaryLockingScript: beneficiaryScript,
        beneficiaryAddress: beneficiaryAddress.address,
        vaultLockingBytecode,
        vaultScriptHash: '',
        vaultAddress: vaultAddress.address,
        vaultSatoshis: String(vaultSatoshis),
        outpointTransactionHash: preview.transactionHash,
        outpointIndex: 0,
        status: 'open',
        history: [],
    };

    let txid = preview.transactionHash;
    if (isBroadcast()) {
        const result = await engine.executeAction(invitationIdentifier, { broadcastTransaction: true });
        txid = result.builtTransaction.transactionHash;
        console.log('BROADCAST_TXID', txid);
    } else {
        console.log('DRY_RUN (set BROADCAST=1 to send)');
    }

    // The covenant script hash is the hash of the *output* script, which the
    // engine also tracks; it is what follow-up scripts look up in storage.
    const tracked = (await engine.listScriptHashes()).find((entry) => entry.lockingBytecode.toLowerCase() === vaultLockingBytecode.toLowerCase());
    record.vaultScriptHash = tracked?.scriptHash ?? '';

    // Audit the address: recompile the covenant from the template's own
    // CashASM and check that it reproduces the bytecode the engine resolved.
    const lookupKey = tracked?.secrets?.[0];
    const ownerPublicKey = lookupKey === undefined ? undefined : await engine.getSecretPublicKey(lookupKey);
    if (ownerPublicKey !== undefined) {
        record.ownerPublicKey = ownerPublicKey;
        const compiled = compileVaultScript({
            ownerPublicKeyHex: ownerPublicKey,
            periodBlocks,
            labelHex: labelToHex(label),
            beneficiaryLockingScript: beneficiaryScript,
        });
        record.redeemScript = compiled.redeemHex;
        if (compiled.p2sh32Hex !== vaultLockingBytecode) {
            throw new Error(`covenant mismatch: engine produced ${vaultLockingBytecode}, template compiles to ${compiled.p2sh32Hex}`);
        }
        console.log('covenant verified: engine bytecode == template compilation, redeem size', compiled.redeemHex.length / 2);
    }

    appendHistory(record, isBroadcast() ? 'createVault' : 'createVault(dry-run)', txid, `funded ${vaultSatoshis} sats`);
    console.log('record', saveRecord(record), `(use VAULT_NAME=${vaultName} for follow-ups)`);
    console.log('VAULT_TXID', txid);
} finally {
    await stopEngine(engine);
}
