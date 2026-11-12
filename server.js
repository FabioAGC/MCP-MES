// =========================================
// FILE: /mes_swagger/server.js
// =========================================

import readline from "readline";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { executeSwaggerTool, config } from "./services/swaggerExecutor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load Swagger JSON

const swaggerPath = path.join(__dirname, "swagger", "MESSwaggerV3-3.json");

const swagger = JSON.parse(fs.readFileSync(swaggerPath, "utf-8"));

// -----------------------------------------
// Options (all optional, set in config/config.json)
// -----------------------------------------
// "dynamic": 3 small tools to search, describe and call operations (default)
// "full":    one tool per Swagger operation
const TOOL_MODE = config.toolMode === "full" ? "full" : "dynamic";
const READ_ONLY = config.readOnly === true;
const INCLUDE_TAGS = toSet(config.includeTags);
const INCLUDE_TOOLS = toSet(config.includeTools);
const EXCLUDE_TOOLS = toSet(config.excludeTools);
// Longest tool response sent back to the model, in characters
const MAX_RESPONSE_CHARS = config.maxResponseChars || 200000;

function toSet(list) {
  return Array.isArray(list) && list.length ? new Set(list) : null;
}

// -----------------------------------------
// Swagger → MCP Schema Converter
// -----------------------------------------
function swaggerTypeToJsonSchema(type) {
  switch (type) {
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "string";
  }
}

