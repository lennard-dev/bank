import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTools } from "./tools.ts";
import { registerPrompts } from "./prompts.ts";

export const VERSION = "0.1.0";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "bank", version: VERSION },
    {
      instructions: [
        "Read-only access to the owner's own bank accounts via Enable Banking (PSD2). There are no payment tools.",
        "Accounts can be referred to by uid or by their label. Call list_accounts first when unsure.",
        "Transaction amounts are signed: negative is money out. Use the `booked` balance for totals and net worth; `available` may include credit lines.",
        "Transactions are answered from a stored copy that syncs about once a day, so asking repeatedly costs nothing. Banks allow only a few direct calls a day without the account holder present; avoid source: bank and sync_account unless today's bookings matter.",
        "Each result has `coverage`: days outside it are missing, not empty. History older than the bank returns (often 90 days) can be added with import_statement from a CSV export.",
        "If a tool says the bank is blocking calls until a time, do not retry; use the stored copy and tell the user when fresh data is possible again.",
        "If a tool says a consent is no longer valid, use start_consent for that bank; nothing else is lost.",
      ].join(" "),
    },
  );
  registerTools(server);
  registerPrompts(server);
  return server;
}
