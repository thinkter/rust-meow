package agentcontrol

import (
	"context"
	"crypto/rand"
	"database/sql"
	_ "embed"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/rust-meow/rust-meow/backend/internal/domain"
	"github.com/rust-meow/rust-meow/backend/internal/store"
)

//go:embed whatsapp_remote_session.md
var remoteSessionSkill []byte

const (
	maxPromptRunes  = 4000
	maxWhatsAppPart = 3500
)

func isActiveStatus(status string) bool {
	return status == "starting" || status == "running" || status == "waiting_approval"
}

type Sender func(context.Context, string, string, string) (domain.Message, error)
type IdentityAliases func(context.Context, ...string) []string
type StatusSink func()

type Controller struct {
	ctx        context.Context
	cancel     context.CancelFunc
	store      *store.Store
	send       Sender
	aliases    IdentityAliases
	ownID      func() string
	statusSink StatusSink
	skillPath  string

	mu            sync.Mutex
	app           *AppServer
	threadRuns    map[string]string
	active        map[string]context.CancelFunc
	approvalIDs   map[string]json.RawMessage
	planMilestone map[string]bool
	seenMessages  map[string]struct{}
}

type ParsedCommand struct {
	Alias, Workspace, Action, Prompt, Code, RunID string
}

func ParseCommand(text string) (ParsedCommand, bool) {
	fields := strings.Fields(strings.TrimSpace(text))
	if len(fields) < 2 || !strings.EqualFold(fields[0], "!meow") {
		return ParsedCommand{}, false
	}
	out := ParsedCommand{Alias: strings.ToLower(fields[1]), Action: "start"}
	fields = fields[2:]
	if len(fields) > 0 && strings.HasPrefix(fields[0], "@") {
		out.Workspace = strings.ToLower(strings.TrimPrefix(fields[0], "@"))
		fields = fields[1:]
	}
	if len(fields) == 0 {
		out.Action = "help"
		return out, true
	}
	switch strings.ToLower(fields[0]) {
	case "help":
		out.Action = "help"
	case "status":
		out.Action = "status"
		if len(fields) > 1 {
			out.RunID = fields[1]
		}
	case "stop":
		out.Action = "stop"
		if len(fields) > 1 {
			out.RunID = fields[1]
		}
	case "approve", "deny":
		out.Action = strings.ToLower(fields[0])
		if len(fields) > 1 {
			out.Code = strings.ToUpper(fields[1])
		}
	default:
		out.Prompt = strings.Join(fields, " ")
	}
	return out, true
}

func New(ctx context.Context, productStore *store.Store, send Sender, aliases IdentityAliases, ownID func() string, statusSink StatusSink) *Controller {
	skillPath := os.Getenv("RUST_MEOW_CODEX_SKILL")
	if skillPath == "" {
		skillPath = materializeRemoteSessionSkill()
	}
	controllerCtx, cancel := context.WithCancel(ctx)
	controller := &Controller{
		ctx: controllerCtx, cancel: cancel, store: productStore, send: send, aliases: aliases, ownID: ownID,
		statusSink: statusSink, skillPath: skillPath,
		threadRuns: make(map[string]string), active: make(map[string]context.CancelFunc),
		approvalIDs: make(map[string]json.RawMessage), planMilestone: make(map[string]bool),
		seenMessages: make(map[string]struct{}),
	}
	go controller.watchOwnerMessages(time.Now().UnixMilli())
	return controller
}

func materializeRemoteSessionSkill() string {
	cache, err := os.UserCacheDir()
	if err != nil {
		return ""
	}
	directory := filepath.Join(cache, "rust-meow", "codex-skills", "whatsapp-remote-session")
	if err = os.MkdirAll(directory, 0o700); err != nil {
		return ""
	}
	path := filepath.Join(directory, "SKILL.md")
	if err = os.WriteFile(path, remoteSessionSkill, 0o600); err != nil {
		return ""
	}
	return path
}

