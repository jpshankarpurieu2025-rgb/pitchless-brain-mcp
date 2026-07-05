import { Client } from "@notionhq/client";
import { createHmac } from "crypto";
import type { IncomingMessage, ServerResponse } from "http";

const NOTION_TOKEN = process.env.NOTION_TOKEN ?? "";
const TEAM_USERNAME = process.env.TEAM_USERNAME ?? "pitchless";
const TEAM_PASSWORD = process.env.TEAM_PASSWORD ?? "";
const TOKEN_SECRET = process.env.TOKEN_SECRET ?? "pitchless-token-secret";
const BASE_URL = "https://pitchless-brain-mcp.vercel.app";
const LUMA_API_KEY = process.env.LUMA_API_KEY ?? "";
const TALLY_API_KEY = process.env.TALLY_API_KEY ?? "";
const BUFFER_API_KEY = process.env.BUFFER_API_KEY ?? "";

const notion = new Client({ auth: NOTION_TOKEN });

const DATABASES: Record<string, string> = {
  partners: "9965cb61-8e08-8393-b706-0125508ef030",
  events: "fd05cb61-8e08-8264-a316-015d86e1d15d",
  team: "0cd5cb61-8e08-83ec-8f00-011679ca61cd",
  tasks: "4f15cb61-8e08-82fc-8a5e-013733286686",
  members: "a445cb61-8e08-82c2-af36-8185dcc2679c",
  goals: "38d5cb61-8e08-80dc-a40a-f0061bab54d4",
  ideas: "38d5cb61-8e08-8077-a086-edfc78f6ccf5",
  meetings: "38d5cb61-8e08-8007-b9db-c87cb5834450",
  projects: "38d5cb61-8e08-8029-b948-f3ea3de74186",
  documents: "38d5cb61-8e08-803b-9b1c-db862462639a",
};

// ── Token helpers ─────────────────────────────────────────────────────────────
function sign(payload: string) {
  return createHmac("sha256", TOKEN_SECRET).update(payload).digest("hex");
}

function makeAccessToken() {
  const p = `access:${Date.now()}`;
  return `${Buffer.from(p).toString("base64")}.${sign(p)}`;
}

function verifyAccessToken(token: string) {
  try {
    const [b64, sig] = token.split(".");
    const p = Buffer.from(b64, "base64").toString();
    return sign(p) === sig && p.startsWith("access:");
  } catch { return false; }
}

function makeAuthCode(redirectUri: string, state: string) {
  const p = `code:${redirectUri}:${state}:${Date.now()}`;
  return `${Buffer.from(p).toString("base64url")}.${sign(p)}`;
}

function verifyAuthCode(code: string): { redirectUri: string; state: string } | null {
  try {
    const [b64, sig] = code.split(".");
    const p = Buffer.from(b64, "base64url").toString();
    if (sign(p) !== sig) return null;
    const parts = p.split(":");
    if (parts[0] !== "code") return null;
    if (Date.now() - parseInt(parts[parts.length - 1]) > 5 * 60 * 1000) return null;
    return { redirectUri: parts[1], state: parts[2] };
  } catch { return null; }
}

function isAuthorized(req: IncomingMessage) {
  const auth = (req.headers["authorization"] ?? "") as string;
  return verifyAccessToken(auth.startsWith("Bearer ") ? auth.slice(7) : "");
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => { b += c; });
    req.on("end", () => resolve(b));
  });
}

// ── Notion helpers ────────────────────────────────────────────────────────────
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
  const r: Record<string, string> = { id: page.id, url: page.url };
  for (const [k, v] of Object.entries(page.properties ?? {})) {
    const t = extractText(v);
    if (t) r[k] = t;
  }
  return r;
}

