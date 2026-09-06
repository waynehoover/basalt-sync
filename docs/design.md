# Design

[Back to the README](../README.md)

Why Basalt is built the way it is: the rules it will not break, what it refuses
to do, and what it does and does not protect against.

**Minimal, opinionated, fast, self-hosted.** In that order when they conflict.
Every question with a right answer is answered once, in the source, which is
why there is no settings screen. Fast follows, because the cheapest thing a
sync client can do with a byte is not send it. Self-hosted is what makes the
rest possible: one backend, one transport, one person's devices.

Nothing outranks not losing a note. When simplicity and correctness conflict,
correctness wins and the feature gets cut.

## The durability rules

Each of these came from something going wrong. The incident stays next to the
rule because a rule without its story gets softened later. Code comments cite
them by number.

1. **Acknowledge only after the write is durable.** The ack for a push waits
   until the chunk bodies and the entry are both committed. An early ack is a
   "stored" that a crash can turn into a lie.

2. **A failed read is not an empty result.** Code that read a config file,
   fell back to an empty list on error, and wrote it back disabled every plugin
   on a device. Absent and unreadable are different states. Unreadable aborts.

3. **Never delete until a verified copy exists elsewhere.** Copy, checksum both
   ends, then delete.

4. **Verify the outcome, not the exit code.** `adb push` returned 0 after
   writing one file of four. Read back what you wrote.

5. **Never write a result smaller than its input without proving that is
   right.** A merge, prune or rewrite that shrinks a list is a bug until shown
   otherwise. Refuse it and say why.

6. **Deletions are entries, not absences.** A deleted file leaves a record.
   That is what makes it recoverable, and why a vault whose files were all
   deleted is not an empty vault.

7. **A status describes the vault, not the filter.** "Fully synced" has twice
   meant something else: once at cursor 0 with 4,030 local files, once with 13
   files excluded by type. A status that cannot tell "everything is here" from
   "everything I looked at is here" is not a status.

8. **Trust the numbers, not the passes.** Most real bugs here were caught by an
   implausible figure, not a failing assertion. An impossible throughput number
   revealed that two "devices" were the same vault.

9. **A fix without a test that failed first is not finished.** Revert the fix,
   watch the test fail, restore it.

10. **Assertions must check the property that matters.** A conflict test
    asserted that two devices agreed. It passed while one side's edit had
    vanished. Agreement is not the property. Not losing an edit is.

11. **A recovery path tested only in docs is a rumour.** The restore runbook
    read correctly the whole time nothing had run it. It runs on every push
    now, against the built binary, ending in a read-back of every version and
    every body: a restore with a hole in it verifies, starts and serves before
    that step.

## Conflicts: keep both

Obsidian Sync and LiveSync both merge with diff-match-patch. Obsidian discards
the array saying which hunks landed, so a hunk that does not apply is silently
dropped. Basalt uses the same library, abandons the merge if any hunk fails,
and adds the check the library lacks: it compares which spans each side changed
and refuses before applying anything if they overlap. Two devices rewriting one
sentence differently would otherwise "apply" cleanly and produce a sentence
neither wrote. Two additions at the same point on a line boundary are allowed,
because that is two devices adding to one daily note.

When both versions are kept, the incoming one takes the conflict name. Obsidian
puts the local one there and overwrites the file you have open. A sync you did
not ask for should never rewrite the file you are editing.

## Fast, because it sends less

Notes are chunked on a rolling hash and only the chunks the server lacks are
sent. One line inserted into a 2 MiB note costs about 22 KB, most of it the
entry naming the new version's chunks. Chunks are compressed after chunking and
before encryption, which takes a vault's text to well under what the plaintext
would have cost. That order is forced: compressing first would move every
boundary on any edit, and ciphertext does not compress.

Every size and threshold came from a measurement on a real vault. The figures
live in [compared.md](compared.md) with the corpus each was taken on, so there
is one place to correct when they are measured again.

## Simplicity

