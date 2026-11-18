# Findings

Concrete observations from building and running **XO Inheritance Vault** end to
end on Chipnet (engine `@xo-cash/engine@0.1.1-next.18029697917`, libauth
`3.1.0-next.8`, Node 22/24, November 2026). Every item is something that
actually happened in this repository's runs; each one says how to reproduce it.
Items are ordered roughly by how much they cost me.

Where a finding is about XO itself rather than this template, the file, message
or API involved is named so it can be checked against the source.

---

## 1. A covenant spend that needs no signature still has to call `signInvitation()`

**What happened.** `claim` is authorised entirely by the covenant: its
unlocking script is `<1> <redeem>`, with no signature. Building the invitation
and appending the output is not enough. Without a `signInvitation()` call the
built transaction has a **zero-byte** unlocking script, and the spend fails with
`Tried to read from an empty stack.` The method name says "sign"; what it
actually does for such an input is compile the template's `unlockingBytecode`
and append it as a commit.

**Reproduction.**

```bash
# beneficiary engine, fresh database, vault the account does not track
XO_WALLET=...beneficiary_wallet.json XO_DB_PATH=.xo-data-beneficiary VAULT_NAME=A \
  BROADCAST=1 node --import tsx scripts/claim.ts
# -> own inputs to sign []
# -> unlocking script of input 0: 0 bytes
# -> Error: source UTXO not found ...
```

`Own inputs [0]` appears only when the account holds the spent script, and then
one `signInvitation` call produces `<1> <redeem>` (261 bytes, no signature).

**Suggestion.** Either compile the unlocking script when the invitation is
complete (`listMissingRequirements` already reports an empty list), or expose
`appendUnlockingBytecode()` so a signature-free action does not have to pretend
to sign. The current behaviour silently builds an unspendable transaction.

---

## 2. A third party cannot build a spend of a covenant it does not track

**What happened.** The whole point of the vault is that the beneficiary's claim
needs no key. But a wallet that has never seen the covenant output cannot build
the claim:

* `createInvitation({ inputs: [...] })` accepts the outpoint, but
  `listOwnInputIndexes()` returns `[]`, so no unlocking script is ever
  compiled (see finding 1); and
* `verify-tx.ts` cannot resolve the source output either:
  `Error: source UTXO not found: be25cd7c…:0`. `listUnspentOutputs()` only
  returns outputs the engine has stored script-hash data for.

So the *funds* are not custodied, but the *spend path* is: the beneficiary
needs either the owner's database or an invitation someone else completed.

**What does work.** Handing the completed invitation over works: the owner's
wallet assembles and signs it, serialises it, and the beneficiary's wallet runs
`acceptInvitation(invitation, { roleIdentifier: 'beneficiary' })` followed by
`executeAction(..., { broadcastTransaction: true })`. The commit list already
contains the unlocking bytecode, so nothing local is needed. This repository's
`scripts/broadcast-invitation.ts` does exactly that; the run got as far as
submitting to the network (and was then refused by the node for finding 5, not
by the engine).

**Suggestion.** A public "watch/track this locking script" API, or letting an
invitation input carry its own `lockingBytecode`/`valueSatoshis`, would make
true third-party claims possible. Today `selectable`/tracking is a write-only
side effect of the account creating the script.

---

## 3. Every value a covenant references is frozen into the address at funding time

**What happened.** My first draft made `reclaim` pay a destination chosen at
spend time, and `updateBeneficiary` pin the next vault script, by referencing
those variables inside the redeem script. Compilation failed:

```
CashAssemblyRequiredVariableMissingError: Missing required variable:
variableNames [ownerPayoutLockingScript, nextVaultLockingScript]
```

That is correct behaviour — a P2SH32 address commits to the whole script, so a
value the script mentions must be present when the script is compiled — but it
is the single most important design constraint in this template:

* `reclaim` and `updateBeneficiary` therefore leave the **destination
  unconstrained** and only fix the value and the input/output counts, exactly
  like CashScript's `reclaim()`.
* `updateBeneficiary`'s "next vault" property is enforced by the *template's
  output declaration* plus the caller computing the P2SH32, not by the
  covenant. Since the branch requires the owner's signature anyway, this grants
  nobody new power — but it should be stated, not implied.