// ── MCP tool definitions ──────────────────────────────────────────────────────
const TOOLS = [
  {
    name: "get_workspace_overview",
    description: "Get a full overview of the Pitchless Notion workspace — all databases and their purposes. Use this first if unsure where to look.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "search_notion",
    description: "Search across the entire Pitchless Notion workspace. Use for any question about the company.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you want to find or know about" },
        filter_type: { type: "string", enum: ["page", "database"], description: "Optionally restrict results" },
      },
      required: ["query"],
    },
  },
  {
    name: "query_database",
    description: "Query a specific Pitchless database to get structured data about partners, events, team, tasks, etc.",
    inputSchema: {
      type: "object",
      properties: {
        database: { type: "string", enum: Object.keys(DATABASES), description: "Which database to query" },
        limit: { type: "number", description: "Max results (default 50, max 100)" },
        sort_by: { type: "string", description: "Property name to sort by (e.g. 'Nº events')" },
        sort_direction: { type: "string", enum: ["ascending", "descending"], description: "Sort direction (default descending)" },
      },
      required: ["database"],
    },
  },
  {
    name: "get_page",
    description: "Get the full content of a specific Notion page by its ID.",
    inputSchema: {
      type: "object",
      properties: { page_id: { type: "string", description: "The Notion page ID" } },
      required: ["page_id"],
    },
  },
  {
    name: "get_meetings",
    description: "Get recent Pitchless meeting notes and action items.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number", description: "Number of meetings to fetch (default 10)" } },
      required: [],
    },
  },
  {
    name: "get_luma_events",
    description: "Get Pitchless events from Luma — the official event platform. Returns upcoming and past events with attendee counts, dates, and ticket info.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max events to return (default 20)" },
        period: { type: "string", enum: ["future", "past"], description: "Filter by upcoming or past events (default: future)" },
      },
      required: [],
    },
  },
  {
    name: "get_luma_event_guests",
    description: "Get the guest list / attendees for a specific Luma event by its event API ID.",
    inputSchema: {
      type: "object",
      properties: {
        event_api_id: { type: "string", description: "The Luma event API ID (e.g. 'evt-xxxx')" },
        limit: { type: "number", description: "Max guests to return (default 50)" },
      },
      required: ["event_api_id"],
    },
  },
  {
    name: "get_tally_forms",
    description: "List all Tally forms for Pitchless — applications, surveys, registrations, etc.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_tally_submissions",
    description: "Get form submissions / responses for a specific Tally form. Use this to see leads, applicants, or survey answers.",
    inputSchema: {
      type: "object",
      properties: {
        form_id: { type: "string", description: "The Tally form ID" },
        limit: { type: "number", description: "Max submissions to return (default 50)" },
      },
      required: ["form_id"],
    },
  },
  {
    name: "get_buffer_channels",
    description: "Get all social media channels connected to Pitchless Buffer account (Instagram, LinkedIn, Twitter, etc.).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_buffer_posts",
    description: "Get Pitchless social media posts from Buffer — scheduled, published, or draft. Use to see what content is planned or has gone out.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "Buffer channel ID to get posts for (get from get_buffer_channels)" },
        status: { type: "string", enum: ["scheduled", "sent", "draft"], description: "Filter by post status (default: sent)" },
        limit: { type: "number", description: "Max posts to return (default 20)" },
      },
      required: ["channel_id"],
    },
  },
  {
    name: "get_buffer_analytics",
    description: "Get analytics/insights for a Pitchless Buffer channel — impressions, reach, engagement, likes, comments, shares over a time period.",
    inputSchema: {
      type: "object",
      properties: {
        channel_id: { type: "string", description: "Buffer channel ID (get from get_buffer_channels)" },
      },
      required: ["channel_id"],
    },
  },
];

