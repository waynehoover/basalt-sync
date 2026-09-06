package store

import (
	"context"
	"strings"
	"testing"
)

/*
 * Health says what it means (R15).
 *
 * The field is called CanPersist and the question asked was `SELECT 1`, which
 * succeeds against a database opened read-only, one whose file has lost write
 * permission, and one on a filesystem the kernel remounted read-only after an
 * I/O error, which is the ordinary way a Linux box reacts to a failing disk.
 * So the one case an operator most needs to hear about read as healthy, and an
 * immediate write then failed with "attempt to write a readonly database".
 *
 * And `Took` was assigned in a deferred function after an unnamed return had
 * already been copied, so every caller received zero: the figure to look at
 * when a probe starts timing out was the one figure guaranteed to be wrong.
 */

func healthOf(t *testing.T, st *Store) Health {
	t.Helper()
	return st.CheckHealth(context.Background())
}

func TestHealthOnAStoreThatWorks(t *testing.T) {
	dbPath, chunkDir := newStore(t)
	st, err := Open(dbPath, chunkDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	h := healthOf(t, st)
	if !h.CanPersist || h.Why != HealthOK {
		t.Fatalf("a working store reported %v, %q", h.CanPersist, h.Why)
	}
	if h.Took <= 0 {
		t.Error("the check reported that it took no time at all, which is the one thing it cannot have")
	}
	if h.TotalBytes <= 0 {
		t.Error("no filesystem figures came back")
	}
}

// The case a read cannot see. A store opened read-only answers `SELECT 1`
// perfectly and cannot take a note.
func TestHealthNoticesAStoreItCannotWriteTo(t *testing.T) {
	dbPath, chunkDir := newStore(t)
	st, err := OpenForInspection(dbPath, chunkDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	// The premise: reads work.
	var one int
	if err := st.db.QueryRow(`SELECT 1`).Scan(&one); err != nil || one != 1 {
		t.Fatalf("the read-only store cannot even read, so this proves nothing: %v", err)
	}
	// And a write does not, which is what health has to notice.
	if err := st.EnsureVault("default", 1000); err == nil {
		t.Fatal("the read-only store took a write, so this proves nothing")
	}

	h := healthOf(t, st)
	if h.CanPersist {
		t.Fatal("a store that cannot be written to reported that it can take a note")
	}
	if h.Why != HealthUnwritable {
		t.Errorf("the reason was %q, wanted %q", h.Why, HealthUnwritable)
	}
	if h.Took <= 0 {
		t.Error("the check reported that it took no time at all")
	}
}

// A closed database is unreadable, and that is a different word from
// unwritable: one is a server that is broken and the other is a disk that has
// gone read-only, and they are fixed differently.
func TestHealthTellsUnreadableFromUnwritable(t *testing.T) {
	dbPath, chunkDir := newStore(t)
	st, err := Open(dbPath, chunkDir)
	if err != nil {
		t.Fatal(err)
	}
	if err := st.Close(); err != nil {
		t.Fatal(err)
	}
	h := healthOf(t, st)
	if h.CanPersist {
		t.Fatal("a closed store reported that it can take a note")
	}
	if h.Why != HealthUnreadable {
		t.Errorf("the reason was %q, wanted %q", h.Why, HealthUnreadable)
	}
}

// The check must not leave anything behind: it is run every few seconds.
func TestHealthWritesNothing(t *testing.T) {
	dbPath, chunkDir := newStore(t)
	st, err := Open(dbPath, chunkDir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	if err := st.EnsureVault("default", 1000); err != nil {
		t.Fatal(err)
	}

	before, err := DatabaseStamp(strings.TrimSuffix(dbPath, "/basalt.db"))
	if err != nil {
		// DataDir layout differs; fall back to hashing the file directly.
		before.Digest, err = fileDigest(dbPath)
		if err != nil {
			t.Fatal(err)
		}
	}
	for range 20 {
		if h := healthOf(t, st); !h.CanPersist {
			t.Fatalf("health failed on a working store: %q", h.Why)
		}
	}
	after, err := fileDigest(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if before.Digest != "" && before.Digest != after {
		t.Error("twenty health checks changed the database")
	}
}