// Swagger summaries come with XML-doc tags like <para>
function cleanText(text) {
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

// -----------------------------------------------
// Resolve Swagger $ref → actual definition object
//  ----------------------------------------------
function resolveSwaggerRef(ref) {
  if (!ref) return null;
  const refPath = ref.replace("#/definitions/", "");
  return swagger.definitions?.[refPath] || null;
}

// -----------------------------------------
// Convert Swagger definition → JSON Schema
// Each definition is converted once and reused.
// -----------------------------------------
const definitionSchemaCache = new Map();

function convertDefinitionToSchema(definition) {
  // Fallback if definition missing
  if (!definition || !definition.properties) {
    return {
      type: "object",
      properties: {}
    };
  }

  const cached = definitionSchemaCache.get(definition);
  if (cached) return cached;

  const properties = {};
  const schema = { type: "object", properties };
  // Stored before the loop so a self-referencing definition cannot recurse forever
  definitionSchemaCache.set(definition, schema);

  // Loop all definition properties
  for (const [key, value] of Object.entries(definition.properties)) {
    // Nested $ref (child object)
    if (value.$ref) {
      const nestedDef = resolveSwaggerRef(value.$ref);
      properties[key] = convertDefinitionToSchema(nestedDef);
    }
    // Normal field
    else {
      properties[key] = {
        type: swaggerTypeToJsonSchema(value.type)
      };

      if (value.description) {
        properties[key].description = cleanText(value.description);
      }
    }
  }

  return schema;
}

// -----------------------------------------
// Build Input Schema
// -----------------------------------------
function buildInputSchema(parameters = []) {
  const properties = {};
  const required = [];

  for (const param of parameters) {
    // Normalize Swagger body param names like "model" → "body"
    const schemaKey = param.in === "body" ? "body" : param.name;

    // BODY PARAM ($ref from Swagger definitions)
    if (param.in === "body" && param.schema?.["$ref"]) {
      const definition = resolveSwaggerRef(param.schema["$ref"]);

      // Copied so the description below does not leak into the cached schema
      properties[schemaKey] = definition
        ? { ...convertDefinitionToSchema(definition) }
        : {
            type: "object"
          };
    }

    // NORMAL PARAM (query/header/path)
    else {
      properties[schemaKey] = {
        type: swaggerTypeToJsonSchema(param.type)
      };
    }
    // DESCRIPTION
    if (param.description) {
      properties[schemaKey].description = cleanText(param.description);
    }
    // REQUIRED
    if (param.required) {
      required.push(schemaKey);
    }
  }

  const schema = { type: "object", properties };
  if (required.length) schema.required = required;
  return schema;
}

// -----------------------------------------
// Build Dynamic Tools Registry
// Skip MiddlewareAccess APIs
// Input schemas are built on first use, not at startup.
// -----------------------------------------
const tools = {};

for (const [apiPath, methods] of Object.entries(swagger.paths)) {
  // OMIT any path containing /MiddlewareAccess/
  if (apiPath.includes("/MiddlewareAccess/")) {
    continue;
  }

  for (const [httpMethod, operation] of Object.entries(methods)) {
    // Friendly business name
    const toolName = operation.operationId || `${httpMethod}_${apiPath}`;
    const tags = operation.tags || [];

    if (READ_ONLY && httpMethod !== "get") continue;
    if (INCLUDE_TAGS && !tags.some((tag) => INCLUDE_TAGS.has(tag))) continue;
    if (INCLUDE_TOOLS && !INCLUDE_TOOLS.has(toolName)) continue;
    if (EXCLUDE_TOOLS && EXCLUDE_TOOLS.has(toolName)) continue;

    const parameters = operation.parameters || [];
    const description = cleanText(operation.summary || toolName);
    let inputSchema = null;

    tools[toolName] = {
      name: toolName,
      method: httpMethod.toUpperCase(),
      path: apiPath,
      description,
      tags,
      parameters,
      // Lower-case text used by the search tool
      searchText: `${toolName} ${description} ${tags.join(" ")}`.toLowerCase(),
      get inputSchema() {
        return (inputSchema ??= buildInputSchema(parameters));
      }
    };
  }
}

// The Swagger document is only needed for $ref lookups from here on
swagger.paths = null;

// -----------------------------------------
// Dynamic mode: 3 tools instead of one per operation
// -----------------------------------------
const SEARCH_TOOL = "mes_search_operations";
const DESCRIBE_TOOL = "mes_describe_operation";
const CALL_TOOL = "mes_call_operation";

const dynamicTools = [
  {
    name: SEARCH_TOOL,
    description:
      `Search the ${Object.keys(tools).length} AVEVA MES API operations by keyword. ` +
      "Returns operation names with method and summary. " +
      `Use ${DESCRIBE_TOOL} to see the parameters and ${CALL_TOOL} to run one.`,
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Keywords, e.g. 'work order', 'job start', 'lot attr'. Empty lists everything."
        },
        method: {
          type: "string",
          description: "Optional HTTP method filter: GET, POST, PUT or DELETE."
        },
        limit: {
          type: "number",
          description: "Maximum results. Default 25."
        }
      }
    }
  },
  {
    name: DESCRIBE_TOOL,
    description:
      "Get the full input schema (query, header and body parameters) of one MES operation.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Operation name, e.g. V3_WO_Get." }
      },
      required: ["name"]
    }
  },
  {
    name: CALL_TOOL,
    description:
      `Run one MES operation. Check its parameters with ${DESCRIBE_TOOL} first.`,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Operation name, e.g. V3_WO_Get." },
        arguments: {
          type: "object",
          description: "Arguments for the operation, as given by its input schema."
        }
      },
      required: ["name"]
    }
  }
];

function getTool(name) {
  // hasOwn: names like "constructor" must not resolve to Object.prototype
  if (typeof name !== "string" || !Object.hasOwn(tools, name)) {
    throw new Error(`Tool not found: ${name}`);
  }
  return tools[name];
}

function searchOperations({ query = "", method, limit = 25 } = {}) {
  const words = String(query).toLowerCase().split(/[\s_]+/).filter(Boolean);
  const wantedMethod = method ? String(method).toUpperCase() : null;
  const matches = [];

  for (const tool of Object.values(tools)) {
    if (wantedMethod && tool.method !== wantedMethod) continue;

    let score = 0;
    for (const word of words) {
      if (tool.searchText.includes(word)) score++;
    }
    if (words.length && score === 0) continue;

    matches.push({ tool, score });
  }

  matches.sort((a, b) => b.score - a.score);

  return {
    total: matches.length,
    operations: matches.slice(0, Math.max(1, limit)).map(({ tool }) => ({
      name: tool.name,
      method: tool.method,
      summary: tool.description
    }))
  };
}

