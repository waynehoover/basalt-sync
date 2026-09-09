# Design and threat model

[Developer documentation](development.md) · [Plain-language privacy guide](security.md)

Basalt serves one person's trusted devices through one server. The product
priorities are preserving notes, keeping deployment small, and reducing repeat
transfers. This is an engineering reference, not a setup guide.

## The durability rules

These rule numbers are stable because code comments cite them. The
[findings index](findings.md) links the implementation's review history.

1. **Acknowledge only after the write is durable.** Commit content and its
   version record before confirming an upload.
2. **A failed read is not an empty result.** Refuse unreadable state instead of
   replacing it with defaults. This prevents a failed read becoming a deletion.
3. **Never delete until a verified copy exists elsewhere.** Verify the copy
   before removing the source.
4. **Verify the outcome, not the exit code.** Check the written bytes and
   resulting state; a successful call alone is insufficient.
5. **Never write a result smaller than its input without proving that is
   right.** Merges, pruning, and rewrites must account for what they remove.
6. **Deletions are entries, not absences.** Retain a deletion record so clients
   can distinguish removal from an incomplete listing.
7. **A status describes the vault, not the filter.** Report exclusions,
   refusals, retries, and unresolved recovery alongside successful transfers.
8. **Trust the numbers, not the passes.** Investigate impossible counts and
   timings even when assertions pass.
9. **A fix without a test that failed first is not finished.** Demonstrate the
   failure without the fix and the pass with it.
10. **Assertions must check the property that matters.** Device agreement is
    insufficient if both devices lost an edit. Check the retained content.
11. **A recovery path tested only in docs is a rumour.** Exercise restore with
    the built server and read the restored versions and content back.

## Conflicts: keep both

Three-way merging uses the last reconciled content as its ancestor. The engine
checks overlap, merge-order agreement, patch application, and retained insertions.
Structured formats have additional validity checks. A refused merge keeps both
versions; a successful merge can update the original note.

In ordinary conflict handling, the incoming version takes the conflict name.
An edit detected during replacement can instead be preserved under a new name.
Neither rule provides mutual exclusion with the editor.

A read-only CLI device must record local reconciliation separately from
uploading. Otherwise a successfully preserved or merged remote version remains
eligible on every pass. Its local edit remains held back even after that remote
version has been handled.

## File replacement

Both adapters stage incoming content, check it, preserve displaced bytes, and
publish only into a destination they can safely claim. A preservation failure
other than an already-absent source stops the write. Recovery records make
retained versions discoverable after restart; unreadable inventory is an
explicit incomplete state.

The CLI relies on local filesystem link/rename behavior. The plugin relies on
Obsidian's adapters refusing occupied rename destinations, as inspected in
Obsidian 1.13.7. Its test adapter models that behavior; it is not a substitute
for acceptance against a new Obsidian release. The mobile path also rechecks a
destination before rename, which narrows a race without proving exclusion.

`Vault.process()` is not a replacement for staging. In the inspected desktop
and Capacitor adapters, it reads and writes strings in place. Its operation
queue serializes adapter calls within Obsidian; it does not make an interrupted
filesystem write atomic or coordinate an external editor. It also does not
cover attachment writes, deletion, or restore.

Desktop can flush through the filesystem; mobile does not expose an equivalent
flush primitive. Mobile crash/power-loss durability is therefore weaker. A
whole-file fallback can also exceed an older phone's memory on large attachments.
The 64 MiB default was informed by desktop measurements, not a measured bound
for every phone.

## Fast, because it sends less

Files are divided into content-defined chunks, compressed, then encrypted.
Unchanged chunks are reused across versions. Compressing before chunking would
move boundaries after edits; compressing ciphertext would not save space.

The compression implementation and chunking parameters affect content names.
Changing them can trigger re-upload or require a migration. See
[historical measurements and evaluations](research.md) before changing them.

## Simplicity

Keep sync decisions in the shared engine. Adapters provide file operations;
the CLI and plugin expose outcomes and user actions. Shared state transitions
and outcome rendering reduce differences between the two clients.

The plugin has actions rather than a general settings screen. Server flags and
CLI options still form a configuration surface and need explicit documentation
and combination testing. Avoid adding a second implementation where the same
behavior can be shared.

Joining an existing vault checks the filesystem before registration or invite
redemption; unreadable folders refuse pairing. Empty vaults proceed directly.
Populated vaults require confirmation before their files are combined with the
synced vault. Cancelling does not consume the invite. This is a setup step, not
a lasting merge preference: paired devices use normal two-way sync.

## Refusals

Current scope excludes a second server backend, peer-to-peer sync, teams/shared
vaults, and a server web interface. Obsidian configuration sync is also absent:
settings and workspace files have different ownership and failure consequences
from notes, and the configuration folder contains device credentials.

Notes and ordinary attachments are the target. Large media libraries, arbitrary
filesystem layouts, and untrusted collaborators require a different product
scope. These are scope decisions, not claims that alternatives cannot solve them.

## Where this is supported

| Environment | Status |
|---|---|
| Obsidian on macOS/Linux, local storage | Supported product scope; real-app acceptance remains necessary. |
| Obsidian on Android, local storage | In use; foreground sync only, with mobile durability limits. |
| CLI on macOS/Linux, local storage | Experimental; intended primarily for mirrors. |
| iOS | Untested. |
| Windows | Unsupported. |
| NFS, SMB, or other network filesystems | Unsupported. |
| A vault spanning several mounts | Outside the tested setup. |
| Another sync tool on the same local vault | Unsupported. |
| Two Basalt writers to one local vault | Unsupported; CLI exclusion enforces one CLI writer. |

