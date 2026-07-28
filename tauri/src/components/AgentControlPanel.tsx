import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { Bot, FolderPlus, ShieldCheck, X } from "lucide-solid";
import type { AppModel } from "../state/app";
import { bridge, openFile, normalizeBridgeError } from "../lib/bridge";
import type { AgentControlState, AgentGrant, AgentWorkspace, ContactSearchResult } from "../lib/types";
import { IconButton, Spinner } from "./Primitives";
import { ThemeIcon } from "./ThemeIcon";

type Section = "overview" | "workspaces" | "access" | "chats" | "runs";

export function AgentControlPanel(props: { model: AppModel; onClose: () => void }) {
  const [state, setState] = createSignal<AgentControlState>();
  const [section, setSection] = createSignal<Section>("overview");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [alias, setAlias] = createSignal("meow");
  const [codexPath, setCodexPath] = createSignal("codex");
  const [workspaceAlias, setWorkspaceAlias] = createSignal("");
  const [workspacePath, setWorkspacePath] = createSignal("");
  const [grantName, setGrantName] = createSignal("");
  const [grantAddress, setGrantAddress] = createSignal("");
  const [grantRole, setGrantRole] = createSignal<"operator" | "viewer">("operator");
  const [grantWorkspace, setGrantWorkspace] = createSignal("");
  const [contactResults, setContactResults] = createSignal<ContactSearchResult[]>([]);

  async function load() {
    try {
      const response = await bridge.getAgentControlState();
      if (!response.state) throw new Error("Agent Control state is unavailable");
      setState(response.state);
      setAlias(response.state.settings?.alias || "meow");
      setCodexPath(response.state.settings?.codexPath || "codex");
      if (!grantWorkspace()) setGrantWorkspace(response.state.workspaces[0]?.id ?? "");
    } catch (cause) {
      setError(normalizeBridgeError(cause).message);
    }
  }

  async function mutate(operation: () => Promise<{ state: AgentControlState | null }>) {
    setBusy(true);
    setError("");
    try {
      const response = await operation();
      if (response.state) setState(response.state);
    } catch (cause) {
      setError(normalizeBridgeError(cause).message);
    } finally {
      setBusy(false);
    }
  }

  onMount(() => {
    void load();
    const refresh = () => void load();
    window.addEventListener("rust-meow-agent-control-changed", refresh);
    onCleanup(() => window.removeEventListener("rust-meow-agent-control-changed", refresh));
  });

  async function chooseWorkspace() {
    const selected = await openFile({ directory: true, title: "Choose a repository for Agent Control" });
    if (selected) setWorkspacePath(selected);
  }

  async function addWorkspace() {
    const workspace: AgentWorkspace = {
      id: "", alias: workspaceAlias(), path: workspacePath(),
      isDefault: (state()?.workspaces.length ?? 0) === 0,
    };
    await mutate(() => bridge.saveAgentWorkspace(workspace));
    setWorkspaceAlias("");
    setWorkspacePath("");
  }

  async function addGrant() {
    const grant: AgentGrant = {
      id: "", displayName: grantName(), role: grantRole(),
      addresses: [grantAddress()], workspaceIds: [grantWorkspace()],
    };
    await mutate(() => bridge.saveAgentGrant(grant));
    setGrantName("");
    setGrantAddress("");
    setContactResults([]);
  }

  async function findContacts() {
    const query = grantName().trim();
    if (query.length < 2) {
      setContactResults([]);
      return;
    }
    try {
      const results = await bridge.searchLocal(query);
      setContactResults(results.contacts.slice(0, 5));
    } catch (cause) {
      setError(normalizeBridgeError(cause).message);
    }
  }

  const workspaceName = (id: string) => state()?.workspaces.find((item) => item.id === id)?.alias ?? id;
  const shortRun = (id: string) => id.replace(/^run_/, "").replaceAll("-", "").slice(0, 8).toUpperCase();

  return (
    <div class="modal-backdrop agent-control-backdrop" role="presentation">
      <section class="agent-control-panel" role="dialog" aria-modal="true" aria-label="Agent Control">
        <header class="agent-control-header">
          <div>
            <span class="agent-kicker">Local-first Codex over WhatsApp</span>
            <h2><ThemeIcon icon={Bot} name="chat" size={20} /> Agent Control</h2>
          </div>
          <IconButton label="Close Agent Control" onClick={props.onClose}>
            <ThemeIcon icon={X} name="close" size={20} />
          </IconButton>
        </header>
        <nav class="agent-control-tabs" aria-label="Agent Control sections">
          <For each={[
            ["overview", "Overview"], ["workspaces", "Workspaces"], ["access", "Access"],
            ["chats", "Control chats"], ["runs", "Runs & audit"],
          ] as const}>
            {([id, label]) => <button class={section() === id ? "active" : ""} onClick={() => setSection(id)}>{label}</button>}
          </For>
        </nav>
        <Show when={error()}><div class="agent-control-error">{error()}</div></Show>
        <Show when={state()} fallback={<div class="agent-control-loading"><Spinner label="Loading Agent Control" /></div>}>
          {(current) => (
            <div class="agent-control-body">
              <Show when={section() === "overview"}>
                <div class="agent-overview-grid">
                  <article class="agent-stat"><span>Controller</span><strong>{current().settings?.enabled ? "Enabled" : "Disabled"}</strong></article>
                  <article class="agent-stat"><span>Codex</span><strong>{current().settings?.codexRunning ? "Running" : "Idle"}</strong></article>
                  <article class="agent-stat"><span>Workspaces</span><strong>{current().workspaces.length}</strong></article>
                  <article class="agent-stat"><span>Active runs</span><strong>{current().runs.filter((run) => ["starting", "running", "waiting_approval"].includes(run.status)).length}</strong></article>
                </div>
                <section class="agent-card">
                  <h3>Host identity</h3>
                  <label>Agent alias<input value={alias()} onInput={(event) => setAlias(event.currentTarget.value.toLowerCase())} placeholder="ashman" /></label>
                  <label>Codex executable<input value={codexPath()} onInput={(event) => setCodexPath(event.currentTarget.value)} placeholder="codex" /></label>
                  <div class="agent-warning"><ShieldCheck size={17} /> Remote runs are confined to a registered workspace, use restricted reads, and start with network disabled.</div>
                  <div class="agent-actions">
                    <button class="agent-secondary" disabled={busy()} onClick={() => mutate(() => bridge.saveAgentSettings(false, alias(), codexPath()))}>Disable</button>
                    <button class="agent-primary" disabled={busy() || current().workspaces.length === 0 || current().controlChatIds.length === 0} onClick={() => mutate(() => bridge.saveAgentSettings(true, alias(), codexPath()))}>Enable Agent Control</button>
                  </div>
                </section>
              </Show>

              <Show when={section() === "workspaces"}>
                <section class="agent-card">
                  <h3>Register a repository</h3>
                  <div class="agent-inline-fields">
                    <label>Alias<input value={workspaceAlias()} onInput={(event) => setWorkspaceAlias(event.currentTarget.value.toLowerCase())} placeholder="rust-meow" /></label>
                    <label>Folder<div class="agent-path-field"><input value={workspacePath()} readOnly placeholder="Choose a folder" /><button onClick={() => void chooseWorkspace()}><FolderPlus size={16} /></button></div></label>
                  </div>
                  <button class="agent-primary" disabled={busy() || !workspaceAlias() || !workspacePath()} onClick={() => void addWorkspace()}>Add workspace</button>
                </section>
                <div class="agent-list">
                  <For each={current().workspaces} fallback={<p class="agent-empty">No remote workspaces are exposed.</p>}>
                    {(workspace) => <article class="agent-list-row"><div><strong>@{workspace.alias}</strong><span>{workspace.path}</span></div><div>{workspace.isDefault ? <em>Default</em> : null}<button class="agent-danger" onClick={() => mutate(() => bridge.deleteAgentWorkspace(workspace.id))}>Remove</button></div></article>}
                  </For>
                </div>
              </Show>

              <Show when={section() === "access"}>
                <section class="agent-card">
                  <h3>Grant a WhatsApp identity</h3>
                  <div class="agent-inline-fields">
                    <label>Name or contact<div class="agent-path-field"><input value={grantName()} onInput={(event) => setGrantName(event.currentTarget.value)} placeholder="Friend's name or number" /><button type="button" onClick={() => void findContacts()}>Find</button></div></label>
                    <label>WhatsApp JID<input value={grantAddress()} onInput={(event) => setGrantAddress(event.currentTarget.value)} placeholder="9198…@s.whatsapp.net" /></label>
                    <label>Role<select value={grantRole()} onChange={(event) => setGrantRole(event.currentTarget.value as "operator" | "viewer")}><option value="operator">Operator</option><option value="viewer">Viewer</option></select></label>
                    <label>Workspace<select value={grantWorkspace()} onChange={(event) => setGrantWorkspace(event.currentTarget.value)}><For each={current().workspaces}>{(workspace) => <option value={workspace.id}>@{workspace.alias}</option>}</For></select></label>
                  </div>
                  <Show when={contactResults().length > 0}>
                    <div class="agent-contact-results" aria-label="Matching contacts">
                      <For each={contactResults()}>
                        {(contact) => <button type="button" onClick={() => {
                          setGrantName(contact.displayName || contact.phoneNumber);
                          setGrantAddress(contact.contactJid);
                          setContactResults([]);
                        }}><strong>{contact.displayName || contact.phoneNumber}</strong><span>{contact.phoneNumber || contact.contactJid}</span></button>}
                      </For>
                    </div>
                  </Show>
                  <button class="agent-primary" disabled={busy() || !grantAddress() || !grantWorkspace()} onClick={() => void addGrant()}>Add grant</button>
                </section>
                <div class="agent-list">
                  <For each={current().grants} fallback={<p class="agent-empty">Only the owner can currently use this agent.</p>}>
                    {(grant) => <article class="agent-list-row"><div><strong>{grant.displayName || grant.addresses[0]}</strong><span>{grant.role} · {grant.workspaceIds.map((id) => `@${workspaceName(id)}`).join(", ")}</span></div><button class="agent-danger" onClick={() => mutate(() => bridge.deleteAgentGrant(grant.id))}>Revoke</button></article>}
                  </For>
                </div>
              </Show>

              <Show when={section() === "chats"}>
                <div class="agent-warning">Anyone in an enabled group can read agent output posted there. RBAC controls who can command the agent, not who can see the group.</div>
                <div class="agent-list">
                  <For each={props.model.state.chats} fallback={<p class="agent-empty">Load a chat before enabling it as a control room.</p>}>
                    {(chat) => {
                      const enabled = () => current().controlChatIds.includes(chat.id);
                      return <article class="agent-list-row"><div><strong>{chat.title}</strong><span>{chat.kind === 2 ? "Group" : "Direct chat"}</span></div><button class={enabled() ? "agent-primary" : "agent-secondary"} onClick={() => mutate(() => bridge.setAgentControlChat(chat.id, !enabled()))}>{enabled() ? "Enabled" : "Enable"}</button></article>;
                    }}
                  </For>
                </div>
              </Show>

              <Show when={section() === "runs"}>
                <For each={current().approvals.filter((approval) => approval.status === "pending")}>
                  {(approval) => <article class="agent-card agent-approval"><h3>Approval {approval.ownerCode}</h3><p>{approval.kind}: {approval.preview}</p><div class="agent-actions"><button class="agent-danger" onClick={() => mutate(() => bridge.resolveAgentApproval(approval.ownerCode, false))}>Deny</button><button class="agent-primary" onClick={() => mutate(() => bridge.resolveAgentApproval(approval.ownerCode, true))}>Approve once</button></div></article>}
                </For>
                <div class="agent-list">
                  <For each={current().runs} fallback={<p class="agent-empty">No WhatsApp-driven runs yet.</p>}>
                    {(run) => <article class="agent-run-row"><div class="agent-run-title"><strong>{shortRun(run.id)} · @{workspaceName(run.workspaceId)}</strong><span class={`agent-status ${run.status}`}>{run.status}</span></div><p>{run.promptPreview}</p><small>{run.principalAddress} · {new Date(run.updatedAtMs).toLocaleString()}</small><Show when={run.error}><div class="agent-control-error">{run.error}</div></Show><Show when={["starting", "running", "waiting_approval"].includes(run.status)}><button class="agent-danger" onClick={() => mutate(() => bridge.interruptAgentRun(run.id))}>Emergency stop</button></Show></article>}
                  </For>
                </div>
              </Show>
            </div>
          )}
        </Show>
      </section>
    </div>
  );
}