function describeOperation({ name } = {}) {
  const tool = getTool(name);

  return {
    name: tool.name,
    method: tool.method,
    path: tool.path,
    description: tool.description,
    inputSchema: tool.inputSchema
  };
}

async function callTool(name, args = {}) {
  if (TOOL_MODE === "dynamic") {
    if (name === SEARCH_TOOL) return searchOperations(args);
    if (name === DESCRIBE_TOOL) return describeOperation(args);
    if (name === CALL_TOOL) {
      return executeSwaggerTool(getTool(args.name), args.arguments || {});
    }
  }

  // Operation names are accepted directly in both modes
  return executeSwaggerTool(getTool(name), args);
}

// -----------------------------------------
// tools/list payload, serialized once and reused
// -----------------------------------------
let toolsListJson = null;

function getToolsListJson() {
  if (!toolsListJson) {
    const list =
      TOOL_MODE === "dynamic"
        ? dynamicTools
        : Object.values(tools).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema
          }));

    toolsListJson = JSON.stringify({ tools: list });
  }
  return toolsListJson;
}

// -----------------------------------------
// Tool result helpers
// -----------------------------------------
function toText(data) {
  const text = typeof data === "string" ? data : JSON.stringify(data) ?? "";

  if (text.length <= MAX_RESPONSE_CHARS) return text;

  return (
    text.slice(0, MAX_RESPONSE_CHARS) +
    `\n[Truncated: response has ${text.length} characters, limit is ${MAX_RESPONSE_CHARS}. ` +
    "Narrow the filters or set max_rows.]"
  );
}

// Give the model the reason the MES returned, not only the HTTP status
function errorText(err) {
  const status = err.response?.status;
  const detail = err.response?.data;

  let text = status ? `MES returned HTTP ${status}: ${err.message}` : err.message;
  if (detail) text += `\n${toText(detail)}`;
  return text;
}

// -----------------------------------------
// MCP STDIO SERVER
// -----------------------------------------
function sendRaw(id, key, json) {
  process.stdout.write(
    `{"jsonrpc":"2.0","id":${JSON.stringify(id ?? null)},"${key}":${json}}\n`
  );
}

function sendResult(id, result) {
  sendRaw(id, "result", JSON.stringify(result));
}

function sendError(id, code, message) {
  sendRaw(id, "error", JSON.stringify({ code, message }));
}

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false
});

rl.on("line", async (line) => {
  let req;

  try {
    req = JSON.parse(line);
  } catch {
    return;
  }

  if (!req || typeof req !== "object") return;

  const { id, method, params } = req;
  // Notifications carry no id and never get a response
  const isRequest = id !== undefined && id !== null;

  try {
    // MCP Initialize
    if (method === "initialize") {
      sendResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: "mes-swagger-server",
          version: "1.1.0"
        }
      });
      return;
    }

    if (method === "ping") {
      sendResult(id, {});
      return;
    }

    // List Tools
    if (method === "tools/list") {
      sendRaw(id, "result", getToolsListJson());
      return;
    }

    // Execute Tool
    if (method === "tools/call") {
      const { name, arguments: args } = params || {};

      try {
        const result = await callTool(name, args || {});

        sendResult(id, {
          content: [{ type: "text", text: toText(result) }]
        });
      } catch (err) {
        // Reported as a tool result so the model can read it and react
        sendResult(id, {
          content: [{ type: "text", text: errorText(err) }],
          isError: true
        });
      }
      return;
    }

    // Unknown request: answer right away instead of leaving the client waiting
    if (isRequest) {
      sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    if (isRequest) {
      sendError(id, -32603, err.message);
    }
  }
});