Every option is something to explain, to get wrong, and to leave untested in
combination. So: the first device enters a server address and a token, every
device after pastes one string, and the panel has status and actions but no
configuration.

A setting earns its place only by surviving three questions. Can another device
tell us? Then it travels in the pairing string. Is there a right answer? Then it
is chosen once in the source. Is it only relevant when something specific
happens? Then it appears in that moment, like the `-allow-origin` hint inside
the error that needs it.

Six more rules: every option must justify its existence; inherit Obsidian's
judgement except where it trades away a note; fail loudly and never report
success you have not verified; the server is an opaque blob store and stays one;
verify against the artifact, never infer; everything is reversible.

One honest note against all of that, raised in review. There is no settings
screen, and there is a settings surface: `-max-file`,
`-max-batch-bytes`, `-max-fetch-bytes`, `-allow-origin`, `-grace`, `-ttl`,
`--ignore`, `--timeout`, the device cap, the retry hints, the debounce, the
full-pass interval. Some are flags, some options, some constants answered once
in the source, and the ones a phone most needs are the ones it can least reach.
Two of those refusals have already been re-litigated by reality: `-allow-origin`
exists because phones exist, `--ignore` because vaults hold things people do
not want synced. The counter is real too: every option multiplies untested
combinations. So the surface stays documented in one place per component rather
than gathered into a screen, and a refusal that keeps losing the same argument
gets amended rather than restated.

## Refusals

No second backend. No peer-to-peer. No teams or shared vaults. No settings
screen. No web UI on the server, because anything it could show you it would
have to read. No merge algorithm of our own. No silent conflict resolution.

## The open one: plugins, themes and config

Obsidian Sync syncs the config folder. Basalt syncs none of it, and unlike the
refusals above this is not settled.

The reason is mechanical. Obsidian holds the config folder in memory and writes
it back, so a file changed underneath the running app is overwritten rather
than read, and a config change from another device would land and be undone.
Beyond that: rule 2 came from exactly this bug; a broken config reaches every
device including the one that still worked, where a note conflict is two
visible files; the pairing secret lives in that folder; and `workspace.json` is
rewritten whenever a pane moves.

Snippets and themes are inert, so a slice limited to those is the one worth
building first. Until then the rule is the same on every device: the config
folder, and any file or folder whose name starts with a dot, never syncs in
either direction. Obsidian's own index does not list dot-prefixed paths, so a
client that accepted one from a peer would write it, fail to see it, and report
it deleted.

## Notes first, and what that costs attachments

Somebody writing prose is the case every decision is made for. Attachments are
supported and not optimised for: chunk sizes were tuned against Markdown,
deduplication does nothing for two photographs, and a large file costs the
sender memory a note never does. Hence a default file limit of 64 MiB rather
than the 256 MiB the format allows, raised by `basaltd serve -max-file`. A
vault that is mostly video wants a file sync.

## Who this is wrong for