func (c *Controller) Close() {
	c.cancel()
	c.mu.Lock()
	app := c.app
	c.app = nil
	cancels := make([]context.CancelFunc, 0, len(c.active))
	for _, cancel := range c.active {
		cancels = append(cancels, cancel)
	}
	c.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
	if app != nil {
		app.Close()
	}
}

func (c *Controller) Running() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.app != nil
}

func (c *Controller) Interrupt(runID, actor string) error {
	run, err := c.store.AgentRun(c.ctx, runID)
	if err != nil {
		return err
	}
	if !isActiveStatus(run.Status) {
		return fmt.Errorf("run is not active")
	}
	c.mu.Lock()
	app := c.app
	cancel := c.active[run.ID]
	c.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	c.mu.Lock()
	delete(c.active, run.ID)
	c.mu.Unlock()
	if app != nil && run.CodexThreadID != "" && run.CodexTurnID != "" {
		_ = app.Interrupt(c.ctx, run.CodexThreadID, run.CodexTurnID)
	}
	run.Status = "interrupted"
	if err = c.store.UpdateAgentRun(c.ctx, run); err != nil {
		return err
	}
	_ = c.store.AddAgentAudit(c.ctx, run.ID, actor, "run_interrupted", "")
	c.changed()
	return nil
}

func (c *Controller) ResolveApproval(code string, approve bool, actor string) error {
	approval, err := c.store.AgentApprovalByCode(c.ctx, code)
	if err != nil {
		return err
	}
	if approval.Status != "pending" || time.Now().UnixMilli() > approval.ExpiresAtMS {
		return fmt.Errorf("approval is expired or already resolved")
	}
	c.mu.Lock()
	requestID := c.approvalIDs[approval.OwnerCode]
	app := c.app
	c.mu.Unlock()
	if app == nil || len(requestID) == 0 {
		return fmt.Errorf("Codex is no longer waiting for this approval")
	}
	decision, status := "decline", "denied"
	if approve {
		decision, status = "accept", "approved"
	}
	if err = app.Respond(requestID, map[string]any{"decision": decision}); err != nil {
		return err
	}
	if err = c.store.ResolveAgentApproval(c.ctx, approval.ID, status); err != nil {
		return err
	}
	run, err := c.store.AgentRun(c.ctx, approval.RunID)
	if err == nil {
		run.Status = "running"
		_ = c.store.UpdateAgentRun(c.ctx, run)
		_ = c.store.AddAgentAudit(c.ctx, run.ID, actor, "approval_"+status, approval.Kind)
	}
	c.changed()
	return nil
}

func (c *Controller) HandleMessage(message domain.Message) {
	if message.Kind != "text" || message.Text == "" || message.EditedAt.UnixMilli() > 0 || message.Revoked {
		return
	}
	settings, err := c.store.AgentSettings(c.ctx)
	if err != nil || !settings.Enabled {
		return
	}
	chats, err := c.store.AgentControlChats(c.ctx)
	if err != nil || !slices.Contains(chats, message.ChatJID) {
		return
	}
	if _, generated, linkErr := c.store.AgentMessageRun(c.ctx, message.ChatJID, message.ID); linkErr == nil && generated {
		return
	}
	if !c.claimMessage(message.ChatJID, message.ID) {
		return
	}
	command, addressed := ParseCommand(message.Text)
	if !addressed && message.ReplyToID != "" {
		runID, generated, linkErr := c.store.AgentMessageRun(c.ctx, message.ChatJID, message.ReplyToID)
		if linkErr == nil && generated {
			run, runErr := c.store.AgentRun(c.ctx, runID)
			if runErr == nil {
				c.continueRun(message, run, strings.TrimSpace(message.Text))
			}
		}
		return
	}
	if !addressed || command.Alias != settings.Alias {
		return
	}
	aliases := c.aliases(c.ctx, message.SenderJID)
	if len(aliases) == 0 {
		aliases = []string{message.SenderJID}
	}
	owner := message.FromMe || slices.Contains(aliases, c.ownID())
	role, workspaceIDs := c.roleFor(aliases, owner)
	if role == "" {
		_ = c.store.AddAgentAudit(c.ctx, "", message.SenderJID, "denied", "identity is not authorized")
		c.reply("", message, "Agent Control denied: your WhatsApp identity has no grant.")
		return
	}
	switch command.Action {
	case "help":
		c.reply("", message, fmt.Sprintf("Agent %s\nStart: !meow %s @workspace <task>\nCommands: status, stop <run>, approve <code>, deny <code>\nReplies continue the referenced run.", settings.Alias, settings.Alias))
	case "status":
		c.sendStatus(message, role, workspaceIDs, command.RunID)
	case "stop":
		if role == "viewer" {
			c.reply("", message, "Viewer grants cannot interrupt runs.")
			return
		}
		c.stopRun(message, command.RunID, workspaceIDs)
	case "approve", "deny":
		if !owner {
			c.reply("", message, "Only the machine owner can resolve Codex approvals.")
			return
		}
		c.resolveApproval(message, command.Code, command.Action == "approve")
	case "start":
		if role == "viewer" {
			c.reply("", message, "Viewer grants can inspect status but cannot start runs.")
			return
		}
		c.startRun(message, settings, workspaceIDs, command)
	}
}

