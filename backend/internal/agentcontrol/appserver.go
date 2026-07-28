package agentcontrol

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"
)

type appEvent struct {
	Method string
	Params json.RawMessage
	ID     json.RawMessage
}

type appResponse struct {
	ID     json.RawMessage `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
}

type AppServer struct {
	ctx      context.Context
	cancel   context.CancelFunc
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	pending  sync.Map
	writeMu  sync.Mutex
	nextID   atomic.Uint64
	events   chan appEvent
	done     chan error
	closeOne sync.Once
}

func StartAppServer(ctx context.Context, codexPath string) (*AppServer, error) {
	childCtx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(childCtx, codexPath, "app-server", "--listen", "stdio://")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	if err = cmd.Start(); err != nil {
		cancel()
		return nil, err
	}
	server := &AppServer{
		ctx: childCtx, cancel: cancel, cmd: cmd, stdin: stdin,
		events: make(chan appEvent, 128), done: make(chan error, 1),
	}
	go server.readLoop(stdout)
	var initialized struct {
		UserAgent string `json:"userAgent"`
	}
	if err = server.Call(ctx, "initialize", map[string]any{
		"clientInfo": map[string]string{"name": "rust-meow", "title": "Rust Meow", "version": "0.1.0"},
		"capabilities": map[string]any{
			"experimentalApi":           true,
			"optOutNotificationMethods": []string{"item/agentMessage/delta", "item/reasoning/textDelta"},
		},
	}, &initialized); err != nil {
		server.Close()
		return nil, fmt.Errorf("initialize codex app-server: %w", err)
	}
	if err = server.Notify("initialized", map[string]any{}); err != nil {
		server.Close()
		return nil, err
	}
	return server, nil
}

func (s *AppServer) Events() <-chan appEvent { return s.events }
func (s *AppServer) Done() <-chan error      { return s.done }

func (s *AppServer) Call(ctx context.Context, method string, params any, target any) error {
	id := s.nextID.Add(1)
	response := make(chan appResponse, 1)
	s.pending.Store(id, response)
	defer s.pending.Delete(id)
	if err := s.write(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		return err
	}
	select {
	case message := <-response:
		if message.Error != nil {
			return fmt.Errorf("%s (%d)", message.Error.Message, message.Error.Code)
		}
		if target == nil || len(message.Result) == 0 {
			return nil
		}
		return json.Unmarshal(message.Result, target)
	case <-ctx.Done():
		return ctx.Err()
	case err := <-s.done:
		if err == nil {
			err = errors.New("codex app-server stopped")
		}
		return err
	}
}

func (s *AppServer) Notify(method string, params any) error {
	return s.write(map[string]any{"method": method, "params": params})
}

func (s *AppServer) Respond(id json.RawMessage, result any) error {
	var wireID any
	if err := json.Unmarshal(id, &wireID); err != nil {
		return err
	}
	return s.write(map[string]any{"id": wireID, "result": result})
}

func (s *AppServer) write(value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, err = s.stdin.Write(raw)
	return err
}

func (s *AppServer) readLoop(stdout io.Reader) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		var message appResponse
		if err := json.Unmarshal(scanner.Bytes(), &message); err != nil {
			continue
		}
		if message.Method != "" {
			select {
			case s.events <- appEvent{Method: message.Method, Params: message.Params, ID: message.ID}:
			case <-s.ctx.Done():
				return
			}
			continue
		}
		var id uint64
		if err := json.Unmarshal(message.ID, &id); err != nil {
			continue
		}
		if pending, ok := s.pending.Load(id); ok {
			pending.(chan appResponse) <- message
		}
	}
	err := scanner.Err()
	if err == nil {
		err = s.cmd.Wait()
	}
	select {
	case s.done <- err:
	default:
	}
	close(s.events)
}

func (s *AppServer) StartThread(ctx context.Context, cwd, skillPath string) (string, error) {
	var response struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	if err := s.Call(ctx, "thread/start", map[string]any{
		"cwd": cwd, "approvalPolicy": "never", "permissions": ":danger-full-access",
		"serviceName": "rust-meow-whatsapp",
	}, &response); err != nil {
		return "", err
	}
	if response.Thread.ID == "" {
		return "", errors.New("codex returned an empty thread id")
	}
	return response.Thread.ID, nil
}

func (s *AppServer) StartTurn(ctx context.Context, threadID, cwd, prompt, skillPath string) (string, error) {
	input := []map[string]any{{"type": "text", "text": prompt}}
	if skillPath != "" {
		input = append(input, map[string]any{"type": "skill", "name": "whatsapp-remote-session", "path": skillPath})
	}
	var response struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	params := map[string]any{
		"threadId":       threadID,
		"input":          input,
		"cwd":            cwd,
		"approvalPolicy": "never",
		"permissions":    ":danger-full-access",
	}
	turnCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := s.Call(turnCtx, "turn/start", params, &response); err != nil {
		return "", err
	}
	return response.Turn.ID, nil
}

func (s *AppServer) Steer(ctx context.Context, threadID, turnID, prompt string) error {
	return s.Call(ctx, "turn/steer", map[string]any{
		"threadId": threadID, "expectedTurnId": turnID,
		"input": []map[string]any{{"type": "text", "text": prompt}},
	}, nil)
}

func (s *AppServer) Interrupt(ctx context.Context, threadID, turnID string) error {
	return s.Call(ctx, "turn/interrupt", map[string]any{"threadId": threadID, "turnId": turnID}, nil)
}

func (s *AppServer) Close() {
	s.closeOne.Do(func() {
		s.cancel()
		_ = s.stdin.Close()
	})
}
