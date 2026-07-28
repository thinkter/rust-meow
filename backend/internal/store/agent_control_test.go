package store

import (
	"context"
	"path/filepath"
	"testing"
)

func TestAgentControlPolicyPersistsAndClearsWithAccount(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	workspaceDir := t.TempDir()
	settings, err := s.SaveAgentSettings(ctx, AgentSettings{Enabled: true, Alias: "ashman", CodexPath: "codex"})
	if err != nil || !settings.Enabled {
		t.Fatalf("save settings: %+v %v", settings, err)
	}
	workspace, err := s.SaveAgentWorkspace(ctx, AgentWorkspace{Alias: "rust-meow", Path: workspaceDir, IsDefault: true})
	if err != nil {
		t.Fatal(err)
	}
	grant, err := s.SaveAgentGrant(ctx, AgentGrant{
		DisplayName: "Friend", Role: "operator",
		Addresses: []string{"123@s.whatsapp.net", "abc@lid"}, WorkspaceIDs: []string{workspace.ID},
	})
	if err != nil {
		t.Fatal(err)
	}
	if grant.ID == "" || len(grant.Addresses) != 2 {
		t.Fatalf("grant=%+v", grant)
	}
	run, err := s.CreateAgentRun(ctx, AgentRun{
		ChatID: "chat-1", SourceMessageID: "message-1", PrincipalAddress: grant.Addresses[0],
		WorkspaceID: workspace.ID, Status: "starting", PromptPreview: "test",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err = s.LinkAgentMessage(ctx, "chat-1", "agent-reply", run.ID, true); err != nil {
		t.Fatal(err)
	}
	if got, generated, lookupErr := s.AgentMessageRun(ctx, "chat-1", "agent-reply"); lookupErr != nil || got != run.ID || !generated {
		t.Fatalf("message link=%q generated=%v err=%v", got, generated, lookupErr)
	}
	if err = s.ClearAccountData(ctx); err != nil {
		t.Fatal(err)
	}
	settings, err = s.AgentSettings(ctx)
	if err != nil || settings.Enabled || settings.Alias != "meow" {
		t.Fatalf("cleared settings=%+v err=%v", settings, err)
	}
}

func TestAgentGrantRejectsInvalidRoleAndEmptyScope(t *testing.T) {
	ctx := context.Background()
	s, err := Open(ctx, filepath.Join(t.TempDir(), "client.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if _, err = s.SaveAgentGrant(ctx, AgentGrant{Role: "owner", Addresses: []string{"x"}, WorkspaceIDs: []string{"y"}}); err == nil {
		t.Fatal("expected owner grant to be rejected")
	}
	if _, err = s.SaveAgentGrant(ctx, AgentGrant{Role: "operator"}); err == nil {
		t.Fatal("expected empty scope to be rejected")
	}
	if _, err = s.SaveAgentGrant(ctx, AgentGrant{Role: "operator", Addresses: []string{"x"}, WorkspaceIDs: []string{"missing"}}); err == nil {
		t.Fatal("expected an unknown workspace to be rejected")
	}
}
