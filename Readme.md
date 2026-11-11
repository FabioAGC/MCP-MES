# Restore the Claude MCP MES Server

Please Note: This MCP server is tested with AVEVA MES 2023 version

## 1. Prerequisites

Before starting, ensure you have the following installed:

* Node.js: Necessary to run the server.
* Claude Desktop: The interface where the MCP server will be integrated.

---

## 2. Program Setup

### Extract the Project Files

Extract the downloaded file to your preferred location.

Example:

```text id="e1"
C:\aveva-mes-claude-integration-main\
```

After extraction, the folder structure should look like this:

```text id="e2"
mcp_server/
    ├── config/
    │   └── config.json
    ├── services/
    │   └── swaggerExecutor.js
    ├── swagger/
    │   └── MESSwaggerV3-3.json
    └── server.js
    └── package.json
    
```

### Installation

Open a terminal inside the `aveva-mes-claude-integration-main/` folder and install the required dependency:

```bash id="e3"
npm install
```

### Action

Update the `config/config.json` file with your credentials and server details.

Do not modify any other files.

---

## 3. Configure Claude Desktop

### Claude Configuration

📁 **Path**

**File Name:** `claude_desktop_config.json`

```text
C:\Users\Administrator\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\
```

or

Directly go to Claude Desktop Settings, open **Developer**, and click the **"Edit Config"** button. It will directly redirect you to the location.

### 📝 Config

Add the following to the existing configuration:

```json
  "mcpServers": {
    "server-name": {
      "command": "node",
      "args": ["path"]
    }
  }
```

### Example

```json
{
  "mcpServers": {
    "mes-server": {
      "command": "node",
      "args": [
        "C:\\aveva-mes-claude-integration-main\\server.js"
      ]
    }
  },
  "preferences": {
    "coworkScheduledTasksEnabled": false,
    "ccdScheduledTasksEnabled": true,
    "coworkWebSearchEnabled": true,
    "remoteToolsDeviceName": "machine_name",
    "epitaxyPrefs": {
      "starred-local-code-sessions": [],
      "starred-cowork-spaces": [],
      "starred-session-groups": [],
      "dframe-local-slice": {
        "pinnedOrder": [],
        "customGroupAssignments": {},
        "customGroupOrder": {}
      }
    }
  }
}
```

---

## 4. Restart Claude Properly

Close the app.

To apply the changes, the application must be fully restarted. Use these commands to ensure no background processes remain:

```bash
taskkill /F /IM claude.exe /T
tasklist | findstr claude
```

---

## 5. Verify MCP Connection

### 📁 Logs

```text
Claude/logs/
```

### Files

```text
mcp-server-server-name.txt
```

### UI Check

Directly go to the Claude Desktop app Settings, open **Developer**, and verify that the configured MCP server is listed.

---

## 6. Final Outcome

* Claude Desktop connected to local MCP servers
* Tools auto-discovered via `tools/list`
* Tools executed via `tools/call`
* Real MCP flow achieved
