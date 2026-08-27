# Appliance RFCs

This directory contains written technical decisions for Appliance.

RFCs use four-digit numbers and descriptive filenames. A merged RFC records the
decision at the time it was accepted; later changes should amend it explicitly
or add a superseding RFC rather than silently changing the contract.

| RFC | Title | Status |
| --- | --- | --- |
| 0004 | [Identity, entitlements, and Ed25519 signing](0004-identity-entitlements-and-signing.md) | Proposed |

RFC 0001, which owns the runnable bundle manifest, publisher block, and
signature-envelope shape, is being developed on a sibling branch. RFC 0004
depends on that wire contract and defines its trust, identity, and entitlement
semantics without duplicating the envelope.
