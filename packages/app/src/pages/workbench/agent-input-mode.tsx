import { Button } from '@/components/ui/button';
import { useTerminalSessions, type TerminalSessionMeta } from '@/providers/terminal-sessions-provider';

/** Shared mode chrome: the dock and Workbench must describe the same write gate. */
export function AgentInputMode({ session, type }: { session?: TerminalSessionMeta; type?: string }) {
  const { setInputMode } = useTerminalSessions();
  const observing = !session || session.inputMode === 'observe';
  const unavailable = !session || session.status !== 'open';
  return (
    <section aria-label="Agent input mode" className="space-y-2 border-b border-border p-3 text-sm">
      <p role="status">{!session ? 'No observation attached' : observing ? 'Observing · read-only' : 'Interactive'}</p>
      <p className="min-h-10">
        {!session
          ? 'Choose Observe to open this session in the terminal dock.'
          : observing
            ? 'Read-only view. You can copy output; this view sends no input. The agent may still change files.'
            : 'Interactive terminal. Input is sent to the agent.'}
      </p>
      <Button
        size="sm"
        variant="outline"
        aria-disabled={unavailable}
        onClick={() => {
          if (unavailable || !session) return;
          setInputMode(session.id, observing ? 'interactive' : 'observe');
        }}
      >
        {observing ? 'Interact with agent' : 'Return to observation'}
      </Button>
      <p className="min-h-5">
        {unavailable
          ? 'Interaction requires a live terminal connection.'
          : 'Mode is shared with the global terminal tab.'}
      </p>
      <AgentPosture type={session?.agent?.type ?? type} />
    </section>
  );
}
export function AgentPosture({ type }: { type?: string }) {
  const credential =
    type === 'claude-code'
      ? 'Your Anthropic key stays on this computer; the VM only sees a placeholder.'
      : type === 'codex'
        ? 'Your OpenAI key stays on this computer; the VM only sees a placeholder.'
        : type === 'copilot'
          ? 'Your GitHub token stays on this computer. A short-lived Copilot session token derived from it does enter the VM. A prompt-injected agent could read that token and spend against your GitHub account until it expires.'
          : 'Credential handling depends on the agent adapter; this workspace record does not identify it.';
  return (
    <div>
      <h3 className="font-semibold">Development VM</h3>
      <p>
        The microVM is the isolation boundary. The sandbox is not a jail for hostile code. {credential} Development-VM
        egress is cooperative and bypassable. Approve, deny and stop steer the agent; they do not provide containment.
        An agent can read anything in this folder and send it out over the network.
      </p>
    </div>
  );
}