**Suggestion.** A way to express "output 0 must be a P2SH32 of a redeem script
built from these variables" (a covenant-in-covenant / recursive template
reference) would make vault chains first-class instead of an application-level
convention.

---

## 4. There is no API to compile a template script with different values

**What happened.** `updateBeneficiary` has to know the *next* vault's P2SH32
before it can build the transaction. The engine can compile a locking script
only from the invitation's own variables
(`resolveInvitationOutputLockingBytecode` returns the current script, not a
hypothetical one). I ended up re-implementing the compiler call in
`scripts/lib/vault.ts`:

```ts
compileCashAssemblyString({ cashAssemblyText: parsed.scripts.vaultRedeemBytecode, … })
// then P2SH32 = OP_HASH256 <hash256(redeem)> OP_EQUAL
```

That duplication is ~30 lines and has to be kept in sync with the template by
hand. It also had a useful side effect: `scripts/create.ts` recompiles the
covenant and refuses to fund unless it matches the bytecode the engine
resolved, which is a real audit check.

**Suggestion.** `engine.compileLockingScript({ templateIdentifier, lockingScriptIdentifier, variables })`.

---

## 5. Chipnet's BIP68 rule disagrees with Chipnet's own chain state (and its error message hides why)

**What happened.** The claim spends a covenant coin confirmed at height
`337144` with `nSequence = 3`. Every Electrum server reported that height and
21+ confirmations. Broadcasting the claim was rejected, repeatedly, with:

```
the transaction was rejected by network rules.
non-BIP68-final (code 64)
```

Retries every 45–60 s failed from tip `337146` through `337173` (~28 blocks,
~26 minutes) for the *identical* bytes. The same bytes were accepted unchanged
at tip `337174` — long after the coin was, by any reading of BIP68, old enough.
The merkle proof of the poke transaction was verified against the block header
at `337144`, so the coin's height is not in question.

**The diagnostic that makes this actionable.** Build the same claim with
several `nSequence` values and compare the error:

| nSequence | node's answer |
|---|---|
| 0 | `non-mandatory-script-verify-flag (Locktime …)` — the *lock* check passed, `OP_CHECKSEQUENCEVERIFY` failed |
| 1 | `non-mandatory-script-verify-flag (Locktime …)` |
| 2 | `non-mandatory-script-verify-flag (Locktime …)` |
| 3 | `non-BIP68-final (code 64)` — the *lock* check failed |

From BCHN's `CalculateSequenceLocks` / `EvaluateSequenceLocks` (`lockHeight =
coinHeight + nSequence - 1`, invalid when `lockHeight >= tip + 1`) the pattern
0,1,2-pass / 3-fail means the node is using **coinHeight ≈ tip − 1**, not the
`337144` its own transaction index reports. In other words the coin looks
"just confirmed" to the mempool check while the explorer and every Electrum
server call it 20 blocks old. This is the same class of failure reported for the
sibling Mecenas template; the sequence sweep above is a cheap way to prove it is
the node's height bookkeeping and not your transaction.

**Why it matters.** Any XO app gated on relative locktime needs a retry loop and
should budget minutes, not blocks. `scripts/claim.ts` retries on exactly this
message. The same pattern reproduced on a second, freshly created vault
(coin at `337172`, `periodBlocks = 1`, `nSequence = 1`), so it is not specific
to one coin or to an unusual period.

---

## 6. `XOTemplateInput.sequenceNumber` now works (it did not in the build the sibling templates targeted)

**What happened.** The engine resolves a template input's `sequenceNumber` when
the invitation input does not set one:

```js
// @xo-cash/engine, completeMergedInput()
if (processedInput.sequenceNumber === undefined)
  processedInput.sequenceNumber = resolveTemplateSequenceNumberForMergedInput(processedInput.inputIdentifier, template, variables);
