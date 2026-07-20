import { Command } from 'commander';
import { Writable } from 'node:stream';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createApplianceMcpServer } from './utils/mcp-server.js';
import { setActiveProfileOverride } from './utils/credentials.js';

// `appliance mcp` — serve the Appliance deploy/debug surface over the
// Model Context Protocol on stdio, so external agents (Claude Code,
// Copilot, Codex, any MCP client) can drive deployments and diagnose
// failures. Register it in an agent as:
//
//   { "command": "appliance", "args": ["mcp"] }
//
// stdout IS the protocol channel on a stdio server. The deploy engine
// and its helpers this server reuses print progress to stdout (chalk
// banners, progress lines) — one stray write would corrupt a JSON-RPC
// frame. So before anything else runs we swap process.stdout's write to
// stderr (where MCP clients surface it as server logging) and hand the
// transport a private Writable bound to the REAL stdout, which nothing
// else can reach.

const realStdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) =>
  (process.stderr.write as (...args: unknown[]) => boolean)(chunk, encoding, cb)) as typeof process.stdout.write;

const protocolOut = new Writable({
  write(chunk, encoding, callback) {
    realStdoutWrite(chunk, encoding as BufferEncoding, callback);
  },
});

const program = new Command();

program
  .description('serve Appliance over the Model Context Protocol (stdio) so AI agents can deploy and debug')
  .option('--profile <name>', 'default credential profile for tool calls (tools can still override per call)')
  .action(async (opts: { profile?: string }) => {
    setActiveProfileOverride(opts.profile);
    const server = createApplianceMcpServer();
    const transport = new StdioServerTransport(process.stdin, protocolOut);
    await server.connect(transport);
    console.error(
      'appliance mcp: serving on stdio (tools: overview, deploy, deployment_status, health, logs, destroy, doctor, vm)'
    );
    // The transport owns the process lifetime: stay up until the client
    // closes stdin (or the process is signaled).
    await new Promise<void>((resolve) => {
      transport.onclose = resolve;
    });
  });

program.parse(process.argv);
