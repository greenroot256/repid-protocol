# SPEC-010: Protocol Versioning

> **Status:** normative. This specification exists because no version identifier
> existed anywhere in RepID before it. A protocol whose meaning can change
> silently is not implementable by a third party with confidence.

## 1. Context and Objective

RepID is a protocol on Bitcoin Cash. A transaction, once broadcast, is immutable
and may be interpreted for years. Therefore **the meaning of a historical event
must never change**.

This specification defines:

1. the version identifier of the protocol;
2. what a version covers;
3. which changes are breaking;
4. how an implementation declares the version(s) it implements;
5. how versions relate to one another.

## 2. The Version Identifier

The protocol version is a three-part semantic version, `MAJOR.MINOR.PATCH`,
recorded machine-readably in `protocol/protocol-version.json`. That file is the
authoritative copy; §6 describes how the version of an individual fact's
*encoding* is identified, which is a separate mechanism.

### Current version

```json
{
  "protocol": "repid",
  "version": "0.1.0",
  "status": "pre-release",
  "specification": {
    "normativeCore": "SPEC-008-repid-protocol.md",
    "wireFormat": "SPEC-009-repid-wire-format-and-recognition.md",
    "recognition": "SPEC-005-indexer-protocol.md",
    "versioning": "SPEC-010-protocol-versioning.md"
  },
  "promotionTo1_0_0": [
    "At least one independent implementation outside this repository has been verified against the recognition rules (SPEC-005) and the wire format (SPEC-009), following the external indexer guide.",
    "The covenant artifacts in artifacts/ have been executed by the Bitcoin VM on a public test network with every invariant in SPEC-008 section 4 asserted, not merely observed."
  ]
}
```

The guide referred to in the first criterion is the external indexer guide that
ships with the demonstration repository; it is not part of this repository.

> **Why `0.1.0` and not `1.0.0`.** A leading zero is a promise that the
> specification has *not* yet been validated by an independent implementation.
> That is currently true: the recognition rules have been exercised only by this
> repository's own code. Claiming `1.0.0` would be a claim the project cannot
> yet support (see `constitution.md`, Article 4). The promotion criteria above
> are objective, and moving to `1.0.0` is a one-line change once they are met.

## 3. What a Version Covers

The protocol version covers **everything an independent implementation must
agree on** to reach the same conclusion about a transaction:

| Covered | Not covered |
|---|---|
| `OP_RETURN` tags and payload encoding | Reputation models, confidence indices |
| The field schema of each of the seven facts | Storage, transport, query interfaces |
| Recognition and validation rules (SPEC-005) | Application workflows |
| The on-chain invariants and covenant interfaces (SPEC-008 §4) | Wallet software, key custody |
| The score range (`MIN_SCORE`–`MAX_SCORE`) | Any user interface |

A change to anything in the **Covered** column changes the meaning of
historical data and is therefore breaking.

## 4. Breaking and Non-Breaking Changes

### Breaking — requires `MAJOR`

Any change that would cause a previously valid fact to be read differently, or a
previously recognized shape to stop being recognized:

- adding, removing or renaming a fact type;
- adding, removing or renaming a field of a fact, or changing its encoding;
- changing an `OP_RETURN` tag or the container layout;
- changing the score range;
- changing a covenant interface or an on-chain invariant;
- changing the recognition order or the precedence rules of SPEC-009.

### Non-breaking — requires `MINOR`

Additive changes that leave every historical fact interpretable exactly as
before:

- adding an **optional** field to a fact, which recognizers MUST ignore when
  absent;
- adding a new specification that does not alter existing facts;
- adding edge-case documentation that clarifies, but does not change, a rule.

### Editorial — requires `PATCH`

Typos, formatting, examples, cross-reference fixes. No semantic content.

> **The invariant.** The `MAJOR` number alone guarantees that two facts
> recognized by different versions of the specification can be compared. If a
> change can alter the reading of a historical transaction, it is `MAJOR`.
> There is no exception for "small" changes.

## 5. Declaring Implemented Versions

An implementation MUST declare the set of protocol versions it implements, and
MUST NOT claim a version it has not been verified against.

