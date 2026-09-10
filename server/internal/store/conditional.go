package store

import (
	"database/sql"
	"errors"
	"fmt"
)

type headReader interface{ QueryRow(string, ...any) *sql.Row }

// Queries whose current entry is aliased as e must also account for a rename
// retiring that path. A later incarnation of the path is not retired by an
// older rename, so comparing UIDs is essential.
const notRetiredByRename = `NOT EXISTS (
  SELECT 1 FROM entries moved
   WHERE moved.vault_id = e.vault_id AND moved.prev_path = e.path AND moved.uid > e.uid)`

// The latest record for each path is required for catch-up. A rename can also
// be the current deletion of its source after its destination has been edited
// again. Keep that retirement until a later record occupies its source path.
// Purge and its preview use exactly the same survivor set.
const purgeSurvivorUIDs = `
SELECT MAX(uid) AS uid FROM entries WHERE vault_id = ? GROUP BY path
UNION
SELECT MAX(moved.uid) AS uid FROM entries moved
 WHERE moved.vault_id = ? AND moved.prev_path <> ''
   AND NOT EXISTS (
     SELECT 1 FROM entries newer
      WHERE newer.vault_id = moved.vault_id AND newer.path = moved.prev_path AND newer.uid > moved.uid)
 GROUP BY moved.prev_path`

// A rename is also a tombstone for its previous path at the same UID.
func pathHead(q headReader, vault, path string) (uid int64, deleted bool, err error) {
	var moved int64
	var gone sql.NullBool
	err = q.QueryRow(`SELECT
	  (SELECT COALESCE(MAX(uid), 0) FROM entries WHERE vault_id = ? AND path = ?),
	  (SELECT COALESCE(MAX(uid), 0) FROM entries WHERE vault_id = ? AND prev_path = ?),
	  (SELECT deleted FROM entries WHERE vault_id = ? AND path = ? ORDER BY uid DESC LIMIT 1)`,
		vault, path, vault, path, vault, path).Scan(&uid, &moved, &gone)
	if moved > uid {
		return moved, true, err
	}
	return uid, gone.Bool, err
}

func (s *Store) CurrentUID(vault, path string) (int64, error) {
	uid, _, err := pathHead(s.db, vault, path)
	return uid, err
}

var ErrStale = errors.New("the path changed since this write was prepared; reconcile before retrying")

func ValidateBase(base int64) error {
	if base < 0 || base > 9007199254740991 {
		return fmt.Errorf("%w: base must be a non-negative safe integer", ErrBadEntry)
	}
	return nil
}