func (c *Controller) claimMessage(chatID, messageID string) bool {
	key := chatID + "\x00" + messageID
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, exists := c.seenMessages[key]; exists {
		return false
	}
	if len(c.seenMessages) >= 10_000 {
		clear(c.seenMessages)
	}
	c.seenMessages[key] = struct{}{}
	return true
}

func (c *Controller) watchOwnerMessages(afterMS int64) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-c.ctx.Done():
			return
		case now := <-ticker.C:
			// Keep a short lag behind wall time so a message transaction with a
			// server timestamp near the scan boundary is committed before the
			// cursor advances past it.
			throughMS := now.Add(-2 * time.Second).UnixMilli()
			if throughMS <= afterMS {
				continue
			}
			messages, err := c.store.AgentOwnerMessagesBetween(c.ctx, afterMS, throughMS, 200)
			if err != nil {
				continue
			}
			for _, message := range messages {
				c.HandleMessage(message)
			}
			afterMS = throughMS
		}
	}
}

func (c *Controller) roleFor(addresses []string, owner bool) (string, []string) {
	workspaces, _ := c.store.AgentWorkspaces(c.ctx)
	if owner {
		ids := make([]string, len(workspaces))
		for i := range workspaces {
			ids[i] = workspaces[i].ID
		}
		return "owner", ids
	}
	grants, err := c.store.AgentGrants(c.ctx)
	if err != nil {
		return "", nil
	}
	for _, grant := range grants {
		if slices.ContainsFunc(addresses, func(address string) bool { return slices.Contains(grant.Addresses, address) }) {
			return grant.Role, grant.WorkspaceIDs
		}
	}
	return "", nil
}

