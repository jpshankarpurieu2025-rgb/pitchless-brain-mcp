import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@notionhq/client";
import { z } from "zod";
import type { IncomingMessage, ServerResponse } from "http";
import { createHmac, randomBytes } from "crypto";

const NOTION_TOKEN = process.env.NOTION_TOKEN ?? "";
const TEAM_USERNAME = process.env.TEAM_USERNAME ?? "pitchless";
const TEAM_PASSWORD = process.env.TEAM_PASSWORD ?? "";
const TOKEN_SECRET = process.env.TOKEN_SECRET ?? "pitchless-token-secret";
const BASE_URL = "https://pitchless-brain-mcp.vercel.app";

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

// ── Token helpers ─────────────────────────────────────────────────────────────
function signToken(payload: string): string {
  return createHmac("sha256", TOKEN_SECRET).update(payload).digest("hex");
}

function makeAccessToken(): string {
  const payload = `access:${Date.now()}`;
  return `${Buffer.from(payload).toString("base64")}.${signToken(payload)}`;
}

function makeAuthCode(redirectUri: string, state: string): string {
  const payload = `code:${redirectUri}:${state}:${Date.now()}`;
  return `${Buffer.from(payload).toString("base64url")}.${signToken(payload)}`;
}

function verifyAuthCode(code: string): { redirectUri: string; state: string } | null {
  try {
    const [b64, sig] = code.split(".");
    const payload = Buffer.from(b64, "base64url").toString();
    if (signToken(payload) !== sig) return null;
    const parts = payload.split(":");
    if (parts[0] !== "code") return null;
    const ts = parseInt(parts[parts.length - 1]);
    if (Date.now() - ts > 5 * 60 * 1000) return null; // 5 min expiry
    return { redirectUri: parts[1], state: parts[2] };
  } catch { return null; }
}

function verifyAccessToken(token: string): boolean {
  try {
    const [b64, sig] = token.split(".");
    const payload = Buffer.from(b64, "base64").toString();
    return signToken(payload) === sig;
  } catch { return false; }
}

function isAuthorized(req: IncomingMessage): boolean {
  const auth = (req.headers["authorization"] ?? "") as string;
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  return verifyAccessToken(token);
}

// ── Body reader ───────────────────────────────────────────────────────────────
async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => resolve(body));
  });
}

// ── Login page HTML ───────────────────────────────────────────────────────────
function loginPage(redirectUri: string, state: string, clientId: string, error?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Pitchless Brain — Connect</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #0a0a0a; color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #111; border: 1px solid #222; border-radius: 16px; padding: 40px; width: 100%; max-width: 400px; }
    .logo { font-size: 28px; font-weight: 700; margin-bottom: 8px; letter-spacing: -0.5px; }
    .logo span { color: #00c9a7; }
    .subtitle { color: #888; font-size: 14px; margin-bottom: 32px; }
    label { display: block; font-size: 13px; color: #aaa; margin-bottom: 6px; }
    input { width: 100%; padding: 12px 14px; background: #1a1a1a; border: 1px solid #333; border-radius: 8px; color: #fff; font-size: 15px; outline: none; transition: border-color 0.2s; margin-bottom: 16px; }
    input:focus { border-color: #00c9a7; }
    .error { background: #2a1111; border: 1px solid #ff4444; border-radius: 8px; padding: 12px 14px; font-size: 13px; color: #ff6666; margin-bottom: 16px; }
    button { width: 100%; padding: 13px; background: #00c9a7; border: none; border-radius: 8px; color: #000; font-size: 15px; font-weight: 600; cursor: pointer; transition: opacity 0.2s; }
    button:hover { opacity: 0.9; }
    .footer { text-align: center; margin-top: 20px; font-size: 12px; color: #555; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Pitch<span>less</span> Brain</div>
    <div class="subtitle">Connect to your Claude account to access the Pitchless knowledge base.</div>
    ${error ? `<div class="error">${error}</div>` : ""}
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="redirect_uri" value="${redirectUri}"/>
      <input type="hidden" name="state" value="${state}"/>
      <input type="hidden" name="client_id" value="${clientId}"/>
      <label>Username</label>
      <input type="text" name="username" placeholder="Enter username" autocomplete="username" required/>
      <label>Password</label>
      <input type="password" name="password" placeholder="Enter password" autocomplete="current-password" required/>
      <button type="submit">Connect to Pitchless Brain</button>
    </form>
    <div class="footer">Internal access only — Pitchless team</div>
  </div>
</body>
</html>`;
}

// ── MCP server factory ────────────────────────────────────────────────────────
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

// ── Main handler ──────────────────────────────────────────────────────────────
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const url = (req as any).url as string;
  const urlObj = new URL(url, BASE_URL);
  const pathname = urlObj.pathname;

  // ── OAuth discovery ────────────────────────────────────────────────────────
  if (pathname === "/.well-known/oauth-authorization-server") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      issuer: BASE_URL,
      authorization_endpoint: `${BASE_URL}/oauth/authorize`,
      token_endpoint: `${BASE_URL}/oauth/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256", "plain"],
    }));
    return;
  }

  // ── OAuth authorize — GET (show login page) ────────────────────────────────
  if (pathname === "/oauth/authorize" && req.method === "GET") {
    const redirectUri = urlObj.searchParams.get("redirect_uri") ?? "";
    const state = urlObj.searchParams.get("state") ?? "";
    const clientId = urlObj.searchParams.get("client_id") ?? "";
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(loginPage(redirectUri, state, clientId));
    return;
  }

  // ── OAuth authorize — POST (handle login form) ─────────────────────────────
  if (pathname === "/oauth/authorize" && req.method === "POST") {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const username = params.get("username") ?? "";
    const password = params.get("password") ?? "";
    const redirectUri = params.get("redirect_uri") ?? "";
    const state = params.get("state") ?? "";
    const clientId = params.get("client_id") ?? "";

    if (username !== TEAM_USERNAME || password !== TEAM_PASSWORD) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(loginPage(redirectUri, state, clientId, "Incorrect username or password."));
      return;
    }

    const code = makeAuthCode(redirectUri, state);
    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", state);
    res.writeHead(302, { Location: redirect.toString() });
    res.end();
    return;
  }

  // ── OAuth token exchange ───────────────────────────────────────────────────
  if (pathname === "/oauth/token" && req.method === "POST") {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const code = params.get("code") ?? "";
    const verified = verifyAuthCode(code);

    if (!verified) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid_grant" }));
      return;
    }

    const accessToken = makeAccessToken();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: 31536000,
    }));
    return;
  }

  // ── Health ─────────────────────────────────────────────────────────────────
  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", name: "pitchless-brain-mcp" }));
    return;
  }

  // ── MCP endpoint ───────────────────────────────────────────────────────────
  if (!isAuthorized(req)) {
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer realm="Pitchless Brain"`,
    });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}
