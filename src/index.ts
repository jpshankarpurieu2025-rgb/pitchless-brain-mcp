import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@notionhq/client";
import { z } from "zod";
import type { IncomingMessage, ServerResponse } from "http";

const NOTION_TOKEN = process.env.NOTION_TOKEN ?? "";
const OAUTH_CLIENT_ID = process.env.OAUTH_CLIENT_ID ?? "pitchless-brain";
const OAUTH_CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET ?? "";
// Derived bearer token — SHA-free simple concat, good enough for internal tool
const VALID_TOKEN = `${OAUTH_CLIENT_ID}:${OAUTH_CLIENT_SECRET}`;

const notion = new Client({ auth: NOTION_TOKEN });

const DATABASES: Record<string, string> = {
  partners: "9965cb61-8e08-8393-b706-0125508ef030",
  events: "fd05cb61-8e08-8264-a316-015d86e1d15d",
  team: "0cd5cb61-8e08-83ec-8f00-011679ca61cd",
  tasks: "4f15cb61-8e08-82fc-8a5e-013733286686",
  members: "38d5cb61-8e08-8099-b490-d560230e34ab",
  goals: "38d5cb61-8e08-80dc-a40a-f0061bab54d4",
  ideas: "38d5cb61-8e08-8077-a086-edfc78f6ccf5",
  meetings: "38d5cb61-8e08-8007-b9db-c87cb5834450",
  projects: "38d5cb61-8e08-8029-b948-f3ea3de74186",
  documents: "38d5cb61-8e08-803b-9b1c-db862462639a",
};

function extractText(prop: any): string {
  if (!prop) return "";
  switch (prop.type) {
    case "title": return prop.title?.map((t: any) => t.plain_text).join("") ?? "";
    case "rich_text": return prop.rich_text?.map((t: any) => t.plain_text).join("") ?? "";
    case "select": return prop.select?.name ?? "";
    case "multi_select": return prop.multi_select?.map((s: any) => s.name).join(", ") ?? "";
    case "status": return prop.status?.name ?? "";
    case "date": return prop.date?.start ?? "";
    case "number": return prop.number?.toString() ?? "";
    case "url": return prop.url ?? "";
    case "email": return prop.email ?? "";
    case "people": return prop.people?.map((p: any) => p.name).join(", ") ?? "";
    case "checkbox": return prop.checkbox ? "Yes" : "No";
    case "formula": return prop.formula?.string ?? prop.formula?.number?.toString() ?? "";
    case "relation": return `[${prop.relation?.length ?? 0} linked items]`;
    default: return "";
  }
}

function formatPage(page: any): Record<string, string> {
  const result: Record<string, string> = { id: page.id, url: page.url };
  for (const [key, value] of Object.entries(page.properties ?? {})) {
    const text = extractText(value);
    if (text) result[key] = text;
  }
  return result;
}

function isAuthorized(req: IncomingMessage): boolean {
  const auth = (req.headers["authorization"] ?? "") as string;
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return token === VALID_TOKEN;
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body));
  });
}

