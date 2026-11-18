# Reproduction guide

Every command below was run for real against Chipnet from this repository. No
step is simulated, and every txid quoted here is a confirmed (or, where marked,
mempool) Chipnet transaction.

## 0. Setup

```bash
git clone https://github.com/matrixneoaiagent/xo-inheritance-vault.git
cd xo-inheritance-vault
npm install
export XO_WALLET=/path/to/chipnet-wallet.json    # { "mnemonic": "..." }, chipnet only
export XO_DB_PATH=$PWD/.xo-data                  # scratch engine database
```

Fund the wallet from a Chipnet faucet if needed (<https://tbch.googol.cash/> or
<https://chipnet.bch.ninja/>). The scripts never print or store the mnemonic.

Sanity checks:

```bash
npm run typecheck
npm test                                  # 29 unit tests (VM + template rules)
npm run fixtures:template                 # prints the template identifier
XO_INTEGRATION=1 npm run test:integration # live engine import, same identifier
```

Expected template identifier:

```
bc4d0a967885754fb5e9add7e9cc204710d251b4263a1077edda7b20f1c6c79a
```

## 1. Derive the beneficiary's public script (separate wallet)

The beneficiary is a *different* wallet. Only its public P2PKH script is used,
so the owner never needs the beneficiary's key:

```bash
XO_WALLET=/path/to/beneficiary-wallet.json XO_DB_PATH=.xo-data-beneficiary \
  node --import tsx scripts/beneficiary-address.ts
# BENEFICIARY_SCRIPT 76a914e8e6bd0f07e2b138825b72dfa72a378cd5868a7988ac
# BENEFICIARY_ADDRESS bchtest:qr5wd0g0ql3tzwyztdedlfe2x7xdtp520yvtvvwmxe
```

## 2. Create vault A (60,000 sats, 3-block period)

```bash
BROADCAST=1 \
  BENEFICIARY_SCRIPT=76a914e8e6bd0f07e2b138825b72dfa72a378cd5868a7988ac \
  VAULT_SATS=60000 PERIOD_BLOCKS=3 LABEL=for-alice-2026 VAULT_NAME=A \
  node --import tsx scripts/create.ts
```

Output (pinned):

```
template     bc4d0a967885754fb5e9add7e9cc204710d251b4263a1077edda7b20f1c6c79a
vault        bchtest:pw00468kadlmwrfa7khlxy04nlcf3hlc50uty57wp3anejf38kp7cfc0m36w0
covenant     aa209efae8f6eb7fb70d3df5aff311f59ff098dff8a3f8b253ce0c7b3cc9313d83ec87
covenant verified: engine bytecode == template compilation, redeem size 257
BROADCAST_TXID ffa941216cd2cd884a51fb6b264f9e657e1ea9f9aa26c219b921efc0eb3d4c7e
```

`create.ts` recompiles the covenant from the template's own CashASM and refuses
to continue if that differs from the bytecode the engine resolved, so the
address is audited before any money moves. The record is written to
`artifacts/vault-A.json`.

## 3. Poke A (the owner's proof of liveness)

Wait for the create to confirm, then:

```bash
BROADCAST=1 VAULT_NAME=A node --import tsx scripts/poke.ts
# chain tip 337143  covenant height 337143  period 3
# covenant age 0 blocks (claim needs 3)
# BROADCAST_TXID be25cd7c161333f22b6aed6c2bc412b44497ba05b5daef6c9daaa799de3caa23
# NEW_BALANCE 58500 NEW_OUTPOINT be25cd7c…:0
```

The covenant requires the poke's single output to have the *identical* locking
bytecode and exactly `input - 1500` satoshis, so a poke is a no-op that costs
one fee and restarts the BIP68 age.

## 4. Negative test: an early claim is rejected (twice)

```bash
BROADCAST=1 VAULT_NAME=B node --import tsx scripts/reject-early-claim.ts
```

Two rejections, both real:

* **Script level** (`nSequence = periodBlocks - 1`):
  `Program called an OP_CHECKSEQUENCEVERIFY operation that requires a sequence
  number greater than the input's sequence number. Sequence number: 99999;
  required sequence number: 100000.`
* **Network level** (correct `nSequence`, coin not old enough): the local VM
  accepts the transaction, then Chipnet answers
  `the transaction was rejected by network rules. non-BIP68-final (code 64)`.

Vault B has `periodBlocks = 100000`, so the negative test cannot accidentally
succeed. The script also refuses to broadcast if the off-chain age check says
the vault is already claimable.

Artifacts: `artifacts/final-run/claim-too-early-script-B-invitation.json`,
`claim-too-early-network-B-invitation.json`, `claim-too-early-B-reason.txt`.

## 5. Claim A (the beneficiary, with no signature)

Once the poke's output is `periodBlocks` old:

```bash
BROADCAST=1 VAULT_NAME=A MAX_RETRIES=40 RETRY_DELAY_SECONDS=60 \
  node --import tsx scripts/claim.ts
```

Expect `unlocking script of input 0: 261 bytes, selector only, no signature`,
then `BROADCAST_TXID bf9fa85020c9396405c75e781b481ab05eb8e2fe015a2ce604254a0d99899dc3`
(57,000 satoshis to `bchtest:qr5wd0g0ql3tzwyztdedlfe2x7xdtp520yvtvvwmxe`).

The retry loop is not cosmetic: on the day of the run Chipnet rejected this
exact transaction as `non-BIP68-final` from tip `337146` to `337173` — about
26 minutes after the coin was old enough — and accepted the identical bytes at
tip `337174` (see `docs/FINDINGS.md` 5, which also shows how to tell a node
bookkeeping problem apart from a covenant bug by sweeping `nSequence`).

If the retry loop exhausts itself, the transaction can be placed directly once
the node catches up — it is the same bytes, so the txid does not change:

```bash
# the claim's raw transaction, from engine.buildInvitationTransactionFromMergedCommit
RAW_TX_FILE=/tmp/claim.hex EXPECTED_TXID=bf9fa850… node --import tsx scripts/broadcast-raw.ts
# chipnet.imaginary.cash tip 337174 ACCEPTED bf9fa850…
# chipnet.bch.ninja      tip 337174 ACCEPTED bf9fa850…
```

### Claiming from the beneficiary's own wallet (what works and what does not)

```bash
# 1. the owner's wallet assembles the claim and writes the invitation
VAULT_NAME=A node --import tsx scripts/claim.ts          # dry run, writes the JSON

# 2. the beneficiary's wallet joins and broadcasts it
INVITATION_FILE=artifacts/claim-A-invitation.json \
  XO_WALLET=/path/to/beneficiary-wallet.json XO_DB_PATH=.xo-data-beneficiary \
  ROLE=beneficiary BROADCAST=1 node --import tsx scripts/broadcast-invitation.ts
```

Step 2 works because the invitation already carries the unlocking bytecode.
Step 1 *cannot* be run by the beneficiary alone: a wallet that does not track the
covenant output has no own input index, so the engine never compiles the
unlocking script (`docs/FINDINGS.md` 1 and 2).

## 6. Update the beneficiary, then reclaim (owner escape hatches)

```bash
# B: 40,000 sats, period 100000 (a claim nobody will live to see)
BROADCAST=1 BENEFICIARY_SCRIPT=76a914e8e6bd0f07e2b138825b72dfa72a378cd5868a7988ac \
  VAULT_SATS=40000 PERIOD_BLOCKS=100000 LABEL=for-alice-2026-b VAULT_NAME=B \
  node --import tsx scripts/create.ts
# BROADCAST_TXID 98b5a2a8b1a9814786a8fad1d657d8a36899d4b0af2fc94ea7c27c3ca2696d5b

# B -> B' for a different beneficiary, period 4
BROADCAST=1 VAULT_NAME=B \
  NEW_BENEFICIARY_SCRIPT=76a914819295b3a8f18ad46789de0c8b05a40c6e1796e688ac \
  NEW_PERIOD_BLOCKS=4 NEW_LABEL=for-bob-2026 \
  node --import tsx scripts/update-beneficiary.ts
# BROADCAST_TXID 225f71fcce5d9561858701bfe83dbe570cbee1db9d575f8ffdc5a3e627e5a79b
# NEXT_VAULT bchtest:pd50c70fv7x26jz6uy3vxqyzhtefgjd38qywdvdzryrtd4rj9ct2zepq02yxs
```

`updateBeneficiary` is documented in `docs/FINDINGS.md` 9: the transaction is
valid, but the engine does not track an output locked to an opaque script
variable, so B′ cannot be spent *through the engine*. The reclaim demonstration
therefore uses a third vault:

```bash
BROADCAST=1 BENEFICIARY_SCRIPT=76a914e8e6bd0f07e2b138825b72dfa72a378cd5868a7988ac \
  VAULT_SATS=30000 PERIOD_BLOCKS=100000 LABEL=cancel-demo VAULT_NAME=C \
  node --import tsx scripts/create.ts
# BROADCAST_TXID 9e8fec4924ae09e7650ea705233a02a7ae3b4e7b4e394d094095a7cb4591f0d6

BROADCAST=1 VAULT_NAME=C node --import tsx scripts/reclaim.ts
# BROADCAST_TXID 9e144216c8a2f21f7511f5a7eb4d44b7cf8c37c845cd0d15ab39d5004da6ea7b
# RECLAIMED 28500
```

The reclaim was broadcast while its funding transaction was still unconfirmed
and ignored the 100,000-block period entirely: that is the "cancel the
inheritance" property.

## 7. Reproduce the engine findings

```bash
VAULT_NAME=<an open vault> node --import tsx scripts/verify-findings.ts
```

Prints, in one run: the constants-not-in-scripts error, the hex-vs-UTF-8 label
address mismatch, whether the covenant UTXO appears in
`listSpendableUnspentOutputs()` despite `selectable: false`, the
`nSequence` a template input declaration actually produces, and the fact that an
explicit output value silently overrides the template's own expression.

## 8. Debug tool

1. <https://blaze.xo.cash> → Chipnet account.
2. **Import Template** → paste `fixtures/inheritance-vault.template.json` →
   **Import JSON**. The toast should read
   `Template imported: XO Inheritance Vault (bc4d0a96…)`.
3. **Join Invitation** → paste any file from `artifacts/final-run/*-invitation.json`
   → **View invitation**.

Screenshots of all seven invitation types are in `docs/debug-tool/`.

## 9. Screenshots

`docs/explorer/` holds one full-page screenshot per transaction from
`https://chipnet.imaginary.cash/tx/<txid>`, and `docs/debug-tool/` holds the
template import plus one screenshot per invitation. They were captured with a
headless Chromium session against the live pages; nothing is staged.

## Final-run txids

| Step | Txid | Height |
|---|---|---|
| create A | `ffa941216cd2cd884a51fb6b264f9e657e1ea9f9aa26c219b921efc0eb3d4c7e` | 337,143 |
| poke A | `be25cd7c161333f22b6aed6c2bc412b44497ba05b5daef6c9daaa799de3caa23` | 337,144 |
| claim A | `bf9fa85020c9396405c75e781b481ab05eb8e2fe015a2ce604254a0d99899dc3` | see the explorer link |
| create B | `98b5a2a8b1a9814786a8fad1d657d8a36899d4b0af2fc94ea7c27c3ca2696d5b` | 337,144 |
| updateBeneficiary B→B′ | `225f71fcce5d9561858701bfe83dbe570cbee1db9d575f8ffdc5a3e627e5a79b` | 337,157 |
| create C | `9e8fec4924ae09e7650ea705233a02a7ae3b4e7b4e394d094095a7cb4591f0d6` | 337,164 |
| reclaim C | `9e144216c8a2f21f7511f5a7eb4d44b7cf8c37c845cd0d15ab39d5004da6ea7b` | 337,165 |

Early claim (rejected, not a transaction): `0ed670420af74de46fb294cc847ca08ce407f3063cd1eb94f86b9ec4d83f39bb`
was built, verified locally and refused by the network as `non-BIP68-final`.
