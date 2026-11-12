// ==============================================
// FILE: /mes_swagger/services/swaggerExecutor.js
// ==============================================

import axios from "axios";
import https from "https";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// -----------------------------------------
// LOAD CONFIG
// -----------------------------------------
const configPath = path.join(__dirname, "../config/config.json");

if (!fs.existsSync(configPath)) {
  throw new Error(`Missing config file: ${configPath}`);
}

export const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

const BASE_URL = config.baseUrl;
const TOKEN_URL = config.tokenUrl;
const HOST = config.host;

// OAuth Client Credentials
const CLIENT_ID = config.clientId;
const CLIENT_SECRET = config.clientSecret;

// MES Service Account Credentials
const USERNAME = config.username;
const PASSWORD = config.password;

// Optional prebuilt basicAuth OR generate dynamically
const BASIC_AUTH =
  config.basicAuth ||
  Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

// -----------------------------------------
// HTTP CLIENT
// One shared client with keep-alive, so the TCP + TLS handshake
// is paid once and reused by every following call.
// SSL validation stays off (internal self-signed support).
// -----------------------------------------
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
  maxSockets: config.maxSockets || 10
});

const http = axios.create({
  httpsAgent,
  timeout: config.timeoutMs || 30000,
  maxBodyLength: Infinity
});

// -----------------------------------------
// TOKEN CACHE
// -----------------------------------------
let cachedToken = null;
let tokenExpiry = 0;
// Token request in flight, shared by concurrent calls
let pendingToken = null;

async function requestToken() {
  const formData = new URLSearchParams();
  formData.append("grant_type", "password");
  formData.append("scope", "system");
  formData.append("username", USERNAME);
  formData.append("password", PASSWORD);

  const response = await http.post(TOKEN_URL, formData, {
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      Host: HOST,
      Authorization: `Basic ${BASIC_AUTH}`
    }
  });

  if (!response.data?.access_token) {
    throw new Error("No access_token returned from MES Identity Manager.");
  }

  cachedToken = response.data.access_token;

  // Fallback ~55 mins
  const expiresInSeconds = response.data.expires_in || 3300;

  // Refresh slightly early (30 sec buffer)
  tokenExpiry = Date.now() + (expiresInSeconds - 30) * 1000;

  return cachedToken;
}

// -----------------------------------------
// GET ACCESS TOKEN
// grant_type=password
// -----------------------------------------
function getAccessToken() {
  // Reuse cached token if valid
  if (cachedToken && Date.now() < tokenExpiry) {
    return Promise.resolve(cachedToken);
  }

  // Parallel calls wait for the same token request
  if (!pendingToken) {
    pendingToken = requestToken()
      .catch((error) => {
        console.error(
          "[MES Auth] Token request failed:",
          error.response?.data || error.message
        );
        throw error;
      })
      .finally(() => {
        pendingToken = null;
      });
  }

  return pendingToken;
}

// Drop the token only if it is still the one that was rejected,
// so parallel 401s trigger a single refresh.
function invalidateToken(rejectedToken) {
  if (cachedToken === rejectedToken) {
    cachedToken = null;
    tokenExpiry = 0;
  }
}

// -----------------------------------------
// GENERIC SWAGGER TOOL EXECUTOR
// -----------------------------------------
export async function executeSwaggerTool(tool, args = {}) {
  try {
    if (!tool) {
      throw new Error("Swagger tool definition is missing.");
    }

    const queryParams = {};
    const headers = {};
    let body = null;

    // -----------------------------------------
    // PARAMETER MAPPING
    // body  => args.body
    // query => args[param.name]
    // header=> args[param.name]
    // -----------------------------------------
    for (const param of tool.parameters || []) {
      const value = param.in === "body" ? args.body : args[param.name];

      if (value === undefined || value === null) {
        continue;
      }

      if (param.in === "query") {
        queryParams[param.name] = value;
      } else if (param.in === "header") {
        headers[param.name] = value;
      } else if (param.in === "body") {
        body = value;
      }
    }

    const request = {
      method: tool.method,
      url: BASE_URL + tool.path,
      params: queryParams,
      data: body,
      headers
    };

    // Always ensure valid token
    let token = await getAccessToken();
    headers.Authorization = `Bearer ${token}`;

    try {
      return (await http(request)).data;
    } catch (error) {
      if (error.response?.status !== 401) {
        throw error;
      }

      // Token expired / invalid → force refresh and retry once
      invalidateToken(token);
      token = await getAccessToken();
      headers.Authorization = `Bearer ${token}`;

      return (await http(request)).data;
    }
  } catch (error) {
    console.error(
      `[Swagger Execute Failed] ${tool?.method?.toUpperCase()} ${tool?.path}`,
      error.response?.data || error.message
    );

    throw error;
  }
}
