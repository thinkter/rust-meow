package store

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/rust-meow/rust-meow/backend/internal/domain"
	searchutil "github.com/rust-meow/rust-meow/backend/internal/search"
	"github.com/rust-meow/rust-meow/backend/internal/securefs"
	"github.com/rust-meow/rust-meow/backend/internal/sqliteprivacy"
	_ "modernc.org/sqlite"
)

type Store struct{ db *sql.DB }

const (
	reactionReplaySchemaVersion = 9
	searchSchemaVersion         = 10
	supportedSchemaVersion      = 13
)

type ChatMerge struct {
	OldChatID string
	NewChatID string
}

var (
	ErrReactionRepairNotNeeded      = errors.New("reaction repair is not needed")
	ErrReactionRepairRateLimit      = errors.New("reaction repair is rate limited")
	ErrReactionRepairExhausted      = errors.New("reaction repair attempts exhausted")
	ErrReactionRepairCursorNotReady = errors.New("reaction repair cursor is not ready")
)

func Open(ctx context.Context, path string) (*Store, error) {
	if err := securefs.EnsurePrivateFile(path); err != nil {
		return nil, fmt.Errorf("secure database: %w", err)
	}
	for _, suffix := range []string{"-wal", "-shm"} {
		if err := securefs.RestrictFileIfPresent(path + suffix); err != nil {
			return nil, fmt.Errorf("secure database sidecar: %w", err)
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	db.SetMaxOpenConns(1)
	if err = sqliteprivacy.EnableSecureDelete(ctx, db); err != nil {
		db.Close()
		return nil, fmt.Errorf("configure database privacy: %w", err)
	}
	for _, pragma := range []string{"PRAGMA journal_mode=WAL", "PRAGMA foreign_keys=ON", "PRAGMA busy_timeout=5000", "PRAGMA synchronous=NORMAL"} {
		if _, err = db.ExecContext(ctx, pragma); err != nil {
			db.Close()
			return nil, fmt.Errorf("%s: %w", pragma, err)
		}
	}
	if err = migrate(ctx, db); err != nil {
		db.Close()
		return nil, err
	}
	// FTS5 maintains its own segments, so core PRAGMA secure_delete does not
	// cover deleted search terms. This persistent setting must be enabled before
	// any account writes on both new and already-migrated databases.
	if _, err = db.ExecContext(ctx, `INSERT INTO message_search(message_search,rank) VALUES('secure-delete',1)`); err != nil {
		db.Close()
		return nil, fmt.Errorf("enable secure message search deletion: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) ClearAccountData(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, statement := range []string{`DELETE FROM legacy_reaction_replays`, `DELETE FROM reaction_repair_jobs`, `DELETE FROM outgoing_reactions`, `DELETE FROM outgoing_requests`, `DELETE FROM reactions`, `DELETE FROM messages`, `INSERT INTO message_search(message_search) VALUES('delete-all')`, `DELETE FROM chats`, `DELETE FROM sync_state`, `DELETE FROM sticker_favorites`} {
		if _, err = tx.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("clear account data: %w", err)
		}
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("commit account data clear: %w", err)
	}
	if err = sqliteprivacy.PurgeDeletedData(ctx, s.db); err != nil {
		return fmt.Errorf("purge deleted account data: %w", err)
	}
	return nil
}

func migrate(ctx context.Context, db *sql.DB) error {
	currentVersion := 0
	var hasVersionTable bool
	if err := db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version')`).Scan(&hasVersionTable); err != nil {
		return err
	}
	if hasVersionTable {
		if err := db.QueryRowContext(ctx, `SELECT max(version) FROM schema_version`).Scan(&currentVersion); err == nil && currentVersion > supportedSchemaVersion {
			return fmt.Errorf("database schema version %d is newer than supported version %d", currentVersion, supportedSchemaVersion)
		}
	}
	// v8 deliberately replaces raw-JID chat identity with opaque local
	// conversation IDs. This development build does not attempt a lossy merge
	// of existing account data: log out with the previous build first so its
	// fail-closed account clear leaves an empty product cache.
	if hasVersionTable && currentVersion < 8 {
		var chatCount int64
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM chats`).Scan(&chatCount); err != nil {
			return fmt.Errorf("inspect legacy chat cache: %w", err)
		}
		if chatCount != 0 {
			return fmt.Errorf("client cache reset required: log out with the previous Rust Meow build before upgrading to conversation identities")
		}
		for _, statement := range []string{
			`DROP TABLE IF EXISTS legacy_reaction_replays`, `DROP TABLE IF EXISTS reaction_repair_jobs`,
			`DROP TABLE IF EXISTS outgoing_reactions`, `DROP TABLE IF EXISTS outgoing_requests`,
			`DROP TABLE IF EXISTS reactions`, `DROP TABLE IF EXISTS messages`, `DROP TABLE IF EXISTS chat_redirects`,
			`DROP TABLE IF EXISTS chat_addresses`, `DROP TABLE IF EXISTS chats`, `DROP TABLE IF EXISTS sync_state`,
			`DROP TABLE IF EXISTS schema_version`,
		} {
			if _, err := db.ExecContext(ctx, statement); err != nil {
				return fmt.Errorf("reset empty legacy cache: %w", err)
			}
		}
		currentVersion = 0
	}
	const schema = `
CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL);
INSERT INTO schema_version(version) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM schema_version);
CREATE TABLE IF NOT EXISTS chats(
  jid TEXT PRIMARY KEY,
  preferred_jid TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  last_message_id TEXT NOT NULL DEFAULT '',
  last_message_text TEXT NOT NULL DEFAULT '',
  last_message_at INTEGER NOT NULL DEFAULT 0,
  unread_count INTEGER NOT NULL DEFAULT 0,
  muted_until INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS chats_last_message_idx ON chats(last_message_at DESC, jid DESC);
CREATE TABLE IF NOT EXISTS chat_addresses(
  jid TEXT PRIMARY KEY,
  chat_jid TEXT NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(chat_jid) REFERENCES chats(jid) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS chat_addresses_chat_idx ON chat_addresses(chat_jid);
CREATE TABLE IF NOT EXISTS chat_redirects(
  old_chat_jid TEXT PRIMARY KEY,
  new_chat_jid TEXT NOT NULL,
  FOREIGN KEY(new_chat_jid) REFERENCES chats(jid) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS messages(
  id TEXT NOT NULL,
  chat_jid TEXT NOT NULL,
  transport_jid TEXT NOT NULL,
  sender_jid TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  timestamp INTEGER NOT NULL,
  from_me INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'text',
  reply_to_id TEXT NOT NULL DEFAULT '',
  edited_at INTEGER NOT NULL DEFAULT 0,
  revoked INTEGER NOT NULL DEFAULT 0,
  unread INTEGER NOT NULL DEFAULT 0,
  image_mime TEXT NOT NULL DEFAULT '',
  image_caption TEXT NOT NULL DEFAULT '',
  image_local_path TEXT NOT NULL DEFAULT '',
  image_direct_path TEXT NOT NULL DEFAULT '',
  image_media_key BLOB NOT NULL DEFAULT X'',
  image_file_sha256 BLOB NOT NULL DEFAULT X'',
  image_file_enc_sha256 BLOB NOT NULL DEFAULT X'',
  image_width INTEGER NOT NULL DEFAULT 0,
  image_height INTEGER NOT NULL DEFAULT 0,
  image_size INTEGER NOT NULL DEFAULT 0,
  image_animated INTEGER NOT NULL DEFAULT 0,
  media_file_name TEXT NOT NULL DEFAULT '',
  media_duration INTEGER NOT NULL DEFAULT 0,
  media_voice INTEGER NOT NULL DEFAULT 0,
  contacts_json TEXT NOT NULL DEFAULT '',
  location_lat REAL NOT NULL DEFAULT 0,
  location_lng REAL NOT NULL DEFAULT 0,
  location_name TEXT NOT NULL DEFAULT '',
  location_address TEXT NOT NULL DEFAULT '',
  location_url TEXT NOT NULL DEFAULT '',
  location_live INTEGER NOT NULL DEFAULT 0,
  link_preview_url TEXT NOT NULL DEFAULT '',
  link_preview_title TEXT NOT NULL DEFAULT '',
  link_preview_description TEXT NOT NULL DEFAULT '',
  link_preview_thumbnail BLOB NOT NULL DEFAULT X'',
  link_preview_width INTEGER NOT NULL DEFAULT 0,
  link_preview_height INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(chat_jid, id),
  FOREIGN KEY(chat_jid) REFERENCES chats(jid) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS messages_page_idx ON messages(chat_jid, timestamp DESC, id DESC);
-- Every other messages index leads with chat_jid, so a cross-chat sticker
-- library scan otherwise reads the whole table. This partial index only
-- covers sticker rows, which are a small fraction of most accounts' history.
CREATE INDEX IF NOT EXISTS messages_sticker_idx ON messages(timestamp DESC, id DESC) WHERE kind='sticker';
CREATE TABLE IF NOT EXISTS reactions(
  chat_jid TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender_jid TEXT NOT NULL,
  emoji TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  from_me INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(chat_jid,message_id,sender_jid)
);
CREATE INDEX IF NOT EXISTS reactions_message_idx ON reactions(chat_jid,message_id,timestamp,sender_jid);
CREATE TABLE IF NOT EXISTS polls(
  chat_jid TEXT NOT NULL, message_id TEXT NOT NULL, question TEXT NOT NULL,
  selectable_count INTEGER NOT NULL DEFAULT 1, total_voters INTEGER NOT NULL DEFAULT 0, options_json TEXT NOT NULL,
  snapshot_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(chat_jid,message_id),
  FOREIGN KEY(chat_jid,message_id) REFERENCES messages(chat_jid,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS poll_votes(
  chat_jid TEXT NOT NULL, poll_message_id TEXT NOT NULL, voter_jid TEXT NOT NULL,
  selected_json TEXT NOT NULL, timestamp INTEGER NOT NULL, from_me INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(chat_jid,poll_message_id,voter_jid),
  FOREIGN KEY(chat_jid,poll_message_id) REFERENCES polls(chat_jid,message_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS pinned_messages(
  chat_jid TEXT NOT NULL, message_id TEXT NOT NULL, pinned_at INTEGER NOT NULL, pinned_by TEXT NOT NULL DEFAULT '', pinned INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(chat_jid,message_id), FOREIGN KEY(chat_jid) REFERENCES chats(jid) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS sync_state(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS outgoing_requests(
  client_request_id TEXT PRIMARY KEY,
  chat_jid TEXT NOT NULL,
  text TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS outgoing_reactions(
  client_reaction_id TEXT PRIMARY KEY,
  chat_jid TEXT NOT NULL,
  message_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  completed_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reaction_repair_jobs(
  chat_jid TEXT PRIMARY KEY,
  transport_jid TEXT NOT NULL,
  anchor_message_id TEXT NOT NULL,
  anchor_timestamp INTEGER NOT NULL,
  anchor_from_me INTEGER NOT NULL DEFAULT 0,
  requested_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER NOT NULL DEFAULT 0,
  legacy_reaction_at INTEGER NOT NULL DEFAULT 0,
  legacy_reaction_id TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS legacy_reaction_replays(
  chat_jid TEXT NOT NULL,
  transport_jid TEXT NOT NULL,
  event_message_id TEXT NOT NULL,
  sender_jid TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  from_me INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 0,
  request_id TEXT NOT NULL DEFAULT '',
  requested_at INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(chat_jid,event_message_id)
);
CREATE INDEX IF NOT EXISTS legacy_reaction_replays_request_idx ON legacy_reaction_replays(request_id);
CREATE TABLE IF NOT EXISTS sticker_favorites(
  id TEXT PRIMARY KEY,
  mime_type TEXT NOT NULL DEFAULT '',
  direct_path TEXT NOT NULL DEFAULT '',
  media_key BLOB NOT NULL DEFAULT X'',
  file_enc_sha256 BLOB NOT NULL DEFAULT X'',
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  animated INTEGER NOT NULL DEFAULT 0,
  file_size INTEGER NOT NULL DEFAULT 0,
  local_path TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sticker_favorites_updated_idx ON sticker_favorites(updated_at DESC, id DESC);
`
	if _, err := db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate database: %w", err)
	}
	hasUnread, err := hasColumn(ctx, db, "messages", "unread")
	if err != nil {
		return fmt.Errorf("inspect messages schema: %w", err)
	}
	if !hasUnread {
		if _, err = db.ExecContext(ctx, `ALTER TABLE messages ADD COLUMN unread INTEGER NOT NULL DEFAULT 0`); err != nil {
			return fmt.Errorf("migrate messages to v2: %w", err)
		}
	}
	if _, err = db.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS messages_unread_cursor_idx ON messages(chat_jid,unread,timestamp,id)`); err != nil {
		return fmt.Errorf("create unread cursor index: %w", err)
	}
	hasPollSnapshotAt, err := hasColumn(ctx, db, "polls", "snapshot_at")
	if err != nil {
		return fmt.Errorf("inspect poll snapshot schema: %w", err)
	}
	if !hasPollSnapshotAt {
		if _, err = db.ExecContext(ctx, `ALTER TABLE polls ADD COLUMN snapshot_at INTEGER NOT NULL DEFAULT 0`); err != nil {
			return fmt.Errorf("add poll snapshot timestamp: %w", err)
		}
	}
	mediaColumns := []struct{ name, definition string }{
		{"image_mime", "TEXT NOT NULL DEFAULT ''"},
		{"image_caption", "TEXT NOT NULL DEFAULT ''"},
		{"image_local_path", "TEXT NOT NULL DEFAULT ''"},
		{"image_direct_path", "TEXT NOT NULL DEFAULT ''"},
		{"image_media_key", "BLOB NOT NULL DEFAULT X''"},
		{"image_file_sha256", "BLOB NOT NULL DEFAULT X''"},
		{"image_file_enc_sha256", "BLOB NOT NULL DEFAULT X''"},
		{"image_width", "INTEGER NOT NULL DEFAULT 0"},
		{"image_height", "INTEGER NOT NULL DEFAULT 0"},
		{"image_size", "INTEGER NOT NULL DEFAULT 0"},
		{"image_animated", "INTEGER NOT NULL DEFAULT 0"},
		{"media_file_name", "TEXT NOT NULL DEFAULT ''"},
		{"media_duration", "INTEGER NOT NULL DEFAULT 0"},
		{"media_voice", "INTEGER NOT NULL DEFAULT 0"},
		{"contacts_json", "TEXT NOT NULL DEFAULT ''"},
		{"location_lat", "REAL NOT NULL DEFAULT 0"},
		{"location_lng", "REAL NOT NULL DEFAULT 0"},
		{"location_name", "TEXT NOT NULL DEFAULT ''"},
		{"location_address", "TEXT NOT NULL DEFAULT ''"},
		{"location_url", "TEXT NOT NULL DEFAULT ''"},
		{"location_live", "INTEGER NOT NULL DEFAULT 0"},
		{"link_preview_url", "TEXT NOT NULL DEFAULT ''"},
		{"link_preview_title", "TEXT NOT NULL DEFAULT ''"},
		{"link_preview_description", "TEXT NOT NULL DEFAULT ''"},
		{"link_preview_thumbnail", "BLOB NOT NULL DEFAULT X''"},
		{"link_preview_width", "INTEGER NOT NULL DEFAULT 0"},
		{"link_preview_height", "INTEGER NOT NULL DEFAULT 0"},
	}
	for _, column := range mediaColumns {
		hasMediaColumn, inspectErr := hasColumn(ctx, db, "messages", column.name)
		if inspectErr != nil {
			return fmt.Errorf("inspect image message schema: %w", inspectErr)
		}
		if !hasMediaColumn {
			if _, err = db.ExecContext(ctx, `ALTER TABLE messages ADD COLUMN `+column.name+` `+column.definition); err != nil {
				return fmt.Errorf("add image message column %s: %w", column.name, err)
			}
		}
	}
	hasLegacyReactionAt, err := hasColumn(ctx, db, "reaction_repair_jobs", "legacy_reaction_at")
	if err != nil {
		return fmt.Errorf("inspect reaction repair schema: %w", err)
	}
	if !hasLegacyReactionAt {
		if _, err = db.ExecContext(ctx, `ALTER TABLE reaction_repair_jobs ADD COLUMN legacy_reaction_at INTEGER NOT NULL DEFAULT 0`); err != nil {
			return fmt.Errorf("migrate reaction repairs to v5: %w", err)
		}
	}
	hasLegacyReactionID, err := hasColumn(ctx, db, "reaction_repair_jobs", "legacy_reaction_id")
	if err != nil {
		return fmt.Errorf("inspect reaction repair cursor schema: %w", err)
	}
	if !hasLegacyReactionID {
		if _, err = db.ExecContext(ctx, `ALTER TABLE reaction_repair_jobs ADD COLUMN legacy_reaction_id TEXT NOT NULL DEFAULT ''`); err != nil {
			return fmt.Errorf("add v5 reaction repair cursor id: %w", err)
		}
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if currentVersion < reactionReplaySchemaVersion {
		// v6 preserves every legacy reaction event before the pseudo-message rows
		// are deleted. These exact event IDs can be re-requested from the primary.
		if _, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO legacy_reaction_replays(chat_jid,transport_jid,event_message_id,sender_jid,timestamp,from_me)
	SELECT chat_jid,transport_jid,id,sender_jid,timestamp,from_me FROM messages WHERE kind='reaction'`); err != nil {
			return fmt.Errorf("preserve legacy reaction events: %w", err)
		}
		// Preserve one real WhatsApp reaction-event anchor per affected chat before
		// removing the old pseudo-message representation. Asking the primary for the
		// 50 messages immediately before this anchor recovers target-message reaction
		// aggregates without scanning unrelated chats.
		if _, err = tx.ExecContext(ctx, `INSERT OR IGNORE INTO reaction_repair_jobs(chat_jid,transport_jid,anchor_message_id,anchor_timestamp,anchor_from_me,legacy_reaction_at,legacy_reaction_id)
	SELECT m.chat_jid,m.transport_jid,m.id,m.timestamp,m.from_me,m.timestamp,m.id FROM messages m
	WHERE m.kind='reaction' AND NOT EXISTS (
  SELECT 1 FROM messages newer WHERE newer.chat_jid=m.chat_jid AND newer.kind='reaction'
    AND (newer.timestamp>m.timestamp OR (newer.timestamp=m.timestamp AND newer.id>m.id))
)`); err != nil {
			return fmt.Errorf("record legacy reaction repair jobs: %w", err)
		}
		if _, err = tx.ExecContext(ctx, `UPDATE reaction_repair_jobs SET
	legacy_reaction_at=CASE WHEN legacy_reaction_at=0 THEN anchor_timestamp ELSE legacy_reaction_at END,
	legacy_reaction_id=CASE WHEN legacy_reaction_id='' THEN anchor_message_id ELSE legacy_reaction_id END
	WHERE legacy_reaction_at=0 OR legacy_reaction_id=''`); err != nil {
			return fmt.Errorf("backfill legacy reaction repair timestamps: %w", err)
		}
		// Use the first visible message after the legacy reaction span as the peer
		// history cursor. It is accepted by the primary and keeps the bounded
		// 50-message page centered on the affected targets. An earlier cursor is not
		// a safe fallback because the peer history request is exclusive and would
		// omit that cursor message itself. Leave the cursor empty until a later
		// visible message exists; BeginReactionRepair will adopt one dynamically.
		if _, err = tx.ExecContext(ctx, `UPDATE reaction_repair_jobs SET
	anchor_message_id=COALESCE(
	  (SELECT id FROM messages WHERE chat_jid=reaction_repair_jobs.chat_jid AND kind<>'reaction' AND (timestamp>reaction_repair_jobs.legacy_reaction_at OR (timestamp=reaction_repair_jobs.legacy_reaction_at AND id>reaction_repair_jobs.legacy_reaction_id)) ORDER BY timestamp ASC,id ASC LIMIT 1),
	  ''),
	anchor_timestamp=COALESCE(
	  (SELECT timestamp FROM messages WHERE chat_jid=reaction_repair_jobs.chat_jid AND kind<>'reaction' AND (timestamp>reaction_repair_jobs.legacy_reaction_at OR (timestamp=reaction_repair_jobs.legacy_reaction_at AND id>reaction_repair_jobs.legacy_reaction_id)) ORDER BY timestamp ASC,id ASC LIMIT 1),
	  0),
	anchor_from_me=COALESCE(
	  (SELECT from_me FROM messages WHERE chat_jid=reaction_repair_jobs.chat_jid AND kind<>'reaction' AND (timestamp>reaction_repair_jobs.legacy_reaction_at OR (timestamp=reaction_repair_jobs.legacy_reaction_at AND id>reaction_repair_jobs.legacy_reaction_id)) ORDER BY timestamp ASC,id ASC LIMIT 1),
	  0)`); err != nil {
			return fmt.Errorf("select visible reaction repair cursors: %w", err)
		}
		if currentVersion < 5 {
			if _, err = tx.ExecContext(ctx, `UPDATE reaction_repair_jobs SET requested_at=0,attempts=0,completed_at=0`); err != nil {
				return fmt.Errorf("reset v5 reaction repair jobs: %w", err)
			}
		}
		if currentVersion < 6 {
			if _, err = tx.ExecContext(ctx, `UPDATE reaction_repair_jobs SET requested_at=0,attempts=0,completed_at=0 WHERE chat_jid IN (SELECT DISTINCT chat_jid FROM legacy_reaction_replays)`); err != nil {
				return fmt.Errorf("reset targeted v6 reaction repairs: %w", err)
			}
		}
		if _, err = tx.ExecContext(ctx, `DELETE FROM messages WHERE kind='reaction'`); err != nil {
			return fmt.Errorf("remove legacy reaction messages: %w", err)
		}
		if _, err = tx.ExecContext(ctx, `UPDATE chats SET
last_message_id=COALESCE((SELECT id FROM messages WHERE chat_jid=chats.jid ORDER BY timestamp DESC,id DESC LIMIT 1),''),
last_message_text=COALESCE((SELECT text FROM messages WHERE chat_jid=chats.jid ORDER BY timestamp DESC,id DESC LIMIT 1),''),
last_message_at=COALESCE((SELECT timestamp FROM messages WHERE chat_jid=chats.jid ORDER BY timestamp DESC,id DESC LIMIT 1),0),
unread_count=(SELECT count(*) FROM messages WHERE chat_jid=chats.jid AND unread=1)`); err != nil {
			return fmt.Errorf("repair chat metadata after reaction cleanup: %w", err)
		}
		if _, err = tx.ExecContext(ctx, `UPDATE schema_version SET version=?`, reactionReplaySchemaVersion); err != nil {
			return fmt.Errorf("record schema v9: %w", err)
		}
	}
	if currentVersion < searchSchemaVersion {
		const searchSchema = `
CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(
  text, image_caption, media_file_name, contacts_json, location_name, location_address,
  content='messages', content_rowid='rowid', tokenize='trigram', detail='none'
);
CREATE TRIGGER IF NOT EXISTS message_search_ai AFTER INSERT ON messages BEGIN
  INSERT INTO message_search(rowid,text,image_caption,media_file_name,contacts_json,location_name,location_address)
  VALUES(new.rowid,new.text,new.image_caption,new.media_file_name,new.contacts_json,new.location_name,new.location_address);
END;
CREATE TRIGGER IF NOT EXISTS message_search_ad AFTER DELETE ON messages BEGIN
  INSERT INTO message_search(message_search,rowid,text,image_caption,media_file_name,contacts_json,location_name,location_address)
  VALUES('delete',old.rowid,old.text,old.image_caption,old.media_file_name,old.contacts_json,old.location_name,old.location_address);
END;
CREATE TRIGGER IF NOT EXISTS message_search_au AFTER UPDATE OF text,image_caption,media_file_name,contacts_json,location_name,location_address ON messages BEGIN
  INSERT INTO message_search(message_search,rowid,text,image_caption,media_file_name,contacts_json,location_name,location_address)
  VALUES('delete',old.rowid,old.text,old.image_caption,old.media_file_name,old.contacts_json,old.location_name,old.location_address);
  INSERT INTO message_search(rowid,text,image_caption,media_file_name,contacts_json,location_name,location_address)
  VALUES(new.rowid,new.text,new.image_caption,new.media_file_name,new.contacts_json,new.location_name,new.location_address);
END;`
		if _, err = tx.ExecContext(ctx, searchSchema); err != nil {
			return fmt.Errorf("create message search index: %w", err)
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO message_search(message_search,rank) VALUES('secure-delete',1)`); err != nil {
			return fmt.Errorf("enable secure message search deletion: %w", err)
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO message_search(message_search) VALUES('rebuild')`); err != nil {
			return fmt.Errorf("backfill message search index: %w", err)
		}
		if _, err = tx.ExecContext(ctx, `UPDATE schema_version SET version=?`, searchSchemaVersion); err != nil {
			return fmt.Errorf("record schema v10: %w", err)
		}
		currentVersion = searchSchemaVersion
	}
	if currentVersion < supportedSchemaVersion {
		if _, err = tx.ExecContext(ctx, `UPDATE schema_version SET version=?`, supportedSchemaVersion); err != nil {
			return fmt.Errorf("record schema v12: %w", err)
		}
	}
	return tx.Commit()
}

func hasColumn(ctx context.Context, db *sql.DB, table, column string) (bool, error) {
	rows, err := db.QueryContext(ctx, `PRAGMA table_info(`+table+`)`)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, kind string
		var notNull, pk int
		var defaultValue any
		if err = rows.Scan(&cid, &name, &kind, &notNull, &defaultValue, &pk); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}

func clampLimit(limit int) int {
	if limit <= 0 {
		return 50
	}
	if limit > 200 {
		return 200
	}
	return limit
}

func encodeCursor(ts int64, id string) string {
	return base64.RawURLEncoding.EncodeToString([]byte(strconv.FormatInt(ts, 10) + "\x00" + id))
}

func decodeCursor(value string) (int64, string, error) {
	if value == "" {
		return 1 << 62, "\U0010ffff", nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return 0, "", err
	}
	parts := strings.SplitN(string(raw), "\x00", 2)
	if len(parts) != 2 {
		return 0, "", errors.New("invalid cursor")
	}
	ts, err := strconv.ParseInt(parts[0], 10, 64)
	return ts, parts[1], err
}

func newChatID() string { return "c:" + uuid.NewString() }

func isLID(jid string) bool { return strings.HasSuffix(jid, "@lid") }

func resolveChatTx(ctx context.Context, tx *sql.Tx, value string) (string, error) {
	var id string
	err := tx.QueryRowContext(ctx, `SELECT jid FROM chats WHERE jid=?`, value).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	err = tx.QueryRowContext(ctx, `SELECT chat_jid FROM chat_addresses WHERE jid=?`, value).Scan(&id)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	err = tx.QueryRowContext(ctx, `SELECT new_chat_jid FROM chat_redirects WHERE old_chat_jid=?`, value).Scan(&id)
	return id, err
}

func resolveOrCreateChatTx(ctx context.Context, tx *sql.Tx, value string) (string, error) {
	id, err := resolveChatTx(ctx, tx, value)
	if err == nil {
		return id, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	id = newChatID()
	if _, err = tx.ExecContext(ctx, `INSERT INTO chats(jid,preferred_jid) VALUES(?,?)`, id, value); err != nil {
		return "", err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO chat_addresses(jid,chat_jid,last_seen_at) VALUES(?,?,?)`, value, id, time.Now().UnixMilli()); err != nil {
		return "", err
	}
	return id, nil
}

func (s *Store) ResolveChat(ctx context.Context, value string) (string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	id, err := resolveChatTx(ctx, tx, value)
	if err != nil {
		return "", err
	}
	return id, tx.Commit()
}

func (s *Store) PreferredJID(ctx context.Context, value string) (string, error) {
	id, err := s.ResolveChat(ctx, value)
	if err != nil {
		return "", err
	}
	var jid string
	err = s.db.QueryRowContext(ctx, `SELECT preferred_jid FROM chats WHERE jid=?`, id).Scan(&jid)
	return jid, err
}

// ConversationAddresses returns every WhatsApp address currently bound to a
// logical conversation. The preferred transport address is first so callers
// can use the remaining entries as identity/profile fallbacks without making
// raw JIDs the user-visible chat identity again.
func (s *Store) ConversationAddresses(ctx context.Context, value string) ([]string, error) {
	id, err := s.ResolveChat(ctx, value)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT a.jid FROM chat_addresses a JOIN chats c ON c.jid=a.chat_jid
WHERE a.chat_jid=? ORDER BY CASE WHEN a.jid=c.preferred_jid THEN 0 WHEN a.jid LIKE '%@lid' THEN 1 ELSE 2 END,a.last_seen_at DESC,a.jid`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	addresses := make([]string, 0, 2)
	for rows.Next() {
		var address string
		if err = rows.Scan(&address); err != nil {
			return nil, err
		}
		addresses = append(addresses, address)
	}
	return addresses, rows.Err()
}

// ConversationAddressesForChats returns presentation addresses for a page of
// opaque chat IDs with one query. Callers must pass canonical IDs obtained from
// this store; unlike ConversationAddresses, this page-oriented method does not
// resolve aliases one at a time.
func (s *Store) ConversationAddressesForChats(ctx context.Context, chatIDs []string) (map[string][]string, error) {
	addresses := make(map[string][]string, len(chatIDs))
	unique := make([]string, 0, len(chatIDs))
	for _, chatID := range chatIDs {
		if chatID == "" {
			continue
		}
		if _, exists := addresses[chatID]; exists {
			continue
		}
		addresses[chatID] = nil
		unique = append(unique, chatID)
	}
	if len(unique) == 0 {
		return addresses, nil
	}
	args := make([]any, len(unique))
	for i := range unique {
		args[i] = unique[i]
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(unique)), ",")
	rows, err := s.db.QueryContext(ctx, `SELECT a.chat_jid,a.jid FROM chat_addresses a JOIN chats c ON c.jid=a.chat_jid
WHERE a.chat_jid IN (`+placeholders+`) ORDER BY a.chat_jid,CASE WHEN a.jid=c.preferred_jid THEN 0 WHEN a.jid LIKE '%@lid' THEN 1 ELSE 2 END,a.last_seen_at DESC,a.jid`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var chatID, address string
		if err = rows.Scan(&chatID, &address); err != nil {
			return nil, err
		}
		addresses[chatID] = append(addresses[chatID], address)
	}
	return addresses, rows.Err()
}

func (s *Store) ConversationAddressMap(ctx context.Context) (map[string]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT jid,chat_jid FROM chat_addresses`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	addresses := make(map[string]string)
	for rows.Next() {
		var address, chatID string
		if err = rows.Scan(&address, &chatID); err != nil {
			return nil, err
		}
		addresses[address] = chatID
	}
	return addresses, rows.Err()
}

// EnsureConversation binds all known WhatsApp addresses to one opaque local
// chat ID. LID-backed conversations win when previously separate provisional
// PN and LID conversations become linkable.
func (s *Store) EnsureConversation(ctx context.Context, addresses ...string) (string, []ChatMerge, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", nil, err
	}
	defer tx.Rollback()
	unique := make([]string, 0, len(addresses))
	seenAddress := make(map[string]bool, len(addresses))
	for _, address := range addresses {
		if address != "" && !seenAddress[address] {
			seenAddress[address] = true
			unique = append(unique, address)
		}
	}
	if len(unique) == 0 {
		return "", nil, fmt.Errorf("at least one chat address is required")
	}
	type candidate struct{ id, preferred string }
	candidates := make(map[string]candidate)
	for _, address := range unique {
		var candidateID, preferred string
		err = tx.QueryRowContext(ctx, `SELECT jid,preferred_jid FROM chats WHERE jid=?`, address).Scan(&candidateID, &preferred)
		if errors.Is(err, sql.ErrNoRows) {
			err = tx.QueryRowContext(ctx, `SELECT c.jid,c.preferred_jid FROM chat_addresses a JOIN chats c ON c.jid=a.chat_jid WHERE a.jid=?`, address).Scan(&candidateID, &preferred)
		}
		if err == nil {
			candidates[candidateID] = candidate{candidateID, preferred}
		} else if !errors.Is(err, sql.ErrNoRows) {
			return "", nil, err
		}
	}
	var winner string
	for _, address := range unique {
		if !isLID(address) {
			continue
		}
		for _, candidate := range candidates {
			if candidate.preferred == address {
				winner = candidate.id
				break
			}
		}
	}
	if winner == "" {
		for id := range candidates {
			winner = id
			break
		}
	}
	preferred := ""
	if winner != "" {
		preferred = candidates[winner].preferred
	}
	for _, address := range unique {
		if isLID(address) {
			preferred = address
			break
		}
	}
	if preferred == "" {
		preferred = unique[0]
	}
	if winner == "" {
		winner = newChatID()
		if _, err = tx.ExecContext(ctx, `INSERT INTO chats(jid,preferred_jid) VALUES(?,?)`, winner, preferred); err != nil {
			return "", nil, err
		}
	}
	var merges []ChatMerge
	for loser := range candidates {
		if loser == winner {
			continue
		}
		// A PN may be reassigned to a different LID over time. Never merge two
		// already-LID-backed conversations merely because they temporarily share
		// that mutable phone alias; the address binding below moves only the PN.
		loserPreferred := candidates[loser].preferred
		winnerPreferred := candidates[winner].preferred
		if isLID(loserPreferred) && isLID(winnerPreferred) && loserPreferred != winnerPreferred {
			continue
		}
		if err = mergeChatsTx(ctx, tx, loser, winner); err != nil {
			return "", nil, err
		}
		merges = append(merges, ChatMerge{OldChatID: loser, NewChatID: winner})
	}
	if _, err = tx.ExecContext(ctx, `UPDATE chats SET preferred_jid=? WHERE jid=?`, preferred, winner); err != nil {
		return "", nil, err
	}
	now := time.Now().UnixMilli()
	for _, address := range unique {
		if _, err = tx.ExecContext(ctx, `INSERT INTO chat_addresses(jid,chat_jid,last_seen_at) VALUES(?,?,?) ON CONFLICT(jid) DO UPDATE SET chat_jid=excluded.chat_jid,last_seen_at=excluded.last_seen_at`, address, winner, now); err != nil {
			return "", nil, err
		}
	}
	return winner, merges, tx.Commit()
}

func mergeChatsTx(ctx context.Context, tx *sql.Tx, loser, winner string) error {
	if loser == winner {
		return nil
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO messages(id,chat_jid,transport_jid,sender_jid,text,timestamp,from_me,status,kind,reply_to_id,edited_at,revoked,unread,
image_mime,image_caption,image_local_path,image_direct_path,image_media_key,image_file_sha256,image_file_enc_sha256,image_width,image_height,image_size,
image_animated,media_file_name,media_duration,media_voice,contacts_json,location_lat,location_lng,location_name,location_address,location_url,location_live,
link_preview_url,link_preview_title,link_preview_description,link_preview_thumbnail,link_preview_width,link_preview_height)
SELECT id,?,transport_jid,sender_jid,text,timestamp,from_me,status,kind,reply_to_id,edited_at,revoked,unread,
image_mime,image_caption,image_local_path,image_direct_path,image_media_key,image_file_sha256,image_file_enc_sha256,image_width,image_height,image_size,
image_animated,media_file_name,media_duration,media_voice,contacts_json,location_lat,location_lng,location_name,location_address,location_url,location_live,
link_preview_url,link_preview_title,link_preview_description,link_preview_thumbnail,link_preview_width,link_preview_height
FROM messages WHERE chat_jid=? AND true
ON CONFLICT(chat_jid,id) DO UPDATE SET
transport_jid=CASE WHEN excluded.transport_jid LIKE '%@lid' OR messages.transport_jid='' THEN excluded.transport_jid ELSE messages.transport_jid END,
sender_jid=excluded.sender_jid,timestamp=max(messages.timestamp,excluded.timestamp),from_me=excluded.from_me,
status=CASE WHEN excluded.status=5 AND messages.status<=1 THEN 5 WHEN excluded.status=5 THEN messages.status WHEN messages.status=5 THEN excluded.status ELSE max(messages.status,excluded.status) END,
kind=excluded.kind,reply_to_id=excluded.reply_to_id,
text=CASE WHEN excluded.edited_at>=messages.edited_at THEN excluded.text ELSE messages.text END,
edited_at=max(messages.edited_at,excluded.edited_at),revoked=(messages.revoked OR excluded.revoked),unread=(messages.unread OR excluded.unread),
image_mime=CASE WHEN excluded.image_mime<>'' THEN excluded.image_mime ELSE messages.image_mime END,
image_caption=CASE WHEN excluded.image_caption<>'' THEN excluded.image_caption ELSE messages.image_caption END,
image_local_path=CASE WHEN excluded.image_local_path<>'' THEN excluded.image_local_path ELSE messages.image_local_path END,
image_direct_path=CASE WHEN excluded.image_direct_path<>'' THEN excluded.image_direct_path ELSE messages.image_direct_path END,
image_media_key=CASE WHEN length(excluded.image_media_key)>0 THEN excluded.image_media_key ELSE messages.image_media_key END,
image_file_sha256=CASE WHEN length(excluded.image_file_sha256)>0 THEN excluded.image_file_sha256 ELSE messages.image_file_sha256 END,
image_file_enc_sha256=CASE WHEN length(excluded.image_file_enc_sha256)>0 THEN excluded.image_file_enc_sha256 ELSE messages.image_file_enc_sha256 END,
image_width=max(messages.image_width,excluded.image_width),image_height=max(messages.image_height,excluded.image_height),image_size=max(messages.image_size,excluded.image_size),
image_animated=(messages.image_animated OR excluded.image_animated),media_file_name=CASE WHEN excluded.media_file_name<>'' THEN excluded.media_file_name ELSE messages.media_file_name END,
media_duration=max(messages.media_duration,excluded.media_duration),media_voice=(messages.media_voice OR excluded.media_voice),
contacts_json=CASE WHEN excluded.contacts_json<>'' THEN excluded.contacts_json ELSE messages.contacts_json END,
location_lat=CASE WHEN excluded.kind='location' THEN excluded.location_lat ELSE messages.location_lat END,
location_lng=CASE WHEN excluded.kind='location' THEN excluded.location_lng ELSE messages.location_lng END,
location_name=CASE WHEN excluded.location_name<>'' THEN excluded.location_name ELSE messages.location_name END,
location_address=CASE WHEN excluded.location_address<>'' THEN excluded.location_address ELSE messages.location_address END,
location_url=CASE WHEN excluded.location_url<>'' THEN excluded.location_url ELSE messages.location_url END,
location_live=(messages.location_live OR excluded.location_live),
link_preview_url=CASE WHEN excluded.link_preview_url<>'' THEN excluded.link_preview_url ELSE messages.link_preview_url END,
link_preview_title=CASE WHEN excluded.link_preview_title<>'' THEN excluded.link_preview_title ELSE messages.link_preview_title END,
link_preview_description=CASE WHEN excluded.link_preview_description<>'' THEN excluded.link_preview_description ELSE messages.link_preview_description END,
link_preview_thumbnail=CASE WHEN length(excluded.link_preview_thumbnail)>0 THEN excluded.link_preview_thumbnail ELSE messages.link_preview_thumbnail END,
link_preview_width=max(messages.link_preview_width,excluded.link_preview_width),link_preview_height=max(messages.link_preview_height,excluded.link_preview_height)`, winner, loser); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO polls(chat_jid,message_id,question,selectable_count,total_voters,options_json,snapshot_at) SELECT ?,message_id,question,selectable_count,total_voters,options_json,snapshot_at FROM polls WHERE chat_jid=? ON CONFLICT(chat_jid,message_id) DO UPDATE SET question=excluded.question,selectable_count=excluded.selectable_count,total_voters=excluded.total_voters,options_json=excluded.options_json,snapshot_at=excluded.snapshot_at WHERE excluded.snapshot_at>=polls.snapshot_at`, winner, loser); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO poll_votes(chat_jid,poll_message_id,voter_jid,selected_json,timestamp,from_me)
SELECT ?,v.poll_message_id,v.voter_jid,v.selected_json,v.timestamp,v.from_me FROM poll_votes v
WHERE v.chat_jid=? AND v.timestamp>COALESCE((SELECT p.snapshot_at FROM polls p WHERE p.chat_jid=? AND p.message_id=v.poll_message_id),0)
ON CONFLICT(chat_jid,poll_message_id,voter_jid) DO UPDATE SET selected_json=excluded.selected_json,timestamp=excluded.timestamp,from_me=excluded.from_me WHERE excluded.timestamp>=poll_votes.timestamp`, winner, loser, winner); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO pinned_messages(chat_jid,message_id,pinned_at,pinned_by,pinned) SELECT ?,message_id,pinned_at,pinned_by,pinned FROM pinned_messages WHERE chat_jid=? ON CONFLICT(chat_jid,message_id) DO UPDATE SET pinned_at=excluded.pinned_at,pinned_by=excluded.pinned_by,pinned=excluded.pinned WHERE excluded.pinned_at>=pinned_messages.pinned_at`, winner, loser); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM messages WHERE chat_jid=?`, loser); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO reactions(chat_jid,message_id,sender_jid,emoji,timestamp,from_me)
SELECT ?,message_id,sender_jid,emoji,timestamp,from_me FROM reactions WHERE chat_jid=? AND true
ON CONFLICT(chat_jid,message_id,sender_jid) DO UPDATE SET emoji=excluded.emoji,timestamp=excluded.timestamp,from_me=excluded.from_me WHERE excluded.timestamp>=reactions.timestamp`, winner, loser); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM reactions WHERE chat_jid=?`, loser); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM reactions AS stale
WHERE stale.chat_jid=? AND stale.from_me=1 AND EXISTS (
  SELECT 1 FROM reactions AS newer
  WHERE newer.chat_jid=stale.chat_jid AND newer.message_id=stale.message_id AND newer.from_me=1
    AND (newer.timestamp>stale.timestamp OR (newer.timestamp=stale.timestamp AND newer.rowid>stale.rowid))
)`, winner); err != nil {
		return err
	}
	for _, table := range []string{"outgoing_requests", "outgoing_reactions"} {
		if _, err := tx.ExecContext(ctx, `UPDATE `+table+` SET chat_jid=? WHERE chat_jid=?`, winner, loser); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO legacy_reaction_replays(chat_jid,transport_jid,event_message_id,sender_jid,timestamp,from_me,status,request_id,requested_at,attempts,completed_at)
SELECT ?,transport_jid,event_message_id,sender_jid,timestamp,from_me,status,request_id,requested_at,attempts,completed_at FROM legacy_reaction_replays WHERE chat_jid=?`, winner, loser); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM legacy_reaction_replays WHERE chat_jid=?`, loser); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO reaction_repair_jobs(chat_jid,transport_jid,anchor_message_id,anchor_timestamp,anchor_from_me,requested_at,attempts,completed_at,legacy_reaction_at,legacy_reaction_id)
SELECT ?,transport_jid,anchor_message_id,anchor_timestamp,anchor_from_me,requested_at,attempts,completed_at,legacy_reaction_at,legacy_reaction_id FROM reaction_repair_jobs WHERE chat_jid=?`, winner, loser); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM reaction_repair_jobs WHERE chat_jid=?`, loser); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE chat_addresses SET chat_jid=? WHERE chat_jid=?`, winner, loser); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT OR REPLACE INTO chat_redirects(old_chat_jid,new_chat_jid) VALUES(?,?)`, loser, winner); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE chat_redirects SET new_chat_jid=? WHERE new_chat_jid=?`, winner, loser); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE chats SET
name=CASE WHEN name='' THEN (SELECT name FROM chats WHERE jid=?) ELSE name END,
muted_until=max(muted_until,(SELECT muted_until FROM chats WHERE jid=?)),
archived=CASE WHEN (SELECT last_message_at FROM chats WHERE jid=?)>last_message_at THEN (SELECT archived FROM chats WHERE jid=?) ELSE archived END
WHERE jid=?`, loser, loser, loser, loser, winner); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM chats WHERE jid=?`, loser); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `UPDATE chats SET
last_message_id=COALESCE((SELECT id FROM messages WHERE chat_jid=? ORDER BY timestamp DESC,id DESC LIMIT 1),''),
last_message_text=COALESCE((SELECT text FROM messages WHERE chat_jid=? ORDER BY timestamp DESC,id DESC LIMIT 1),''),
last_message_at=COALESCE((SELECT timestamp FROM messages WHERE chat_jid=? ORDER BY timestamp DESC,id DESC LIMIT 1),0),
unread_count=(SELECT count(*) FROM messages WHERE chat_jid=? AND unread=1)
WHERE jid=?`, winner, winner, winner, winner, winner)
	return err
}

func (s *Store) ChatCount(ctx context.Context) (int64, error) {
	var n int64
	err := s.db.QueryRowContext(ctx, "SELECT count(*) FROM chats").Scan(&n)
	return n, err
}

func (s *Store) Chat(ctx context.Context, jid string) (domain.Chat, error) {
	var c domain.Chat
	var timestamp, muted int64
	id, err := s.ResolveChat(ctx, jid)
	if err != nil {
		return c, err
	}
	err = s.db.QueryRowContext(ctx, `SELECT jid,preferred_jid,name,last_message_id,last_message_text,last_message_at,unread_count,muted_until,archived FROM chats WHERE jid=?`, id).
		Scan(&c.JID, &c.AddressJID, &c.Name, &c.LastMessageID, &c.LastMessageText, &timestamp, &c.UnreadCount, &muted, &c.Archived)
	c.LastMessageAt = unixMilli(timestamp)
	c.MutedUntil = unixMilli(muted)
	return c, err
}

func (s *Store) Chats(ctx context.Context, cursor string, limit int) (domain.Page[domain.Chat], error) {
	ts, id, err := decodeCursor(cursor)
	if err != nil {
		return domain.Page[domain.Chat]{}, fmt.Errorf("decode cursor: %w", err)
	}
	limit = clampLimit(limit)
	rows, err := s.db.QueryContext(ctx, `SELECT jid,preferred_jid,name,last_message_id,last_message_text,last_message_at,unread_count,muted_until,archived
FROM chats WHERE (last_message_at < ? OR (last_message_at = ? AND jid < ?)) ORDER BY last_message_at DESC,jid DESC LIMIT ?`, ts, ts, id, limit+1)
	if err != nil {
		return domain.Page[domain.Chat]{}, err
	}
	defer rows.Close()
	page := domain.Page[domain.Chat]{Items: make([]domain.Chat, 0, limit)}
	var lastTS int64
	for rows.Next() {
		var c domain.Chat
		var timestamp, muted int64
		if err := rows.Scan(&c.JID, &c.AddressJID, &c.Name, &c.LastMessageID, &c.LastMessageText, &timestamp, &c.UnreadCount, &muted, &c.Archived); err != nil {
			return page, err
		}
		if len(page.Items) == limit {
			page.NextCursor = encodeCursor(lastTS, page.Items[len(page.Items)-1].JID)
			break
		}
		lastTS = timestamp
		c.LastMessageAt = unixMilli(timestamp)
		c.MutedUntil = unixMilli(muted)
		page.Items = append(page.Items, c)
	}
	return page, rows.Err()
}

func (s *Store) Groups(ctx context.Context) ([]domain.Chat, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT jid,preferred_jid,name,last_message_id,last_message_text,last_message_at,unread_count,muted_until,archived
FROM chats WHERE preferred_jid LIKE '%@g.us' ORDER BY last_message_at DESC,jid DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	groups := make([]domain.Chat, 0)
	for rows.Next() {
		var chat domain.Chat
		var timestamp, muted int64
		if err = rows.Scan(&chat.JID, &chat.AddressJID, &chat.Name, &chat.LastMessageID, &chat.LastMessageText, &timestamp, &chat.UnreadCount, &muted, &chat.Archived); err != nil {
			return nil, err
		}
		chat.LastMessageAt = unixMilli(timestamp)
		chat.MutedUntil = unixMilli(muted)
		groups = append(groups, chat)
	}
	return groups, rows.Err()
}

func (s *Store) SearchMessages(ctx context.Context, query string, limit int) ([]domain.MessageSearchHit, error) {
	matcher := searchutil.New(query)
	trigrams := searchTrigrams(matcher.Query())
	if len(trigrams) == 0 {
		return nil, nil
	}
	rows, err := s.db.QueryContext(ctx, `SELECT m.id,m.chat_jid,m.sender_jid,m.text,m.timestamp,m.from_me,m.kind,
m.image_caption,m.media_file_name,m.contacts_json,m.location_name,m.location_address,
c.preferred_jid,c.name,c.last_message_id,c.last_message_text,c.last_message_at,c.unread_count,c.muted_until,c.archived
FROM message_search JOIN messages m ON m.rowid=message_search.rowid JOIN chats c ON c.jid=m.chat_jid
WHERE message_search MATCH ? AND m.kind<>'reaction' AND m.revoked=0 ORDER BY rank,m.timestamp DESC LIMIT 256`, strings.Join(trigrams, " OR "))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	hits := make([]domain.MessageSearchHit, 0, limit)
	for rows.Next() {
		var hit domain.MessageSearchHit
		var imageCaption, fileName, contactsJSON, locationName, locationAddress string
		var timestamp, chatTimestamp, muted int64
		if err = rows.Scan(&hit.MessageID, &hit.Chat.JID, &hit.SenderJID, &hit.Text, &timestamp, &hit.FromMe, &hit.Kind,
			&imageCaption, &fileName, &contactsJSON, &locationName, &locationAddress,
			&hit.Chat.AddressJID, &hit.Chat.Name, &hit.Chat.LastMessageID, &hit.Chat.LastMessageText, &chatTimestamp, &hit.Chat.UnreadCount, &muted, &hit.Chat.Archived); err != nil {
			return nil, err
		}
		hit.Timestamp = unixMilli(timestamp)
		hit.Chat.LastMessageAt = unixMilli(chatTimestamp)
		hit.Chat.MutedUntil = unixMilli(muted)
		fields := []struct {
			value string
			bonus int
		}{
			{hit.Text, 200}, {imageCaption, 180}, {fileName, 160},
			{contactsJSON, 150}, {locationName, 150}, {locationAddress, 150},
		}
		hit.Score = searchutil.NoMatch
		searchParts := make([]string, 0, len(fields))
		for _, field := range fields {
			if field.value == "" {
				continue
			}
			searchParts = append(searchParts, field.value)
			if score := matcher.Score(field.value); score != searchutil.NoMatch && score+field.bonus > hit.Score {
				hit.Score = score + field.bonus
			}
		}
		if hit.Score == searchutil.NoMatch {
			continue
		}
		hit.SearchText = strings.Join(searchParts, " · ")
		hits = append(hits, hit)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(hits, func(i, j int) bool {
		if hits[i].Score != hits[j].Score {
			return hits[i].Score > hits[j].Score
		}
		if !hits[i].Timestamp.Equal(hits[j].Timestamp) {
			return hits[i].Timestamp.After(hits[j].Timestamp)
		}
		if hits[i].Chat.JID != hits[j].Chat.JID {
			return hits[i].Chat.JID < hits[j].Chat.JID
		}
		return hits[i].MessageID < hits[j].MessageID
	})
	if limit <= 0 || limit > 20 {
		limit = 20
	}
	if len(hits) > limit {
		hits = hits[:limit]
	}
	return hits, nil
}

func searchTrigrams(query string) []string {
	runes := []rune(query)
	if len(runes) < 3 {
		return nil
	}
	seen := make(map[string]bool, len(runes)-2)
	terms := make([]string, 0, len(runes)-2)
	for index := 0; index+3 <= len(runes); index++ {
		term := string(runes[index : index+3])
		if seen[term] {
			continue
		}
		seen[term] = true
		terms = append(terms, `"`+strings.ReplaceAll(term, `"`, `""`)+`"`)
	}
	return terms
}

func (s *Store) attachReactions(ctx context.Context, chatJID string, messages []domain.Message) error {
	if len(messages) == 0 {
		return nil
	}
	ids := make([]string, len(messages))
	positions := make(map[string]int, len(messages))
	for i := range messages {
		ids[i] = messages[i].ID
		positions[messages[i].ID] = i
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := make([]any, 0, len(ids)+1)
	args = append(args, chatJID)
	for _, id := range ids {
		args = append(args, id)
	}
	rows, err := s.db.QueryContext(ctx, `SELECT message_id,sender_jid,emoji,timestamp,from_me FROM reactions WHERE chat_jid=? AND emoji<>'' AND message_id IN (`+placeholders+`) ORDER BY timestamp,sender_jid`, args...)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var reaction domain.Reaction
		var timestamp int64
		if err = rows.Scan(&reaction.MessageID, &reaction.SenderJID, &reaction.Emoji, &timestamp, &reaction.FromMe); err != nil {
			return err
		}
		reaction.ChatJID = chatJID
		reaction.Timestamp = unixMilli(timestamp)
		if position, ok := positions[reaction.MessageID]; ok {
			messages[position].Reactions = append(messages[position].Reactions, reaction)
		}
	}
	return rows.Err()
}

func (s *Store) ApplyReaction(ctx context.Context, reaction domain.Reaction) error {
	_, err := s.ApplyReactionIfNewer(ctx, reaction)
	return err
}

// ApplyReactionIfNewer reports whether the candidate won the per-sender
// timestamp race. Callers that publish live events must suppress losing stale
// candidates so the in-memory UI cannot diverge from durable state.
func (s *Store) ApplyReactionIfNewer(ctx context.Context, reaction domain.Reaction) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	resolved, err := resolveOrCreateChatTx(ctx, tx, reaction.ChatJID)
	if err != nil {
		return false, err
	}
	reaction.ChatJID = resolved
	applied, err := applyReactionTx(ctx, tx, reaction)
	if err != nil {
		return false, err
	}
	return applied, tx.Commit()
}

func (s *Store) ApplyReactions(ctx context.Context, reactions []domain.Reaction) error {
	if len(reactions) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, reaction := range reactions {
		resolved, resolveErr := resolveOrCreateChatTx(ctx, tx, reaction.ChatJID)
		if resolveErr != nil {
			return resolveErr
		}
		reaction.ChatJID = resolved
		if _, err = applyReactionTx(ctx, tx, reaction); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func applyReactionTx(ctx context.Context, tx *sql.Tx, reaction domain.Reaction) (bool, error) {
	ts := reaction.Timestamp.UnixMilli()
	if reaction.Timestamp.IsZero() {
		ts = time.Now().UnixMilli()
	}
	if reaction.FromMe {
		var newest sql.NullInt64
		if err := tx.QueryRowContext(ctx, `SELECT max(timestamp) FROM reactions WHERE chat_jid=? AND message_id=? AND from_me=1`, reaction.ChatJID, reaction.MessageID).Scan(&newest); err != nil {
			return false, err
		}
		if newest.Valid && ts < newest.Int64 {
			return false, nil
		}
		// PN and LID are aliases for the same current user. Once the candidate
		// wins the timestamp comparison, replace every self alias atomically.
		if _, err := tx.ExecContext(ctx, `DELETE FROM reactions WHERE chat_jid=? AND message_id=? AND from_me=1`, reaction.ChatJID, reaction.MessageID); err != nil {
			return false, err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO reactions(chat_jid,message_id,sender_jid,emoji,timestamp,from_me) VALUES(?,?,?,?,?,1)`, reaction.ChatJID, reaction.MessageID, reaction.SenderJID, reaction.Emoji, ts)
		return err == nil, err
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO reactions(chat_jid,message_id,sender_jid,emoji,timestamp,from_me) VALUES(?,?,?,?,?,0) ON CONFLICT(chat_jid,message_id,sender_jid) DO UPDATE SET emoji=excluded.emoji,timestamp=excluded.timestamp,from_me=excluded.from_me WHERE excluded.timestamp>=reactions.timestamp`, reaction.ChatJID, reaction.MessageID, reaction.SenderJID, reaction.Emoji, ts)
	if err != nil {
		return false, err
	}
	changed, err := result.RowsAffected()
	return changed > 0, err
}

// ReserveOutgoingReaction binds a client action UUID to one state-setting
// reaction. A completed reservation returns its persisted timestamp so callers
// can replay the result without another network send. An incomplete reservation
// may be sent again after a crash; WhatsApp reactions are a per-sender state set,
// so repeating the same target and emoji is safe.
func (s *Store) ReserveOutgoingReaction(ctx context.Context, clientID string, reaction domain.Reaction) (domain.Reaction, bool, error) {
	resolved, resolveErr := s.ResolveChat(ctx, reaction.ChatJID)
	if errors.Is(resolveErr, sql.ErrNoRows) {
		resolved, _, resolveErr = s.EnsureConversation(ctx, reaction.ChatJID)
	}
	if resolveErr != nil {
		return domain.Reaction{}, false, resolveErr
	}
	reaction.ChatJID = resolved
	var existingChat, existingMessage, existingEmoji string
	var completedAt int64
	err := s.db.QueryRowContext(ctx, `SELECT chat_jid,message_id,emoji,completed_at FROM outgoing_reactions WHERE client_reaction_id=?`, clientID).
		Scan(&existingChat, &existingMessage, &existingEmoji, &completedAt)
	if err == nil {
		if existingChat != reaction.ChatJID || existingMessage != reaction.MessageID || existingEmoji != reaction.Emoji {
			return domain.Reaction{}, false, fmt.Errorf("client_reaction_id already used with different payload")
		}
		if completedAt > 0 {
			reaction.Timestamp = unixMilli(completedAt)
			return reaction, true, nil
		}
		return reaction, false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return domain.Reaction{}, false, err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO outgoing_reactions(client_reaction_id,chat_jid,message_id,emoji,created_at) VALUES(?,?,?,?,?)`, clientID, reaction.ChatJID, reaction.MessageID, reaction.Emoji, time.Now().UnixMilli())
	return reaction, false, err
}

// CompleteOutgoingReaction atomically records the network result and updates
// the materialized per-message reaction state.
func (s *Store) CompleteOutgoingReaction(ctx context.Context, clientID string, reaction domain.Reaction) error {
	resolved, resolveErr := s.ResolveChat(ctx, reaction.ChatJID)
	if resolveErr != nil {
		return resolveErr
	}
	reaction.ChatJID = resolved
	ts := reaction.Timestamp.UnixMilli()
	if reaction.Timestamp.IsZero() {
		ts = time.Now().UnixMilli()
		reaction.Timestamp = unixMilli(ts)
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `UPDATE outgoing_reactions SET completed_at=? WHERE client_reaction_id=? AND chat_jid=? AND message_id=? AND emoji=?`, ts, clientID, reaction.ChatJID, reaction.MessageID, reaction.Emoji)
	if err != nil {
		return err
	}
	if changed, rowsErr := result.RowsAffected(); rowsErr != nil {
		return rowsErr
	} else if changed != 1 {
		return fmt.Errorf("outgoing reaction reservation not found")
	}
	if _, err = applyReactionTx(ctx, tx, reaction); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) Messages(ctx context.Context, chatJID, cursor string, limit int) (domain.Page[domain.Message], error) {
	resolvedChat, err := s.ResolveChat(ctx, chatJID)
	if err != nil {
		return domain.Page[domain.Message]{}, err
	}
	chatJID = resolvedChat
	ts, id, err := decodeCursor(cursor)
	if err != nil {
		return domain.Page[domain.Message]{}, fmt.Errorf("decode cursor: %w", err)
	}
	limit = clampLimit(limit)
	rows, err := s.db.QueryContext(ctx, `SELECT id,chat_jid,transport_jid,sender_jid,text,timestamp,from_me,status,kind,reply_to_id,edited_at,revoked,
image_mime,image_caption,image_local_path,image_direct_path,image_media_key,image_file_sha256,image_file_enc_sha256,image_width,image_height,image_size,
image_animated,media_file_name,media_duration,media_voice,contacts_json,location_lat,location_lng,location_name,location_address,location_url,location_live,
link_preview_url,link_preview_title,link_preview_description,link_preview_thumbnail,link_preview_width,link_preview_height
FROM messages WHERE chat_jid=? AND kind<>'reaction' AND (timestamp < ? OR (timestamp=? AND id < ?)) ORDER BY timestamp DESC,id DESC LIMIT ?`, chatJID, ts, ts, id, limit+1)
	if err != nil {
		return domain.Page[domain.Message]{}, err
	}
	defer rows.Close()
	page := domain.Page[domain.Message]{Items: make([]domain.Message, 0, limit)}
	var lastTS int64
	for rows.Next() {
		m, timestamp, err := scanStoredMessage(rows)
		if err != nil {
			return page, err
		}
		if len(page.Items) == limit {
			page.NextCursor = encodeCursor(lastTS, page.Items[len(page.Items)-1].ID)
			break
		}
		lastTS = timestamp
		page.Items = append(page.Items, m)
	}
	if err = rows.Err(); err != nil {
		return page, err
	}
	if err = rows.Close(); err != nil {
		return page, err
	}
	if err = s.attachReactions(ctx, chatJID, page.Items); err != nil {
		return page, err
	}
	if err = s.attachPolls(ctx, chatJID, page.Items); err != nil {
		return page, err
	}
	return page, nil
}

func (s *Store) MessagesBefore(ctx context.Context, chatJID string, timestampMS int64, messageID string, limit int) (domain.Page[domain.Message], error) {
	cursor := ""
	if timestampMS > 0 || messageID != "" {
		cursor = encodeCursor(timestampMS, messageID)
	}
	return s.Messages(ctx, chatJID, cursor, limit)
}

func (s *Store) MessagesAround(ctx context.Context, chatJID, messageID string, sideLimit int) (domain.MessageWindow, error) {
	resolved, err := s.ResolveChat(ctx, chatJID)
	if err != nil {
		return domain.MessageWindow{}, err
	}
	anchor, err := s.Message(ctx, resolved, messageID)
	if err != nil {
		return domain.MessageWindow{}, err
	}
	if sideLimit <= 0 || sideLimit > 50 {
		sideLimit = 25
	}
	older, hasOlder, err := s.messagesRelative(ctx, resolved, anchor.Timestamp.UnixMilli(), anchor.ID, sideLimit, true)
	if err != nil {
		return domain.MessageWindow{}, err
	}
	newer, hasNewer, err := s.messagesRelative(ctx, resolved, anchor.Timestamp.UnixMilli(), anchor.ID, sideLimit, false)
	if err != nil {
		return domain.MessageWindow{}, err
	}
	items := make([]domain.Message, 0, len(older)+1+len(newer))
	items = append(items, older...)
	items = append(items, anchor)
	items = append(items, newer...)
	if err = s.attachReactions(ctx, resolved, items); err != nil {
		return domain.MessageWindow{}, err
	}
	if err = s.attachPolls(ctx, resolved, items); err != nil {
		return domain.MessageWindow{}, err
	}
	return domain.MessageWindow{Items: items, HasOlder: hasOlder, HasNewer: hasNewer, AnchorID: anchor.ID}, nil
}

// InitialMessageWindow opens at the earliest unread message when one exists.
// The surrounding context remains loaded so the desktop can scroll upward,
// while AnchorID tells it which row belongs at the top of the viewport.
func (s *Store) InitialMessageWindow(ctx context.Context, chatJID string, sideLimit int) (domain.MessageWindow, error) {
	resolved, err := s.ResolveChat(ctx, chatJID)
	if err != nil {
		return domain.MessageWindow{}, err
	}
	var firstUnreadID string
	err = s.db.QueryRowContext(ctx, `SELECT id FROM messages WHERE chat_jid=? AND kind<>'reaction' AND unread=1 ORDER BY timestamp,id LIMIT 1`, resolved).Scan(&firstUnreadID)
	if err == nil {
		return s.MessagesAround(ctx, resolved, firstUnreadID, sideLimit)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return domain.MessageWindow{}, err
	}
	page, err := s.MessagesBefore(ctx, resolved, 0, "", 50)
	if err != nil {
		return domain.MessageWindow{}, err
	}
	slices.Reverse(page.Items)
	return domain.MessageWindow{Items: page.Items, HasOlder: page.NextCursor != ""}, nil
}

// MessagesAfter returns a forward, exclusive page ordered oldest-to-newest.
func (s *Store) MessagesAfter(ctx context.Context, chatJID string, timestampMS int64, messageID string, limit int) ([]domain.Message, bool, error) {
	resolved, err := s.ResolveChat(ctx, chatJID)
	if err != nil {
		return nil, false, err
	}
	if timestampMS <= 0 || messageID == "" {
		return nil, false, fmt.Errorf("after timestamp and message ID are required")
	}
	limit = clampLimit(limit)
	items, hasMore, err := s.messagesRelative(ctx, resolved, timestampMS, messageID, limit, false)
	if err != nil {
		return nil, false, err
	}
	if err = s.attachReactions(ctx, resolved, items); err != nil {
		return nil, false, err
	}
	if err = s.attachPolls(ctx, resolved, items); err != nil {
		return nil, false, err
	}
	return items, hasMore, nil
}

func (s *Store) messagesRelative(ctx context.Context, chatID string, timestamp int64, messageID string, limit int, older bool) ([]domain.Message, bool, error) {
	operator, direction := ">", "ASC"
	if older {
		operator, direction = "<", "DESC"
	}
	query := `SELECT id,chat_jid,transport_jid,sender_jid,text,timestamp,from_me,status,kind,reply_to_id,edited_at,revoked,
image_mime,image_caption,image_local_path,image_direct_path,image_media_key,image_file_sha256,image_file_enc_sha256,image_width,image_height,image_size,
image_animated,media_file_name,media_duration,media_voice,contacts_json,location_lat,location_lng,location_name,location_address,location_url,location_live,
link_preview_url,link_preview_title,link_preview_description,link_preview_thumbnail,link_preview_width,link_preview_height
FROM messages WHERE chat_jid=? AND kind<>'reaction' AND (timestamp ` + operator + ` ? OR (timestamp=? AND id ` + operator + ` ?))
ORDER BY timestamp ` + direction + `,id ` + direction + ` LIMIT ?`
	rows, err := s.db.QueryContext(ctx, query, chatID, timestamp, timestamp, messageID, limit+1)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	items := make([]domain.Message, 0, limit)
	for rows.Next() {
		message, _, scanErr := scanStoredMessage(rows)
		if scanErr != nil {
			return nil, false, scanErr
		}
		items = append(items, message)
	}
	if err = rows.Err(); err != nil {
		return nil, false, err
	}
	hasMore := len(items) > limit
	if hasMore {
		items = items[:limit]
	}
	if older {
		slices.Reverse(items)
	}
	return items, hasMore, nil
}

type messageScanner interface{ Scan(...any) error }

func scanStoredMessage(scanner messageScanner) (domain.Message, int64, error) {
	var m domain.Message
	var timestamp, edited, width, height, size, duration int64
	var media domain.Image
	var animated, voice, locationLive bool
	var fileName, contactsJSON string
	var location domain.Location
	var preview domain.LinkPreview
	var previewWidth, previewHeight int64
	err := scanner.Scan(&m.ID, &m.ChatJID, &m.TransportJID, &m.SenderJID, &m.Text, &timestamp, &m.FromMe, &m.Status, &m.Kind, &m.ReplyToID, &edited, &m.Revoked,
		&media.MIMEType, &media.Caption, &media.LocalPath, &media.DirectPath, &media.MediaKey, &media.FileSHA256, &media.FileEncSHA256, &width, &height, &size,
		&animated, &fileName, &duration, &voice, &contactsJSON, &location.Latitude, &location.Longitude, &location.Name, &location.Address, &location.URL, &locationLive,
		&preview.URL, &preview.Title, &preview.Description, &preview.JPEGThumbnail, &previewWidth, &previewHeight)
	if err != nil {
		return m, 0, err
	}
	m.Timestamp, m.EditedAt = unixMilli(timestamp), unixMilli(edited)
	media.Width, media.Height, media.FileSize, media.Animated = uint32(width), uint32(height), uint64(size), animated
	switch m.Kind {
	case "image", "sticker":
		m.Image = &media
	case "video", "audio", "document":
		m.Attachment = &domain.Attachment{Caption: media.Caption, MIMEType: media.MIMEType, FileName: fileName, LocalPath: media.LocalPath,
			DirectPath: media.DirectPath, MediaKey: media.MediaKey, FileSHA256: media.FileSHA256, FileEncSHA256: media.FileEncSHA256,
			Width: media.Width, Height: media.Height, FileSize: media.FileSize, DurationSeconds: uint32(duration), Animated: animated, VoiceNote: voice}
	case "contact", "contacts":
		if contactsJSON != "" && json.Unmarshal([]byte(contactsJSON), &m.Contacts) != nil {
			return domain.Message{}, 0, fmt.Errorf("decode contacts for message %s", m.ID)
		}
	case "location":
		location.Live = locationLive
		m.Location = &location
	}
	if preview.URL != "" {
		preview.ThumbnailWidth, preview.ThumbnailHeight = uint32(previewWidth), uint32(previewHeight)
		m.LinkPreview = &preview
	}
	return m, timestamp, nil
}

// ApplyMessage is the single idempotent reducer used by live and history messages.
func (s *Store) ApplyMessage(ctx context.Context, message domain.Message, incrementUnread bool) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = applyMessageTx(ctx, tx, message, incrementUnread); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) ApplyMessages(ctx context.Context, messages []domain.Message, incrementUnread bool) error {
	if len(messages) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, message := range messages {
		if err = applyMessageTx(ctx, tx, message, incrementUnread); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func applyMessageTx(ctx context.Context, tx *sql.Tx, message domain.Message, incrementUnread bool) error {
	if message.Kind == "reaction" {
		_, err := resolveOrCreateChatTx(ctx, tx, message.ChatJID)
		return err
	}
	var err error
	originalChat := message.ChatJID
	resolvedChat, resolveErr := resolveOrCreateChatTx(ctx, tx, originalChat)
	if resolveErr != nil {
		return resolveErr
	}
	message.ChatJID = resolvedChat
	if message.TransportJID == "" {
		if originalChat != resolvedChat {
			message.TransportJID = originalChat
		} else if err = tx.QueryRowContext(ctx, `SELECT preferred_jid FROM chats WHERE jid=?`, resolvedChat).Scan(&message.TransportJID); err != nil {
			return err
		}
	}
	ts := message.Timestamp.UnixMilli()
	if message.Timestamp.IsZero() {
		ts = time.Now().UnixMilli()
	}
	var existed bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM messages WHERE chat_jid=? AND id=?)`, message.ChatJID, message.ID).Scan(&existed); err != nil {
		return err
	}
	editedAt := int64(0)
	if !message.EditedAt.IsZero() {
		editedAt = message.EditedAt.UnixMilli()
	}
	unreadValue := 0
	if incrementUnread && !message.FromMe && !existed {
		unreadValue = 1
	}
	image := domain.Image{
		MediaKey:      []byte{},
		FileSHA256:    []byte{},
		FileEncSHA256: []byte{},
	}
	if message.Image != nil {
		image = *message.Image
	}
	fileName := ""
	duration := uint32(0)
	voice := false
	if message.Attachment != nil {
		attachment := message.Attachment
		image = domain.Image{Caption: attachment.Caption, MIMEType: attachment.MIMEType, LocalPath: attachment.LocalPath, DirectPath: attachment.DirectPath,
			MediaKey: attachment.MediaKey, FileSHA256: attachment.FileSHA256, FileEncSHA256: attachment.FileEncSHA256,
			Width: attachment.Width, Height: attachment.Height, FileSize: attachment.FileSize, Animated: attachment.Animated}
		fileName, duration, voice = attachment.FileName, attachment.DurationSeconds, attachment.VoiceNote
	}
	// protobuf getters return nil for absent bytes fields. modernc/sqlite binds
	// nil []byte values as SQL NULL, which violates the durable empty-BLOB
	// invariant used for historical media descriptors.
	if image.MediaKey == nil {
		image.MediaKey = []byte{}
	}
	if image.FileSHA256 == nil {
		image.FileSHA256 = []byte{}
	}
	if image.FileEncSHA256 == nil {
		image.FileEncSHA256 = []byte{}
	}
	contactsJSON := ""
	if len(message.Contacts) > 0 {
		encoded, marshalErr := json.Marshal(message.Contacts)
		if marshalErr != nil {
			return fmt.Errorf("encode contacts: %w", marshalErr)
		}
		contactsJSON = string(encoded)
	}
	location := domain.Location{}
	if message.Location != nil {
		location = *message.Location
	}
	preview := domain.LinkPreview{JPEGThumbnail: []byte{}}
	if message.LinkPreview != nil {
		preview = *message.LinkPreview
		if preview.JPEGThumbnail == nil {
			preview.JPEGThumbnail = []byte{}
		}
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO messages(id,chat_jid,transport_jid,sender_jid,text,timestamp,from_me,status,kind,reply_to_id,edited_at,revoked,unread,
image_mime,image_caption,image_local_path,image_direct_path,image_media_key,image_file_sha256,image_file_enc_sha256,image_width,image_height,image_size,
image_animated,media_file_name,media_duration,media_voice,contacts_json,location_lat,location_lng,location_name,location_address,location_url,location_live,
link_preview_url,link_preview_title,link_preview_description,link_preview_thumbnail,link_preview_width,link_preview_height)
VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(chat_jid,id) DO UPDATE SET
transport_jid=CASE WHEN excluded.transport_jid LIKE '%@lid' OR messages.transport_jid='' THEN excluded.transport_jid ELSE messages.transport_jid END,
sender_jid=excluded.sender_jid,
timestamp=excluded.timestamp,from_me=excluded.from_me,
status=CASE WHEN excluded.status=5 AND messages.status<=1 THEN 5 WHEN excluded.status=5 THEN messages.status WHEN messages.status=5 THEN excluded.status ELSE max(messages.status,excluded.status) END,
kind=excluded.kind,reply_to_id=excluded.reply_to_id,
text=CASE WHEN excluded.edited_at>=messages.edited_at THEN excluded.text ELSE messages.text END,
edited_at=max(messages.edited_at,excluded.edited_at),revoked=(messages.revoked OR excluded.revoked),
image_mime=excluded.image_mime,image_caption=excluded.image_caption,
image_local_path=CASE WHEN excluded.image_local_path<>'' THEN excluded.image_local_path ELSE messages.image_local_path END,
image_direct_path=excluded.image_direct_path,image_media_key=excluded.image_media_key,
image_file_sha256=excluded.image_file_sha256,image_file_enc_sha256=excluded.image_file_enc_sha256,
image_width=excluded.image_width,image_height=excluded.image_height,image_size=excluded.image_size,
image_animated=excluded.image_animated,media_file_name=excluded.media_file_name,media_duration=excluded.media_duration,media_voice=excluded.media_voice,
contacts_json=excluded.contacts_json,location_lat=excluded.location_lat,location_lng=excluded.location_lng,
location_name=excluded.location_name,location_address=excluded.location_address,location_url=excluded.location_url,location_live=excluded.location_live,
link_preview_url=excluded.link_preview_url,link_preview_title=excluded.link_preview_title,link_preview_description=excluded.link_preview_description,
link_preview_thumbnail=excluded.link_preview_thumbnail,link_preview_width=excluded.link_preview_width,link_preview_height=excluded.link_preview_height`,
		message.ID, message.ChatJID, message.TransportJID, message.SenderJID, message.Text, ts, message.FromMe, message.Status, message.Kind, message.ReplyToID, editedAt, message.Revoked, unreadValue,
		image.MIMEType, image.Caption, image.LocalPath, image.DirectPath, image.MediaKey, image.FileSHA256, image.FileEncSHA256, image.Width, image.Height, image.FileSize,
		image.Animated, fileName, duration, voice, contactsJSON, location.Latitude, location.Longitude, location.Name, location.Address, location.URL, location.Live,
		preview.URL, preview.Title, preview.Description, preview.JPEGThumbnail, preview.ThumbnailWidth, preview.ThumbnailHeight)
	if err != nil {
		return err
	}
	if message.Poll != nil {
		encoded, marshalErr := json.Marshal(message.Poll.Options)
		if marshalErr != nil {
			return fmt.Errorf("encode poll options: %w", marshalErr)
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO polls(chat_jid,message_id,question,selectable_count,total_voters,options_json) VALUES(?,?,?,?,?,?)
ON CONFLICT(chat_jid,message_id) DO UPDATE SET question=excluded.question,selectable_count=excluded.selectable_count,total_voters=excluded.total_voters,options_json=excluded.options_json WHERE polls.snapshot_at=0`,
			message.ChatJID, message.ID, message.Poll.Question, message.Poll.SelectableOptionsCount, message.Poll.TotalVoters, string(encoded)); err != nil {
			return err
		}
	}
	unread := int64(0)
	if incrementUnread && !message.FromMe && !existed {
		unread = 1
	}
	_, err = tx.ExecContext(ctx, `UPDATE chats SET last_message_id=CASE WHEN last_message_at<? OR (last_message_at=? AND last_message_id<?) THEN ? ELSE last_message_id END,
last_message_text=CASE WHEN last_message_id=? OR last_message_at<? OR (last_message_at=? AND last_message_id<?) THEN ? ELSE last_message_text END,last_message_at=max(last_message_at,?),
unread_count=unread_count+? WHERE jid=?`, ts, ts, message.ID, message.ID, message.ID, ts, ts, message.ID, message.Text, ts, unread, message.ChatJID)
	if err != nil {
		return err
	}
	return nil
}

func (s *Store) UpdateReceipt(ctx context.Context, chatJID, messageID string, status domain.MessageStatus) error {
	resolved, err := s.ResolveChat(ctx, chatJID)
	if err != nil {
		return err
	}
	chatJID = resolved
	_, err = s.db.ExecContext(ctx, `UPDATE messages SET status=CASE WHEN ?=5 AND status<=1 THEN 5 WHEN ?=5 THEN status WHEN status=5 THEN ? ELSE max(status,?) END WHERE chat_jid=? AND id=?`, status, status, status, status, chatJID, messageID)
	return err
}

func (s *Store) Message(ctx context.Context, chatJID, messageID string) (domain.Message, error) {
	var m domain.Message
	resolved, err := s.ResolveChat(ctx, chatJID)
	if err != nil {
		return m, err
	}
	chatJID = resolved
	row := s.db.QueryRowContext(ctx, `SELECT id,chat_jid,transport_jid,sender_jid,text,timestamp,from_me,status,kind,reply_to_id,edited_at,revoked,
image_mime,image_caption,image_local_path,image_direct_path,image_media_key,image_file_sha256,image_file_enc_sha256,image_width,image_height,image_size,
image_animated,media_file_name,media_duration,media_voice,contacts_json,location_lat,location_lng,location_name,location_address,location_url,location_live,
link_preview_url,link_preview_title,link_preview_description,link_preview_thumbnail,link_preview_width,link_preview_height
FROM messages WHERE chat_jid=? AND id=? AND kind<>'reaction'`, chatJID, messageID)
	m, _, err = scanStoredMessage(row)
	if err == nil && m.Kind == "poll" {
		m.Poll, err = s.Poll(ctx, chatJID, messageID)
	}
	return m, err
}

func (s *Store) Poll(ctx context.Context, chatJID, messageID string) (*domain.Poll, error) {
	resolved, err := s.ResolveChat(ctx, chatJID)
	if err != nil {
		return nil, err
	}
	var question, optionsJSON string
	var selectable, totalVoters uint32
	if err = s.db.QueryRowContext(ctx, `SELECT question,selectable_count,total_voters,options_json FROM polls WHERE chat_jid=? AND message_id=?`, resolved, messageID).Scan(&question, &selectable, &totalVoters, &optionsJSON); err != nil {
		return nil, err
	}
	poll := &domain.Poll{Question: question, SelectableOptionsCount: selectable, TotalVoters: totalVoters}
	poll.Options, err = decodePollOptions(optionsJSON)
	if err != nil {
		return nil, err
	}
	byName := make(map[string]int, len(poll.Options))
	for i, option := range poll.Options {
		byName[option.Name] = i
	}
	rows, err := s.db.QueryContext(ctx, `SELECT selected_json,from_me FROM poll_votes WHERE chat_jid=? AND poll_message_id=?`, resolved, messageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var raw string
		var fromMe bool
		if err = rows.Scan(&raw, &fromMe); err != nil {
			return nil, err
		}
		var selected []string
		if json.Unmarshal([]byte(raw), &selected) != nil {
			continue
		}
		if len(selected) > 0 {
			poll.TotalVoters++
		}
		for _, name := range selected {
			if i, ok := byName[name]; ok {
				poll.Options[i].VoteCount++
				if fromMe {
					poll.Options[i].SelectedByMe = true
				}
			}
		}
	}
	return poll, rows.Err()
}

func decodePollOptions(raw string) ([]domain.PollOption, error) {
	var options []domain.PollOption
	if err := json.Unmarshal([]byte(raw), &options); err == nil {
		return options, nil
	}
	var legacy []string
	if err := json.Unmarshal([]byte(raw), &legacy); err != nil {
		return nil, err
	}
	options = make([]domain.PollOption, 0, len(legacy))
	for _, name := range legacy {
		options = append(options, domain.PollOption{Name: name})
	}
	return options, nil
}

// AddPollOption applies WhatsApp's incremental PollAddOption signal without
// re-saving aggregate vote counts into the poll definition. The latter would
// be counted again when Poll joins the durable per-voter rows.
func (s *Store) AddPollOption(ctx context.Context, chatJID, messageID, name string) (domain.Message, bool, error) {
	resolved, err := s.ResolveChat(ctx, chatJID)
	if err != nil {
		return domain.Message{}, false, err
	}
	name = strings.TrimSpace(name)
	if name == "" {
		return domain.Message{}, false, fmt.Errorf("poll option is empty")
	}
	var raw string
	if err = s.db.QueryRowContext(ctx, `SELECT options_json FROM polls WHERE chat_jid=? AND message_id=?`, resolved, messageID).Scan(&raw); err != nil {
		return domain.Message{}, false, err
	}
	options, err := decodePollOptions(raw)
	if err != nil {
		return domain.Message{}, false, err
	}
	for _, option := range options {
		if option.Name == name {
			message, messageErr := s.Message(ctx, resolved, messageID)
			return message, false, messageErr
		}
	}
	options = append(options, domain.PollOption{Name: name})
	encoded, err := json.Marshal(options)
	if err != nil {
		return domain.Message{}, false, err
	}
	if _, err = s.db.ExecContext(ctx, `UPDATE polls SET options_json=? WHERE chat_jid=? AND message_id=?`, string(encoded), resolved, messageID); err != nil {
		return domain.Message{}, false, err
	}
	message, err := s.Message(ctx, resolved, messageID)
	return message, err == nil, err
}

// ApplyPollSnapshot replaces voter rows covered by WhatsApp's aggregate while
// retaining any vote that arrived after it. A stale/replayed snapshot is a
// no-op, so it cannot erase newer reducer state.
func (s *Store) ApplyPollSnapshot(ctx context.Context, chatJID, messageID string, poll *domain.Poll, at time.Time) (domain.Message, bool, error) {
	resolved, err := s.ResolveChat(ctx, chatJID)
	if err != nil {
		return domain.Message{}, false, err
	}
	if poll == nil {
		return domain.Message{}, false, fmt.Errorf("poll snapshot is empty")
	}
	snapshotAt := at.UnixMilli()
	if snapshotAt <= 0 {
		snapshotAt = 1
	}
	encoded, err := json.Marshal(poll.Options)
	if err != nil {
		return domain.Message{}, false, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.Message{}, false, err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `UPDATE polls SET question=?,selectable_count=?,total_voters=?,options_json=?,snapshot_at=? WHERE chat_jid=? AND message_id=? AND snapshot_at<?`, poll.Question, poll.SelectableOptionsCount, poll.TotalVoters, string(encoded), snapshotAt, resolved, messageID, snapshotAt)
	if err != nil {
		return domain.Message{}, false, err
	}
	updated, err := result.RowsAffected()
	if err != nil {
		return domain.Message{}, false, err
	}
	if updated == 0 {
		var exists bool
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM polls WHERE chat_jid=? AND message_id=?)`, resolved, messageID).Scan(&exists); err != nil {
			return domain.Message{}, false, err
		}
		if !exists {
			return domain.Message{}, false, sql.ErrNoRows
		}
		if err = tx.Commit(); err != nil {
			return domain.Message{}, false, err
		}
		message, messageErr := s.Message(ctx, resolved, messageID)
		return message, false, messageErr
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM poll_votes WHERE chat_jid=? AND poll_message_id=? AND timestamp<=?`, resolved, messageID, snapshotAt); err != nil {
		return domain.Message{}, false, err
	}
	if err = tx.Commit(); err != nil {
		return domain.Message{}, false, err
	}
	message, err := s.Message(ctx, resolved, messageID)
	return message, err == nil, err
}

func (s *Store) attachPolls(ctx context.Context, chatID string, messages []domain.Message) error {
	for i := range messages {
		if messages[i].Kind != "poll" {
			continue
		}
		poll, err := s.Poll(ctx, chatID, messages[i].ID)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		messages[i].Poll = poll
	}
	return nil
}

func (s *Store) ApplyPollVote(ctx context.Context, vote domain.PollVote) (domain.Message, bool, error) {
	resolved, err := s.ResolveChat(ctx, vote.ChatJID)
	if err != nil {
		return domain.Message{}, false, err
	}
	vote.ChatJID = resolved
	encoded, err := json.Marshal(vote.SelectedOptions)
	if err != nil {
		return domain.Message{}, false, err
	}
	ts := vote.Timestamp.UnixMilli()
	if ts <= 0 {
		ts = time.Now().UnixMilli()
	}
	result, err := s.db.ExecContext(ctx, `INSERT INTO poll_votes(chat_jid,poll_message_id,voter_jid,selected_json,timestamp,from_me)
SELECT ?,?,?,?,?,? WHERE ?>COALESCE((SELECT snapshot_at FROM polls WHERE chat_jid=? AND message_id=?),0)
ON CONFLICT(chat_jid,poll_message_id,voter_jid) DO UPDATE SET selected_json=excluded.selected_json,timestamp=excluded.timestamp,from_me=excluded.from_me WHERE excluded.timestamp>=poll_votes.timestamp`, resolved, vote.PollMessageID, vote.VoterJID, string(encoded), ts, vote.FromMe, ts, resolved, vote.PollMessageID)
	if err != nil {
		return domain.Message{}, false, err
	}
	changed, _ := result.RowsAffected()
	message, err := s.Message(ctx, resolved, vote.PollMessageID)
	return message, changed > 0, err
}

func (s *Store) SetMessagePinned(ctx context.Context, chatID, messageID, pinnedBy string, at time.Time, pinned bool) error {
	resolved, err := s.ResolveChat(ctx, chatID)
	if err != nil {
		return err
	}
	if at.IsZero() {
		at = time.Now()
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO pinned_messages(chat_jid,message_id,pinned_at,pinned_by,pinned) VALUES(?,?,?,?,?) ON CONFLICT(chat_jid,message_id) DO UPDATE SET pinned_at=excluded.pinned_at,pinned_by=excluded.pinned_by,pinned=excluded.pinned WHERE excluded.pinned_at>=pinned_messages.pinned_at`, resolved, messageID, at.UnixMilli(), pinnedBy, pinned)
	return err
}

func (s *Store) PinnedMessages(ctx context.Context, chatID string) ([]domain.PinnedMessage, error) {
	resolved, err := s.ResolveChat(ctx, chatID)
	if err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT message_id,pinned_at,pinned_by FROM pinned_messages WHERE chat_jid=? AND pinned=1 ORDER BY pinned_at DESC,message_id`, resolved)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var pins []domain.PinnedMessage
	for rows.Next() {
		var pin domain.PinnedMessage
		var at int64
		if err = rows.Scan(&pin.MessageID, &at, &pin.PinnedBy); err != nil {
			return nil, err
		}
		pin.PinnedAt = unixMilli(at)
		pins = append(pins, pin)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if err = rows.Close(); err != nil {
		return nil, err
	}
	for i := range pins {
		if msg, messageErr := s.Message(ctx, resolved, pins[i].MessageID); messageErr == nil {
			pins[i].Message = &msg
		}
	}
	return pins, nil
}

func (s *Store) SetImageLocalPath(ctx context.Context, chatJID, messageID, localPath string) error {
	resolved, err := s.ResolveChat(ctx, chatJID)
	if err != nil {
		return err
	}
	chatJID = resolved
	result, err := s.db.ExecContext(ctx, `UPDATE messages SET image_local_path=? WHERE chat_jid=? AND id=? AND kind IN ('image','sticker')`, localPath, chatJID, messageID)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		return sql.ErrNoRows
	}
	return nil
}

func (s *Store) SetAttachmentLocalPath(ctx context.Context, chatJID, messageID, localPath string) error {
	resolved, err := s.ResolveChat(ctx, chatJID)
	if err != nil {
		return err
	}
	chatJID = resolved
	result, err := s.db.ExecContext(ctx, `UPDATE messages SET image_local_path=? WHERE chat_jid=? AND id=? AND kind IN ('video','audio','document')`, localPath, chatJID, messageID)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		return sql.ErrNoRows
	}
	return nil
}

// stickerScanLimit bounds how many sticker messages RecentStickerMessages
// reads before the caller deduplicates and caps its own pack sizes. It is
// intentionally larger than any pack's display cap because the same sticker
// sent repeatedly occupies one row per message (the media cache is keyed by
// chat+message, not by content), so a naive small scan can under-fill a pack
// even when the account has plenty of distinct stickers.
const stickerScanLimit = 2000

// RecentStickerMessages returns sticker messages across every chat, newest
// first, bounded by scanLimit (RecentStickerMessages uses stickerScanLimit
// when scanLimit is not a sane positive bound). Only messages with a known
// plaintext content hash are included, which is every sticker message this
// client has ever sent or received.
func (s *Store) RecentStickerMessages(ctx context.Context, scanLimit int) ([]domain.StickerCandidate, error) {
	if scanLimit <= 0 || scanLimit > 5000 {
		scanLimit = stickerScanLimit
	}
	rows, err := s.db.QueryContext(ctx, `SELECT chat_jid,id,from_me,timestamp,image_mime,image_file_sha256,image_width,image_height,image_animated
FROM messages WHERE kind='sticker' AND revoked=0 AND image_file_sha256<>X'' ORDER BY timestamp DESC,id DESC LIMIT ?`, scanLimit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]domain.StickerCandidate, 0, scanLimit)
	for rows.Next() {
		var chatJID, messageID, mimeType string
		var fromMe, animated bool
		var timestamp int64
		var fileSHA256 []byte
		var width, height int64
		if err = rows.Scan(&chatJID, &messageID, &fromMe, &timestamp, &mimeType, &fileSHA256, &width, &height, &animated); err != nil {
			return nil, err
		}
		items = append(items, domain.StickerCandidate{
			ID: fmt.Sprintf("%x", fileSHA256), ChatJID: chatJID, MessageID: messageID, MIMEType: mimeType,
			Width: uint32(width), Height: uint32(height), Animated: animated, FromMe: fromMe, TimestampMs: timestamp,
		})
	}
	return items, rows.Err()
}

// StickerMessageBySHA256 finds one message that can supply the bytes for a
// sticker identified by the hex encoding of its plaintext content hash, as
// produced by RecentStickerMessages / StickerCandidate.ID.
func (s *Store) StickerMessageBySHA256(ctx context.Context, fileSHA256Hex string) (chatJID, messageID, mimeType string, err error) {
	raw, decodeErr := hex.DecodeString(fileSHA256Hex)
	if decodeErr != nil || len(raw) != sha256.Size {
		return "", "", "", sql.ErrNoRows
	}
	err = s.db.QueryRowContext(ctx, `SELECT chat_jid,id,image_mime FROM messages WHERE kind='sticker' AND revoked=0 AND image_file_sha256=? ORDER BY timestamp DESC,id DESC LIMIT 1`, raw).
		Scan(&chatJID, &messageID, &mimeType)
	return chatJID, messageID, mimeType, err
}

// FavoriteStickers returns stickers WhatsApp synced as favourited on another
// linked device, newest first.
func (s *Store) FavoriteStickers(ctx context.Context, limit int) ([]domain.FavoriteSticker, error) {
	if limit <= 0 || limit > 1000 {
		limit = 300
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id,mime_type,direct_path,media_key,file_enc_sha256,width,height,animated,file_size,local_path,updated_at
FROM sticker_favorites ORDER BY updated_at DESC,id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]domain.FavoriteSticker, 0, limit)
	for rows.Next() {
		item, scanErr := scanFavoriteSticker(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// FavoriteSticker looks up one favourite by ID (see domain.FavoriteSticker.ID).
func (s *Store) FavoriteSticker(ctx context.Context, id string) (domain.FavoriteSticker, error) {
	row := s.db.QueryRowContext(ctx, `SELECT id,mime_type,direct_path,media_key,file_enc_sha256,width,height,animated,file_size,local_path,updated_at
FROM sticker_favorites WHERE id=?`, id)
	return scanFavoriteSticker(row)
}

type favoriteStickerScanner interface {
	Scan(dest ...any) error
}

func scanFavoriteSticker(scanner favoriteStickerScanner) (domain.FavoriteSticker, error) {
	var f domain.FavoriteSticker
	var width, height, fileSize, updatedAt int64
	err := scanner.Scan(&f.ID, &f.MIMEType, &f.DirectPath, &f.MediaKey, &f.FileEncSHA256, &width, &height, &f.Animated, &fileSize, &f.LocalPath, &updatedAt)
	if err != nil {
		return domain.FavoriteSticker{}, err
	}
	f.Width, f.Height, f.FileSize, f.UpdatedAtMs = uint32(width), uint32(height), uint64(fileSize), updatedAt
	return f, nil
}

// UpsertFavoriteSticker records or refreshes a favourite from a WhatsApp
// app-state `favoriteSticker` SET mutation.
func (s *Store) UpsertFavoriteSticker(ctx context.Context, fav domain.FavoriteSticker) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO sticker_favorites(id,mime_type,direct_path,media_key,file_enc_sha256,width,height,animated,file_size,local_path,updated_at)
VALUES(?,?,?,?,?,?,?,?,?,'',?)
ON CONFLICT(id) DO UPDATE SET mime_type=excluded.mime_type,direct_path=excluded.direct_path,media_key=excluded.media_key,
  file_enc_sha256=excluded.file_enc_sha256,width=excluded.width,height=excluded.height,animated=excluded.animated,
  file_size=excluded.file_size,updated_at=excluded.updated_at`,
		fav.ID, fav.MIMEType, fav.DirectPath, fav.MediaKey, fav.FileEncSHA256, fav.Width, fav.Height, fav.Animated, fav.FileSize, fav.UpdatedAtMs)
	return err
}

// RemoveFavoriteSticker un-favourites a sticker. It reports whether a row was
// actually removed so the caller only emits a change event when needed.
func (s *Store) RemoveFavoriteSticker(ctx context.Context, id string) (bool, error) {
	result, err := s.db.ExecContext(ctx, `DELETE FROM sticker_favorites WHERE id=?`, id)
	if err != nil {
		return false, err
	}
	changed, err := result.RowsAffected()
	return changed > 0, err
}

func (s *Store) SetFavoriteStickerLocalPath(ctx context.Context, id, localPath string) error {
	result, err := s.db.ExecContext(ctx, `UPDATE sticker_favorites SET local_path=? WHERE id=?`, localPath, id)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		return sql.ErrNoRows
	}
	return nil
}

func (s *Store) BeginReactionRepair(ctx context.Context, chatJID string) (domain.ReactionRepairJob, bool, error) {
	resolved, resolveErr := s.ResolveChat(ctx, chatJID)
	if resolveErr != nil {
		return domain.ReactionRepairJob{}, false, resolveErr
	}
	chatJID = resolved
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return domain.ReactionRepairJob{}, false, err
	}
	defer tx.Rollback()
	var job domain.ReactionRepairJob
	var timestamp, requestedAt, completedAt, legacyTimestamp int64
	var legacyID string
	err = tx.QueryRowContext(ctx, `SELECT chat_jid,transport_jid,anchor_message_id,anchor_timestamp,anchor_from_me,requested_at,attempts,completed_at,legacy_reaction_at,legacy_reaction_id FROM reaction_repair_jobs WHERE chat_jid=?`, chatJID).
		Scan(&job.ChatJID, &job.TransportJID, &job.AnchorMessageID, &timestamp, &job.AnchorFromMe, &requestedAt, &job.Attempts, &completedAt, &legacyTimestamp, &legacyID)
	if errors.Is(err, sql.ErrNoRows) || completedAt > 0 {
		return domain.ReactionRepairJob{}, false, ErrReactionRepairNotNeeded
	}
	if err != nil {
		return domain.ReactionRepairJob{}, false, err
	}
	if job.AnchorMessageID == "" {
		err = tx.QueryRowContext(ctx, `SELECT id,transport_jid,timestamp,from_me FROM messages WHERE chat_jid=? AND kind<>'reaction' AND (timestamp>? OR (timestamp=? AND id>?)) ORDER BY timestamp ASC,id ASC LIMIT 1`, chatJID, legacyTimestamp, legacyTimestamp, legacyID).
			Scan(&job.AnchorMessageID, &job.TransportJID, &timestamp, &job.AnchorFromMe)
		if errors.Is(err, sql.ErrNoRows) {
			return job, false, ErrReactionRepairCursorNotReady
		}
		if err != nil {
			return domain.ReactionRepairJob{}, false, err
		}
		if _, err = tx.ExecContext(ctx, `UPDATE reaction_repair_jobs SET transport_jid=?,anchor_message_id=?,anchor_timestamp=?,anchor_from_me=? WHERE chat_jid=? AND anchor_message_id=''`, job.TransportJID, job.AnchorMessageID, timestamp, job.AnchorFromMe, chatJID); err != nil {
			return domain.ReactionRepairJob{}, false, err
		}
	}
	job.AnchorTimestamp = unixMilli(timestamp)
	if job.Attempts >= 3 {
		return job, false, ErrReactionRepairExhausted
	}
	now := time.Now().UnixMilli()
	if requestedAt > 0 && now-requestedAt < int64((10*time.Minute)/time.Millisecond) {
		return job, false, ErrReactionRepairRateLimit
	}
	job.Attempts++
	if _, err = tx.ExecContext(ctx, `UPDATE reaction_repair_jobs SET requested_at=?,attempts=? WHERE chat_jid=?`, now, job.Attempts, chatJID); err != nil {
		return domain.ReactionRepairJob{}, false, err
	}
	if err = tx.Commit(); err != nil {
		return domain.ReactionRepairJob{}, false, err
	}
	return job, true, nil
}

// ReserveLegacyReactionReplays reserves at most 16 exact legacy events. Items
// are retried no more than three times and no faster than once per ten minutes.
// The boolean reports whether the chat has targeted items at all, including
// items currently cooling down or already completed.
func (s *Store) ReserveLegacyReactionReplays(ctx context.Context, chatJID string, limit int) ([]domain.LegacyReactionReplay, bool, error) {
	resolved, resolveErr := s.ResolveChat(ctx, chatJID)
	if resolveErr != nil {
		return nil, false, resolveErr
	}
	chatJID = resolved
	if limit <= 0 || limit > 16 {
		limit = 16
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, false, err
	}
	defer tx.Rollback()
	var total, incomplete, retryable int
	if err = tx.QueryRowContext(ctx, `SELECT count(*),coalesce(sum(CASE WHEN status<>2 THEN 1 ELSE 0 END),0),coalesce(sum(CASE WHEN status<>2 AND attempts<3 THEN 1 ELSE 0 END),0) FROM legacy_reaction_replays WHERE chat_jid=?`, chatJID).Scan(&total, &incomplete, &retryable); err != nil {
		return nil, false, err
	}
	if total == 0 || incomplete == 0 {
		return nil, total > 0, nil
	}
	cutoff := time.Now().Add(-10 * time.Minute).UnixMilli()
	rows, err := tx.QueryContext(ctx, `SELECT chat_jid,transport_jid,event_message_id,sender_jid,timestamp,from_me,attempts FROM legacy_reaction_replays
	WHERE chat_jid=? AND status<>2 AND attempts<3 AND (requested_at=0 OR requested_at<=?) ORDER BY timestamp,event_message_id LIMIT ?`, chatJID, cutoff, limit)
	if err != nil {
		return nil, true, err
	}
	var items []domain.LegacyReactionReplay
	for rows.Next() {
		var item domain.LegacyReactionReplay
		var timestamp int64
		if err = rows.Scan(&item.ChatJID, &item.TransportJID, &item.EventMessageID, &item.SenderJID, &timestamp, &item.FromMe, &item.Attempts); err != nil {
			rows.Close()
			return nil, true, err
		}
		item.Timestamp = unixMilli(timestamp)
		item.Attempts++
		items = append(items, item)
	}
	if err = rows.Close(); err != nil {
		return nil, true, err
	}
	if err = rows.Err(); err != nil {
		return nil, true, err
	}
	if len(items) == 0 {
		if retryable == 0 {
			return nil, true, ErrReactionRepairExhausted
		}
		return nil, true, ErrReactionRepairRateLimit
	}
	now := time.Now().UnixMilli()
	for _, item := range items {
		if _, err = tx.ExecContext(ctx, `UPDATE legacy_reaction_replays SET status=1,request_id='',requested_at=?,attempts=? WHERE chat_jid=? AND event_message_id=? AND status<>2`, now, item.Attempts, item.ChatJID, item.EventMessageID); err != nil {
			return nil, true, err
		}
	}
	if err = tx.Commit(); err != nil {
		return nil, true, err
	}
	return items, true, nil
}

func (s *Store) MarkLegacyReactionReplayRequested(ctx context.Context, chatJID, eventMessageID, requestID string) error {
	if requestID == "" {
		return errors.New("legacy reaction replay request id is empty")
	}
	resolved, resolveErr := s.ResolveChat(ctx, chatJID)
	if resolveErr != nil {
		return resolveErr
	}
	chatJID = resolved
	result, err := s.db.ExecContext(ctx, `UPDATE legacy_reaction_replays SET request_id=? WHERE chat_jid=? AND event_message_id=? AND status=1`, requestID, chatJID, eventMessageID)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		return errors.New("legacy reaction replay reservation not found")
	}
	return nil
}

// CompleteLegacyReactionReplay requires the original event identity and the
// pre-persisted peer request ID WhatsMeow attaches as UnavailableRequestID.
func (s *Store) CompleteLegacyReactionReplay(ctx context.Context, chatJID, eventMessageID, requestID string, fromMe bool) (bool, int, error) {
	if requestID == "" {
		return false, 0, errors.New("legacy reaction replay unavailable request id is empty")
	}
	resolved, resolveErr := s.ResolveChat(ctx, chatJID)
	if resolveErr != nil {
		return false, 0, resolveErr
	}
	chatJID = resolved
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, 0, err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `UPDATE legacy_reaction_replays SET status=2,completed_at=? WHERE chat_jid=? AND event_message_id=? AND request_id=? AND from_me=? AND status=1`, time.Now().UnixMilli(), chatJID, eventMessageID, requestID, fromMe)
	if err != nil {
		return false, 0, err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return false, 0, err
	}
	var remaining int
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM legacy_reaction_replays WHERE chat_jid=? AND status<>2`, chatJID).Scan(&remaining); err != nil {
		return false, 0, err
	}
	if changed == 1 && remaining == 0 {
		if _, err = tx.ExecContext(ctx, `UPDATE reaction_repair_jobs SET completed_at=? WHERE chat_jid=?`, time.Now().UnixMilli(), chatJID); err != nil {
			return false, 0, err
		}
	}
	if err = tx.Commit(); err != nil {
		return false, 0, err
	}
	return changed == 1, remaining, nil
}

func (s *Store) CompleteReactionRepair(ctx context.Context, chatJID string, recovered int) (bool, bool, error) {
	resolved, resolveErr := s.ResolveChat(ctx, chatJID)
	if resolveErr != nil {
		return false, false, resolveErr
	}
	chatJID = resolved
	var targeted int
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM legacy_reaction_replays WHERE chat_jid=?`, chatJID).Scan(&targeted); err != nil {
		return false, false, err
	}
	if targeted > 0 {
		var marked bool
		err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM reaction_repair_jobs WHERE chat_jid=? AND completed_at=0)`, chatJID).Scan(&marked)
		return marked, false, err
	}
	if recovered <= 0 {
		var marked bool
		err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM reaction_repair_jobs WHERE chat_jid=? AND completed_at=0)`, chatJID).Scan(&marked)
		return marked, false, err
	}
	result, err := s.db.ExecContext(ctx, `UPDATE reaction_repair_jobs SET completed_at=? WHERE chat_jid=? AND completed_at=0`, time.Now().UnixMilli(), chatJID)
	if err != nil {
		return false, false, err
	}
	changed, err := result.RowsAffected()
	return changed > 0, changed > 0, err
}

func (s *Store) MarkRead(ctx context.Context, chatJID string) error {
	resolved, resolveErr := s.ResolveChat(ctx, chatJID)
	if resolveErr != nil {
		return resolveErr
	}
	chatJID = resolved
	_, err := s.db.ExecContext(ctx, `UPDATE chats SET unread_count=0 WHERE jid=?`, chatJID)
	return err
}

func (s *Store) MarkReadThrough(ctx context.Context, chatJID, messageID string) error {
	resolved, resolveErr := s.ResolveChat(ctx, chatJID)
	if resolveErr != nil {
		return resolveErr
	}
	chatJID = resolved
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var ts int64
	var fromMe bool
	if err = tx.QueryRowContext(ctx, `SELECT timestamp,from_me FROM messages WHERE chat_jid=? AND id=?`, chatJID, messageID).Scan(&ts, &fromMe); err != nil {
		return err
	}
	if fromMe {
		return fmt.Errorf("message is outgoing")
	}
	if _, err = tx.ExecContext(ctx, `UPDATE messages SET unread=0 WHERE chat_jid=? AND unread=1 AND (timestamp<? OR (timestamp=? AND id<=?))`, chatJID, ts, ts, messageID); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE chats SET unread_count=(SELECT count(*) FROM messages WHERE chat_jid=? AND unread=1) WHERE jid=?`, chatJID, chatJID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) UnreadThrough(ctx context.Context, chatJID, messageID string) ([]domain.Message, error) {
	resolved, resolveErr := s.ResolveChat(ctx, chatJID)
	if resolveErr != nil {
		return nil, resolveErr
	}
	chatJID = resolved
	var ts int64
	var fromMe bool
	if err := s.db.QueryRowContext(ctx, `SELECT timestamp,from_me FROM messages WHERE chat_jid=? AND id=?`, chatJID, messageID).Scan(&ts, &fromMe); err != nil {
		return nil, err
	}
	if fromMe {
		return nil, fmt.Errorf("message is outgoing")
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id,chat_jid,transport_jid,sender_jid,timestamp FROM messages WHERE chat_jid=? AND unread=1 AND (timestamp<? OR (timestamp=? AND id<=?)) ORDER BY timestamp,id`, chatJID, ts, ts, messageID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var messages []domain.Message
	for rows.Next() {
		var m domain.Message
		var timestamp int64
		if err = rows.Scan(&m.ID, &m.ChatJID, &m.TransportJID, &m.SenderJID, &timestamp); err != nil {
			return nil, err
		}
		m.Timestamp = unixMilli(timestamp)
		messages = append(messages, m)
	}
	return messages, rows.Err()
}

func (s *Store) MarkReadIDs(ctx context.Context, chatJID string, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	resolved, resolveErr := s.ResolveChat(ctx, chatJID)
	if resolveErr != nil {
		return resolveErr
	}
	chatJID = resolved
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, id := range ids {
		if _, err = tx.ExecContext(ctx, `UPDATE messages SET unread=0 WHERE chat_jid=? AND id=?`, chatJID, id); err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(ctx, `UPDATE chats SET unread_count=(SELECT count(*) FROM messages WHERE chat_jid=? AND unread=1) WHERE jid=?`, chatJID, chatJID); err != nil {
		return err
	}
	return tx.Commit()
}

// MarkReadThroughPosition applies a cross-device read marker. When the
// referenced message is available locally its exact cursor wins; otherwise
// WhatsApp's second-resolution range timestamp is used as a safe fallback.
func (s *Store) MarkReadThroughPosition(ctx context.Context, chatJID, messageID string, rangeTimestamp time.Time) error {
	resolved, resolveErr := s.ResolveChat(ctx, chatJID)
	if resolveErr != nil {
		return resolveErr
	}
	chatJID = resolved
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var result sql.Result
	var ts int64
	if messageID != "" {
		err = tx.QueryRowContext(ctx, `SELECT timestamp FROM messages WHERE chat_jid=? AND id=?`, chatJID, messageID).Scan(&ts)
	}
	if messageID != "" && err == nil {
		result, err = tx.ExecContext(ctx, `UPDATE messages SET unread=0 WHERE chat_jid=? AND unread=1 AND (timestamp<? OR (timestamp=? AND id<=?))`, chatJID, ts, ts, messageID)
	} else {
		if messageID != "" && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if rangeTimestamp.IsZero() {
			return fmt.Errorf("read marker has no local message or timestamp")
		}
		// App-state message ranges use Unix seconds. The marker covers the
		// complete stated second, but not messages received afterward.
		upperExclusive := rangeTimestamp.UnixMilli() + time.Second.Milliseconds()
		result, err = tx.ExecContext(ctx, `UPDATE messages SET unread=0 WHERE chat_jid=? AND unread=1 AND timestamp<?`, chatJID, upperExclusive)
	}
	if err != nil {
		return err
	}
	if _, err = result.RowsAffected(); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE chats SET unread_count=(SELECT count(*) FROM messages WHERE chat_jid=? AND unread=1) WHERE jid=?`, chatJID, chatJID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) UpsertChatName(ctx context.Context, jid, name string) error {
	resolved, err := s.ResolveChat(ctx, jid)
	if errors.Is(err, sql.ErrNoRows) {
		resolved, _, err = s.EnsureConversation(ctx, jid)
	}
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `UPDATE chats SET name=CASE WHEN ?<>'' THEN ? ELSE name END WHERE jid=?`, name, name, resolved)
	return err
}

// UpsertChatMetadata applies conversation-level metadata delivered by history
// sync. A nil archived value means the sparse sync omitted that field, while a
// non-nil false value is an authoritative unarchive. Name follows the same
// preservation rule: a sparse sync cannot erase a known title.
func (s *Store) UpsertChatMetadata(ctx context.Context, jid, name string, archived *bool) error {
	resolved, err := s.ResolveChat(ctx, jid)
	if errors.Is(err, sql.ErrNoRows) {
		resolved, _, err = s.EnsureConversation(ctx, jid)
	}
	if err != nil {
		return err
	}
	var archivedValue any
	if archived != nil {
		archivedValue = *archived
	}
	_, err = s.db.ExecContext(ctx, `UPDATE chats SET name=CASE WHEN ?<>'' THEN ? ELSE name END, archived=CASE WHEN ? IS NULL THEN archived ELSE ? END WHERE jid=?`, name, name, archivedValue, archivedValue, resolved)
	return err
}

// SetChatMute records a chat's WhatsApp mute-until instant as Unix
// milliseconds; zero clears the mute. The chat is created if a mute mutation
// arrives before its first message, mirroring UpsertChatMetadata, so a mute
// synced from the phone for an otherwise-silent chat is not lost.
func (s *Store) SetChatMute(ctx context.Context, jid string, mutedUntilMillis int64) error {
	resolved, err := s.ResolveChat(ctx, jid)
	if errors.Is(err, sql.ErrNoRows) {
		resolved, _, err = s.EnsureConversation(ctx, jid)
	}
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `UPDATE chats SET muted_until=? WHERE jid=?`, mutedUntilMillis, resolved)
	return err
}

func (s *Store) ReserveOutgoing(ctx context.Context, clientRequestID, chatJID, text, messageID string) (string, bool, error) {
	resolved, resolveErr := s.ResolveChat(ctx, chatJID)
	if errors.Is(resolveErr, sql.ErrNoRows) {
		resolved, _, resolveErr = s.EnsureConversation(ctx, chatJID)
	}
	if resolveErr != nil {
		return "", false, resolveErr
	}
	chatJID = resolved
	var existingChat, existingText, existingID string
	err := s.db.QueryRowContext(ctx, `SELECT chat_jid,text,message_id FROM outgoing_requests WHERE client_request_id=?`, clientRequestID).Scan(&existingChat, &existingText, &existingID)
	if err == nil {
		if existingChat != chatJID || existingText != text {
			return "", true, fmt.Errorf("client_message_id already used with different payload")
		}
		return existingID, true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", false, err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO outgoing_requests(client_request_id,chat_jid,text,message_id,created_at) VALUES(?,?,?,?,?)`, clientRequestID, chatJID, text, messageID, time.Now().UnixMilli())
	return messageID, false, err
}

func (s *Store) ReserveOutgoingMessage(ctx context.Context, clientRequestID string, message domain.Message) (string, bool, error) {
	return s.ReserveOutgoingMessageWithPayload(ctx, clientRequestID, message.Text, message)
}

// ReserveOutgoingMessageWithPayload atomically reserves a pending message while
// comparing retries against an opaque payload fingerprint. This keeps the
// human-readable message preview separate from idempotency for binary sends.
func (s *Store) ReserveOutgoingMessageWithPayload(ctx context.Context, clientRequestID, payloadFingerprint string, message domain.Message) (string, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", false, err
	}
	defer tx.Rollback()
	resolvedChat, resolveErr := resolveOrCreateChatTx(ctx, tx, message.ChatJID)
	if resolveErr != nil {
		return "", false, resolveErr
	}
	message.ChatJID = resolvedChat
	if message.TransportJID == "" {
		if err = tx.QueryRowContext(ctx, `SELECT preferred_jid FROM chats WHERE jid=?`, resolvedChat).Scan(&message.TransportJID); err != nil {
			return "", false, err
		}
	}
	var chat, text, id string
	err = tx.QueryRowContext(ctx, `SELECT chat_jid,text,message_id FROM outgoing_requests WHERE client_request_id=?`, clientRequestID).Scan(&chat, &text, &id)
	if err == nil {
		if chat != message.ChatJID || text != payloadFingerprint {
			return "", true, fmt.Errorf("client_message_id already used with different payload")
		}
		return id, true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", false, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO outgoing_requests(client_request_id,chat_jid,text,message_id,created_at) VALUES(?,?,?,?,?)`, clientRequestID, message.ChatJID, payloadFingerprint, message.ID, time.Now().UnixMilli()); err != nil {
		return "", false, err
	}
	if err = applyMessageTx(ctx, tx, message, false); err != nil {
		return "", false, err
	}
	return message.ID, false, tx.Commit()
}

func unixMilli(value int64) time.Time {
	if value <= 0 {
		return time.Time{}
	}
	return time.UnixMilli(value)
}
