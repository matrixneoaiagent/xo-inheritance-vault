import type { XOTemplate } from '@xo-cash/types';

/**
 * XO Inheritance Vault
 *
 * A dead-man's switch for BCH with **no oracle, no custodian and no trusted
 * third party**. The owner funds a P2SH32 covenant that commits to:
 *
 *   - the owner's public key                (the only key that can renew or cancel)
 *   - the beneficiary's locking script      (where the balance must go on a claim)
 *   - periodBlocks                          (the BIP68 relative-locktime period)
 *   - label                                 (free-form bytes committed into the address)
 *
 * While the owner is alive they periodically spend the covenant back to
 * *itself* (`poke`). That spend is the entire liveness signal: it is a plain
 * owner-signed transaction that resets the covenant UTXO's BIP68 age because
 * the coin is new.
 *
 * If the owner stops poking for `periodBlocks` blocks, the beneficiary may
 * `claim`: the covenant's own rules (CSV + destination + value) pay the whole
 * balance to the beneficiary without the owner's signature and without any
 * cooperation from a server or an oracle. Until that moment the owner keeps
 * full control and can `reclaim` at any time, or hand the vault to a different
 * beneficiary with `updateBeneficiary`.
 *
 * CashScript analogy. This template is written in the same spirit as
 * CashScript's "Licho's Mecenas" (a funder pledges, a recipient withdraws after
 * `this.age >= period`, the remainder returns to the same covenant), but the
 * economics are inverted: the *owner* must keep proving liveness, and the
 * direction of the transfer is a fallback rather than a subscription. See
 * docs/ARCHITECTURE.md for the line-by-line mapping.
 *
 * Every branch of the redeem script is selected by a small integer pushed by
 * the spender (`cashc` compiles multiple `function`s the same way):
 *
 *   1  claim            (beneficiary, no signature, after periodBlocks)
 *   2  poke             (owner signature, one output back to this exact script)
 *   3  reclaim          (owner signature, one output to the owner's destination)
 *   4  updateBeneficiary(owner signature, one output to the next vault script)
 */
