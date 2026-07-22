package sqliteprivacy

import (
	"context"
	"database/sql"
	"fmt"
)

// EnableSecureDelete configures the only connection in a sensitive SQLite
// pool before schema migrations or account data can be written.
func EnableSecureDelete(ctx context.Context, db *sql.DB) error {
	if _, err := db.ExecContext(ctx, `PRAGMA secure_delete=ON`); err != nil {
		return fmt.Errorf("enable secure delete: %w", err)
	}
	var enabled int
	if err := db.QueryRowContext(ctx, `PRAGMA secure_delete`).Scan(&enabled); err != nil {
		return fmt.Errorf("verify secure delete: %w", err)
	}
	if enabled != 1 {
		return fmt.Errorf("verify secure delete: SQLite reported mode %d", enabled)
	}
	return nil
}

// PurgeDeletedData runs only after logical deletion has committed and all
// users of the single-connection pool are quiescent. The first checkpoint
// removes pre-vacuum WAL frames; VACUUM rewrites the main file without free
// pages; the final checkpoint truncates WAL frames produced by VACUUM.
func PurgeDeletedData(ctx context.Context, db *sql.DB) error {
	if err := checkpointAndTruncate(ctx, db); err != nil {
		return fmt.Errorf("checkpoint before vacuum: %w", err)
	}
	if _, err := db.ExecContext(ctx, `VACUUM`); err != nil {
		return fmt.Errorf("vacuum: %w", err)
	}
	if err := checkpointAndTruncate(ctx, db); err != nil {
		return fmt.Errorf("checkpoint after vacuum: %w", err)
	}
	return nil
}

func checkpointAndTruncate(ctx context.Context, db *sql.DB) error {
	var busy, logFrames, checkpointedFrames int
	if err := db.QueryRowContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`).Scan(
		&busy,
		&logFrames,
		&checkpointedFrames,
	); err != nil {
		return err
	}
	if busy != 0 {
		return fmt.Errorf(
			"WAL checkpoint remained busy (log=%d checkpointed=%d)",
			logFrames,
			checkpointedFrames,
		)
	}
	return nil
}
