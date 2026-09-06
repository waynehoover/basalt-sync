package store

import (
	"context"
	"errors"
	"path/filepath"
	"syscall"
	"time"
)

// Health is what can be learned about a store cheaply enough to ask on every
// probe (I17).
//
// The distinction it exists to draw is between a process that answers and a
// server that can still take a note. Those came apart in exactly one way and
// nothing could see it: /health returned "ok" from an http handler that touched
// nothing, so a full disk, a database that had gone read-only, or a chunk
// directory that had lost its mount all looked identical to a healthy server
// for as long as nobody tried to save anything. A monitor cannot alert on that
// and an operator finds out from a phone that will not sync.
//
// Cheap on purpose. One indexed read and one statfs, both of which a probe can
// afford every few seconds; the deep verification lives in `basaltd verify`,
// where it is asked for. A health check that costs real work is a health check
// somebody turns off, and one that walks the store competes with the thing it
// is reporting on.
type Health struct {
	// CanPersist is the one that decides the status code. False means a note
	// arriving now would not be stored.
	CanPersist bool

	// Why is a short machine-readable reason, from a fixed vocabulary, or empty
	// when all is well. Fixed so that a monitor can match on it and so that it
	// never carries a path, a vault name or an error string from the OS.
	Why HealthReason

	// FreeBytes and TotalBytes describe the filesystem holding the store, or
	// zero where it could not be asked. Not reported over the network: a
	// stranger on the port learns nothing from this package, and these are for
	// `basaltd stats` and the log.
	FreeBytes  int64
	TotalBytes int64

	// Took is how long the check itself needed, which is the thing to look at
	// when a probe starts timing out: a store whose fsync has gone slow answers
	// this correctly and slowly, and "correct and slow" is its own failure.
	Took time.Duration
}

// HealthReason is the fixed vocabulary. A monitor matches these; they are part
// of the interface and are not sentences.
type HealthReason string

const (
	HealthOK HealthReason = ""
	// HealthUnreadable is the database not answering a trivial query.
	HealthUnreadable HealthReason = "store-unreadable"
	// HealthNoSpace is a filesystem with no room to write a note into.
	HealthNoSpace HealthReason = "disk-full"
	// HealthNoChunkDir is the body directory gone: an unmounted volume, most
	// likely, which SQLite on another filesystem will not notice at all.
	HealthNoChunkDir HealthReason = "chunks-unreachable"
	// HealthClosing is a server draining its sessions. Set by the server rather
	// than by anything here; it is in this list so the vocabulary is in one
	// place, which is what a monitor matching on it needs.
	HealthClosing HealthReason = "shutting-down"
)

// lowSpaceBytes is the point below which this reports a full disk.
//
// Not zero, because a store that fills completely is one that has already
// failed: SQLite needs room for its write-ahead log and a rollback journal
// before it can commit anything, and a chunk write needs room for the body plus
// the directory entry. Reporting trouble with a little room left is what makes
// the report actionable rather than a post-mortem.
//
// 64 MiB is one maximum fetch, which is a rough stand-in for "enough for the
// work in flight to finish".
const lowSpaceBytes = 64 << 20

// LowSpaceBytes is the threshold, exposed so a test can assert it is not zero
// without this package having to be the one that says why.
func LowSpaceBytes() int64 { return lowSpaceBytes }

// CheckHealth answers whether this store could take a note right now.
//
// The context bounds it: a probe should time out rather than hang, and a
// database whose disk has stopped answering will hang rather than fail.
func (s *Store) CheckHealth(ctx context.Context) Health {
	started := time.Now()
	h := Health{CanPersist: true}
	defer func() { h.Took = time.Since(started) }()

	// The cheapest question that reaches the file: does the database answer.
	// A count would scale with the vault; this touches one page.
	var one int
	if err := s.db.QueryRowContext(ctx, `SELECT 1`).Scan(&one); err != nil || one != 1 {
		h.CanPersist = false
		h.Why = HealthUnreadable
		return h
	}

	// The chunk directory, which is on the same filesystem as the database in
	// every supported layout and is the half that goes missing when a volume
	// unmounts. Statting it answers both questions at once: whether it is
	// there, and how much room is left.
	dir := s.chunks.Root()
	if dir == "" {
		dir = filepath.Dir(s.dbPath)
	}
	var fs syscall.Statfs_t
	if err := syscall.Statfs(dir, &fs); err != nil {
		h.CanPersist = false
		if errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.ENOTDIR) {
			h.Why = HealthNoChunkDir
			return h
		}
		// Something else is wrong with the filesystem and a note is not going
		// to land on it. Reported as unreadable rather than invented into a
		// reason of its own: the vocabulary is fixed and this is not one of it.
		h.Why = HealthUnreadable
		return h
	}
	//nolint:unconvert // Bavail is uint64 on Linux and uint32 on some others.
	h.FreeBytes = int64(fs.Bavail) * int64(fs.Bsize)
	h.TotalBytes = int64(fs.Blocks) * int64(fs.Bsize)
	if h.FreeBytes < lowSpaceBytes {
		h.CanPersist = false
		h.Why = HealthNoSpace
	}
	return h
}