function createMcpServer() {
  const server = new McpServer({ name: "pitchless-brain", version: "1.0.0" });

  server.tool("get_workspace_overview", "Get a full overview of the Pitchless Notion workspace — all databases and their purposes. Use this first if unsure where to look.", {}, async () => {
    const overview = {
      company: "Pitchless — Madrid's strongest founder community",
      website: "https://pitchless.eu",
      events_calendar: "https://luma.com/pitchless.community",
      databases: {
        partners: { description: "All partner organisations — venues, sponsors, VCs, universities, co-organisers", key_fields: ["Name", "Org Type", "Relationship", "Bond Strength (1-5)", "Events", "Contact"] },
        events: { description: "All Pitchless events — past, present, and planned", key_fields: ["Name", "Date", "Type", "Status", "Partners", "Attendees", "Place", "Luma URL"], event_types: ["Roundtables", "Networking", "Buildathon", "Tech Hackathon", "Traction Hackathon", "GTM Hackathon", "Investor intro", "Workshop", "Hacker House"] },
        team: { description: "Pitchless team members and their roles", key_fields: ["Name", "Role", "Departments", "LinkedIn"] },
        tasks: { description: "All tasks across the company with owners, deadlines, and status", statuses: ["Not started", "In progress", "Blocked", "Done"] },
        members: { description: "Pitchless community members (~1,100 contacts)" },
        goals: { description: "Company goals and OKRs" },
        ideas: { description: "Team ideas and suggestions" },
        meetings: { description: "Meeting notes, summaries, and action items" },
        projects: { description: "Company projects and initiatives" },
        documents: { description: "Company documents and references" },
      },
    };
    return { content: [{ type: "text", text: JSON.stringify(overview, null, 2) }] };
  });

  server.tool("search_notion", "Search across the entire Pitchless Notion workspace. Use for any question about the company.", {
    query: z.string().describe("What you want to find or know about"),
    filter_type: z.enum(["page", "database"]).optional(),
  }, async ({ query, filter_type }) => {
    const params: any = { query, page_size: 20 };
    if (filter_type) params.filter = { value: filter_type, property: "object" };
    const res = await notion.search(params);
    const results = res.results.map((r: any) => ({
      id: r.id,
      type: r.object,
      title: r.properties?.title?.title?.[0]?.plain_text ?? r.properties?.Name?.title?.[0]?.plain_text ?? r.title?.[0]?.plain_text ?? "(untitled)",
      url: r.url,
      last_edited: r.last_edited_time,
    }));
    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
  });

  server.tool("query_database", "Query a specific Pitchless database to get structured data.", {
    database: z.enum(["partners", "events", "team", "tasks", "members", "goals", "ideas", "meetings", "projects", "documents"]),
    limit: z.number().optional().default(50),
  }, async ({ database, limit }) => {
    const res = await notion.databases.query({
      database_id: DATABASES[database],
      page_size: Math.min(limit ?? 50, 100),
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    });
    const rows = res.results.map(formatPage);
    return { content: [{ type: "text", text: JSON.stringify({ database, count: rows.length, rows }, null, 2) }] };
  });

  server.tool("get_page", "Get the full content of a specific Notion page by its ID.", {
    page_id: z.string().describe("The Notion page ID"),
  }, async ({ page_id }) => {
    const id = page_id.replace(/-/g, "");
    const [page, blocks] = await Promise.all([
      notion.pages.retrieve({ page_id: id }),
      notion.blocks.children.list({ block_id: id, page_size: 100 }),
    ]);
    const props = formatPage(page);
    const content = blocks.results.map((block: any) => {
      const type = block.type;
      const data = block[type];
      const text = data?.rich_text?.map((t: any) => t.plain_text).join("") ?? "";
      if (!text) return null;
      switch (type) {
        case "heading_1": return `# ${text}`;
        case "heading_2": return `## ${text}`;
        case "heading_3": return `### ${text}`;
        case "bulleted_list_item": return `• ${text}`;
        case "numbered_list_item": return `1. ${text}`;
        case "to_do": return `[${data.checked ? "x" : " "}] ${text}`;
        default: return text;
      }
    }).filter(Boolean).join("\n");
    return { content: [{ type: "text", text: JSON.stringify({ properties: props, content }, null, 2) }] };
  });

  server.tool("get_meetings", "Get recent Pitchless meeting notes and action items.", {
    limit: z.number().optional().default(10),
  }, async ({ limit }) => {
    const res = await notion.databases.query({
      database_id: DATABASES.meetings,
      page_size: Math.min(limit ?? 10, 50),
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    });
    return { content: [{ type: "text", text: JSON.stringify(res.results.map(formatPage), null, 2) }] };
  });

  return server;
}

// ── Vercel serverless handler ─────────────────────────────────────────────────
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const url = (req as any).url as string;

  // ── OAuth metadata discovery (required by Claude.ai) ──────────────────────
  if (url === "/.well-known/oauth-authorization-server" || url === "/.well-known/openid-configuration") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      issuer: "https://pitchless-brain-mcp.vercel.app",
      token_endpoint: "https://pitchless-brain-mcp.vercel.app/oauth/token",
      grant_types_supported: ["client_credentials"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    }));
    return;
  }

  // ── OAuth token endpoint ───────────────────────────────────────────────────
  if (url === "/oauth/token" && req.method === "POST") {
    const body = await readBody(req);
    let clientId = "";
    let clientSecret = "";

    // Support both form-encoded and JSON body
    const contentType = req.headers["content-type"] ?? "";
    if (contentType.includes("application/json")) {
      try {
        const json = JSON.parse(body);
        clientId = json.client_id ?? "";
        clientSecret = json.client_secret ?? "";
      } catch {}
    } else {
      // application/x-www-form-urlencoded
      const params = new URLSearchParams(body);
      clientId = params.get("client_id") ?? "";
      clientSecret = params.get("client_secret") ?? "";

      // Also check Authorization header (Basic auth)
      const authHeader = (req.headers["authorization"] ?? "") as string;
      if (authHeader.startsWith("Basic ")) {
        const decoded = Buffer.from(authHeader.slice(6), "base64").toString();
        const [id, secret] = decoded.split(":");
        if (id) clientId = id;
        if (secret) clientSecret = secret;
      }
    }

    if (clientId !== OAUTH_CLIENT_ID || clientSecret !== OAUTH_CLIENT_SECRET) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_client" }));
      return;
    }

    // Issue token (same as client_id:client_secret for simplicity)
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      access_token: VALID_TOKEN,
      token_type: "Bearer",
      expires_in: 31536000, // 1 year
    }));
    return;
  }

  // ── Health check ───────────────────────────────────────────────────────────
  if (req.method === "GET" && url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", name: "pitchless-brain-mcp" }));
    return;
  }

  // ── MCP endpoint ───────────────────────────────────────────────────────────
  if (!isAuthorized(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => { transport.close(); server.close(); });

  await server.connect(transport);
  await transport.handleRequest(req, res);
}
