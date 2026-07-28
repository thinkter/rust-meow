package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/rust-meow/rust-meow/backend/internal/domain"
)

var agentAliasPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,31}$`)

type AgentSettings struct {
	Enabled   bool
	Alias     string
	CodexPath string
}

type AgentWorkspace struct {
	ID        string
	Alias     string
	Path      string
	IsDefault bool
}

type AgentGrant struct {
	ID           string
	DisplayName  string
	Role         string
	Addresses    []string
	WorkspaceIDs []string
}

type AgentRun struct {
	ID, ChatID, SourceMessageID, PrincipalAddress, WorkspaceID string
	CodexThreadID, CodexTurnID, Status                         string
	PromptPreview, Summary, Error                              string
	CreatedAtMS, UpdatedAtMS                                   int64
}

type AgentApproval struct {
	ID, RunID, OwnerCode, Kind, Preview, Status, RequestID string
	ExpiresAtMS, CreatedAtMS                               int64
}

type AgentAuditEvent struct {
	ID, CreatedAtMS                     int64
	RunID, ActorAddress, Action, Detail string
}

func normalizeAgentAlias(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if !agentAliasPattern.MatchString(value) {
		return "", fmt.Errorf("alias must contain only lowercase letters, numbers, and hyphens")
	}
	return value, nil
}

func (s *Store) AgentSettings(ctx context.Context) (AgentSettings, error) {
	var out AgentSettings
	var enabled int
	err := s.db.QueryRowContext(ctx, `SELECT enabled,alias,codex_path FROM agent_settings WHERE singleton=1`).Scan(&enabled, &out.Alias, &out.CodexPath)
	if errors.Is(err, sql.ErrNoRows) {
		return AgentSettings{Alias: "meow", CodexPath: "codex"}, nil
	}
	out.Enabled = enabled != 0
	return out, err
}

func (s *Store) SaveAgentSettings(ctx context.Context, settings AgentSettings) (AgentSettings, error) {
	alias, err := normalizeAgentAlias(settings.Alias)
	if err != nil {
		return AgentSettings{}, err
	}
	settings.Alias = alias
	settings.CodexPath = strings.TrimSpace(settings.CodexPath)
	if settings.CodexPath == "" {
		settings.CodexPath = "codex"
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO agent_settings(singleton,enabled,alias,codex_path,updated_at)
VALUES(1,?,?,?,?) ON CONFLICT(singleton) DO UPDATE SET enabled=excluded.enabled,alias=excluded.alias,codex_path=excluded.codex_path,updated_at=excluded.updated_at`,
		settings.Enabled, settings.Alias, settings.CodexPath, time.Now().UnixMilli())
	return settings, err
}

func (s *Store) AgentWorkspaces(ctx context.Context) ([]AgentWorkspace, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,alias,path,is_default FROM agent_workspaces ORDER BY is_default DESC,alias`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AgentWorkspace
	for rows.Next() {
		var item AgentWorkspace
		var isDefault int
		if err = rows.Scan(&item.ID, &item.Alias, &item.Path, &isDefault); err != nil {
			return nil, err
		}
		item.IsDefault = isDefault != 0
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Store) SaveAgentWorkspace(ctx context.Context, item AgentWorkspace) (AgentWorkspace, error) {
	alias, err := normalizeAgentAlias(item.Alias)
	if err != nil {
		return AgentWorkspace{}, err
	}
	path, err := filepath.Abs(strings.TrimSpace(item.Path))
	if err != nil {
		return AgentWorkspace{}, err
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		return AgentWorkspace{}, fmt.Errorf("workspace path is unavailable: %w", err)
	}
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		return AgentWorkspace{}, fmt.Errorf("workspace path is unavailable")
	}
	if item.ID == "" {
		item.ID = "ws_" + uuid.NewString()
	}
	item.Alias, item.Path = alias, path
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return AgentWorkspace{}, err
	}
	defer tx.Rollback()
	if item.IsDefault {
		if _, err = tx.ExecContext(ctx, `UPDATE agent_workspaces SET is_default=0`); err != nil {
			return AgentWorkspace{}, err
		}
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO agent_workspaces(id,alias,path,is_default,created_at) VALUES(?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET alias=excluded.alias,path=excluded.path,is_default=excluded.is_default`,
		item.ID, item.Alias, item.Path, item.IsDefault, time.Now().UnixMilli())
	if err != nil {
		return AgentWorkspace{}, err
	}
	return item, tx.Commit()
}

