import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { Client } from "@notionhq/client";
import { z } from "zod";
import http from "http";

const NOTION_TOKEN = process.env.NOTION_TOKEN ?? "";

const notion = new Client({ auth: NOTION_TOKEN });

// ── Workspace map ─────────────────────────────────────────────────────────────
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

// ── Helper ────────────────────────────────────────────────────────────────────
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

function createServer() {
  const server = new McpServer({
    name: "pitchless-brain",
    version: "1.0.0",
  });

  // ── Tool: get_workspace_overview ────────────────────────────────────────────
  server.tool(
    "get_workspace_overview",
    "Get a full overview of the Pitchless Notion workspace — all databases, their purposes, and key info. Use this first if unsure where to look.",
    {},
    async () => {
      const overview = {
        company: "Pitchless — Madrid's strongest founder community",
        website: "https://pitchless.eu",
        events_calendar: "https://luma.com/pitchless.community",
        databases: {
          partners: { description: "All partner organisations — venues, sponsors, VCs, universities, co-organisers", key_fields: ["Name", "Org Type", "Relationship", "Bond Strength (1-5)", "Events", "Contact"] },
          events: { description: "All Pitchless events — past, present, and planned", key_fields: ["Name", "Date", "Type", "Status", "Partners", "Attendees", "Place", "Luma URL"], event_types: ["Roundtables", "Networking", "Buildathon", "Tech Hackathon", "Traction Hackathon", "GTM Hackathon", "Investor intro", "Workshop", "Hacker House"] },
          team: { description: "Pitchless team members and their roles", key_fields: ["Name", "Role", "Departments", "LinkedIn"] },
          tasks: { description: "All tasks across the company with owners, deadlines, and status", key_fields: ["Name", "Status", "Owner", "Deadline", "Eisenhower State", "OKRs", "KPIs"], statuses: ["Not started", "In progress", "Blocked", "Done"] },
          members: { description: "Pitchless community members (~1,100 contacts)" },
          goals: { description: "Company goals and OKRs" },
          ideas: { description: "Team ideas and suggestions" },
          meetings: { description: "Meeting notes, summaries, and action items" },
          projects: { description: "Company projects and initiatives" },
          documents: { description: "Company documents and references" },
        },
      };
      return { content: [{ type: "text", text: JSON.stringify(overview, null, 2) }] };
    }
  );

  // ── Tool: search_notion ─────────────────────────────────────────────────────
  server.tool(
    "search_notion",
    "Search across the entire Pitchless Notion workspace. Use for any question about the company, team, events, partners, tasks, meetings, members, goals, or projects.",
    {
      query: z.string().describe("What you want to find or know about"),
      filter_type: z.enum(["page", "database"]).optional().describe("Optionally restrict to pages or databases"),
    },
    async ({ query, filter_type }) => {
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
    }
  );

  // ── Tool: query_database ────────────────────────────────────────────────────
  server.tool(
    "query_database",
    "Query a specific Pitchless database to get structured data about partners, events, team members, tasks, etc.",
    {
      database: z.enum(["partners", "events", "team", "tasks", "members", "goals", "ideas", "meetings", "projects", "documents"]).describe("Which database to query"),
      limit: z.number().optional().default(50).describe("Max number of results to return"),
    },
    async ({ database, limit }) => {
      const dbId = DATABASES[database];
      const res = await notion.databases.query({
        database_id: dbId,
        page_size: Math.min(limit ?? 50, 100),
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      });
      const rows = res.results.map(formatPage);
      return { content: [{ type: "text", text: JSON.stringify({ database, count: rows.length, rows }, null, 2) }] };
    }
  );

  // ── Tool: get_page ──────────────────────────────────────────────────────────
  server.tool(
    "get_page",
    "Get the full content of a specific Notion page by its ID. Use after search_notion to read full details.",
    { page_id: z.string().describe("The Notion page ID to retrieve") },
    async ({ page_id }) => {
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
    }
  );

  // ── Tool: get_meetings ──────────────────────────────────────────────────────
  server.tool(
    "get_meetings",
    "Get recent Pitchless meeting notes. Use for questions about what was discussed, decisions made, or action items.",
    { limit: z.number().optional().default(10).describe("Number of recent meetings to fetch") },
    async ({ limit }) => {
      const res = await notion.databases.query({
        database_id: DATABASES.meetings,
        page_size: Math.min(limit ?? 10, 50),
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      });
      const meetings = res.results.map(formatPage);
      return { content: [{ type: "text", text: JSON.stringify(meetings, null, 2) }] };
    }
  );

  return server;
}

// ── HTTP server for Vercel / remote MCP ──────────────────────────────────────
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

const httpServer = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", name: "pitchless-brain-mcp" }));
    return;
  }

  if (req.url === "/mcp") {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

    res.on("close", () => { transport.close(); server.close(); });

    await server.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

httpServer.listen(PORT, () => {
  console.log(`Pitchless Brain MCP running on port ${PORT}`);
  console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
});