func (c *Controller) startRun(message domain.Message, settings store.AgentSettings, allowed []string, command ParsedCommand) {
	prompt := strings.TrimSpace(command.Prompt)
	if prompt == "" {
		c.reply("", message, "Add a task after the agent alias.")
		return
	}
	if utf8.RuneCountInString(prompt) > maxPromptRunes {
		c.reply("", message, "Task is too long; keep it under 4,000 characters.")
		return
	}
	var workspace store.AgentWorkspace
	var err error
	if command.Workspace == "" {
		workspace, err = c.store.DefaultAgentWorkspace(c.ctx)
	} else {
		workspace, err = c.store.AgentWorkspace(c.ctx, command.Workspace)
	}
	if err != nil {
		c.reply("", message, "Unknown workspace. Choose one configured in Agent Control.")
		return
	}
	if !slices.Contains(allowed, workspace.ID) {
		c.reply("", message, "Your role is not granted access to that workspace.")
		return
	}
	workspaceActive, totalActive, err := c.store.ActiveAgentRunCounts(c.ctx, workspace.ID)
	if err != nil || workspaceActive > 0 || totalActive >= 3 {
		c.reply("", message, "Agent host is busy for that workspace. Use status or stop the active run.")
		return
	}
	preview := prompt
	if len(preview) > 180 {
		preview = preview[:180] + "…"
	}
	run, err := c.store.CreateAgentRun(c.ctx, store.AgentRun{
		ChatID: message.ChatJID, SourceMessageID: message.ID, PrincipalAddress: message.SenderJID,
		WorkspaceID: workspace.ID, Status: "starting", PromptPreview: preview,
	})
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return
		}
		c.reply("", message, "Could not create the agent run.")
		return
	}
	_ = c.store.LinkAgentMessage(c.ctx, message.ChatJID, message.ID, run.ID, false)
	_ = c.store.AddAgentAudit(c.ctx, run.ID, message.SenderJID, "run_started", workspace.Alias)
	c.reply(run.ID, message, fmt.Sprintf("Accepted %s in @%s. Codex is starting with workspace-only access and network disabled.", shortRunID(run.ID), workspace.Alias))
	runCtx, cancel := context.WithCancel(c.ctx)
	c.mu.Lock()
	c.active[run.ID] = cancel
	c.mu.Unlock()
	c.changed()
	go c.execute(runCtx, run, workspace, prompt, settings.CodexPath, false)
}

func (c *Controller) continueRun(message domain.Message, run store.AgentRun, prompt string) {
	if prompt == "" || utf8.RuneCountInString(prompt) > maxPromptRunes {
		c.reply(run.ID, message, "Reply with a task under 4,000 characters.")
		return
	}
	aliases := c.aliases(c.ctx, message.SenderJID)
	role, allowed := c.roleFor(aliases, message.FromMe || slices.Contains(aliases, c.ownID()))
	if role == "" || role == "viewer" || !slices.Contains(allowed, run.WorkspaceID) {
		c.reply(run.ID, message, "Your role cannot continue this run.")
		return
	}
	workspace, err := c.store.AgentWorkspace(c.ctx, run.WorkspaceID)
	if err != nil {
		return
	}
	c.mu.Lock()
	app := c.app
	c.mu.Unlock()
	if run.Status == "running" && app != nil && run.CodexTurnID != "" {
		if err = app.Steer(c.ctx, run.CodexThreadID, run.CodexTurnID, prompt); err == nil {
			c.reply(run.ID, message, fmt.Sprintf("Steered %s with your reply.", shortRunID(run.ID)))
			return
		}
	}
	if run.Status != "completed" && run.Status != "failed" && run.Status != "interrupted" {
		c.reply(run.ID, message, "That run is not ready for another turn.")
		return
	}
	run.Status, run.Error, run.Summary = "starting", "", ""
	_ = c.store.UpdateAgentRun(c.ctx, run)
	settings, settingsErr := c.store.AgentSettings(c.ctx)
	if settingsErr != nil {
		c.failRun(&run, "Agent Control settings are unavailable.")
		return
	}
	runCtx, cancel := context.WithCancel(c.ctx)
	c.mu.Lock()
	c.active[run.ID] = cancel
	c.mu.Unlock()
	c.reply(run.ID, message, fmt.Sprintf("Continuing %s in @%s.", shortRunID(run.ID), workspace.Alias))
	go c.execute(runCtx, run, workspace, prompt, settings.CodexPath, true)
}

func (c *Controller) ensureApp(settingsPath string) (*AppServer, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.app != nil {
		return c.app, nil
	}
	if settingsPath == "" {
		settingsPath = "codex"
	}
	app, err := StartAppServer(c.ctx, settingsPath)
	if err != nil {
		return nil, err
	}
	c.app = app
	go c.eventLoop(app)
	return app, nil
}

