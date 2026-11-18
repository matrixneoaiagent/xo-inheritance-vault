# XO Inheritance Vault — a dead-man's switch with no oracle

An [XO](https://xo.cash/) template for Bitcoin Cash that turns a **periodic
signed transaction into a proof of life**. The owner funds a P2SH32 covenant
that commits to the owner's public key, the beneficiary's locking script, a
liveness period and a label. While the owner is alive they `poke` the vault
(spend it back to itself) every few blocks, which resets the coin's BIP68 age.
If they stop, the beneficiary `claim`s the whole balance once the coin is
`periodBlocks` old — enforced by the covenant, with **no owner signature, no
custodian, no oracle and no server**. The owner can always `reclaim`, and can
hand the vault to someone else with `updateBeneficiary`.

> **Chipnet only.** This repository contains no mainnet configuration, address
> or key. Every script is dry-run by default and refuses to broadcast unless
> `BROADCAST=1` is set. Not audited; do not put real money in it.

## Why this is useful

* **No custodian.** A lawyer, an exchange or a "dead man's switch service" holds
  your keys or your money today. Here the rule is public, the money is on-chain
  and the trigger is a relative locktime.
* **No oracle.** Liveness is not asserted by an API, a notary or a heartbeat
  service. The owner's poke *is* the assertion, and only the owner's key can
  make it.
* **The owner keeps full control while alive.** `reclaim` has no age gate and
  no beneficiary involvement; `updateBeneficiary` re-targets the vault without
  moving the money through a wallet.
* **The beneficiary needs nothing but a public key.** They do not sign the
  claim, so they cannot lose the inheritance by losing a key, and they do not
  have to be online or cooperative until the moment they claim.
* **Committing a label makes the address unique**, so two vaults with the same
  owner, beneficiary and period (for example "for Alice 2026" and "for Alice
  2027") are still different addresses.

## Repository

* Source of the template: [`source/inheritance-vault.ts`](source/inheritance-vault.ts)
* CashScript ⇄ XO mapping and the redeem script: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
* Reproduction commands and pinned inputs: [`docs/REPRODUCTION.md`](docs/REPRODUCTION.md)
* Engine findings from building it: [`docs/FINDINGS.md`](docs/FINDINGS.md)
* Feedback scaffold (prose to be written by hand): [`docs/FEEDBACK.md`](docs/FEEDBACK.md)

Template identifier (hash of the template content):

```
6dce91458e1cc66d92dd2f09d439d2d1280358c357c4bbb9ae32831be0750f53
```

`parseTemplate` + `generateTemplateIdentifier` and a live
`Engine.importTemplate` produce the same identifier (`test/import.test.ts`,
run with `XO_INTEGRATION=1`). The serialized template used by the debug tool is
[`fixtures/inheritance-vault.template.json`](fixtures/inheritance-vault.template.json).

## Actions

| Action | Who | On-chain rule | Signature |
|---|---|---|---|
| `createVault` | owner | Creates the P2SH32 covenant holding `vaultSatoshis`. Commits owner pubkey, beneficiary script, period and label. | owner (funding input only) |
| `poke` | owner | **Exactly one** output, whose locking bytecode equals the input's, and whose value is `input - 1500`. Proves liveness; the new coin restarts the BIP68 age. | owner |
| `claim` | beneficiary | Requires `nSequence >= periodBlocks` (CSV) **and** the coin to be that old. Exactly one input and one output; output 0 pays the committed beneficiary script exactly `input - 1500`. | **none** |
| `reclaim` | owner | At any age: exactly one output, value `input - 1500`, destination free. Cancels the inheritance. | owner |
| `updateBeneficiary` | owner | At any age: exactly one output, value `input - 1500`, the next vault script. Re-targets the vault. | owner |

`poke` is the only state-preserving action: it is not a payment, it is a
*timestamp*. The fee it burns (1500 satoshis, fixed in the covenant) is the
price of another period.

### Redeem script

```
# committed label (affects the address, dropped at run time)
<label> OP_DROP
OP_DUP OP_1 OP_NUMEQUAL          # function selector: 1 = claim, 2 = poke, 3 = reclaim, 4 = update
OP_IF
    OP_DROP
    # claim: the beneficiary, after the age gate, with no signature
    <periodBlocks> OP_CHECKSEQUENCEVERIFY OP_DROP
    OP_TXINPUTCOUNT OP_BIN2NUM OP_1 OP_NUMEQUALVERIFY
    OP_TXOUTPUTCOUNT OP_BIN2NUM OP_1 OP_NUMEQUALVERIFY
    OP_0 OP_OUTPUTBYTECODE <beneficiaryLockingScript> OP_EQUALVERIFY
    OP_0 OP_OUTPUTVALUE OP_BIN2NUM OP_INPUTINDEX OP_UTXOVALUE OP_BIN2NUM <1500> OP_SUB OP_NUMEQUAL
OP_ELSE
    OP_DUP OP_2 OP_NUMEQUAL
    OP_IF
        OP_DROP
        # poke: back into this exact script, minus the fixed fee
        OP_TXINPUTCOUNT OP_BIN2NUM OP_1 OP_NUMEQUALVERIFY
        OP_TXOUTPUTCOUNT OP_BIN2NUM OP_1 OP_NUMEQUALVERIFY
        OP_0 OP_OUTPUTBYTECODE OP_INPUTINDEX OP_UTXOBYTECODE OP_EQUALVERIFY
        OP_0 OP_OUTPUTVALUE OP_BIN2NUM OP_INPUTINDEX OP_UTXOVALUE OP_BIN2NUM <1500> OP_SUB OP_NUMEQUALVERIFY
        <ownerPubKey> OP_CHECKSIG
    OP_ELSE
        OP_DUP OP_3 OP_NUMEQUAL
        OP_IF
            OP_DROP
            # reclaim: any destination, owner signature
            OP_TXINPUTCOUNT OP_BIN2NUM OP_1 OP_NUMEQUALVERIFY
            OP_TXOUTPUTCOUNT OP_BIN2NUM OP_1 OP_NUMEQUALVERIFY
            OP_0 OP_OUTPUTVALUE OP_BIN2NUM OP_INPUTINDEX OP_UTXOVALUE OP_BIN2NUM <1500> OP_SUB OP_NUMEQUALVERIFY
            <ownerPubKey> OP_CHECKSIG
        OP_ELSE
            OP_4 OP_NUMEQUALVERIFY
            # updateBeneficiary: same shape, into the next vault covenant
            OP_TXINPUTCOUNT OP_BIN2NUM OP_1 OP_NUMEQUALVERIFY
            OP_TXOUTPUTCOUNT OP_BIN2NUM OP_1 OP_NUMEQUALVERIFY
            OP_0 OP_OUTPUTVALUE OP_BIN2NUM OP_INPUTINDEX OP_UTXOVALUE OP_BIN2NUM <1500> OP_SUB OP_NUMEQUALVERIFY
            <ownerPubKey> OP_CHECKSIG
        OP_ENDIF
    OP_ENDIF
OP_ENDIF

# unlocking scripts
claim:   OP_1 <redeem>                              (no signature at all)
poke:    <sig> OP_2 <redeem>
reclaim: <sig> OP_3 <redeem>
update:  <sig> OP_4 <redeem>
```

The selector values are 1-based because the first branch (`claim`) has no
signature: `<1>` is a single `OP_1`, which keeps the unlocking script non-empty
and unambiguous.

## CashScript analogy

XO's template language is declarative, CashScript is imperative, but this
contract has a direct CashScript sibling. Here is the same design written in
CashScript:

```solidity
contract InheritanceVault(bytes20 owner, bytes25 beneficiary, int period) {
    // The owner's liveness proof: back into the same covenant.
    function poke(pubkey pk, sig s) {
        require(hash160(pk) == owner);
        require(checkSig(s, pk));
        require(tx.inputs.length == 1);
        require(tx.outputs.length == 1);
        require(tx.outputs[0].lockingBytecode == tx.inputs[this.activeInputIndex].lockingBytecode);
        require(tx.outputs[0].value == tx.inputs[this.activeInputIndex].value - 1500);
    }

    // The inheritance: no signature, just age and a fixed destination.
    function claim() {
        require(this.age >= period);
        require(tx.inputs.length == 1);
        require(tx.outputs.length == 1);
        require(tx.outputs[0].lockingBytecode == new LockingBytecodeP2PKH(beneficiary));
        require(tx.outputs[0].value == tx.inputs[this.activeInputIndex].value - 1500);
    }

    // The owner cancels at any time, to any address.
    function reclaim(pubkey pk, sig s) {
        require(hash160(pk) == owner);
        require(checkSig(s, pk));
        require(tx.inputs.length == 1);
        require(tx.outputs.length == 1);
        require(tx.outputs[0].value == tx.inputs[this.activeInputIndex].value - 1500);
    }
}
```

| CashScript | XO Inheritance Vault |
|---|---|
| `contract InheritanceVault(owner, beneficiary, period)` | template variables + `vaultScript.state` + a committed `label` |
| three `function`s in one contract | one `lockingScripts.vaultScript` with a numeric selector (`OP_DUP OP_0 OP_NUMEQUAL …`) and four `unlock*` scripts |
| `this.age >= period` | `<periodBlocks> OP_CHECKSEQUENCEVERIFY OP_DROP` plus `nSequence = periodBlocks` on the invitation input |
| `tx.outputs[0].lockingBytecode == tx.inputs[i].lockingBytecode` | `OP_0 OP_OUTPUTBYTECODE OP_INPUTINDEX OP_UTXOBYTECODE OP_EQUALVERIFY` |
| `new LockingBytecodeP2PKH(beneficiary)` | the beneficiary script is a *template variable*, committed as bytes |
| `int minerFee = 1500;` | the literal `<1500>` inlined in each branch (XO constants are not visible inside compiled scripts, see FINDINGS 4) |
| a `.cash` file compiled by `cashc` | a `XOTemplate` object compiled by `@xo-cash/utils`, executed by `@xo-cash/engine` |

The important difference: **in CashScript the constructor parameters are typed
and the compiler knows them**; in XO every value a script references becomes
part of the template's *state*, must be supplied on every follow-up action by
the role that holds it, and cannot be changed afterwards. That is what makes
the "poke returns to the identical bytecode" rule possible, and it is also what
forces `reclaim`'s destination to be unconstrained (see `docs/FINDINGS.md` 6).

## Chipnet run

All transactions below are real, broadcast Chipnet transactions. Explorer:
`https://chipnet.imaginary.cash/tx/<txid>`. Screenshots of every transaction
and of every invitation in the debug tool live in `docs/explorer/` and
`docs/debug-tool/`.

| Step | Txid | What it proves |
|---|---|---|
| create vault A (60,000 sats, period 3, label `for-alice-2026`) | `ffa941216cd2cd884a51fb6b264f9e657e1ea9f9aa26c219b921efc0eb3d4c7e` | the covenant is funded at `bchtest:pw00468kadlmwrfa7khlxy04nlcf3hlc50uty57wp3anejf38kp7cfc0m36w0` |
| poke A (owner, 1 block after funding) | `be25cd7c161333f22b6aed6c2bc412b44497ba05b5daef6c9daaa799de3caa23` | the balance returns to the identical script (58,500 sats); the age restarts |
| early claim A/B (beneficiary) | _rejected, no txid_ | a claim before the period is refused by the network (`non-BIP68-final`) |
| claim A (beneficiary, no signature) | `bf9fa85020c9396405c75e781b481ab05eb8e2fe015a2ce604254a0d99899dc3` | the beneficiary receives 57,000 sats without any owner key |
| create vault B (40,000 sats, period 100,000) | `98b5a2a8b1a9814786a8fad1d657d8a36899d4b0af2fc94ea7c27c3ca2696d5b` | a vault whose claim is effectively unreachable |
| updateBeneficiary B → B′ | `225f71fcce5d9561858701bfe83dbe570cbee1db9d575f8ffdc5a3e627e5a79b` | the owner re-targets the vault to a new beneficiary; balance carries over |
| create vault C (30,000 sats, period 100,000) | `9e8fec4924ae09e7650ea705233a02a7ae3b4e7b4e394d094095a7cb4591f0d6` | a vault created only to be cancelled |
| reclaim C (owner, 0-conf) | `9e144216c8a2f21f7511f5a7eb4d44b7cf8c37c845cd0d15ab39d5004da6ea7b` | the owner cancels at any age and ignores the 100,000-block period |

Chipnet rejected the first claim broadcast as `non-BIP68-final` from tip 337146
to 337173 although the coin was 30 blocks old; the identical bytes were accepted
at tip 337174. The
sequence sweep that diagnoses it (0,1,2 pass the lock check, 3 does not) is in
[`docs/FINDINGS.md`](docs/FINDINGS.md) item 5. Two further honest notes:
`updateBeneficiary`'s new vault is not tracked by the engine (FINDINGS 9), and
the beneficiary's own wallet cannot *assemble* a claim (FINDINGS 2) — both are
engine limitations, reproduced here, not hidden.

The full sequence, including the rejected early claim and the retry loop that
Chipnet's BIP68 handling made necessary, is in
[`docs/REPRODUCTION.md`](docs/REPRODUCTION.md).

## Quick start

Requirements: Node.js 22+, a funded Chipnet wallet file, and a Chipnet Electrum
connection (the engine picks servers automatically).

```bash
npm install
npm run typecheck
npm test                       # 29 unit tests: VM vectors + template rules
npm run fixtures:template      # prints the template identifier, rewrites the fixture
```

`npm test` runs the unit suite; `npm run test:integration` additionally imports
the template into a live engine (needs Chipnet).

| Command | Purpose |
|---|---|
| `npm run create` | Fund a new vault (`VAULT_SATS`, `PERIOD_BLOCKS`, `LABEL`, `BENEFICIARY_SCRIPT`, `VAULT_NAME`). |
| `npm run poke` | Owner proves liveness (`VAULT_NAME`). |
| `npm run claim` | Beneficiary claims after the period (`VAULT_NAME`). |
| `npm run reclaim` | Owner cancels at any age (`VAULT_NAME`, `OWNER_PAYOUT_SCRIPT`). |
| `npm run update-beneficiary` | Owner moves the vault to a new beneficiary (`NEW_BENEFICIARY_SCRIPT`, `NEW_PERIOD_BLOCKS`, `NEW_LABEL`). |
| `npm run reject-early-claim` | Negative test: script-level and network-level rejection of an early claim. |
| `npm run broadcast-raw` | Resubmit an already-built transaction directly to the Electrum servers (`RAW_TX_FILE`, `EXPECTED_TXID`). |
| `npm run verify-findings` | Reproduces the engine findings in one run (FINDINGS 6, 7, 8, 12, 14). |

Environment: `XO_WALLET` (wallet file with a `mnemonic` field), `XO_DB_PATH`
(engine database), `BROADCAST=1` to actually send, `RETRY_DELAY_SECONDS` /
`MAX_RETRIES` for the CSV retry loop.

## Debug tool

1. Open <https://blaze.xo.cash>, switch to **Chipnet**.
2. **Import Template** → paste `fixtures/inheritance-vault.template.json` →
   **Import JSON**.
3. **Join Invitation** → paste any `artifacts/*-invitation.json` →
   **View invitation**.

The invitations for every action (create, poke, claim, reclaim,
updateBeneficiary, and both early-claim rejections) are in
`artifacts/final-run/` and previewed in `docs/debug-tool/`. Invitations contain
only public commit data and signatures — never a mnemonic or private key.

## Security notes and known limits

* **Testnet only.** No mainnet address, key or transaction exists in this repo.
* **Not audited.** The covenant is covered by deterministic libauth VM tests
  (`test/vm.test.ts`) and a byte-for-byte engine/template comparison in
  `scripts/create.ts`, but that is not an external review.
* **The owner key is a single point of failure.** Losing it means the vault can
  never be poked or reclaimed; leaking it means the holder can drain the vault
  at any time (the covenant cannot tell "the owner" from "a thief with the
  owner's key").
* **The fee is covenant-fixed at 1500 satoshis per spend.** No fee bumping, no
  CPFP inside the covenant; congestion makes the switch slower to renew.
* **The vault holds one UTXO.** All four spend paths require exactly one input
  and one output, so a second payment to the same address creates a second
  vault UTXO that must be handled separately.
* **The label is public.** It is committed as raw bytes in the redeem script,
  visible on-chain and to the beneficiary.
* **The beneficiary's script is fixed at funding.** Changing the beneficiary
  means `updateBeneficiary` (a new address), not an in-place edit.
* **`updateBeneficiary`'s output is not tracked by this engine version.** The
  transaction is valid and confirmed, but the new vault's script hash never
  enters the engine's store, so that vault cannot be spent *through the engine*
  (`docs/FINDINGS.md` 9). The update is therefore demonstrated, and the
  reclaim demonstration uses a separate vault.
* **The beneficiary's own wallet cannot *assemble* a claim.** A wallet that does
  not track the covenant has no input to unlock and no source output to verify
  (`docs/FINDINGS.md` 1–2). The claim can be assembled by any wallet that
  tracks the vault and then executed by the beneficiary's wallet as a shared
  invitation (`scripts/broadcast-invitation.ts`).

## Repository layout

```
source/
  inheritance-vault.ts   the XO template (CashASM covenant)
  types.ts               state types, fee helpers, BIP68 arithmetic
test/
  helpers/covenant.ts    libauth VM harness (compiles the real CashASM)
  vm.test.ts             16 VM vectors, including every rejection path
  template.test.ts       parse/serialize, selector shape, requirements, helpers
  import.test.ts         optional live Engine.importTemplate agreement
scripts/
  create.ts poke.ts claim.ts reclaim.ts update-beneficiary.ts
  reject-early-claim.ts  the two early-claim rejections
  verify-tx.ts           libauth VM pre-flight for every broadcast
  beneficiary-address.ts derives the beneficiary's P2PKH from a second wallet
  broadcast-invitation.ts  join + execute an invitation from another wallet
  broadcast-raw.ts        resubmit built bytes when a node is behind
  verify-findings.ts      one-shot reproduction of the engine findings
  list-utxos.ts           print the account's tracked UTXOs
  scan-wallet.ts scan-balances.ts recover-change.ts  key-derivation recovery
  serialize-template.ts
  lib/                   config, engine, vault record, covenant compilation
fixtures/
  inheritance-vault.template.json
docs/
  ARCHITECTURE.md REPRODUCTION.md FINDINGS.md FEEDBACK.md
  explorer/ debug-tool/  screenshots of the final Chipnet run
```

## License

MIT. See [LICENSE](LICENSE).