```

and `resolveTemplateSequenceNumberForMergedInput` evaluates a CashASM
expression against the invitation's variables and falls back to
`DEFAULT_SEQUENCE_NUMBER` (`0`) only when the template sets nothing. In the
build the sibling Mecenas template had to work around
(`0.1.1-next.17778370827`), that call did not exist, which is why its README
says the field is ignored.

**Verified here.** Building a claim with no invitation-level `sequenceNumber`
produces `nSequence = 0`; passing `0xffffffff` produces `0xffffffff`
(`scripts/verify-findings.ts`). The template-level path is present in the
source but is not exercised end to end by this repository: `claimInput`
deliberately omits it and every script passes the value on the invitation, so
the invitation JSON is the complete recipe for the transaction.

**Suggestion.** Document this: it is the difference between "a CSV covenant is
impossible from the template schema" (true in the older build) and "declare
`sequenceNumber: '<periodBlocks>'` on the input" (true today).

## 7. `bytes` variables are hex-decoded, so a text label can silently become binary

**What happened.** The template's `label` is a `bytes` variable, and I wanted a
readable on-chain memo ("for-alice-2026"). The engine's
`convertInvitationVariableValueForCompiler` does:

```js
if (variableType === BYTES) return hexToBin(variableText);
```

so a label of `cafe` commits the two bytes `0xca 0xfe`, not the four bytes of
UTF-8 "cafe", while `hello` (not valid hex) is UTF-8 encoded. The same input can
therefore mean two different things depending on its spelling.

**Reproduction.** `scripts/verify-findings.ts` compiles the same vault with
`labelHex: labelToHex('cafe')` (→ `63616665`) and with `labelHex: 'cafe'`, and
prints two different addresses. This repository always passes
`labelToHex(label)` and documents it in `source/types.ts`.

**Suggestion.** For `bytes`, accept `Uint8Array`/`0x…` only and error on a bare
string; or add a `text` type.

---

## 8. Template constants are not visible inside compiled scripts

**What happened.** `<pokeFeeSatoshis>` inside a `scripts` entry fails with
`CashAssemblyRequiredVariableMissingError`, even though `pokeFeeSatoshis` is
declared, typed and valued under `constants`. Only `variables` are resolved into
script bodies. The fee is therefore inlined as the literal `<1500>` in all four
branches, and `constants.*` exists only for off-chain code and documentation.

**Reproduction.** `scripts/verify-findings.ts` compiles a one-line script
containing `<pokeFeeSatoshis>` and prints the error.

---

## 9. An output locked to an opaque script variable is never tracked

**What happened.** `updateBeneficiary` spends vault B into a *new* vault B′ whose
locking script is `$(<nextVaultLockingScript>)` — a 34-byte P2SH32 the caller
computed. The transaction is valid and confirmed
(`225f71fcce5d9561858701bfe83dbe570cbee1db9d575f8ffdc5a3e627e5a79b`), but the
engine never learns the new script hash: `listUnspentOutputs()` does not contain
B′'s 38,500 satoshis even after 8 confirmations, and `scripts/reclaim.ts` fails
on it with `source UTXO not found`.

The cause is that tracking is a side effect of *creating* an output whose
locking script the template can resolve to a declared `lockingScripts` entry
with a role. An opaque variable script is built correctly, signed correctly and
then forgotten.

**Consequence in this repo.** Vault B′ (38,500 Chipnet sats,
`bchtest:pd50c70fv7x26jz6uy3vxqyzhtefgjd38qywdvdzryrtd4rj9ct2zepq02yxs`) is
spendable in principle and unreachable through the engine in practice. The
reclaim demonstration therefore uses a freshly created vault C instead. This is
the strongest argument for finding 3's "recursive template reference": if the
next vault were a first-class template output, the engine would track it.

---

## 10. Change outputs can be lost by recreating the account database (no rescan API)

**What happened.** I rebuilt the scratch database (`.xo-data`) while iterating.
The mnemonic was unchanged, but every change output generated by the previous
database disappeared from `listSpendableUnspentOutputs()`, including 786,940
Chipnet sats. The engine derives keys from `m/42415'/{templateIndex}'/0'/{n}`
where `n` is a counter stored *in the database*; a fresh database rewinds the
counter, so those scripts are never subscribed to again. Nothing is lost
on-chain, but there is no `rescan`/`deriveTo(index)` call to bring them back.