func (c *Controller) execute(ctx context.Context, run store.AgentRun, workspace store.AgentWorkspace, prompt, codexPath string, resume bool) {
	app, err := c.ensureApp(codexPath)
	if err != nil {
		c.failRun(&run, "Codex app-server could not start. Check the Codex path, login, and version.")
		return
	}
	if !resume || run.CodexThreadID == "" {
		run.CodexThreadID, err = app.StartThread(ctx, workspace.Path, c.skillPath)
		if err != nil {
			c.failRun(&run, "Codex rejected the workspace-restricted session: "+safeError(err))
			return
		}
		c.mu.Lock()
		c.threadRuns[run.CodexThreadID] = run.ID
		c.mu.Unlock()
	}
	run.CodexTurnID, err = app.StartTurn(ctx, run.CodexThreadID, workspace.Path, prompt, c.skillPath)
	if err != nil {
		c.failRun(&run, "Codex could not start the turn: "+safeError(err))
		return
	}
	run.Status = "running"
	_ = c.store.UpdateAgentRun(c.ctx, run)
	c.changed()
}

func (c *Controller) eventLoop(app *AppServer) {
	for event := range app.Events() {
		c.handleAppEvent(app, event)
	}
	c.mu.Lock()
	activeRunIDs := make([]string, 0, len(c.active))
	for runID, cancel := range c.active {
		cancel()
		activeRunIDs = append(activeRunIDs, runID)
	}
	clear(c.active)
	if c.app == app {
		c.app = nil
	}
	c.mu.Unlock()
	for _, runID := range activeRunIDs {
		run, err := c.store.AgentRun(c.ctx, runID)
		if err != nil || !isActiveStatus(run.Status) {
			continue
		}
		run.Status = "failed"
		run.Error = "Codex app-server stopped before the run completed."
		_ = c.store.UpdateAgentRun(c.ctx, run)
		_ = c.store.AddAgentAudit(c.ctx, run.ID, "", "run_failed", "app-server stopped")
	}
	if len(activeRunIDs) > 0 {
		c.changed()
	}
}

