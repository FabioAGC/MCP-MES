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

const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

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
// SSL (Internal Self-Signed Support)
// -----------------------------------------
const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

// -----------------------------------------
// TOKEN CACHE
// -----------------------------------------
let cachedToken = null;
let tokenExpiry = 0;

// -----------------------------------------
// GET ACCESS TOKEN
// grant_type=password
// -----------------------------------------
async function getAccessToken() {
  try {
    // Reuse cached token if valid
    if (cachedToken && Date.now() < tokenExpiry) {
      return cachedToken;
    }

    const formData = new URLSearchParams();
    formData.append("grant_type", "password");
    formData.append("scope", "system");
    formData.append("username", USERNAME);
    formData.append("password", PASSWORD);

    const response = await axios.post(
      TOKEN_URL,
      formData,
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          Host: HOST,
          Authorization: `Basic ${BASIC_AUTH}`
        },
        httpsAgent,
        maxBodyLength: Infinity
      }
    );

    if (!response.data?.access_token) {
      throw new Error("No access_token returned from MES Identity Manager.");
    }

    cachedToken = response.data.access_token;

    // Fallback ~55 mins
    const expiresInSeconds = response.data.expires_in || 3300;

    // Refresh slightly early (30 sec buffer)
    tokenExpiry = Date.now() + ((expiresInSeconds - 30) * 1000);


    return cachedToken;

  } catch (error) {
    console.error(
      "[MES Auth] Token request failed:",
      error.response?.data || error.message
    );

    throw error;
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

    // Always ensure valid token
    const token = await getAccessToken();

    const queryParams = {};

    const headers = {
      Authorization: `Bearer ${token}`
    };

    let body = null;

    // -----------------------------------------
    // PARAMETER MAPPING
    // body  => args.body
    // query => args[param.name]
    // header=> args[param.name]
    // -----------------------------------------
    for (const param of tool.parameters || []) {
      const value =
        param.in === "body"
          ? args.body
          : args[param.name];

      if (value === undefined || value === null) {
        continue;
      }

      if (param.in === "query") {
        queryParams[param.name] = value;
      }

      if (param.in === "header") {
        headers[param.name] = value;
      }

      if (param.in === "body") {
        body = value;
      }
    }

    const url = BASE_URL + tool.path;

    let response;

    try {
      response = await axios({
        method: tool.method,
        url,
        params: queryParams,
        data: body,
        headers,
        httpsAgent,
        maxBodyLength: Infinity
      });
    } catch (error) {

      // Token expired / invalid → force refresh once
      if (error.response?.status === 401) {

        // Clear old token
        cachedToken = null;
        tokenExpiry = 0;

        // Get fresh token
        const newToken = await getAccessToken();

        // Replace bearer token
        headers.Authorization = `Bearer ${newToken}`;

        // Retry original request once
        response = await axios({
          method: tool.method,
          url,
          params: queryParams,
          data: body,
          headers,
          httpsAgent,
          maxBodyLength: Infinity
        });

      } else {
        throw error;
      }
    }
    return response.data;

  } catch (error) {
    console.error(
      `[Swagger Execute Failed] ${tool?.method?.toUpperCase()} ${tool?.path}`,
      error.response?.data || error.message
    );

    throw error;
  }
}