func (s *Store) AgentWorkspace(ctx context.Context, idOrAlias string) (AgentWorkspace, error) {
	var item AgentWorkspace
	var isDefault int
	err := s.db.QueryRowContext(ctx, `SELECT id,alias,path,is_default FROM agent_workspaces WHERE id=? OR alias=?`, idOrAlias, idOrAlias).
		Scan(&item.ID, &item.Alias, &item.Path, &isDefault)
	item.IsDefault = isDefault != 0
	return item, err
}

func (s *Store) DefaultAgentWorkspace(ctx context.Context) (AgentWorkspace, error) {
	var item AgentWorkspace
	var isDefault int
	err := s.db.QueryRowContext(ctx, `SELECT id,alias,path,is_default FROM agent_workspaces ORDER BY is_default DESC,alias LIMIT 1`).
		Scan(&item.ID, &item.Alias, &item.Path, &isDefault)
	item.IsDefault = isDefault != 0
	return item, err
}

func (s *Store) DeleteAgentWorkspace(ctx context.Context, id string) error {
	var active int
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM agent_runs WHERE workspace_id=? AND status IN ('starting','running','waiting_approval')`, id).Scan(&active); err != nil {
		return err
	}
	if active != 0 {
		return fmt.Errorf("workspace has an active agent run")
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM agent_workspaces WHERE id=?`, id)
	return err
}

func (s *Store) AgentControlChats(ctx context.Context) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT chat_id FROM agent_control_chats ORDER BY chat_id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

func (s *Store) SetAgentControlChat(ctx context.Context, chatID string, enabled bool) error {
	if enabled {
		_, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO agent_control_chats(chat_id,created_at) VALUES(?,?)`, chatID, time.Now().UnixMilli())
		return err
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM agent_control_chats WHERE chat_id=?`, chatID)
	return err
}

func encodeStrings(values []string) string {
	clean := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" && !seen[value] {
			seen[value] = true
			clean = append(clean, value)
		}
	}
	sort.Strings(clean)
	raw, _ := json.Marshal(clean)
	return string(raw)
}

func decodeStrings(raw string) []string {
	var out []string
	_ = json.Unmarshal([]byte(raw), &out)
	return out
}

