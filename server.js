// =========================================
// FILE: /mes_swagger/server.js
// =========================================

import readline from "readline";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { executeSwaggerTool } from "./services/swaggerExecutor.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load Swagger JSON

const swaggerPath = path.join(__dirname, "swagger", "MESSwaggerV3-3.json");

const swagger = JSON.parse(fs.readFileSync(swaggerPath, "utf-8"));

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
// -----------------------------------------
function convertDefinitionToSchema(definition) {
  // Fallback if definition missing
  if (!definition || !definition.properties) {
    return {
      type: "object",
      properties: {}
    };
  }
  const properties = {};
  const required = [];
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
        properties[key].description = value.description;
      }
    }
  }
  return {
    type: "object",
    properties,
    required
  };
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

      properties[schemaKey] = definition
        ? convertDefinitionToSchema(definition)
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
      properties[schemaKey].description = param.description;
    }
    // REQUIRED
    if (param.required) {
      required.push(schemaKey);
    }
  }

  return {
    type: "object",
    properties,
    required
  };
}

// -----------------------------------------
// Build Dynamic Tools Registry
// Skip MiddlewareAccess APIs
// -----------------------------------------
const tools = {};

for (const [apiPath, methods] of Object.entries(swagger.paths)) {
  // OMIT any path containing /MiddlewareAccess/
  if (apiPath.includes("/MiddlewareAccess/")) {
    continue;
  }

  for (const [httpMethod, config] of Object.entries(methods)) {
    // Friendly business name
    let toolName = config.operationId || `${httpMethod}_${apiPath}`;

    tools[toolName] = {
      name: toolName,
      method: httpMethod.toUpperCase(),
      path: apiPath,
      description: config.summary || toolName,
      parameters: config.parameters || [],
      inputSchema: buildInputSchema(config.parameters || [])
    };
  }
}

// -----------------------------------------
// MCP STDIO SERVER
// -----------------------------------------
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on("line", async (line) => {
  let req;

  try {
    req = JSON.parse(line);
  } catch {
    return;
  }

  const { id, method, params } = req;

  try {
    // MCP Initialize
    if (method === "initialize") {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {}
            },
            serverInfo: {
              name: "mes-swagger-server",
              version: "1.0.0"
            }
          }
        }) + "\n"
      );
      return;
    }

    // Ignore initialized notification
    if (method === "notifications/initialized") {
      return;
    }

    // List Tools
    if (method === "tools/list") {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            tools: Object.values(tools).map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: tool.inputSchema
            }))
          }
        }) + "\n"
      );
      return;
    }

    // Execute Tool
    if (method === "tools/call") {
      const { name, arguments: args } = params;

      if (!tools[name]) {
        throw new Error(`Tool not found: ${name}`);
      }

      const tool = tools[name];

      const result = await executeSwaggerTool(tool, args);

      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2)
              }
            ]
          }
        }) + "\n"
      );

      return;
    }
  } catch (err) {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: err.message
        }
      }) + "\n"
    );
  }
});