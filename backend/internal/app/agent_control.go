package app

import (
	bridgev1 "github.com/rust-meow/rust-meow/backend/gen/bridgev1"
)

func (s *Server) agentControlState() (*bridgev1.AgentControlState, error) {
	settings, err := s.store.AgentSettings(s.ctx)
	if err != nil {
		return nil, err
	}
	workspaces, err := s.store.AgentWorkspaces(s.ctx)
	if err != nil {
		return nil, err
	}
	chats, err := s.store.AgentControlChats(s.ctx)
	if err != nil {
		return nil, err
	}
	grants, err := s.store.AgentGrants(s.ctx)
	if err != nil {
		return nil, err
	}
	runs, err := s.store.AgentRuns(s.ctx, 100)
	if err != nil {
		return nil, err
	}
	approvals, err := s.store.AgentApprovals(s.ctx, 100)
	if err != nil {
		return nil, err
	}
	audit, err := s.store.AgentAudit(s.ctx, 200)
	if err != nil {
		return nil, err
	}
	out := &bridgev1.AgentControlState{
		Settings:       &bridgev1.AgentSettings{Enabled: settings.Enabled, Alias: settings.Alias, CodexPath: settings.CodexPath, CodexRunning: s.agent != nil && s.agent.Running()},
		ControlChatIds: chats,
	}
	for _, item := range workspaces {
		out.Workspaces = append(out.Workspaces, &bridgev1.AgentWorkspace{Id: item.ID, Alias: item.Alias, Path: item.Path, IsDefault: item.IsDefault})
	}
	for _, item := range grants {
		out.Grants = append(out.Grants, &bridgev1.AgentGrant{
			Id: item.ID, DisplayName: item.DisplayName, Role: item.Role,
			Addresses: item.Addresses, WorkspaceIds: item.WorkspaceIDs,
		})
	}
	for _, item := range runs {
		out.Runs = append(out.Runs, &bridgev1.AgentRun{
			Id: item.ID, ChatId: item.ChatID, SourceMessageId: item.SourceMessageID,
			PrincipalAddress: item.PrincipalAddress, WorkspaceId: item.WorkspaceID,
			Status: item.Status, PromptPreview: item.PromptPreview, Summary: item.Summary,
			Error: item.Error, CreatedAtMs: item.CreatedAtMS, UpdatedAtMs: item.UpdatedAtMS,
		})
	}
	for _, item := range approvals {
		out.Approvals = append(out.Approvals, &bridgev1.AgentApproval{
			Id: item.ID, RunId: item.RunID, OwnerCode: item.OwnerCode, Kind: item.Kind,
			Preview: item.Preview, Status: item.Status, ExpiresAtMs: item.ExpiresAtMS,
		})
	}
	for _, item := range audit {
		out.Audit = append(out.Audit, &bridgev1.AgentAuditEvent{
			Id: item.ID, RunId: item.RunID, ActorAddress: item.ActorAddress,
			Action: item.Action, Detail: item.Detail, CreatedAtMs: item.CreatedAtMS,
		})
	}
	return out, nil
}

func (s *Server) emitAgentControlChanged() {
	if !s.handshaken.Load() {
		return
	}
	s.eventMu.Lock()
	defer s.eventMu.Unlock()
	body := &bridgev1.BackendEvent{
		Sequence: s.sequence.Add(1),
		Event: &bridgev1.BackendEvent_AgentControlChanged{
			AgentControlChanged: &bridgev1.AgentControlChanged{},
		},
	}
	if err := s.codec.Write(&bridgev1.Envelope{ProtocolVersion: ProtocolVersion, Body: &bridgev1.Envelope_Event{Event: body}}); err != nil {
		s.failBridge()
	}
}
