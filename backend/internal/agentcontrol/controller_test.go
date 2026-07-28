package agentcontrol

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rust-meow/rust-meow/backend/internal/domain"
	"github.com/rust-meow/rust-meow/backend/internal/store"
)

func TestParseCommand(t *testing.T) {
	tests := []struct {
		input                            string
		action, alias, workspace, prompt string
		ok                               bool
	}{
		{"hello", "", "", "", "", false},
		{"!meow ashman @rust-meow fix the tests", "start", "ashman", "rust-meow", "fix the tests", true},
		{"!MEOW Ashman status ABC123", "status", "ashman", "", "", true},
		{"!meow ashman stop CAFE", "stop", "ashman", "", "", true},
		{"!meow ashman approve A1B2C3", "approve", "ashman", "", "", true},
		{"!meow ashman", "help", "ashman", "", "", true},
	}
	for _, test := range tests {
		got, ok := ParseCommand(test.input)
		if ok != test.ok {
			t.Fatalf("ParseCommand(%q) ok=%v want %v", test.input, ok, test.ok)
		}
		if !ok {
			continue
		}
		if got.Action != test.action || got.Alias != test.alias || got.Workspace != test.workspace || got.Prompt != test.prompt {
			t.Fatalf("ParseCommand(%q)=%+v", test.input, got)
		}
	}
}

func TestLiveAppServerHandshake(t *testing.T) {
	if os.Getenv("RUST_MEOW_LIVE_CODEX") != "1" {
		t.Skip("set RUST_MEOW_LIVE_CODEX=1 for the local Codex smoke test")
	}
	codex, err := exec.LookPath("codex")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	server, err := StartAppServer(ctx, codex)
	if err != nil {
		t.Fatal(err)
	}
	server.Close()
	server, err = StartAppServer(ctx, codex)
	if err != nil {
		t.Fatal(err)
	}
	workspace := t.TempDir()
	var profiles struct {
		Data []struct {
			ID          string `json:"id"`
			Allowed     bool   `json:"allowed"`
			Description string `json:"description"`
		} `json:"data"`
	}
	if err = server.Call(ctx, "permissionProfile/list", map[string]any{"cwd": workspace}, &profiles); err != nil {
		t.Fatal(err)
	}
	t.Logf("permission profiles: %+v", profiles.Data)
	hasDangerProfile := false
	for _, profile := range profiles.Data {
		hasDangerProfile = hasDangerProfile || profile.ID == ":danger-full-access" && profile.Allowed
	}
	if !hasDangerProfile {
		t.Fatal("Codex does not allow the :danger-full-access permission profile")
	}
	threadID, err := server.StartThread(ctx, workspace, "")
	if err != nil {
		t.Fatal(err)
	}
	if threadID == "" {
		t.Fatal("empty thread id")
	}
	turnID, err := server.StartTurn(ctx, threadID, workspace, "Reply with exactly: ready", "")
	if err != nil {
		t.Fatal(err)
	}
	if turnID == "" {
		t.Fatal("empty turn id")
	}
	_ = server.Interrupt(ctx, threadID, turnID)
	_ = server.Call(ctx, "thread/delete", map[string]string{"threadId": threadID}, nil)
	server.Close()
}

func TestSplitMessageBoundsPartsAndLabelsChunks(t *testing.T) {
	text := strings.Repeat("a", 90) + "\n" + strings.Repeat("b", 90)
	parts := splitMessage(text, 100)
	if len(parts) != 2 {
		t.Fatalf("parts=%d want 2", len(parts))
	}
	for _, part := range parts {
		if !strings.HasPrefix(part, "(") || len(part) > 110 {
			t.Fatalf("unexpected part %q", part)
		}
	}
}

func TestShortRunIDIsPhoneFriendly(t *testing.T) {
	if got := shortRunID("run_12345678-abcd"); got != "12345678" {
		t.Fatalf("short id=%q", got)
	}
}

func TestConciseResultCollapsesWhitespaceAndCapsRunes(t *testing.T) {
	if got := conciseResult("done\n\nwith   tests", 50); got != "done with tests" {
		t.Fatalf("concise result=%q", got)
	}
	got := conciseResult(strings.Repeat("🐈", 20), 10)
	if len([]rune(got)) != 10 || !strings.HasSuffix(got, "…") {
		t.Fatalf("truncated result=%q runes=%d", got, len([]rune(got)))
	}
}

func TestOperatorCannotInterruptOutsideGrantedWorkspace(t *testing.T) {
	ctx := context.Background()
	productStore, err := store.Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer productStore.Close()

	allowed, err := productStore.SaveAgentWorkspace(ctx, store.AgentWorkspace{Alias: "allowed", Path: t.TempDir(), IsDefault: true})
	if err != nil {
		t.Fatal(err)
	}
	blocked, err := productStore.SaveAgentWorkspace(ctx, store.AgentWorkspace{Alias: "blocked", Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = productStore.SaveAgentSettings(ctx, store.AgentSettings{Enabled: true, Alias: "meow", CodexPath: "codex"}); err != nil {
		t.Fatal(err)
	}
	const controlAddress = "123456789@s.whatsapp.net"
	if err = productStore.UpsertChatName(ctx, controlAddress, "Control chat"); err != nil {
		t.Fatal(err)
	}
	controlChat, err := productStore.ResolveChat(ctx, controlAddress)
	if err != nil {
		t.Fatal(err)
	}
	if err = productStore.SetAgentControlChat(ctx, controlChat, true); err != nil {
		t.Fatal(err)
	}
	if _, err = productStore.SaveAgentGrant(ctx, store.AgentGrant{
		Role: "operator", Addresses: []string{"friend@s.whatsapp.net"}, WorkspaceIDs: []string{allowed.ID},
	}); err != nil {
		t.Fatal(err)
	}
	run, err := productStore.CreateAgentRun(ctx, store.AgentRun{
		ChatID: controlChat, SourceMessageID: "source", PrincipalAddress: "owner",
		WorkspaceID: blocked.ID, Status: "running", PromptPreview: "protected",
	})
	if err != nil {
		t.Fatal(err)
	}

	var replies []string
	controller := New(ctx, productStore, func(_ context.Context, chatID, text, _ string) (domain.Message, error) {
		replies = append(replies, text)
		return domain.Message{ID: "reply", ChatJID: chatID}, nil
	}, func(_ context.Context, addresses ...string) []string {
		return addresses
	}, func() string { return "owner@s.whatsapp.net" }, nil)
	defer controller.Close()

	controller.HandleMessage(domain.Message{
		ID: "command", ChatJID: controlChat, SenderJID: "friend@s.whatsapp.net",
		Kind: "text", Text: "!meow meow stop " + shortRunID(run.ID),
	})
	if len(replies) != 1 || !strings.Contains(replies[0], "cannot interrupt that workspace") {
		t.Fatalf("replies=%q", replies)
	}
	stored, err := productStore.AgentRun(ctx, run.ID)
	if err != nil || stored.Status != "running" {
		t.Fatalf("run status=%q err=%v", stored.Status, err)
	}
}
