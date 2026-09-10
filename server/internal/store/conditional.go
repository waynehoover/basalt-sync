package store

import (
	"database/sql"
	"errors"
	"fmt"
)

type headReader interface{ QueryRow(string, ...any) *sql.Row }

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