**What I did.** `scripts/scan-wallet.ts` re-derives the p2pkh scripts from the
mnemonic and prints their Electrum script hashes; `scripts/scan-balances.ts`
queries them; `scripts/recover-change.ts` walks the engine counter forward
until it regenerates the missing script, which makes the engine subscribe to it
again. That recovered both lost change outputs, but it is ~120 lines of
workaround for what should be a one-line API.

**Suggestion.** `engine.rescan({ templateIdentifier, toIndex })`, or persisting
the derivation counter outside the database.

---

## 11. `minedAtHeight` is often `0`/absent, and the header sync never settles

**What happened.** For a UTXO confirmed in block `337144`,
`listUnspentOutputs()` returned `minedAtHeight: 0` (and sometimes omitted the
field entirely), which makes the off-chain BIP68 helper read an age of
`currentHeight` blocks. `engines.getChainStatus()` reports
`verifiedHeight: 302144` against `currentHeight: 337xxx`
(`verifiedPercent: "0.0"`), and every session logs:

```
Failed to synchronize block headers, will retry later: Error: Header '…' at height 332451 claims target 486604799, expected 437753688.
Failed to process transaction update: Error: Could not validate a block header on height 337133:
  The requested header is ahead of the current checkpoint at height 332335
```

The bundled `@electrum-cash/checkpoint` data is far behind the live chain. It
did not stop any transaction in this repository, but it makes age calculations
unreliable and the logs very hard to read while debugging finding 5.

`scripts/lib/vault.ts` therefore treats `0` as "unknown" and falls back to
Electrum's `blockchain.scripthash.listunspent` height when it needs a real one.

---

## 12. `selectable: false` is honoured in this engine version

Earlier templates reported that a covenant output still appeared in
`listSpendableUnspentOutputs()` despite `selectable: false` on its role. With
`0.1.1-next.18029697917` it does **not**: `scripts/verify-findings.ts` prints
`vault UTXO in listSpendableUnspentOutputs()? false` for the live vault.

`scripts/create.ts` still filters vault outputs out of funding explicitly
(`utxo.templateIdentifier !== templateIdentifier`), because using a covenant
output as an ordinary funding input produces an invalid transaction and the
flag is one engine change away from regressing. Worth knowing that the fix
landed.

## 13. The debug tool needs the template imported before an invitation resolves

Pasting an invitation into <https://blaze.xo.cash> before importing
`fixtures/inheritance-vault.template.json` fails with
`Template not found: import template "<id>" before joining this invitation.`
After the import, all seven invitations in `artifacts/final-run/` preview
cleanly (see `docs/debug-tool/`). This is a reasonable design, but it is not
discoverable from the landing page: the natural first action is to paste an
invitation.

---

## 14. A commit's explicit output value silently overrides the template expression

**What happened.** `completeMergedOutput` only evaluates a template output's
`valueSatoshis` expression when the commit leaves the value unset. Supplying
`{ outputIdentifier: 'beneficiaryPayoutOutput', valueSatoshis: 3500n }` on a
vault that should pay 4,500 produces a transaction that pays 3,500, with no
warning anywhere; only the covenant refuses it (and only when the input is
actually signed and evaluated).

**Reproduction.** `scripts/verify-findings.ts` builds exactly that claim and
prints `template expression would pay 4500 sats` next to
`built transaction pays 3500 sats`. The same mechanism is what makes the
negative tests in `scripts/reject-early-claim.ts` possible.

**Suggestion.** Warn (or refuse) when a committed value conflicts with the
template's own expression; today a stale copy of a number in application code
silently changes the transaction.

## 15. Small things that work well (worth keeping)

* The template identifier is a stable content hash: `parseTemplate` →
  `generateTemplateIdentifier` and a live `Engine.importTemplate` agree.
* `resolveInvitationOutputLockingBytecode` returns exactly the bytecode the
  template compiles to, which is what makes the audit check in
  `scripts/create.ts` possible.
* Editing a deployed template is safe by construction: changing the label, the
  period or a selector changes the address, so an old covenant can never be
  spent by a rebuilt template with different rules.
* `executeAction` producing a *deterministic* transaction means a failed
  broadcast can be retried (or the raw bytes submitted elsewhere) without
  changing the txid.