func (c *Controller) handleAppEvent(app *AppServer, event appEvent) {
	var envelope struct {
		ThreadID string `json:"threadId"`
		TurnID   string `json:"turnId"`
		Turn     struct {
			ID     string `json:"id"`
			Status string `json:"status"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		} `json:"turn"`
		Item struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"item"`
		Plan []struct {
			Step   string `json:"step"`
			Status string `json:"status"`
		} `json:"plan"`
		Command []string `json:"command"`
		Cwd     string   `json:"cwd"`
		Reason  string   `json:"reason"`
	}
	_ = json.Unmarshal(event.Params, &envelope)
	threadID := envelope.ThreadID
	if threadID == "" {
		var withThread struct {
			Thread struct {
				ID string `json:"id"`
			} `json:"thread"`
		}
		_ = json.Unmarshal(event.Params, &withThread)
		threadID = withThread.Thread.ID
	}
	c.mu.Lock()
	runID := c.threadRuns[threadID]
	c.mu.Unlock()
	if runID == "" {
		return
	}
	run, err := c.store.AgentRun(c.ctx, runID)
	if err != nil {
		return
	}
	switch event.Method {
	case "turn/plan/updated":
		c.mu.Lock()
		already := c.planMilestone[runID]
		c.planMilestone[runID] = true
		c.mu.Unlock()
		if !already && len(envelope.Plan) > 0 {
			steps := make([]string, 0, min(3, len(envelope.Plan)))
			for _, step := range envelope.Plan[:min(3, len(envelope.Plan))] {
				steps = append(steps, "• "+step.Step)
			}
			c.sendRun(run, "Plan for "+shortRunID(run.ID)+":\n"+strings.Join(steps, "\n"))
		}
	case "item/completed":
		if envelope.Item.Type == "agentMessage" && strings.TrimSpace(envelope.Item.Text) != "" {
			run.Summary = envelope.Item.Text
			_ = c.store.UpdateAgentRun(c.ctx, run)
		}
	case "turn/completed":
		if envelope.Turn.Status == "failed" {
			run.Status = "failed"
			if envelope.Turn.Error != nil {
				run.Error = envelope.Turn.Error.Message
			}
		} else if envelope.Turn.Status == "interrupted" {
			run.Status = "interrupted"
		} else {
			run.Status = "completed"
		}
		_ = c.store.UpdateAgentRun(c.ctx, run)
		if run.Summary != "" {
			c.sendRun(run, fmt.Sprintf("%s completed:\n%s", shortRunID(run.ID), run.Summary))
		} else {
			c.sendRun(run, fmt.Sprintf("%s finished with status %s.", shortRunID(run.ID), run.Status))
		}
		_ = c.store.AddAgentAudit(c.ctx, run.ID, "", "run_"+run.Status, "")
		c.mu.Lock()
		if cancel := c.active[run.ID]; cancel != nil {
			cancel()
		}
		delete(c.active, run.ID)
		c.mu.Unlock()
		c.changed()
	case "item/commandExecution/requestApproval", "item/fileChange/requestApproval":
		code := approvalCode()
		preview := envelope.Reason
		if len(envelope.Command) > 0 {
			preview = strings.Join(envelope.Command, " ")
		}
		if preview == "" {
			preview = "Codex requested a protected action."
		}
		kind := "file change"
		if strings.Contains(event.Method, "commandExecution") {
			kind = "command"
		}
		requestID := string(event.ID)
		approval, createErr := c.store.CreateAgentApproval(c.ctx, store.AgentApproval{
			RunID: run.ID, OwnerCode: code, Kind: kind, Preview: preview, RequestID: requestID,
		})
		if createErr != nil {
			_ = app.Respond(event.ID, map[string]any{"decision": "decline"})
			return
		}
		c.mu.Lock()
		c.approvalIDs[approval.OwnerCode] = event.ID
		c.mu.Unlock()
		run.Status = "waiting_approval"
		_ = c.store.UpdateAgentRun(c.ctx, run)
		settings, _ := c.store.AgentSettings(c.ctx)
		c.sendRun(run, fmt.Sprintf("Owner approval needed for %s (%s):\n%s\nReply `!meow %s approve %s` or `!meow %s deny %s` within 5 minutes.", shortRunID(run.ID), kind, preview, settings.Alias, code, settings.Alias, code))
	case "item/permissions/requestApproval", "item/tool/requestUserInput", "mcpServer/elicitation/request":
		_ = app.Respond(event.ID, map[string]any{"decision": "decline"})
	}
}

func (c *Controller) resolveApproval(message domain.Message, code string, approve bool) {
	approval, lookupErr := c.store.AgentApprovalByCode(c.ctx, code)
	if lookupErr != nil {
		c.reply("", message, "That approval is missing, expired, or already resolved.")
		return
	}
	if err := c.ResolveApproval(code, approve, message.SenderJID); err != nil {
		c.reply(approval.RunID, message, "Could not resolve approval: "+safeError(err))
		return
	}
	status := "denied"
	if approve {
		status = "approved"
	}
	c.reply(approval.RunID, message, fmt.Sprintf("%s %s for %s.", approval.Kind, status, shortRunID(approval.RunID)))
}

func (c *Controller) stopRun(message domain.Message, runID string, workspaces []string) {
	runID = c.expandRunID(runID)
	run, err := c.store.AgentRun(c.ctx, runID)
	if err != nil {
		c.reply("", message, "Run not found.")
		return
	}
	if !slices.Contains(workspaces, run.WorkspaceID) {
		c.reply("", message, "Your role cannot interrupt that workspace.")
		return
	}
	if err = c.Interrupt(run.ID, message.SenderJID); err != nil {
		c.reply(run.ID, message, "Could not interrupt the run: "+safeError(err))
		return
	}
	c.reply(run.ID, message, "Interrupted "+shortRunID(run.ID)+".")
}

func (c *Controller) sendStatus(message domain.Message, role string, workspaces []string, requested string) {
	runs, err := c.store.AgentRuns(c.ctx, 20)
	if err != nil {
		return
	}
	lines := []string{"Agent Control status (" + role + ")"}
	for _, run := range runs {
		if requested != "" && run.ID != c.expandRunID(requested) {
			continue
		}
		if !slices.Contains(workspaces, run.WorkspaceID) {
			continue
		}
		workspace, _ := c.store.AgentWorkspace(c.ctx, run.WorkspaceID)
		lines = append(lines, fmt.Sprintf("%s @%s — %s", shortRunID(run.ID), workspace.Alias, run.Status))
		if len(lines) == 6 {
			break
		}
	}
	if len(lines) == 1 {
		lines = append(lines, "No visible runs yet.")
	}
	c.reply("", message, strings.Join(lines, "\n"))
}

func (c *Controller) expandRunID(value string) string {
	if strings.HasPrefix(value, "run_") {
		return value
	}
	runs, _ := c.store.AgentRuns(c.ctx, 200)
	for _, run := range runs {
		if strings.EqualFold(shortRunID(run.ID), value) {
			return run.ID
		}
	}
	return value
}

func (c *Controller) failRun(run *store.AgentRun, message string) {
	run.Status, run.Error = "failed", message
	_ = c.store.UpdateAgentRun(c.ctx, *run)
	_ = c.store.AddAgentAudit(c.ctx, run.ID, "", "run_failed", message)
	c.sendRun(*run, shortRunID(run.ID)+" failed: "+message)
	c.mu.Lock()
	if cancel := c.active[run.ID]; cancel != nil {
		cancel()
	}
	delete(c.active, run.ID)
	c.mu.Unlock()
	c.changed()
}

func (c *Controller) reply(runID string, source domain.Message, text string) {
	message, err := c.send(c.ctx, source.ChatJID, text, source.ID)
	if err == nil && runID != "" {
		_ = c.store.LinkAgentMessage(c.ctx, source.ChatJID, message.ID, runID, true)
	}
}

func (c *Controller) sendRun(run store.AgentRun, text string) {
	parts := splitMessage(text, maxWhatsAppPart)
	replyTo := run.SourceMessageID
	for _, part := range parts {
		message, err := c.send(c.ctx, run.ChatID, part, replyTo)
		if err != nil {
			return
		}
		_ = c.store.LinkAgentMessage(c.ctx, run.ChatID, message.ID, run.ID, true)
		replyTo = message.ID
	}
}

func (c *Controller) changed() {
	if c.statusSink != nil {
		c.statusSink()
	}
}

func splitMessage(text string, max int) []string {
	if len(text) <= max {
		return []string{text}
	}
	var parts []string
	for len(text) > max {
		cut := strings.LastIndex(text[:max], "\n")
		if cut < max/2 {
			cut = max
		}
		parts = append(parts, text[:cut])
		text = strings.TrimSpace(text[cut:])
	}
	if text != "" {
		parts = append(parts, text)
	}
	for i := range parts {
		parts[i] = fmt.Sprintf("(%d/%d) %s", i+1, len(parts), parts[i])
	}
	return parts
}

func shortRunID(id string) string {
	id = strings.TrimPrefix(id, "run_")
	id = strings.ReplaceAll(id, "-", "")
	if len(id) > 8 {
		id = id[:8]
	}
	return strings.ToUpper(id)
}

func approvalCode() string {
	var raw [3]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return strings.ToUpper(uuid.NewString()[:6])
	}
	return strings.ToUpper(hex.EncodeToString(raw[:]))
}

func safeError(err error) string {
	text := strings.ReplaceAll(err.Error(), "\n", " ")
	home, _ := os.UserHomeDir()
	if home != "" {
		text = strings.ReplaceAll(text, home, "<home>")
	}
	if len(text) > 300 {
		text = text[:300]
	}
	return text
}

func SkillPathFromPluginRoot(root string) string {
	if root == "" {
		return ""
	}
	return filepath.Join(root, "skills", "whatsapp-remote-session", "SKILL.md")
}
