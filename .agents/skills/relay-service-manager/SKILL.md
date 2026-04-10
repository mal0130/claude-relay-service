---
name: relay-service-manager
description: Manage the Codex Relay Service backend and frontend dev server (start, stop, restart, status, logs, frontend). Use this skill when the user wants to control the backend service process or start the frontend dev server. It automatically handles Node.js version switching (fnm use 24).
---

# Relay Service Manager

This skill helps manage the Codex Relay Service process (backend + frontend). It ensures the correct Node.js version (v24) is used for all operations.

## Usage

The skill uses a wrapper script that loads fnm and switches to Node.js 24 before executing the service management commands.

### Backend Commands

You can run the following commands using the `manage.sh` script:

- **Start**: Start the service (foreground or background)
  ```bash
  .Codex/skills/relay-service-manager/scripts/manage.sh start
  .Codex/skills/relay-service-manager/scripts/manage.sh start -d  # Background (Recommended)
  ```

- **Stop**: Stop the service
  ```bash
  .Codex/skills/relay-service-manager/scripts/manage.sh stop
  ```

- **Restart**: Restart the service
  ```bash
  .Codex/skills/relay-service-manager/scripts/manage.sh restart
  .Codex/skills/relay-service-manager/scripts/manage.sh restart -d  # Background (Recommended)
  ```

- **Status**: Check service status
  ```bash
  .Codex/skills/relay-service-manager/scripts/manage.sh status
  ```

- **Logs**: View service logs
  ```bash
  .Codex/skills/relay-service-manager/scripts/manage.sh logs
  .Codex/skills/relay-service-manager/scripts/manage.sh logs 100  # View last 100 lines
  ```

### Frontend Commands

The frontend dev server (Vite, port 3001) is managed separately:

- **Start frontend dev server** (background, recommended):
  ```bash
  .Codex/skills/relay-service-manager/scripts/frontend.sh start
  ```

- **Stop frontend dev server**:
  ```bash
  .Codex/skills/relay-service-manager/scripts/frontend.sh stop
  ```

- **Status**:
  ```bash
  .Codex/skills/relay-service-manager/scripts/frontend.sh status
  ```

## Examples

**User:** "Start the service in the background"
**Action:** Run `.Codex/skills/relay-service-manager/scripts/manage.sh start -d`

**User:** "Check service status"
**Action:** Run `.Codex/skills/relay-service-manager/scripts/manage.sh status`

**User:** "Restart the service"
**Action:** Run `.Codex/skills/relay-service-manager/scripts/manage.sh restart -d`

**User:** "Start the frontend dev server"
**Action:** Run `.Codex/skills/relay-service-manager/scripts/frontend.sh start`

**User:** "Start both backend and frontend"
**Action:** Run `.Codex/skills/relay-service-manager/scripts/manage.sh start -d` then `.Codex/skills/relay-service-manager/scripts/frontend.sh start`

**User:** "Stop the frontend"
**Action:** Run `.Codex/skills/relay-service-manager/scripts/frontend.sh stop`

## Implementation Details

The `manage.sh` script:
1. Loads `fnm` (Fast Node Manager)
2. Switches to Node.js 24 (`fnm use 24`)
3. Forwards all arguments to `scripts/manage.js`

The `frontend.sh` script:
1. Loads `fnm` and switches to Node.js 24
2. Manages the Vite dev server for `web/admin-spa/` (port 3001)
3. Stores PID in `.Codex/skills/relay-service-manager/frontend.pid`