Anyone who needs a vault shared with other people, sync without running
anything, storage they already pay for, or a vault that is mostly large binary
files. [Self-hosted LiveSync](https://github.com/vrtmrz/obsidian-livesync)
does all of that and is a better answer.

---

## What the server can and cannot do

The server is the interesting adversary: the one part of the system not on a
device you are holding.

**It cannot read anything.** Note contents and filenames are sealed on the
device. The server holds no key and nothing in it needs one. What it can tell
about the ciphertext is its length, and that two chunks are byte-identical,
which is what deduplication is made of.

**It cannot write anything either.** An early draft sealed the bytes of a file
and left the fields deciding what a client did with them in the clear, so the
server could have set `deleted` on a path, emptied a note by declaring a size
with no chunks, or handed one file another's chunk list. Every entry now
carries an HMAC under a key the server never sees, and a device refuses an
entry it cannot verify. Clients also check what the server used to be trusted
with: an assembled file must match its declared size, the merge ancestor must
match the local `synchash`, a cursor never moves backwards, and a missing limit
means this device's own ceiling rather than no ceiling.

Recovery is held to the same standard. Every entry that history, the deleted
list or a `get` returns is checked against its authenticator before anything is
assembled, and a restore fetches exactly the chunk list the writer signed, so a
server cannot point a restore at another file's content.

That rule is why the server does not stamp its own arrival time on an entry.
`ctime` and `mtime` come from the writing device, are covered by the entry's
authenticator, and are never checked, so a wrong clock writes times that read
oddly in a history list. A timestamp the server writes and the panel prefers
was declined: nothing would cover it, and the person choosing which version to
restore would be reading a field the server chose. It buys nothing anyway,
because history comes back in `uid` order, arrival order by construction,
involving no clock. The server says so instead: a device declaring times more
than a day ahead of the server's own clock is named once per session in the
log, with the offset and the note that ordering is unaffected.

**What it can still do is withhold.** A server can advance a client past
versions it never shows it, because an empty batch over a covered range is also
how a device sees its own write. Nothing detects that. A person notices when
two devices disagree. Detecting it needs a hash chain over the whole log, which
was measured and rejected because a global chain forces concurrent writers to
serialise, one round trip per collision.

**And it can replay.** This used to say withholding was the whole of it, and
that no note is altered. That is not true and the difference matters. The
entry's authenticator covers the content, the metadata and the version this one
was written on top of; it does not cover the uid, because the server assigns
uids and ordering the log is the server's job. So a server can take a version a
device really did write, hand it back under a newer uid, and the receiving
device applies it. The note reverts to contents it genuinely had once, and the
entry that did it verifies, because it is a real entry.

What bounds it: the server cannot invent a version, alter one, or move one
file's chunks onto another, so what it can show is some version of that note
that a device once wrote. A note written on this device since is not reverted,
because the incoming version is then not a continuation of what this device
holds and the ordinary divergence rules keep both. Both are pinned in
`core/landing-races.test.ts`.

What would close it is authenticated ancestry rather than a signed uid.
Signing the server-assigned uid does not work: the server would still choose
which signed entry to present, and a fresh device has nothing to compare
against. The mechanism that does is already half built. Every entry carries a
signed `parent`, the hash of the content its writer built on, and the receiving
device stores nothing with it. Checking that an incoming version's `parent` is
the ancestor this device holds turns a replay into a divergence, which is a
conflict copy rather than a silent revert. It is not implemented, and it is not
complete when it is: a device that has just paired has no ancestor for any
path, so it takes what it is given. Closing that needs a retained checkpoint a
device carries across pairings, which is a protocol change and is not designed
here.

### What a stranger on the port learns

Behind `tailscale serve` the port is private. Behind Caddy it is on the
internet, and an unauthenticated request can reach exactly three things: `GET
/health`, one hello frame before the server decides whether to keep talking,
and the `426` that every other path and method gets, which says `basalt speaks
websocket only`. None of them names the release: `/health` answers one word, the
`426` sends no `Server` header, and a hello refused for its protocol or crypto
names the range the server speaks and not its version. The version is in
`ready`, which only a device holding the vault's auth key receives, and in
`basaltd version` on the machine itself. A version string is where targeted
probing starts.

That is a property rather than three careful strings, and it is tested as one:
a sentinel version is stamped on the server and every pre-auth response,
headers included, is checked for it.

What a stranger can still learn is that a Basalt server is here and which
protocol it speaks, because the refusal has to name the numbers for an old
client to know which end to upgrade, and that the port is up, because a
healthcheck has to say so. Since the healthcheck answers whether the server
could take a note rather than whether the process replied, it can also say one
word about why it could not: `store-unreadable`, `disk-full`,
`chunks-unreachable`, `shutting-down`. That vocabulary is fixed and carries no
path, no vault name and no number, for the same reason as everything else here,
and the figures behind it are in `basaltd stats` on the machine.

### Why the other pre-auth codes stay distinct

`auth` deliberately never says which of the token, the vault, the device row or
the invite was wrong, so the codes beside it look like the same disclosure
wearing a different name: `badname` says the vault id parses, `proto` says how
old this client is, `full` says the server is out of room. Each was checked;
none of them is.

`proto`, `badname`, `protostate` and `badentry` are decided by comparing the
frame against constants published in [protocol.md](protocol.md), before any
credential is looked at and without reading the vault. Collapsing them into
`auth` would cost the thing they exist for: a client that cannot tell `proto`
from `auth` cannot tell somebody which end to upgrade, and one that cannot tell
`badname` from `auth` sends somebody hunting a credential bug over a
65-character device name.

`full` is not reachable without a credential at all. It comes from the device
limit, which is counted inside the transaction that writes the row, after the
invite has been spent, so a redeem carrying an invite nobody issued is refused
by the spend and never reaches the count. A vault at its limit answers a bogus
invite exactly as an empty one does.

The property behind all of that: a pre-auth refusal is a function of the
request, never of the vault. It is tested as one, the way the version property
above is. The same probe goes to a vault this server serves, furnished with
devices, entries and an outstanding invite, and to one it has never heard of,
and the two frames must match byte for byte.

### Why a loopback bind is not the token

The obvious way to remove the first-run token is to let a server bound to
`127.0.0.1` accept an unauthenticated claim, since anything reaching loopback
is already on the machine. Refused, because here loopback is where the proxy
lives. [server.md](server.md#tls) says to bind to `127.0.0.1:3003` behind
`tailscale serve` or Caddy, and the systemd unit does exactly that, so bind
address and peer address are both loopback whether only the tailnet can reach
the port or the whole internet can. A rule keyed on either would hand an
unclaimed vault to whoever asked first. `compose.yaml` muddies it further,
publishing on the host's loopback while the server inside binds a wildcard. The
condition is not too broad and in need of narrowing: it is measuring the wrong
thing.

The token is instead evidence that whoever is claiming can read a file in the
data directory, the only same-machine proof a plain TCP listener has. It is
required on every bind, `-localhost` included. What makes it safe to print in a
log is that spending it is final: the claim binds the vault to that device's
key, and the next claim is refused with `auth` and changes nothing. That is
checked against the running binary, not only against the authenticator.

## The keys

One root secret, 256 random bits, generated on the first device, and one data
key that it wraps. The root derives `auth`, which proves to the server that a
caller may register a device, and `wrap`, which opens the data key. Everything
that touches content derives from the **data key**, with HKDF-SHA256 and one
key per purpose: `path` for filenames; `content` for chunk bodies; `nonce` for
synthetic nonces; `meta` for the entry authenticator. A device also has a
secret of its own, which derives one key and unwraps nothing: the credential it
connects with, of which the server stores only a hash. No password stretching
anywhere, because every one of these is random rather than chosen.
[protocol.md](protocol.md#crypto) has the construction.

The split is what makes the three credentials below separable. A device can be
handed the data key without ever being handed the root, which is what an invite
does, and what makes revoking that device mean something.

Sealing is deterministic: the nonce is an HMAC of the plaintext. Equal paths
must seal equal or the server cannot group versions of a file, and equal chunks
must seal equal or deduplication silently does nothing. The cost is stated: the
server can see that two chunks are identical. The construction is SIV-shaped but
not AES-GCM-SIV, so a nonce collision between distinct plaintexts would be
ordinary GCM nonce reuse. Safety rests on the birthday bound at about 2^48
distinct chunks, roughly 2^66 bytes, which is unreachable for a personal vault
and is a bound rather than an impossibility.

## What a device can do to another device

A paired device holds the vault's data key and a credential of its own, so it
can read and write every note; a buggy or hostile one is inside the trust
boundary for content. What is enforced regardless: a path a client would never
upload is one it will never accept, so a peer cannot write
`.obsidian/plugins/<any>/main.js`; containment is checked against the resolved
filesystem, so a symlink inside the vault cannot lead a write out; and a path
from the wire cannot climb out with `..` or an absolute path.

What a device cannot do is `register` or `rotate`, or show you the recovery
key, because it does not hold the root. The boundary stops there.

It cannot **empty the vault** either. Any device may revoke any other, which is
why revocation exists here rather than only rotation: a phone cuts off a stolen
laptop without anybody finding the recovery key. The last row is the exception,
and the only one: revoking it takes the recovery key, for the reason below.

A device **can** add another device, because it can issue an invite and an
invite registers exactly one row. That is the design rather than a leak: the
recovery key stays offline, so something a device holds has to be able to admit
the next one. The honest boundary is not that a compromised laptop cannot issue
a string and redeem it elsewhere, but that it cannot do so unseen.

An invite used to be the one authority on a vault that nothing could see,
invisible until somebody redeemed it, for up to an hour. Both surfaces now list
every row and every outstanding invite, by identifier and expiry and never the
sealed blob, with when a row was added and last seen. Any device can revoke any
row but the last or cancel any invite, and an unredeemed invite dies on the
next rotation or within the hour regardless. Seeing an identifier redeems
nothing: redeeming also takes the invite key, which never reaches the server.

The other side of that boundary: the recovery key can now read the device list
and take rows off it, where before it could only register and rotate. Two
things forced it. Emptying the vault has to be the recovery key's, and a
refusal naming a credential the server would then also refuse is a dead end
rather than an instruction. And a vault whose eight rows are all pairings that
crashed refuses every registration with no device left to prune it from. The
cost is that a leaked root can stop devices connecting, smaller than it sounds
because a leaked root can already register itself and read everything, and a
rotation retires its power to touch the list at all.

## Three credentials, and who holds which

The separation is the point:

| credential | held by | may |
|---|---|---|
| the root secret, which is the recovery key | nobody: written down, offline | register a device, rewrap the data key, read the device list, take a row off it, cancel an invite |
| a device secret | one device | connect and sync as that device, read the device list, issue and cancel invites, revoke any device but the last |
| the data key | every paired device | read and write content |

The root is used twice in a vault's life: when it is created, and when every
device is gone. **Adding a device is not one of those.** A device that already
has the vault issues a single-use invite, carrying the data key sealed under a
key that travels in the string and never to the server, and redeeming it
registers the new device's own credential. So the recovery key stays written
down, and a stolen laptop cannot register itself again, cannot mint a
credential for anything else, and cannot show anybody the recovery key.

## A lost or stolen device

Revoke it. `basalt devices` lists every device that may reach the vault and
`basalt revoke ID` deletes one's row and closes whatever it has open. No other
device is disturbed: each holds a credential of its own, so there is nothing
shared to retire. That is the cheap, common case, and the one that used to cost
a weekend of re-pairing everything. Any device can do it to any other, which is
the point: the recovery key stays in its drawer.

The exception is the vault's **last** device, which takes the recovery key:
`basalt revoke ID --allow-last --recovery-key basalt3_...`. That one revocation
cannot be undone without the key, since what it leaves is a vault only the key
opens, so it is the one that asks for it. It costs nothing in the case it is
aimed at: if the last device was stolen you want the rotation below as well,
and that needs the key anyway.

**Revoking does not un-read what that device already read.** It still holds the
data key and can decrypt every note it had synced. Revocation stops future
connection, not past knowledge, and any surface that offers it has to say so.

For a device stolen rather than merely lost, and for a recovery key that has
been somewhere it should not have been, rotate as well. The vault's content is
sealed under a data key that the root only wraps, so `basalt rotate` gives the
vault a new root, re-wraps the same data key, and swaps the server's auth hash.
The old key stops working, every outstanding invite is deleted, history stays,
and every device goes on syncing, because a rotation replaces the vault's
credential and touches no device row. The steps are in
[server.md](server.md#rotating-the-vault-secret).

Rotation does not unread what was already read either. Whoever held the old key
could decrypt everything the server held while they had it. Do it anyway if a
recovery key has been in a chat, a screenshot, a shell history, a repository,
or on a device you no longer hold, and check `basalt devices` afterwards for a
row you do not recognise: a rotation deliberately leaves device rows alone.

### What a revoked device can still do

Neither revoking nor rotating takes the **data key** off it, and that is worth
stating on its own rather than leaving it to be inferred from "does not
un-read". The data key is what opens content, it is the same key for the life
of the vault, and rotation replaces the wrapping around it rather than the key
itself.

So a device that has been revoked can still read any ciphertext it gets hold
of afterwards, not only the ciphertext it already had. It cannot get it from
the honest server, which is the whole of what revocation buys. It can get it
from a backup directory, from another device's disk, from a second server
somebody points at the same vault, or off the wire on a hop with no TLS in
front of it. Revocation is an access control on one server; it is not
forward secrecy, and calling it that would be the lie this section exists to
prevent.

Making it forward secrecy means a new data key and re-encrypting the history
under it. That is not implemented, and the reasoning for leaving it out is
under the keys above: it would break history recovery for offline devices,
invalidate deduplication across the epoch boundary, and make every existing
backup unreadable by the new client. For one person's own machines that is a
large, permanent cost against a threat that already implies somebody has the
device in their hand.

### What the authenticator proves, and what it does not

The entry MAC is a shared key, not a per-device signature, and the difference
matters in four ways.

- **Authenticity, yes.** Somebody holding the vault's data key wrote this
  entry, and the server did not.
- **Attribution, no.** It does not say *which* device. `entries.device` is a
  free-text name a device chose for itself and is covered by the MAC, so it
  cannot be altered by the server, and it is still a name rather than an
  identity: two laptops may both be called laptop, and any device holding the
  key can write any name. `basalt devices` identifies devices; history does
  not.
- **Freshness, no.** See what the server can do, above: the uid is not
  covered, so an old entry can be presented as a new one.
- **Completeness, no.** A server can withhold, and nothing detects it.

## Provenance

Every release asset is rebuilt in CI from the tag and attested against the
repository and commit:

```bash
gh attestation verify main.js --repo waynehoover/basalt-sync
gh attestation verify basaltd-linux-amd64 --repo waynehoover/basalt-sync
```

Both builds are reproducible per commit. The lockfile is committed, the two
packages inside the bundles are pinned to exact versions, and the npm package is
published from CI over OIDC with no stored token.

## What is not claimed

- Withholding is not detected.
- iOS is untested. It should work; the phone that has synced a vault was an
  Android.
- A device holding the data key is trusted with content. Revoking it stops it
  connecting and does not un-read what it already read.
- Availability. The server can always refuse to serve. The answer is
  `basaltd backup`.
- TLS. The server speaks plain HTTP and expects `tailscale serve` or a proxy in
  front. No key material lives in this repository.
- A canvas edge whose node the other device deleted. The merge keeps it, the
  file is valid JSON, and Obsidian drops the edge silently on the next save.
  Telling it from one the ancestor already had would need the validity check to
  see both sides and the ancestor. Pinned as a test.
- A write landing between the check and the write it guards, on the plugin.
  A pass decides from a scan, fetches, and then writes, and the editor is in
  use throughout. On the headless client the write itself no longer trusts the
  check: it moves whatever is at the path aside before writing over it and
  keeps anything that was not what the pass decided about, so an edit in that
  gap is preserved rather than predicted. Obsidian's adapter has no way to move
  a file aside atomically, so the plugin reads the bytes it is about to replace
  and compares them: an edit is *seen* wherever it happens, including one that
  keeps the file's length and timestamp, and what it displaces is kept. What
  remains on both is an edit landing between that last look and the write
  itself, which needs a compare-and-swap no adapter here has.
- The whole-file fallback on mobile. The 64 MiB default came off a desktop
  memory curve, so an older phone syncing a large attachment may be killed
  mid-pass: no note is lost, the file never syncs, and the symptom is a dead
  app rather than an error. Never measured on a real device.