// ── MCP tool execution ────────────────────────────────────────────────────────
async function callTool(name: string, args: any): Promise<string> {
  switch (name) {
    case "get_workspace_overview":
      return JSON.stringify({
        company: "Pitchless — Madrid's strongest founder community",
        website: "https://pitchless.eu",
        events_calendar: "https://luma.com/pitchless.community",
        databases: {
          partners: { description: "All partner organisations — venues, sponsors, VCs, universities, co-organisers" },
          events: { description: "All Pitchless events — past, present, and planned", event_types: ["Roundtables", "Networking", "Buildathon", "Tech Hackathon", "Traction Hackathon", "GTM Hackathon", "Investor intro", "Workshop", "Hacker House"] },
          team: { description: "Pitchless team members and their roles" },
          tasks: { description: "All tasks with owners, deadlines, and status", statuses: ["Not started", "In progress", "Blocked", "Done"] },
          members: { description: "Community members (~1,100 contacts)" },
          goals: { description: "Company goals and OKRs" },
          ideas: { description: "Team ideas and suggestions" },
          meetings: { description: "Meeting notes, summaries, and action items" },
          projects: { description: "Company projects and initiatives" },
          documents: { description: "Company documents and references" },
        },
      }, null, 2);

    case "search_notion": {
      const params: any = { query: args.query, page_size: 20 };
      if (args.filter_type) params.filter = { value: args.filter_type, property: "object" };
      const res = await notion.search(params);
      return JSON.stringify(res.results.map((r: any) => ({
        id: r.id,
        type: r.object,
        title: r.properties?.title?.title?.[0]?.plain_text ?? r.properties?.Name?.title?.[0]?.plain_text ?? r.title?.[0]?.plain_text ?? "(untitled)",
        url: r.url,
        last_edited: r.last_edited_time,
      })), null, 2);
    }

    case "query_database": {
      const dbId = DATABASES[args.database as string];
      if (!dbId) throw new Error(`Unknown database: ${args.database}`);
      const sorts: any[] = args.sort_by
        ? [{ property: args.sort_by, direction: args.sort_direction ?? "descending" }]
        : [{ timestamp: "last_edited_time", direction: "descending" }];
      const res = await notion.databases.query({
        database_id: dbId,
        page_size: Math.min(args.limit ?? 50, 100),
        sorts,
      });
      return JSON.stringify({ database: args.database, count: res.results.length, rows: res.results.map(formatPage) }, null, 2);
    }

    case "get_page": {
      const id = (args.page_id as string).replace(/-/g, "");
      const [page, blocks] = await Promise.all([
        notion.pages.retrieve({ page_id: id }),
        notion.blocks.children.list({ block_id: id, page_size: 100 }),
      ]);
      const content = (blocks.results as any[]).map((block) => {
        const type = block.type;
        const data = block[type];
        const text = data?.rich_text?.map((t: any) => t.plain_text).join("") ?? "";
        if (!text) return null;
        if (type === "heading_1") return `# ${text}`;
        if (type === "heading_2") return `## ${text}`;
        if (type === "heading_3") return `### ${text}`;
        if (type === "bulleted_list_item") return `• ${text}`;
        if (type === "to_do") return `[${data.checked ? "x" : " "}] ${text}`;
        return text;
      }).filter(Boolean).join("\n");
      return JSON.stringify({ properties: formatPage(page), content }, null, 2);
    }

    case "get_meetings": {
      const res = await notion.databases.query({
        database_id: DATABASES.meetings,
        page_size: Math.min(args.limit ?? 10, 50),
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      });
      return JSON.stringify(res.results.map(formatPage), null, 2);
    }

    case "get_luma_events": {
      const period = args.period ?? "future";
      const limit = Math.min(args.limit ?? 20, 100);
      const res = await fetch(`https://api.lu.ma/public/v1/calendar/list-events?period=${period}&pagination_limit=${limit}`, {
        headers: { "x-luma-api-key": LUMA_API_KEY },
      });
      if (!res.ok) throw new Error(`Luma API error: ${res.status}`);
      const data: any = await res.json();
      const events = (data.entries ?? []).map((e: any) => ({
        api_id: e.event?.api_id,
        name: e.event?.name,
        start_at: e.event?.start_at,
        end_at: e.event?.end_at,
        url: e.event?.url,
        cover_url: e.event?.cover_url,
        guest_count: e.event?.guest_count,
        timezone: e.event?.timezone,
      }));
      return JSON.stringify({ period, count: events.length, events }, null, 2);
    }

    case "get_luma_event_guests": {
      const limit = Math.min(args.limit ?? 50, 100);
      const res = await fetch(`https://api.lu.ma/public/v1/event/get-guests?event_api_id=${args.event_api_id}&pagination_limit=${limit}`, {
        headers: { "x-luma-api-key": LUMA_API_KEY },
      });
      if (!res.ok) throw new Error(`Luma API error: ${res.status}`);
      const data: any = await res.json();
      const guests = (data.entries ?? []).map((e: any) => ({
        name: e.guest?.name,
        email: e.guest?.email,
        approval_status: e.guest?.approval_status,
        registered_at: e.guest?.registered_at,
        checked_in_at: e.guest?.checked_in_at,
      }));
      return JSON.stringify({ event_api_id: args.event_api_id, count: guests.length, guests }, null, 2);
    }

    case "get_tally_forms": {
      const res = await fetch("https://api.tally.so/forms", {
        headers: { Authorization: `Bearer ${TALLY_API_KEY}` },
      });
      if (!res.ok) throw new Error(`Tally API error: ${res.status}`);
      const data: any = await res.json();
      const forms = (data.forms ?? data ?? []).map((f: any) => ({
        id: f.id,
        title: f.title,
        status: f.status,
        created_at: f.createdAt,
        submissions_count: f.submissionsCount,
        url: f.url,
      }));
      return JSON.stringify({ count: forms.length, forms }, null, 2);
    }

    case "get_tally_submissions": {
      const limit = Math.min(args.limit ?? 50, 100);
      const res = await fetch(`https://api.tally.so/forms/${args.form_id}/submissions?limit=${limit}`, {
        headers: { Authorization: `Bearer ${TALLY_API_KEY}` },
      });
      if (!res.ok) throw new Error(`Tally API error: ${res.status}`);
      const data: any = await res.json();
      return JSON.stringify({
        form_id: args.form_id,
        count: (data.submissions ?? data?.data ?? []).length,
        submissions: data.submissions ?? data?.data ?? data,
      }, null, 2);
    }

    case "get_buffer_channels": {
      const bufferGql = async (q: string) => {
        const r = await fetch("https://api.buffer.com/graphql", {
          method: "POST",
          headers: { Authorization: `Bearer ${BUFFER_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ query: q }),
        });
        if (!r.ok) throw new Error(`Buffer API error: ${r.status}`);
        return r.json();
      };
      const accountData: any = await bufferGql(`{ account { id name organizations { id name } } }`);
      const orgId = accountData?.data?.account?.organizations?.[0]?.id;
      const channelsData: any = await bufferGql(`{ channels(input: { organizationId: "${orgId}" }) { id name service serviceId } }`);
      return JSON.stringify({
        organization_id: orgId,
        channels: channelsData?.data?.channels ?? [],
      }, null, 2);
    }

    case "get_buffer_posts": {
      const status = args.status ?? "sent";
      const limit = Math.min(args.limit ?? 20, 100);
      // First get org ID
      const orgRes: any = await (await fetch("https://api.buffer.com/graphql", {
        method: "POST",
        headers: { Authorization: `Bearer ${BUFFER_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: `{ account { organizations { id } } }` }),
      })).json();
      const orgId = orgRes?.data?.account?.organizations?.[0]?.id;
      const query = `{
        posts(input: {
          organizationId: "${orgId}"
          filter: { channelIds: ["${args.channel_id}"], status: ${status} }
        }) {
          edges { node {
            id text status sentAt metricsUpdatedAt
            metrics { type name value unit }
          }}
        }
      }`;
      const res = await fetch("https://api.buffer.com/graphql", {
        method: "POST",
        headers: { Authorization: `Bearer ${BUFFER_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (!res.ok) throw new Error(`Buffer API error: ${res.status}`);
      const data: any = await res.json();
      const posts = (data?.data?.posts?.edges ?? []).slice(0, limit).map((e: any) => e.node);
      return JSON.stringify({ channel_id: args.channel_id, status, count: posts.length, posts }, null, 2);
    }

    case "get_buffer_analytics": {
      const orgRes: any = await (await fetch("https://api.buffer.com/graphql", {
        method: "POST",
        headers: { Authorization: `Bearer ${BUFFER_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: `{ account { organizations { id } } }` }),
      })).json();
      const orgId = orgRes?.data?.account?.organizations?.[0]?.id;
      if (!orgId) throw new Error("Could not find Buffer organization ID");
      const end = new Date();
      const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
      const query = `{
        aggregatedPostMetrics(input: {
          organizationId: "${orgId}"
          startDateTime: "${start.toISOString()}"
          endDateTime: "${end.toISOString()}"
          channelIds: ["${args.channel_id}"]
        }) {
          metrics { type name value unit }
          metricsUpdatedAt
        }
      }`;
      const res = await fetch("https://api.buffer.com/graphql", {
        method: "POST",
        headers: { Authorization: `Bearer ${BUFFER_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      if (!res.ok) throw new Error(`Buffer API error: ${res.status}`);
      const data: any = await res.json();
      return JSON.stringify({
        channel_id: args.channel_id,
        period: { start: start.toISOString(), end: end.toISOString() },
        ...data?.data?.aggregatedPostMetrics,
      }, null, 2);
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Login page ────────────────────────────────────────────────────────────────
function loginPage(redirectUri: string, state: string, clientId: string, error?: string) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Pitchless Brain — Connect</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0a0a;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center}.card{background:#111;border:1px solid #222;border-radius:16px;padding:40px;width:100%;max-width:400px}.logo{font-size:28px;font-weight:700;margin-bottom:8px}.logo span{color:#00c9a7}.subtitle{color:#888;font-size:14px;margin-bottom:32px}label{display:block;font-size:13px;color:#aaa;margin-bottom:6px}input{width:100%;padding:12px 14px;background:#1a1a1a;border:1px solid #333;border-radius:8px;color:#fff;font-size:15px;outline:none;margin-bottom:16px}input:focus{border-color:#00c9a7}.error{background:#2a1111;border:1px solid #ff4444;border-radius:8px;padding:12px 14px;font-size:13px;color:#ff6666;margin-bottom:16px}button{width:100%;padding:13px;background:#00c9a7;border:none;border-radius:8px;color:#000;font-size:15px;font-weight:600;cursor:pointer}.footer{text-align:center;margin-top:20px;font-size:12px;color:#555}</style></head><body><div class="card"><div class="logo">Pitch<span>less</span> Brain</div><div class="subtitle">Connect to your Claude account to access the Pitchless knowledge base.</div>${error ? `<div class="error">${error}</div>` : ""}<form method="POST" action="/oauth/authorize"><input type="hidden" name="redirect_uri" value="${redirectUri}"/><input type="hidden" name="state" value="${state}"/><input type="hidden" name="client_id" value="${clientId}"/><label>Username</label><input type="text" name="username" placeholder="Enter username" autocomplete="username" required/><label>Password</label><input type="password" name="password" placeholder="Enter password" autocomplete="current-password" required/><button type="submit">Connect to Pitchless Brain</button></form><div class="footer">Internal access only — Pitchless team</div></div></body></html>`;
}

// ── Main Vercel handler ───────────────────────────────────────────────────────
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const url = (req as any).url as string;
  const urlObj = new URL(url, BASE_URL);
  const p = urlObj.pathname;

  // CORS — allow Claude.ai and any origin to reach OAuth + MCP endpoints
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  // OAuth protected resource metadata (RFC 9728) — Claude.ai requires this
  if (p === "/.well-known/oauth-protected-resource" || p.startsWith("/.well-known/oauth-protected-resource/")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      resource: BASE_URL,
      authorization_servers: [BASE_URL],
    }));
  }

  // OAuth discovery
  if (p === "/.well-known/oauth-authorization-server") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      issuer: BASE_URL,
      authorization_endpoint: `${BASE_URL}/oauth/authorize`,
      token_endpoint: `${BASE_URL}/oauth/token`,
      registration_endpoint: `${BASE_URL}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256", "plain"],
    }));
  }

  // Dynamic client registration — always return the same static client
  if (p === "/oauth/register" && req.method === "POST") {
    res.writeHead(201, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      client_id: "pitchless-brain-client",
      client_secret: "pitchless-brain-secret",
      client_id_issued_at: Math.floor(Date.now() / 1000),
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }));
  }

  // Show login page
  if (p === "/oauth/authorize" && req.method === "GET") {
    const redirectUri = urlObj.searchParams.get("redirect_uri") ?? "";
    const state = urlObj.searchParams.get("state") ?? "";
    const clientId = urlObj.searchParams.get("client_id") ?? "";
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(loginPage(redirectUri, state, clientId));
  }

  // Handle login form submit
  if (p === "/oauth/authorize" && req.method === "POST") {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const username = params.get("username") ?? "";
    const password = params.get("password") ?? "";
    const redirectUri = params.get("redirect_uri") ?? "";
    const state = params.get("state") ?? "";
    const clientId = params.get("client_id") ?? "";

    if (username !== TEAM_USERNAME || password !== TEAM_PASSWORD) {
      res.writeHead(200, { "Content-Type": "text/html" });
      return res.end(loginPage(redirectUri, state, clientId, "Incorrect username or password."));
    }

    const code = makeAuthCode(redirectUri, state);
    const redirect = new URL(redirectUri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", state);
    res.writeHead(302, { Location: redirect.toString() });
    return res.end();
  }

  // Token exchange
  if (p === "/oauth/token" && req.method === "POST") {
    const body = await readBody(req);
    const params = new URLSearchParams(body);
    const code = params.get("code") ?? "";
    const verified = verifyAuthCode(code);
    if (!verified) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "invalid_grant" }));
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ access_token: makeAccessToken(), token_type: "Bearer", expires_in: 31536000 }));
  }

  // Health
  if (p === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok" }));
  }

  // MCP endpoint — stateless JSON-RPC
  if (!isAuthorized(req)) {
    res.writeHead(401, {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer realm="Pitchless Brain", resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource"`,
    });
    return res.end(JSON.stringify({ error: "Unauthorized" }));
  }

  // Handle GET (SSE capability check) — just confirm we're alive
  if (req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", name: "pitchless-brain", version: "1.0.0" }));
  }

  // Handle POST — JSON-RPC
  const body = await readBody(req);
  let rpc: any;
  try { rpc = JSON.parse(body); } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null }));
  }

  const { method, params, id } = rpc;

  function ok(result: any) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", result, id }));
  }
  function err(code: number, message: string) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id }));
  }

  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: "2024-11-05",
        serverInfo: { name: "pitchless-brain", version: "1.0.0" },
        capabilities: { tools: {} },
      });

    case "notifications/initialized":
      res.writeHead(204);
      return res.end();

    case "tools/list":
      return ok({ tools: TOOLS });

    case "tools/call": {
      const { name, arguments: args } = params ?? {};
      try {
        const text = await callTool(name, args ?? {});
        return ok({ content: [{ type: "text", text }] });
      } catch (e: any) {
        return err(-32000, e.message ?? "Tool error");
      }
    }

    case "ping":
      return ok({});

    default:
      return err(-32601, `Method not found: ${method}`);
  }
}
