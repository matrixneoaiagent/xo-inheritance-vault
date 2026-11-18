# Architecture

XO Inheritance Vault is a dead-man's switch: a covenant that pays a
beneficiary only if the owner stops proving liveness. This document explains
the on-chain state model, the four branches, the fee model, and the parts of
the XO engine that shaped the design.

## 1. The contract in one paragraph

The owner funds a P2SH32 covenant committing to four public facts: the owner's
public key, the beneficiary's locking script, a period in blocks, and a label.
Time is measured by BIP68 relative locktime on the covenant coin itself, so
"the owner is gone" means exactly "this coin has not moved for `periodBlocks`
blocks". The owner moves it back to itself (`poke`) to reset the clock. The
beneficiary's `claim` is gated only by that clock and a fixed destination. The
owner's `reclaim` and `updateBeneficiary` are gated only by a signature. No
participant ever has to trust a server, an oracle, or each other.

## 2. State model

| Value | Where it lives | Mutable? |
|---|---|---|
| owner public key (33 bytes) | pushed inside the redeem script | No |
| beneficiary locking script (25 bytes for P2PKH) | pushed inside the redeem script | No |
| `periodBlocks` | pushed as a VM number, the CHECKSEQUENCEVERIFY operand | No |
| `label` | pushed and dropped inside the redeem script | No |
| balance | the UTXO value | Yes (`poke` subtracts the fee) |
| coin age | the BIP68 relative locktime of the UTXO | Reset by every poke |
| `vaultSatoshis` | template variable, mirrored for descriptions and output construction | Informational only |

Because the owner key, the beneficiary script, the period and the label are all
inside the redeem script, they are all part of the address:

```
P2SH32 = OP_HASH256 <hash256(redeemScript)> OP_EQUAL
```

`scripts/create.ts` recompiles the template's CashASM from the same four values
and refuses to continue unless the result equals the bytecode the engine
resolved for the funding output. That check is what makes "the covenant
commits to X" a verifiable statement rather than a claim about the code.

## 3. Branches and the age gate

The redeem script starts with a numeric selector, the same shape `cashc` emits
for a multi-function contract:

| Selector | Branch | Signature | Age gate | Outputs |
|---|---|---|---|---|
| `0` | `claim` | none | `nSequence >= periodBlocks` | exactly 1, to the committed beneficiary, `value = input - 1500` |
| `1` | `poke` | owner | none | exactly 1, **identical locking bytecode**, `value = input - 1500` |
| `2` | `reclaim` | owner | none | exactly 1, any destination, `value = input - 1500` |
| `3` | `updateBeneficiary` | owner | none | exactly 1, the next vault script, `value = input - 1500` |

**Why `poke` needs no age gate.** A poke is the owner's *renewal*, so requiring
the coin to be old would defeat the purpose: the owner must be able to poke at
any moment, including immediately after the previous poke.

**Why the claim's age gate is two rules, not one.** `OP_CHECKSEQUENCEVERIFY`
compares the spending input's `nSequence` against the script's operand, so the
script can only prove "the spender *claims* an age of at least N". The chain
proves the rest: a node will not include a transaction whose relative locktime
is not satisfied by the coin's real age, and it rejects it as
`non-BIP68-final`. Both halves are demonstrated on Chipnet in the negative test
(`npm run reject-early-claim`), and this split is also why the local VM cannot
catch an early claim on its own (FINDINGS 2).

**Why the claim requires exactly one input and one output.** "Exactly one
output" stops a claim from paying a finder's fee or splitting the inheritance.
"Exactly one input" stops a claim from being combined with other coins, which
would make the covenant's value arithmetic ambiguous.

## 4. Fees, and why the destination of a reclaim is free

Every branch pays a fixed `1500` satoshis of miner fee out of the vault and
requires the output value to be exactly `input - 1500`. A fixed fee is a
deliberate trade-off:

* it makes the vault's balance predictable after N pokes (`balance - 1500N`);
* it prevents a spender from turning a claim into a fee-drain, and a poke into
  a stealth withdrawal;
* it removes any fee input from the transaction, so a poke/claim needs no other
  UTXO and cannot be blocked by a missing wallet balance.

The cost is that the covenant cannot be fee-bumped, and on a congested chain a
poke may need to wait for the mempool to clear.

`reclaim` and `updateBeneficiary` also take a fixed fee but leave the
destination *unconstrained*. That is not laziness: any value the covenant
constrains must be compiled into the address at funding time. A "send the
reclaim wherever the owner wants" rule therefore cannot live inside the
covenant, exactly as in CashScript's `reclaim()`. Since both branches require
the owner's signature, an unconstrained destination grants no one else any
power. The template still declares the intended destination
(`ownerPayoutLockingScript`, `nextVaultLockingScript`) so the transaction the
engine builds is the one the owner asked for.

## 5. Actions and variables

| Action | Inputs | Outputs | Required variables | Secrets |
|---|---|---|---|---|
| `createVault` | funding (wallet) | `initialVaultOutput` + change | `vaultSatoshis`, `periodBlocks`, `beneficiaryLockingScript`, `label` | generates `ownerKey` |
| `poke` | `pokeInput` (`nSequence` final) | `renewedVaultOutput` | the four state values | `ownerKey` |
| `claim` | `claimInput` (`nSequence = periodBlocks`) | `beneficiaryPayoutOutput` | the four state values | none |
| `reclaim` | `reclaimInput` (`nSequence` final) | `ownerPayoutOutput` | the four state values + `ownerPayoutLockingScript` | `ownerKey` |
| `updateBeneficiary` | `updateInput` (`nSequence` final) | `nextVaultOutput` | the four state values + `nextVaultLockingScript` | `ownerKey` |

The four state values are *required* on every follow-up: XO invitations carry
the template's variables, not the funder's memory. `create.ts` writes them to
`artifacts/vault-<name>.json` so nobody has to copy them by hand.

## 6. What the engine provides, and what it does not

* `Engine.importTemplate` compiles and stores the template, and derives the
  template identifier as a content hash.
* `Engine.createInvitation` + `appendInvitation` build the commits; the role
  that takes an action supplies its variables and its own inputs.
* `Engine.signInvitation` signs a P2SH32 input and derives the unlocking script
  from the template (`<sig> <selector>`); it works because the *template*
  declares `unlockPoke` etc.
* `Engine.executeAction({ broadcastTransaction: true })` broadcasts and clears
  the reservations.
* There is **no** VM pre-flight for single-party invitations, so every script
  in this repository calls `scripts/verify-tx.ts` first; that is the only place
  a covenant bug is caught before the network sees it.
* There is **no** API for "compile this template's script with a different set
  of variable values", which is why `updateBeneficiary` needs
  `compileVaultScript()` in `scripts/lib/vault.ts` (FINDINGS 7).
* Relative locktime must be set on the invitation input, not in the template
  (`XOTemplateInput.sequenceNumber` is accepted by the schema and ignored by the
  engine, FINDINGS 1).

## 7. Test strategy

* `test/vm.test.ts` compiles the real CashASM with libauth, signs with real
  Schnorr keys and evaluates 16 vectors: the happy paths for all four branches
  plus every rejection that matters (age too low, wrong destination, a
  1-satoshi skim, a second output, a forked poke, a drained poke, a foreign
  signature, an unknown selector).
* `test/template.test.ts` pins the template's shape: the four-way selector, the
  fact that only `claim` carries the age gate, that `claim` requires no secret,
  that the inlined fee matches the declared constant, and the BIP68 arithmetic
  helper.
* `test/import.test.ts` (opt-in) proves a live engine derives the same template
  identifier.
* `scripts/create.ts` proves the engine and the template compilation agree on
  the covenant bytecode before any money moves.

The VM vectors are the strongest guarantee: they execute the deployed bytecode,
not a reimplementation of its rules.