- `repid-sdk` exports `SDK_VERSION` and `SUPPORTED_PROTOCOL_VERSIONS`.
- Before building or recognizing anything, an implementation MUST check that
  the protocol version it is operating under is in its supported set, and MUST
  fail loudly if it is not.
- A recognizer processing historical data spanning a `MAJOR` boundary MUST
  report which version it applied to each fact. It MUST NOT silently apply one
  rule set to data from another.

## 6. How the Format Version Is Identified

**The payload of a RepID fact does not carry a version string.** The wire format
is exactly what SPEC-009 §3–§4 defines: a tag followed by a payload, and nothing
else.

The version of a fact's encoding is carried by **the tag itself**. Every tag in
`protocol/constants.json` ends in a revision digit — `REPID_RATING1`,
`REPID_PLATFORM1`, `REPID_TRUST1` — and that digit *is* the version of that tag's
encoding. A recognizer that has matched a tag therefore already knows which rule
set governs the payload behind it; there is nothing further to read.

This is deliberate, and it is what makes an unknown format safe:

- A tag whose revision a recognizer does not implement matches no recognizer, so
  under SPEC-009 it produces **no fact**. It is not a fact with unreadable
  fields — it is not a fact at all.
- A wrong field interpretation is therefore unreachable. A recognizer cannot read
  `REPID_RATING2` bytes with the `REPID_RATING1` rules, because the tags differ
  and it never applies those rules.
- Guessing remains forbidden on its own terms: a wrong field interpretation is
  indistinguishable, to a third party auditing the fact, from a correct one.

The protocol version `0.1.0` covers the **set** of tags and rules, not an
individual fact. Which specification produced a given fact is not written into
that fact's bytes; it is recovered from the tag, and the tag's revision is what
ties the fact to the specification that defines it.

If a future revision needs to change a payload — more fields, a different
length, a version string inside the payload — it MUST be published as a **new
tag with a new revision digit** (`REPID_RATING2`) and MUST NOT reuse an existing
tag. That is a `MAJOR` change under §4, and it breaks in both directions: a
recognizer that meets the new tag emits no fact for it until it implements the
new revision.

> **Withdrawn text.** An earlier version of this section specified the payload as
> `<repid-tag> <protocol-version> <payload...>`, with
> `REPID_RATING1 0.1.0 <raterPkh> <rateePkh> <score>` as the concrete case. It
> was never implemented and it contradicts the normative wire format on two
> counts. A `REPID_RATING1` payload is exactly two chunks whose second chunk is
> exactly one byte, so a recognizer is forbidden from reading the rater and the
> ratee out of it — they are recovered from the Rating Right the transaction
> spends, which is the design that lets a rating carry no addresses. And the
> withdrawn text contradicted itself: inserting a version into the payload would
> have changed the number of chunks, and SPEC-009 makes the exact chunk count
> part of the contract. Tag revisions are the versioning mechanism; the payload
> carries no version.

## 7. Compatibility and Migration

- Within a `MAJOR` version, a fact written by any `MINOR`/`PATCH` is readable by
  every implementation of that `MAJOR`. No migration is required.
- Across a `MAJOR` boundary, historical facts are **never rewritten**. They are
  read under the rule set of the version that produced them. There is no
  on-chain migration, because the chain is immutable by design.
- A new `MAJOR` MUST ship alongside the previous one for at least one release
  cycle, so that historical data remains readable during a transition.

## 8. Relation to Implementation Versions

- The **protocol** version (`MAJOR.MINOR.PATCH`) is normative and changes only as
  described above.
- The **SDK** version follows its own semver and is not required to track the
  protocol version numerically. Its compatibility is expressed by
  `SUPPORTED_PROTOCOL_VERSIONS`, not by matching numbers.
- The **demo application** is not versioned against the protocol; it consumes an
  SDK and declares the SDK version it was built with.

## 9. Out of Scope

- Wallet and key-management versioning.
- Wallet software, exchanges and explorers: they version independently.
- Application-level protocol extensions. An application that needs extra events
  MUST define them outside this protocol and MUST NOT alter the meaning of a
  RepID fact.