func (s *Store) AgentGrants(ctx context.Context) ([]AgentGrant, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,display_name,role,addresses_json,workspace_ids_json FROM agent_grants ORDER BY display_name,id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AgentGrant
	for rows.Next() {
		var item AgentGrant
		var addresses, workspaces string
		if err = rows.Scan(&item.ID, &item.DisplayName, &item.Role, &addresses, &workspaces); err != nil {
			return nil, err
		}
		item.Addresses, item.WorkspaceIDs = decodeStrings(addresses), decodeStrings(workspaces)
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Store) SaveAgentGrant(ctx context.Context, item AgentGrant) (AgentGrant, error) {
	item.Role = strings.ToLower(strings.TrimSpace(item.Role))
	if item.Role != "operator" && item.Role != "viewer" {
		return AgentGrant{}, fmt.Errorf("role must be operator or viewer")
	}
	if len(item.Addresses) == 0 || len(item.WorkspaceIDs) == 0 {
		return AgentGrant{}, fmt.Errorf("at least one identity and workspace are required")
	}
	for _, workspaceID := range item.WorkspaceIDs {
		var exists int
		if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM agent_workspaces WHERE id=?`, strings.TrimSpace(workspaceID)).Scan(&exists); err != nil {
			return AgentGrant{}, err
		}
		if exists != 1 {
			return AgentGrant{}, fmt.Errorf("workspace grant target does not exist")
		}
	}
	if item.ID == "" {
		item.ID = "grant_" + uuid.NewString()
	}
	now := time.Now().UnixMilli()
	_, err := s.db.ExecContext(ctx, `INSERT INTO agent_grants(id,display_name,role,addresses_json,workspace_ids_json,created_at,updated_at)
VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET display_name=excluded.display_name,role=excluded.role,addresses_json=excluded.addresses_json,workspace_ids_json=excluded.workspace_ids_json,updated_at=excluded.updated_at`,
		item.ID, strings.TrimSpace(item.DisplayName), item.Role, encodeStrings(item.Addresses), encodeStrings(item.WorkspaceIDs), now, now)
	return item, err
}

func (s *Store) DeleteAgentGrant(ctx context.Context, id string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM agent_grants WHERE id=?`, id)
	return err
}

func (s *Store) AgentRuns(ctx context.Context, limit int) ([]AgentRun, error) {
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id,chat_id,source_message_id,principal_address,workspace_id,codex_thread_id,codex_turn_id,status,prompt_preview,summary,error,created_at,updated_at FROM agent_runs ORDER BY updated_at DESC,id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AgentRun
	for rows.Next() {
		var item AgentRun
		if err = rows.Scan(&item.ID, &item.ChatID, &item.SourceMessageID, &item.PrincipalAddress, &item.WorkspaceID, &item.CodexThreadID, &item.CodexTurnID, &item.Status, &item.PromptPreview, &item.Summary, &item.Error, &item.CreatedAtMS, &item.UpdatedAtMS); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Store) CreateAgentRun(ctx context.Context, item AgentRun) (AgentRun, error) {
	if item.ID == "" {
		item.ID = "run_" + uuid.NewString()
	}
	now := time.Now().UnixMilli()
	item.CreatedAtMS, item.UpdatedAtMS = now, now
	_, err := s.db.ExecContext(ctx, `INSERT INTO agent_runs(id,chat_id,source_message_id,principal_address,workspace_id,status,prompt_preview,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
		item.ID, item.ChatID, item.SourceMessageID, item.PrincipalAddress, item.WorkspaceID, item.Status, item.PromptPreview, now, now)
	return item, err
}

func (s *Store) UpdateAgentRun(ctx context.Context, item AgentRun) error {
	_, err := s.db.ExecContext(ctx, `UPDATE agent_runs SET codex_thread_id=?,codex_turn_id=?,status=?,summary=?,error=?,updated_at=? WHERE id=?`,
		item.CodexThreadID, item.CodexTurnID, item.Status, item.Summary, item.Error, time.Now().UnixMilli(), item.ID)
	return err
}

func (s *Store) AgentRun(ctx context.Context, id string) (AgentRun, error) {
	var item AgentRun
	err := s.db.QueryRowContext(ctx, `SELECT id,chat_id,source_message_id,principal_address,workspace_id,codex_thread_id,codex_turn_id,status,prompt_preview,summary,error,created_at,updated_at FROM agent_runs WHERE id=?`, id).
		Scan(&item.ID, &item.ChatID, &item.SourceMessageID, &item.PrincipalAddress, &item.WorkspaceID, &item.CodexThreadID, &item.CodexTurnID, &item.Status, &item.PromptPreview, &item.Summary, &item.Error, &item.CreatedAtMS, &item.UpdatedAtMS)
	return item, err
}

func (s *Store) ActiveAgentRunCounts(ctx context.Context, workspaceID string) (workspace, total int, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT
sum(CASE WHEN workspace_id=? THEN 1 ELSE 0 END),count(*)
FROM agent_runs WHERE status IN ('starting','running','waiting_approval')`, workspaceID).Scan(&workspace, &total)
	return
}

func (s *Store) CreateAgentApproval(ctx context.Context, item AgentApproval) (AgentApproval, error) {
	if item.ID == "" {
		item.ID = "approval_" + uuid.NewString()
	}
	now := time.Now().UnixMilli()
	item.CreatedAtMS = now
	if item.ExpiresAtMS == 0 {
		item.ExpiresAtMS = now + int64((5*time.Minute)/time.Millisecond)
	}
	if item.Status == "" {
		item.Status = "pending"
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO agent_approvals(id,run_id,owner_code,kind,preview,status,request_id,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)`,
		item.ID, item.RunID, item.OwnerCode, item.Kind, item.Preview, item.Status, item.RequestID, item.ExpiresAtMS, item.CreatedAtMS)
	return item, err
}

func (s *Store) AgentApprovalByCode(ctx context.Context, code string) (AgentApproval, error) {
	var item AgentApproval
	err := s.db.QueryRowContext(ctx, `SELECT id,run_id,owner_code,kind,preview,status,request_id,expires_at,created_at FROM agent_approvals WHERE owner_code=?`, strings.ToUpper(strings.TrimSpace(code))).
		Scan(&item.ID, &item.RunID, &item.OwnerCode, &item.Kind, &item.Preview, &item.Status, &item.RequestID, &item.ExpiresAtMS, &item.CreatedAtMS)
	return item, err
}

func (s *Store) AgentApprovals(ctx context.Context, limit int) ([]AgentApproval, error) {
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id,run_id,owner_code,kind,preview,status,request_id,expires_at,created_at FROM agent_approvals ORDER BY created_at DESC,id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AgentApproval
	for rows.Next() {
		var item AgentApproval
		if err = rows.Scan(&item.ID, &item.RunID, &item.OwnerCode, &item.Kind, &item.Preview, &item.Status, &item.RequestID, &item.ExpiresAtMS, &item.CreatedAtMS); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Store) ResolveAgentApproval(ctx context.Context, id, status string) error {
	if status != "approved" && status != "denied" && status != "expired" {
		return fmt.Errorf("invalid approval status")
	}
	result, err := s.db.ExecContext(ctx, `UPDATE agent_approvals SET status=? WHERE id=? AND status='pending'`, status, id)
	if err != nil {
		return err
	}
	changed, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if changed != 1 {
		return fmt.Errorf("approval is no longer pending")
	}
	return nil
}

func (s *Store) LinkAgentMessage(ctx context.Context, chatID, messageID, runID string, generated bool) error {
	_, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO agent_message_links(chat_id,message_id,run_id,generated,created_at) VALUES(?,?,?,?,?)`, chatID, messageID, runID, generated, time.Now().UnixMilli())
	return err
}

func (s *Store) AgentMessageRun(ctx context.Context, chatID, messageID string) (string, bool, error) {
	var runID string
	var generated int
	err := s.db.QueryRowContext(ctx, `SELECT run_id,generated FROM agent_message_links WHERE chat_id=? AND message_id=?`, chatID, messageID).Scan(&runID, &generated)
	return runID, generated != 0, err
}

// AgentOwnerMessagesBetween returns newly persisted outgoing text messages in
// explicitly enabled control chats. It is used as a bounded fallback for
// linked-device/self-chat messages that WhatsApp may deliver through a sync
// path without a live message event.
func (s *Store) AgentOwnerMessagesBetween(ctx context.Context, afterMS, throughMS int64, limit int) ([]domain.Message, error) {
	if throughMS <= afterMS {
		return nil, nil
	}
	if limit <= 0 || limit > 200 {
		limit = 100
	}
	rows, err := s.db.QueryContext(ctx, `SELECT m.id,m.chat_jid,m.transport_jid,m.sender_jid,m.text,m.timestamp,m.from_me,m.kind,m.reply_to_id,m.reply_to_chat_id,m.edited_at,m.revoked
FROM messages m JOIN agent_control_chats c ON c.chat_id=m.chat_jid
WHERE m.from_me=1 AND m.kind='text' AND m.timestamp>? AND m.timestamp<=?
ORDER BY m.timestamp,m.id LIMIT ?`, afterMS, throughMS, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]domain.Message, 0, limit)
	for rows.Next() {
		var item domain.Message
		var fromMe, revoked int
		var timestampMS, editedAtMS int64
		if err = rows.Scan(&item.ID, &item.ChatJID, &item.TransportJID, &item.SenderJID, &item.Text, &timestampMS, &fromMe, &item.Kind, &item.ReplyToID, &item.ReplyToChatID, &editedAtMS, &revoked); err != nil {
			return nil, err
		}
		item.Timestamp = time.UnixMilli(timestampMS)
		item.FromMe = fromMe != 0
		item.Revoked = revoked != 0
		if editedAtMS > 0 {
			item.EditedAt = time.UnixMilli(editedAtMS)
		}
		out = append(out, item)
	}
	return out, rows.Err()
}

func (s *Store) AddAgentAudit(ctx context.Context, runID, actor, action, detail string) error {
	if len(detail) > 1000 {
		detail = detail[:1000]
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO agent_audit(run_id,actor_address,action,detail,created_at) VALUES(?,?,?,?,?)`, runID, actor, action, detail, time.Now().UnixMilli())
	return err
}

func (s *Store) AgentAudit(ctx context.Context, limit int) ([]AgentAuditEvent, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	rows, err := s.db.QueryContext(ctx, `SELECT id,run_id,actor_address,action,detail,created_at FROM agent_audit ORDER BY created_at DESC,id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AgentAuditEvent
	for rows.Next() {
		var item AgentAuditEvent
		if err = rows.Scan(&item.ID, &item.RunID, &item.ActorAddress, &item.Action, &item.Detail, &item.CreatedAtMS); err != nil {
			return nil, err
		}
		out = append(out, item)
	}
	return out, rows.Err()
}