export const inheritanceVaultTemplate: XOTemplate = {
    $schema: 'https://libauth.org/schemas/wallet-template-v0.schema.json',

    name: 'XO Inheritance Vault',
    description: 'A dead-man\'s switch: the owner renews the vault with a periodic signed poke; if the owner stops, the beneficiary claims the whole balance after periodBlocks with no owner signature. The owner can always reclaim.',
    icon: 'vault',

    version: '1',
    supported: [ 'BCH_2023_05', 'BCH_2024_05', 'BCH_2025_05', 'BCH_2026_05' ],

    resources: [
        {
            name: 'XO template documentation',
            description: 'Guide to writing XO templates.',
            url: 'https://stack.xo.cash/blog/2026-08-24-Vision-to-Reality-6-Writing-Templates.html',
        },
        {
            name: 'Bitcoin Cash relative locktime (BIP68)',
            description: 'The consensus rule behind `this.age` in CashScript and OP_CHECKSEQUENCEVERIFY here.',
            url: 'https://github.com/bitcoin/bips/blob/master/bip-0068.mediawiki',
        },
        {
            name: "CashScript's Mecenas (the closest CashScript analogue)",
            description: 'A recurring-payment covenant built on the same age-gated, self-renewing pattern.',
            url: 'https://cashscript.org/docs/language/examples#lichos-mecenas',
        },
    ],

    roles: {
        owner: {
            name: 'Owner',
            description: 'Funds the vault, proves liveness with periodic pokes, and can reclaim or re-target the vault at any time.',
            icon: 'owner',
        },
        beneficiary: {
            name: 'Beneficiary',
            description: 'Receives the whole balance if the owner stops poking for periodBlocks. Claiming needs no signature: the covenant enforces the payout.',
            icon: 'beneficiary',
        },
    },

    start: [
        {
            action: 'createVault',
            role: 'owner',
            generate: [ 'ownerKey' ],
        },
    ],

    actions: {
        createVault: {
            name: 'Create Inheritance Vault',
            description: 'Fund a new vault for a beneficiary. The owner key and the period are committed into the covenant address.',
            icon: 'vault',

            roles: {
                owner: {
                    name: 'Fund vault',
                    description: 'Choose the beneficiary, the liveness period and an optional label, then deposit the initial balance.',
                    icon: 'owner',

                    generate: [ 'ownerKey' ],

                    requirements: {
                        variables: [ 'vaultSatoshis', 'periodBlocks', 'beneficiaryLockingScript', 'label' ],
                    },
                },
            },

            requirements: {
                participants: [
                    { role: 'owner', slots: { min: 1, max: 1 } },
                ],
            },

            transaction: 'createVaultTransaction',
        },

        poke: {
            name: 'Poke (prove liveness)',
            description: 'Spend the vault back to the identical covenant script. This is the owner\'s periodic proof of liveness: the new output starts a fresh BIP68 age.',
            icon: 'poke',

            roles: {
                owner: {
                    requirements: {
                        variables: [ 'vaultSatoshis', 'periodBlocks', 'beneficiaryLockingScript', 'label' ],
                        secrets: [ 'ownerKey' ],
                    },
                },
            },

            requirements: {
                participants: [
                    { role: 'owner', slots: { min: 1, max: 1 } },
                ],
            },

            // UI/application gate mirroring the on-chain age rule: a poke is
            // allowed at any age, so there is deliberately no condition here.
            transaction: 'pokeTransaction',
        },

        claim: {
            name: 'Claim (beneficiary)',
            description: 'After the vault has been untouched for periodBlocks, the beneficiary takes the whole balance. No signature is required: the covenant enforces the destination and the amount.',
            icon: 'claim',

            roles: {
                beneficiary: {
                    requirements: {
                        variables: [ 'vaultSatoshis', 'periodBlocks', 'beneficiaryLockingScript', 'label' ],
                    },
                },
            },

            requirements: {
                participants: [
                    { role: 'beneficiary', slots: { min: 1, max: 1 } },
                ],
            },

            // Off-chain mirror of the CSV rule for UIs: this action is only
            // meaningful once the covenant outpoint is at least periodBlocks old.
            // The covenant is the real enforcement; see docs/ARCHITECTURE.md.
            conditions: [
                '$(<vaultSatoshis> <1500> OP_SUB <546> OP_GREATERTHANOREQUAL)',
            ],

            transaction: 'claimTransaction',
        },

        reclaim: {
            name: 'Reclaim (cancel the inheritance)',
            description: 'The owner cancels the vault and takes the balance at any time, regardless of age. No signature from the beneficiary and no waiting period.',
            icon: 'reclaim',

            roles: {
                owner: {
                    requirements: {
                        variables: [ 'vaultSatoshis', 'periodBlocks', 'beneficiaryLockingScript', 'label', 'ownerPayoutLockingScript' ],
                        secrets: [ 'ownerKey' ],
                    },
                },
            },

            requirements: {
                participants: [
                    { role: 'owner', slots: { min: 1, max: 1 } },
                ],
            },

            transaction: 'reclaimTransaction',
        },

        updateBeneficiary: {
            name: 'Update beneficiary',
            description: 'The owner replaces the beneficiary by spending the vault into a new vault covenant with a new beneficiary and/or period. The balance carries over; the vault starts a fresh age.',
            icon: 'update',

            roles: {
                owner: {
                    requirements: {
                        variables: [ 'vaultSatoshis', 'periodBlocks', 'beneficiaryLockingScript', 'label', 'nextVaultLockingScript' ],
                        secrets: [ 'ownerKey' ],
                    },
                },
            },

            requirements: {
                participants: [
                    { role: 'owner', slots: { min: 1, max: 1 } },
                ],
            },

            transaction: 'updateBeneficiaryTransaction',
        },
    },

    transactions: {
        createVaultTransaction: {
            name: 'Inheritance Vault Created',
            description: 'Funded an inheritance vault holding $(<vaultSatoshis>) satoshis for the beneficiary, with a $(<periodBlocks>)-block liveness period.',
            icon: 'vault',

            inputs: [],
            outputs: [
                { output: 'initialVaultOutput', outputIndex: 0 },
            ],

            version: 2,
            locktime: 0,
            composable: true,
        },

        pokeTransaction: {
            name: 'Vault Poked',
            description: 'The owner proved liveness: the balance moved back into the identical covenant script, resetting its age.',
            icon: 'poke',

            inputs: [
                { input: 'pokeInput', inputIndex: 0 },
            ],
            outputs: [
                { output: 'renewedVaultOutput', outputIndex: 0 },
            ],

            version: 2,
            locktime: 0,
            composable: true,
        },

        claimTransaction: {
            name: 'Inheritance Claimed',
            description: 'The beneficiary claimed the whole vault balance after the liveness period expired.',
            icon: 'claim',

            inputs: [
                { input: 'claimInput', inputIndex: 0 },
            ],
            outputs: [
                { output: 'beneficiaryPayoutOutput', outputIndex: 0 },
            ],

            // Relative locktime (this.age >= periodBlocks) requires version 2.
            version: 2,
            locktime: 0,
            composable: true,
        },

        reclaimTransaction: {
            name: 'Vault Reclaimed',
            description: 'The owner cancelled the inheritance and took the balance.',
            icon: 'reclaim',

            inputs: [
                { input: 'reclaimInput', inputIndex: 0 },
            ],
            outputs: [
                { output: 'ownerPayoutOutput', outputIndex: 0 },
            ],

            version: 2,
            locktime: 0,
            composable: true,
        },

        updateBeneficiaryTransaction: {
            name: 'Beneficiary Updated',
            description: 'The owner moved the balance into a new vault covenant for a different beneficiary.',
            icon: 'update',

            inputs: [
                { input: 'updateInput', inputIndex: 0 },
            ],
            outputs: [
                { output: 'nextVaultOutput', outputIndex: 0 },
            ],

            version: 2,
            locktime: 0,
            composable: true,
        },
    },

    inputs: {
        // Four input definitions share the same covenant output because each
        // action uses a different unlocking script and only `claim` needs a
        // relative-locktime (nSequence) requirement. See docs/ARCHITECTURE.md.
        pokeInput: {
            name: 'Vault balance',
            description: 'The covenant output holding $(<vaultSatoshis>) satoshis.',
            icon: 'vault',

            valueSatoshis: '$(<vaultSatoshis>)',
            token: null,
            unlockingScript: 'unlockPoke',
        },
        claimInput: {
            name: 'Vault balance',
            description: 'The covenant output holding $(<vaultSatoshis>) satoshis, untouched for at least $(<periodBlocks>) blocks.',
            icon: 'vault',

            valueSatoshis: '$(<vaultSatoshis>)',
            token: null,
            unlockingScript: 'unlockClaim',
        },
        reclaimInput: {
            name: 'Vault balance',
            description: 'The covenant output holding $(<vaultSatoshis>) satoshis.',
            icon: 'vault',

            valueSatoshis: '$(<vaultSatoshis>)',
            token: null,
            unlockingScript: 'unlockReclaim',
        },
        updateInput: {
            name: 'Vault balance',
            description: 'The covenant output holding $(<vaultSatoshis>) satoshis.',
            icon: 'vault',

            valueSatoshis: '$(<vaultSatoshis>)',
            token: null,
            unlockingScript: 'unlockUpdate',
        },
    },

    outputs: {
        initialVaultOutput: {
            name: 'Inheritance Vault',
            description: 'A new covenant holding $(<vaultSatoshis>) satoshis for the beneficiary. Its age starts at the first confirmation.',
            icon: 'vault',

            lockingScript: 'vaultScript',
            valueSatoshis: '$(<vaultSatoshis>)',
            token: null,
        },

        renewedVaultOutput: {
            name: 'Inheritance Vault (poked)',
            description: 'The same covenant bytecode, minus the fixed poke fee. The new output restarts the BIP68 age counter.',
            icon: 'vault',

            lockingScript: 'vaultScript',
            // The poke fee is covenant-fixed: 1500 satoshis, inlined below.
            valueSatoshis: '$(<vaultSatoshis> <1500> OP_SUB)',
            token: null,
        },

        beneficiaryPayoutOutput: {
            name: 'Beneficiary payout',
            description: 'The whole balance minus the fixed claim fee, paid to the beneficiary locking script committed in the covenant.',
            icon: 'beneficiary',

            lockingScript: '$(<beneficiaryLockingScript>)',
            // Informational only: the covenant enforces this exact value on-chain.
            valueSatoshis: '$(<vaultSatoshis> <1500> OP_SUB)',
            token: null,
        },

        ownerPayoutOutput: {
            name: 'Owner payout',
            description: 'The whole balance minus the fixed reclaim fee, paid to the destination the owner chooses when cancelling.',
            icon: 'owner',

            lockingScript: '$(<ownerPayoutLockingScript>)',
            valueSatoshis: '$(<vaultSatoshis> <1500> OP_SUB)',
            token: null,
        },

        nextVaultOutput: {
            name: 'Inheritance Vault (updated)',
            description: 'A new vault covenant for the next beneficiary. The covenant only checks that this is the exact P2SH32 script the owner committed to.',
            icon: 'update',

            lockingScript: '$(<nextVaultLockingScript>)',
            valueSatoshis: '$(<vaultSatoshis> <1500> OP_SUB)',
            token: null,
        },
    },

    lockingScripts: {
        vaultScript: {
            name: 'Inheritance Vault',
            description: 'Holds the balance and enforces the three post-funding paths: an age-gated beneficiary claim, an owner poke that must return to the identical script, and an owner reclaim.',
            icon: 'vault',

            lockingType: 'p2sh',
            lockingBytecode: 'vaultRedeemBytecode',
            unlockingBytecode: 'unlockPoke',

            state: {
                variables: [ 'beneficiaryLockingScript', 'periodBlocks', 'label', 'vaultSatoshis' ],
                secrets: [],
            },

            roles: {
                owner: {
                    state: {
                        variables: [],
                        secrets: [ 'ownerKey' ],
                    },

                    actions: [
                        { action: 'poke', role: 'owner', secrets: [{ ownerKey: null }] },
                        { action: 'reclaim', role: 'owner', secrets: [{ ownerKey: null }] },
                        { action: 'updateBeneficiary', role: 'owner', secrets: [{ ownerKey: null }] },
                    ],

                    balance: {
                        satoshis: true,
                    },

                    // The engine currently normalizes Electrum UTXOs as
                    // selectable; apps must pass the covenant input explicitly.
                    // See docs/FINDINGS.md.
                    selectable: false,
                },

                beneficiary: {
                    state: {
                        variables: [],
                        secrets: [],
                    },

                    // Claim needs no secret: the covenant is the authorization.
                    actions: [
                        { action: 'claim', role: 'beneficiary' },
                    ],

                    selectable: false,
                },
            },
        },
    },

    scripts: {
        // The owner's full public key is committed inside the covenant and
        // pushed back onto the stack at spend time for the signature check.
        ownerPublicKey: '<ownerKey.public_key>',

        // require(checkSig(sig, ownerPubKey))
        enforceOwnerSignature: 'ownerPublicKey OP_CHECKSIG',

        // require(this.age >= periodBlocks);  (BIP68 relative locktime, blocks)
        enforceAge: '<periodBlocks> OP_CHECKSEQUENCEVERIFY OP_DROP',

        // require(tx.inputs.length == 1);
        enforceSingleInput: 'OP_TXINPUTCOUNT OP_BIN2NUM OP_1 OP_NUMEQUALVERIFY',

        // require(tx.outputs.length == 1);
        enforceSingleOutput: 'OP_TXOUTPUTCOUNT OP_BIN2NUM OP_1 OP_NUMEQUALVERIFY',

        // require(tx.outputs[0].lockingBytecode == beneficiaryLockingScript);
        enforceClaimDestination: 'OP_0 OP_OUTPUTBYTECODE <beneficiaryLockingScript> OP_EQUALVERIFY',

        // require(tx.outputs[0].value == tx.inputs[0].value - claimFee);
        // Ends in OP_NUMEQUAL so the claim branch leaves the final `true`.
        enforceClaimValue:
            'OP_0 OP_OUTPUTVALUE OP_BIN2NUM OP_INPUTINDEX OP_UTXOVALUE OP_BIN2NUM <1500> OP_SUB OP_NUMEQUAL',

        // require(tx.outputs[0].lockingBytecode == tx.inputs[0].lockingBytecode);
        enforcePokeDestination: 'OP_0 OP_OUTPUTBYTECODE OP_INPUTINDEX OP_UTXOBYTECODE OP_EQUALVERIFY',

        // require(tx.outputs[0].value == tx.inputs[0].value - pokeFee);
        enforcePokeValue:
            'OP_0 OP_OUTPUTVALUE OP_BIN2NUM OP_INPUTINDEX OP_UTXOVALUE OP_BIN2NUM <1500> OP_SUB OP_NUMEQUALVERIFY',

        // require(tx.outputs[0].value == tx.inputs[0].value - fee);
        //
        // Shared by `reclaim` and `updateBeneficiary`, the two owner-signed
        // exits. Their *destination* is deliberately unconstrained, exactly as
        // in CashScript's `reclaim()`: a value that the covenant constrained
        // would be frozen into the address at funding time, so an owner could
        // never choose where to send their own money afterwards. See
        // docs/ARCHITECTURE.md §4 and docs/FINDINGS.md item 6.
        enforceSpendValue:
            'OP_0 OP_OUTPUTVALUE OP_BIN2NUM OP_INPUTINDEX OP_UTXOVALUE OP_BIN2NUM <1500> OP_SUB OP_NUMEQUALVERIFY',

        // function claim(): beneficiary takes everything once the vault is old.
        enforceClaim: 'enforceAge enforceSingleInput enforceSingleOutput enforceClaimDestination enforceClaimValue',

        // function poke(): owner-signed no-op that returns to the same script.
        enforcePoke: 'enforceSingleInput enforceSingleOutput enforcePokeDestination enforcePokeValue enforceOwnerSignature',

        // function reclaim(): owner-signed exit at any age, to any destination.
        enforceReclaim: 'enforceSingleInput enforceSingleOutput enforceSpendValue enforceOwnerSignature',

        // function updateBeneficiary(): owner-signed hop into the next vault.
        // The "next vault" property is enforced by the template's own output
        // declaration and the off-chain helper, not by the covenant (the
        // covenant cannot hold a script that is not known at funding time).
        enforceUpdate: 'enforceSingleInput enforceSingleOutput enforceSpendValue enforceOwnerSignature',

        // The label is committed into the address by being pushed and dropped:
        // it costs a few bytes per spend but makes the address depend on it,
        // so two vaults with identical keys and periods but different labels
        // are different addresses (a deliberate uniqueness salt).
        commitLabel: '<label> OP_DROP',

        // Function selector, the same shape `cashc` emits for multi-function
        // contracts: 1 = claim, 2 = poke, 3 = reclaim, 4 = updateBeneficiary.
        // The selector is the only thing in the claim's unlocking script, so
        // the claim transaction carries no signature at all.
        vaultRedeemBytecode:
            'commitLabel OP_DUP OP_1 OP_NUMEQUAL OP_IF OP_DROP enforceClaim OP_ELSE OP_DUP OP_2 OP_NUMEQUAL OP_IF OP_DROP enforcePoke OP_ELSE OP_DUP OP_3 OP_NUMEQUAL OP_IF OP_DROP enforceReclaim OP_ELSE OP_4 OP_NUMEQUALVERIFY enforceUpdate OP_ENDIF OP_ENDIF OP_ENDIF',

        unlockClaim: '<1>',
        unlockPoke: '<ownerKey.schnorr_signature.all_outputs> <2>',
        unlockReclaim: '<ownerKey.schnorr_signature.all_outputs> <3>',
        unlockUpdate: '<ownerKey.schnorr_signature.all_outputs> <4>',
    },

    constants: {
        pokeFeeSatoshis: {
            name: 'Poke fee',
            description: 'Fixed miner fee taken from the vault on every poke. Inlined into the covenant as <1500>; template constants are not exposed inside compiled scripts (see docs/FINDINGS.md).',
            type: 'satoshis',
            value: 1500n,
        },
        claimFeeSatoshis: {
            name: 'Claim fee',
            description: 'Fixed miner fee taken from the vault on a beneficiary claim. Inlined into the covenant as <1500>.',
            type: 'satoshis',
            value: 1500n,
        },
        reclaimFeeSatoshis: {
            name: 'Reclaim fee',
            description: 'Fixed miner fee taken from the vault when the owner reclaims. Inlined into the covenant as <1500>.',
            type: 'satoshis',
            value: 1500n,
        },
        dustLimit: {
            name: 'Dust limit',
            description: 'Minimum payout value the off-chain helpers accept.',
            type: 'satoshis',
            value: 546n,
        },
    },

    variables: {
        ownerKey: {
            name: 'Owner key',
            description: 'The key that authorizes poke, reclaim and updateBeneficiary. Its public key is committed into the covenant address.',
            type: 'private_key',
        },
        beneficiaryLockingScript: {
            name: 'Beneficiary',
            description: 'The locking script the covenant pays on a claim. Use the P2PKH script of the beneficiary\'s public key (the XO template language cannot concatenate a P2PKH script from a raw key inside a covenant; see docs/FINDINGS.md).',
            type: 'locking_script',
        },
        periodBlocks: {
            name: 'Liveness period (blocks)',
            description: 'How many blocks the vault must remain untouched before the beneficiary can claim. ~144 blocks is about one day, ~4320 about one month.',
            type: 'integer',
        },
        label: {
            name: 'Label',
            description: 'Free-form bytes committed into the covenant address (for example "for-alice-2031"). Changing the label changes the address.',
            type: 'bytes',
        },
        vaultSatoshis: {
            name: 'Vault balance',
            description: 'The current number of satoshis held by the covenant. Informational mirror; the authoritative balance is the UTXO value.',
            type: 'satoshis',
        },
        ownerPayoutLockingScript: {
            name: 'Reclaim destination',
            description: "The locking script chosen by the owner to receive a reclaim. Freely chosen at spend time: it is not part of the covenant's committed state.",
            type: 'locking_script',
        },
        nextVaultLockingScript: {
            name: 'Next vault script',
            description: 'The 34-byte P2SH32 locking script of the replacement vault (computed off-chain from the new beneficiary/period/label). The covenant pins output 0 to exactly this script.',
            type: 'locking_script',
        },
    },

    icons: [
        { name: 'vault', hash: '0000000000000000000000' },
        { name: 'owner', hash: '0000000000000000000000' },
        { name: 'beneficiary', hash: '0000000000000000000000' },
        { name: 'poke', hash: '0000000000000000000000' },
        { name: 'claim', hash: '0000000000000000000000' },
        { name: 'reclaim', hash: '0000000000000000000000' },
        { name: 'update', hash: '0000000000000000000000' },
    ],
};
