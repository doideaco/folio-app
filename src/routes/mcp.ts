import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { requireUserId } from "../auth.js";
import { config } from "../config.js";
import { createToken, listTokens, revokeToken, verifyToken, type TokenPrincipal } from "../mcp/tokens.js";
import * as tools from "../mcp/tools.js";

// A per-user MCP endpoint so any AI client (Claude, ChatGPT, Cursor…) can read,
// search and save into someone's Folio. Hand-rolled JSON-RPC 2.0 over HTTP
// (Streamable HTTP, non-streaming): initialize → tools/list → tools/call.
const PROTOCOL_VERSION = "2025-06-18";

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  scope: "read" | "read_write";
  run: (p: TokenPrincipal, args: any) => Promise<unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: "list_boards",
    description: "List the user's Folio boards, each with its card count.",
    scope: "read",
    inputSchema: { type: "object", properties: {} },
    run: (p) => tools.listBoards(p),
  },
  {
    name: "search_saves",
    description: "Search the user's saves by keyword, board and/or type (recipe, place, link, other). Returns matching cards.",
    scope: "read",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to match in title / caption / note." },
        board: { type: "string", description: "Board id or name to limit to." },
        type: { type: "string", description: "Card type filter." },
        limit: { type: "integer", default: 20 },
      },
    },
    run: tools.searchSaves,
  },
  {
    name: "get_card",
    description: "Get one save in full, including its structured details (recipe steps, place address, booking record, product price, song…).",
    scope: "read",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    run: tools.getCard,
  },
  {
    name: "get_agenda",
    description: "The user's upcoming dated saves — flights, hotels, tickets, deliveries — soonest first.",
    scope: "read",
    inputSchema: { type: "object", properties: { limit: { type: "integer", default: 10 } } },
    run: tools.getAgenda,
  },
  {
    name: "save_link",
    description: "Save a link to Folio (Folio fetches and structures it). Optionally choose a board by id or name and add a note.",
    scope: "read_write",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, board: { type: "string" }, note: { type: "string" } },
      required: ["url"],
    },
    run: tools.saveLink,
  },
  {
    name: "create_board",
    description: "Create a new Folio board.",
    scope: "read_write",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, emoji: { type: "string" } },
      required: ["name"],
    },
    run: tools.createBoard,
  },
];

function toolsFor(scope: "read" | "read_write"): ToolDef[] {
  return scope === "read_write" ? TOOLS : TOOLS.filter((t) => t.scope === "read");
}

export async function mcpRoutes(app: FastifyInstance) {
  // --- Token management (app-authed with the normal session) ---
  const createSchema = z.object({
    label: z.string().max(80).optional(),
    scope: z.enum(["read", "read_write"]).default("read"),
  });

  app.post("/mcp/tokens", async (req, reply) => {
    const userId = await requireUserId(req);
    const body = createSchema.parse(req.body ?? {});
    const { id, token } = await createToken(userId, body.label ?? null, body.scope);
    reply.code(201);
    return { id, token, url: `${config.PUBLIC_BASE_URL}/mcp`, scope: body.scope };
  });

  app.get("/mcp/tokens", async (req) => {
    const userId = await requireUserId(req);
    return { tokens: await listTokens(userId) };
  });

  app.delete("/mcp/tokens/:id", async (req) => {
    const userId = await requireUserId(req);
    const { id } = req.params as { id: string };
    return { ok: await revokeToken(userId, id) };
  });

  // --- MCP JSON-RPC endpoint (authed with a personal access token) ---
  app.post("/mcp", async (req, reply) => {
    const header = req.headers.authorization;
    const principal = header?.startsWith("Bearer ") ? await verifyToken(header.slice("Bearer ".length)) : null;
    if (!principal) {
      reply.code(401);
      return { error: "invalid or missing MCP token" };
    }

    const msg = req.body as any;
    const id = msg?.id ?? null;
    const method = msg?.method as string | undefined;
    const ok = (result: unknown) => ({ jsonrpc: "2.0", id, result });
    const err = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

    switch (method) {
      case "initialize":
        return ok({
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "Folio", version: "1.0.0" },
        });

      case "notifications/initialized":
      case "notifications/cancelled":
        reply.code(202);
        return null;

      case "ping":
        return ok({});

      case "tools/list":
        return ok({
          tools: toolsFor(principal.scope).map((t) => ({
            name: t.name, description: t.description, inputSchema: t.inputSchema,
          })),
        });

      case "tools/call": {
        const name = msg?.params?.name as string;
        const args = msg?.params?.arguments ?? {};
        const tool = TOOLS.find((t) => t.name === name);
        if (!tool) return err(-32602, `unknown tool: ${name}`);
        if (tool.scope === "read_write" && principal.scope !== "read_write") {
          return ok({
            content: [{ type: "text", text: "This token is read-only. Create a read + write token in Folio to use this action." }],
            isError: true,
          });
        }
        try {
          const result = await tool.run(principal, args);
          return ok({ content: [{ type: "text", text: JSON.stringify(result) }] });
        } catch (e: any) {
          return ok({ content: [{ type: "text", text: `error: ${e?.message ?? "failed"}` }], isError: true });
        }
      }

      default:
        if (id == null) {
          reply.code(202);
          return null; // an unknown notification — accept silently
        }
        return err(-32601, `method not found: ${method}`);
    }
  });
}
