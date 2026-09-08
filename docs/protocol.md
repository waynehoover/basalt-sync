# Wire protocol, v5

[Developer documentation](development.md) · [Design and threat model](design.md)

Basalt uses one WebSocket connection. Text frames carry JSON control messages;
binary frames carry encrypted chunk bodies. Contents and paths are encrypted,
but sizes, timestamps, device labels, and routing metadata are readable by the
server. Use TLS to protect credentials and traffic in transit.

Examples below are message shapes, not literal JSON: unquoted fields stand for
values, `?` means optional, and `...` omits fields already described.
The authoritative definitions are in
[wire.go](../server/internal/wire/wire.go) and
[transport.ts](../client/src/core/transport.ts).

## Design rules

1. Name outcomes explicitly: `have`, `want`, `ack`, and `err`.
2. Acknowledge a device's own writes without requiring it to download an echo.
3. Carry covered version ranges so clients can check stream continuity.
4. Derive sync decisions from state rather than a persisted “initial sync” flag.
5. Validate structure and limits before accepting content. Clients also validate decrypted paths.
6. Version the wire protocol separately from the encryption construction.

## Handshake

A hello selects one of three session types.

### Device session

```text
-> {op:"hello", id, proto:5, vault, deviceId, token, device,
    crypto:"basalt/hkdf-aes-gcm/1", cursor}
<- {res:"ready", id, proto:5, minProto:5, serverVersion, cursor,
    perFileMax, chunkMax, maxChunks, maxBatchBytes, maxFetchBytes, wrapped}
```

`deviceId` identifies a registered device and `token` is its authentication key.
`cursor` is the last applied UID, or 0. `ready` advertises limits before any
catch-up and includes the vault's wrapped data key.

### Registrar session

```text
-> {op:"hello", id, proto:5, vault, token, device, crypto, claim?, wrapped?}
<- {res:"registrar", id, proto:5, minProto:5, serverVersion, maxDevices}
```

With no `deviceId`, `token` is the root-derived vault credential. A registrar
can register devices, rotate the root, and administer device access. It cannot
read/write notes, receives no catch-up, and occupies no syncing-device slot.

An unclaimed vault instead requires the server's bootstrap token plus `claim`
and `wrapped`. Those fields bind the vault once to the proposed auth key and
wrapped data key. The client persists the candidate before claiming and reuses
it on retry. It must not keep sending claim material after setup completes.
A bootstrap-authenticated registrar cannot rotate the root.

### Invite redemption

```text
-> {op:"hello", id, proto:5, vault, device, crypto, invite, deviceId, auth, name?}
<- {res:"redeemed", id, sealed, deviceId}
```