Editing on separate devices is supported. Running the plugin and CLI against
the same local directory is a different case and must be avoided. Filesystem
support depends on the concrete mount and adapter, not just an OS label.

## What the server can and cannot do

The server stores encrypted content and paths. It does not hold the plaintext
data key, but does hold wrapped keys, credential hashes, and readable metadata.
It sees sizes, timestamps, device labels, update activity, and repeated chunks.

The entry authenticator covers the sealed path, size, timestamps, folder and
deleted flags, previous path, ordered chunk list, and parent. Clients verify it
before applying or restoring content and check assembly sizes and ancestors.
A server without the data key cannot forge arbitrary authenticated content.

**Ordering and completeness remain trusted.** The server assigns UIDs, which
are not authenticated. It can replay an older valid version under a newer UID,
causing an unchanged local note to revert, or withhold entries. The signed
`parent` is not currently checked as an ancestry chain. A newly paired device
has no retained checkpoint to challenge an old but valid history.

Do not describe this as protection from every malicious-server action. Server
availability and honest ordering are part of the deployment assumptions. A
backup protects against some operational failures; it does not prove freshness.

### What a stranger on the port learns

Unauthenticated callers can reach health, the initial handshake, and protocol
refusals. These can reveal that Basalt is present, supported protocol numbers,
and a bounded readiness reason. They do not include vault contents, paths, or
the server release. The release is advertised after authentication.

Authentication failures avoid distinguishing unknown vaults, device rows, or
invites. Format errors remain distinct because they describe the request;
capacity details requiring vault state are checked after authorization.

### Why a loopback bind is not the token

A reverse proxy forwards remote traffic to loopback. A local bind therefore
cannot authorize the first claim. The bootstrap token is required on every bind,
including `-localhost`; a successful claim binds the vault once and subsequent
claims cannot replace it.

## The keys

A vault begins with a random 256-bit root secret and a random 256-bit data key.
The root derives an authentication key for registrar operations and a wrapping
key for the data key. The data key derives separate path, content, nonce, and
metadata-authentication keys through HKDF-SHA256.

Each device has its own random secret for connection authentication. The server
stores credential hashes. These are random keys, not user-chosen passwords.
See the [protocol's crypto section](protocol.md#crypto) for the construction.

Sealing uses AES-GCM with an HMAC-derived 96-bit nonce. Equal plaintext under a
key produces equal ciphertext, enabling deduplication. This is not AES-GCM-SIV;
a collision between distinct plaintexts would reuse a GCM nonce. The birthday
scale is about 2^48 distinct inputs, a probabilistic bound rather than an
impossibility. Do not present deterministic sealing as revealing no information.

## Three credentials, and who holds which

| Credential/key | Held by | Purpose |
|---|---|---|
| Recovery key/root secret | Owner's separate recovery copy; transiently during setup/rotation | Register devices, rotate the root, administer device access. |
| Device secret | That device | Connect, sync, list/revoke devices, issue/cancel invites. |
| Data key | Every paired device | Encrypt, decrypt, and authenticate vault content. |

A paired device does not normally retain the root. An incomplete initialization
can retain it until device registration finishes, so an error must preserve and
explain that recovery state.

## What a device can do to another device

Paired devices are trusted with all vault content. Clients still reject paths
outside the vault, traversal, unsafe symlink destinations, and excluded paths
such as the Obsidian configuration folder.

A device cannot directly register with the root or rotate it, but **can issue
an invite and thereby add another device**. Device and invite listings make
that authority visible; they do not prevent a compromised authorized device
from using it. Any device can revoke another except the final device, whose
revocation requires the recovery key.

CLI read-only mode restricts ordinary sync behavior. It does not change the
server credential or prevent explicit repair and administration requests.

## A lost or stolen device

Revoke its device ID to remove access through the server and close its live
connections. Review other devices and outstanding invites. If the root may be
exposed, rotate it and save the new recovery key.

Rotation changes the root and the wrapping of the **same data key**, cancels
invites, and leaves existing devices and history intact. It does not remove
access granted to other already-registered devices; inspect and revoke those
separately. Operator steps are in [Security and privacy](security.md).

### What a revoked device can still do

Revocation does not erase local notes or the data key. It also does not prevent
decryption of future ciphertext obtained from another device, backup, or other
source. Rotation does not change that. Basalt does not provide forward secrecy
through device revocation.

### What the authenticator proves, and what it does not

| Property | Current guarantee |
|---|---|
| Content authenticity | A holder of the shared data key authenticated the protected fields. |
| Device attribution | Not provided. The free-text device label is not covered by `macEntry`, and there are no per-device content signatures. |
| Freshness | Not provided by the MAC; the server-assigned UID is not covered. |
| Completeness | Withholding is not fully detected. |

## Provenance

Release workflows rebuild assets from tags and generate provenance attestations.
Verify the published asset and its checksums; do not infer its contents from a
local build. [Developer documentation](development.md#releases) covers the tools.
Provenance identifies a build; it does not establish that the code is secure.

## What is not claimed

- Full detection of replay, withheld history, or a server refusing service.
- Cryptographic attribution of a version to a particular device.
- Erasing keys from a revoked device or forward secrecy after revocation.
- Mobile persistence guarantees equivalent to desktop flushing.
- Safe coexistence with another sync engine or arbitrary network filesystems.
- Complete semantic validation of every merged format. For example, valid
  canvas JSON can contain an edge whose node another device removed.

A change to the deployment model should revisit these assumptions before adding
mechanisms intended to cover it.