Redemption registers a device and consumes the invite atomically, then closes
the connection. The new device persists its credentials and reconnects as a
device session. See [invites](#adding-a-device-with-a-single-use-invite).

### Validation and compatibility

The supported range is currently **5 through 5**. Protocol 5 adds device-label
`rename`; older protocols are refused with `proto`. Upgrade the server before
clients. A refusal names supported protocol numbers, not the server release;
`serverVersion` is disclosed only after authentication.

Vault and device names are bounded at 64 bytes and reject control characters.
Device IDs use base64url characters, up to 64 characters. Invalid names return
`badname`. `deviceId` plus `claim`, token plus invite, or claim plus invite is
`badentry`. Invite redemption requires `deviceId` and a valid auth key.

A malformed claim/wrapped-key pair is refused regardless of vault state.
Unknown credentials, vaults, and invites use an indistinguishable `auth` error.
Clients ahead of the server are refused with `cursor`, as can happen after
restoring an older backup. Recovery requires an explicit rejoin.

## Request ids

Requests expecting replies carry an integer `id` from **1 to 2^32−1**, unique
among requests in flight. This applies to hello, put, putmany, get, fetch,
resend, history, deleted, register, devices, rename, revoke, invite, uninvite,
and rotate. Replies and request-specific errors echo the ID.

Missing or invalid IDs cause `protostate` and end the session. Clients also end
a session on an unknown reply ID. Unsolicited batches, caught-up notices, pings,
and connection-closing errors are handled separately from request replies.

## Catch-up

```text
<- {res:"ready", ...}
<- {op:"batch", from:120, to:139, entries:[...]}
<- {op:"batch", from:140, to:151, entries:[...]}
<- {op:"caught-up", cursor:151}
```

`batch` is the only message delivering entries; a live change is a batch of one.
Its range covers `from <= uid <= to`. Clients require `from == cursor + 1`.
Purge can leave holes, so a covered range need not contain every UID.

The server orders batches by UID, including concurrent commits. A device's own
write is delivered to it as an empty batch that advances its cursor. Live
changes during catch-up are held and delivered in order afterwards.

Continuity checks detect malformed ordering but do not prove that an untrusted
server supplied every entry in a covered range.

## Writing a file

```text
-> {op:"put", id, path, meta:{size, ctime, mtime, folder, deleted, prev?},
    chunks:[h1,h2,h3], mac, parent}
<- {res:"want", id, chunks:[h2]}
-> binary frame for h2
<- {res:"ack", id, uid:152}
```

When all bodies already exist, the server records the entry and returns
`{res:"have", id, uid}` instead. Both `have` and `ack` mean the content and
entry are durable.

- Chunk names are 64-character lowercase hexadecimal SHA-256 hashes of sealed
  bodies. The server verifies names on upload and download.
- Bodies are matched to requested names by hash. A bad body mid-upload ends the
  session because the remaining frame count can no longer be trusted.
- The ciphertext budget is `size + 256 * len(chunks)`, counting repeated
  references. It is checked during upload and at commit.
- Empty files, folders, and deletions have no chunks; `chunks` is always an array.
- `prev` identifies the former path for a file rename. This is separate from
  the `rename` operation that changes a device label.
- The server checks MAC shape, not authenticity; only clients have its key.
- Errors rejecting an individual request normally leave the session usable.
  See the error table for cases that close it.

Clients must dispatch unsolicited batches independently while awaiting replies.
The server pings idle sessions and allows an upload in progress to finish during
graceful shutdown. Idle sessions receive a retryable shutdown error.

## Writing many files at once

```text
-> {op:"putmany", id, entries:[{path, meta, chunks, mac, parent}, ...]}
<- {res:"want", id, chunks:[h1,h2,h3]}
-> binary frames
<- {res:"acks", id, results:[{uid:152}, {uid:153}, {code, msg}, ...]}
```

A batch contains at most 256 entries. Both encoded request size and summed
ciphertext budgets must fit `maxBatchBytes`. Clients split batches and use
`put` for a file whose own budget exceeds the batch budget.

`results` has one slot per input entry. A refused entry does not reject the
others. An empty batch is `badentry`; too many entries is `toolarge`. All other
`put` rules apply.

## Authenticating an entry

`mac` is HMAC-SHA256 under the metadata key, over canonical length-prefixed
fields: sealed path, size, ctime, mtime, folder/deleted flags, previous path,
parent, chunk count, and ordered chunk names. See
[EntryFacts and macEntry](../client/src/core/crypto.ts).

The server-assigned **UID and device label are not covered**. This is a shared
vault-key authenticator, not a per-device signature.

`parent` is a digest of the writer's previous content identity, or empty for a
previously unsynced file. It is authenticated, but clients do not yet enforce
it as an ancestry chain. Replay of an older valid version under a newer UID and
withholding remain possible; see [the threat model](design.md#what-the-server-can-and-cannot-do).

## Reading a file

```text
-> {op:"get", id, uid}
<- {res:"chunks", id, uid, size, chunks:[h1,h2,h3]}
-> {op:"fetch", id, chunks:[h2]}
<- {res:"bodies", id, count:1}
<- binary frame for h2
```

A fetch can combine chunks from several files within `maxFetchBytes`. The
response announces exactly the number of frames to follow, in requested order.
If any requested body is unavailable, it returns `nochunk` without sending a
partial set. Hash failures are quarantined before announcing bodies.

A missing UID returns `nouid`; a folder or deletion returns `nocontent`.
A zero-byte note has a valid empty chunk list. Clients verify authenticated
version metadata and assembled size before applying content.

## Deleting

A deletion is an entry with `deleted: true`, not an absent path. Its record
remains available to catch-up and recovery even if older content is later purged.

## Repairing a body the server has lost

`resend` repairs missing stored content without creating a note version:

```text
-> {op:"resend", id, chunks:[h1,h2]}
<- {res:"want", id, chunks:[h2]}
-> binary frame for h2
<- {res:"resent", id, stored:1, missing:0}
```

Only names referenced by committed entries in the vault are eligible; others
return `nochunk`. Uploaded bytes must hash to their names. No UID or entry is
created. `missing` counts requested bodies still absent after the attempt; it
does not measure unavailable history the client never offered. Server-side
`verify` is required to assess the store as a whole.

## Recovery

| Request | Reply |
|---|---|
| `{op:"history", id, path, before?, limit?}` | `{res:"history", id, path, entries}` |
| `{op:"deleted", id, before?, limit?}` | `{res:"deleted", id, entries, more}` |

Paths are sealed. History returns versions newest first, including deletions;
`before` pages backward. An empty history does not distinguish an unknown path
from purged history.

Deleted lists the latest deletion for each path, suppressing file renames and
bounding each page at 1,000. `more` indicates another page. `restorable` names
the newest content-bearing UID or is 0 when none remains.

There is no restore wire operation. A client reads an authenticated historical
version, writes a local copy, and ordinarily uploads it as a new version.

## Authentication

| Session | Allowed operations |
|---|---|
| Device | Sync, recovery reads, repair, devices, rename, invite, uninvite, and revoke except the final device. |
| Registrar | Register, rotate, devices, uninvite, and revoke including the final device with confirmation. |
| Invite redemption | Register the requested device, reply, and close. |

The server stores SHA-256 hashes of random auth keys. This construction is for
random high-entropy credentials, not user-selected passwords. Content keys do
not reach the server in plaintext.

### The device list

```text
-> {op:"register", id, deviceId, auth, name?}
<- {res:"registered", id, deviceId, wrapped}

-> {op:"devices", id}
<- {res:"devices", id, devices, maxDevices, invites}

-> {op:"rename", id, name}
<- {res:"renamed", id, name}

-> {op:"revoke", id, deviceId, allowLast?}
<- {res:"revoked", id, deviceId, self}
```

A device row contains its ID, readable name, auth-key hash, creation time, and
last-seen time. IDs establish identity; names need not be unique.

Registering the same ID and key again succeeds, allowing retry after a lost
reply. The same ID with a different key is `badentry`. `name` defaults to the
session's device name.

`rename` changes only the calling device's row. Registrars cannot use it.
An empty or invalid name is `badname`. No content version or UID is created,
and historical device labels and existing conflict filenames are unchanged.

Revoke removes the row and closes its live sessions. Connecting and revoking
are ordered so a revoked device cannot remain attached between those steps.
Revoking the last device needs a registrar and `allowLast`; a device presenting
that field is refused with `auth`. A nonexistent device is `nodevice`.

The registration cap is eight. `full` requires removing a device, whereas
connection-level `busy` can clear by waiting. Failed pairing can leave a row
that never connected; it still counts. The cap does not retroactively remove
rows if a store already contains more.

### The data key, and rotating a leaked secret

Every vault has a random 32-byte data key, wrapped under a root-derived key.
Devices receive the data key through registration or an invite and retain their
own credentials rather than the root.

```text
-> {op:"rotate", id, auth, wrapped}
<- {res:"rotated", id}
```

A registrar supplies a new auth key and the same data key wrapped under the
new root. The server changes the hash and wrapping atomically, cancels invites,
and closes other registrar sessions. Existing devices and content are unchanged.

Registrar writes check that their credential is still current, including
requests already in flight when another rotation commits. Stale writes return
`rotated`. After a lost rotation reply, the client must retain both candidate
roots and establish which one the server accepts before discarding either.

Rotation does not replace the data key, revoke devices, or provide forward
secrecy. A revoked device can decrypt ciphertext obtained elsewhere using the
key it already holds.

### Adding a device with a single-use invite

```text
-> {op:"invite", id, invite, sealed, ttlMs?}
<- {res:"invited", id, expiresAt}

-> {op:"uninvite", id, invite}
<- {res:"uninvited", id, invite}
```

`invite` is a random 128-bit identifier. `sealed` contains the data key encrypted
with a random 256-bit invite key: `nonce || AES-GCM-256(K_inv, nonce, K_data)`.
Both are base64url. The server stores the identifier, ciphertext, and expiry;
the invite key travels only in the user's string.

The `basalt3i_` string encodes a version byte, identifier, invite key,
length-prefixed server address and vault ID, and CRC-32. The default lifetime is
ten minutes; the maximum is one hour. A device can issue invites; a registrar
cannot. Either session can cancel an invite by ID.

Redeeming at hello atomically spends the invite and inserts the new device row.
The `sealed` data key is returned, not the root-wrapped key. A refused insertion
leaves the invite unspent. Unknown, expired, used, or malformed redemption
credentials return `auth`; malformed fields return format errors. Duplicate
device IDs return `badentry`, and the registration cap returns `full`.

Device listings expose outstanding invite IDs and expiration times, never the
sealed value or invite key. Canceling an unknown/expired/used invite returns
`badentry`. Rotation cancels all outstanding invites.

The `basalt3_` recovery string instead carries the root and connection details.
It opens a registrar session to recover access when no paired device remains.

## Which clients may connect

No Origin header is allowed for non-browser clients. Browser clients must match
`app://obsidian.md`, `capacitor://localhost`, `http://localhost`, or an explicitly
configured `-allow-origin`. Rejected origins are logged with an operator hint.

## Crypto

The separately versioned scheme is `basalt/hkdf-aes-gcm/1`:

```text
S         = 32 random bytes                    root secret
K_auth    = HKDF(S, "basalt/auth/1")
K_wrap    = HKDF(S, "basalt/wrap/1")
D         = 32 random bytes                    data key
wrapped   = n || AES-GCM-256(K_wrap, n, D)      random 12-byte nonce n

K_path    = HKDF(D, "basalt/path/1")
K_content = HKDF(D, "basalt/content/1")
K_nonce   = HKDF(D, "basalt/nonce/1")
K_meta    = HKDF(D, "basalt/meta/1")

nonce(p)  = HMAC-SHA-256(K_nonce, p)[:12]
seal(K,p) = nonce(p) || AES-GCM-256(K, nonce(p), p)
```

HKDF uses SHA-256. Paths and chunks use separate keys. Deterministic sealing
allows matching paths and deduplicating chunks; the server can observe equality.
This construction is not AES-GCM-SIV. Distinct plaintexts can collide in the
96-bit nonce space; see the [design's bound](design.md#the-keys).

Before encryption, each chunk gets a marker byte: `0` for uncompressed payload,
`1` for raw deflate at level 6. Compression is used only when smaller. The nonce,
tag, and marker add at most 29 bytes over the original chunk. Compression must
produce identical bytes across platforms because ciphertext determines names.

## What the server can see

File sizes, timestamps, chunk counts and equality, sealed-path activity, device
labels, and connection metadata. It cannot read plaintext contents or filenames.
It still controls availability and ordering, as described in the threat model.

## Errors

```text
<- {res:"err", id?, code, msg, retryable, retryAfterMs?}
```

`code` is machine-readable; `msg` explains the problem. Request errors echo the
ID. Unsolicited errors describe why a connection is closing. `retryable` says
whether reconnecting later may help; clients retain defaults for malformed
frames missing that field.

| code | meaning | retryable | session |
|---|---|---|---|
| `proto` | Unsupported wire/crypto version or incompatible vault format. | no | ends at hello. |
| `auth` | Invalid credentials or an operation not allowed to this session. | no | ends at hello, otherwise rejects the operation. |
| `cursor` | Client is ahead of server history. | no | ends. |
| `rotated` | Registrar credential was retired. | no | ends. |
| `busy` | Connection capacity or shutdown. | yes | ends with a delay hint. |
| `protostate` | Unexpected message/state or invalid framing. | no | generally ends. Unknown ops and invalid history pagination reject that request. |
| `badchunk` | Invalid name or body hash. | no | ends for bad bodies mid-upload, otherwise rejects the request. |
| `badentry` | Invalid entry or request incompatible with current state. | no | rejects the request, or ends for malformed claims at hello. |
| `badname` | Invalid name or device ID. | no | ends at hello, otherwise rejects the request. |
| `toolarge` | A limit or declared size was exceeded. | no | ends if upload framing cannot continue, otherwise rejects the request. |
| `nospace` | Storage capacity exhausted. | yes | ends during upload. |
| `nouid` | Version does not exist. | no | request rejected. |
| `nocontent` | Requested version is a folder or deletion. | no | request rejected. |
| `nochunk` | Content unavailable. | no | request rejected without partial fetch bodies. |
| `nodevice` | Device ID no longer exists. | no | request rejected. |
| `full` | Registration limit reached. | no | remove a device before retrying. |
| `internal` | Server fault; put not committed. | yes | ends during handshake/catch-up, otherwise rejects the request. |

`busy` suggests 30 seconds at connection capacity and 5 seconds during shutdown.
It remains one code because both cases require reconnecting later. `full` is
separate because waiting cannot free a registration slot. Numeric limits are in
the [server reference](server-reference.md#ceilings).
