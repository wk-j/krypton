# OpenCode Dashboard — Implementation Spec

> Status: Implemented
> Date: 2026-03-15
> Milestone: Post-M8 (new dashboard)

## Problem

OpenCode (AI coding assistant CLI) stores all session history, message data, token usage, and tool invocations in a local SQLite database (`~/.local/share/opencode/opencode.db`). There is no quick way to see an overview of recent sessions, aggregate token usage, model distribution, or tool usage patterns without writing ad-hoc SQL queries. A dashboard overlay in Krypton would surface this information at a glance.

## Solution

Add a new OpenCode Dashboard (`Cmd+Shift+O`) to the existing dashboard framework. A new Tauri command `query_sqlite` executes read-only SQL against a specified SQLite database and returns JSON rows. The frontend dashboard module runs several queries in parallel to gather session history, token usage, model stats, and tool usage, then renders them into the dashboard content area.

## Affected Files

| File | Change |
|------|--------|
| `src/dashboards/opencode.ts` | **New** — OpenCode Dashboard implementation |
| `src/main.ts` | Register OpenCode Dashboard |
| `src/styles.css` | OpenCode Dashboard-specific styles |
| `src-tauri/src/commands.rs` | Add `query_sqlite` command |
| `src-tauri/src/lib.rs` | Register `query_sqlite` |
| `src-tauri/Cargo.toml` | Add `rusqlite` dependency |

## Design

### Data Structures

```typescript
// src/dashboards/opencode.ts — internal types

interface OcSession {
  id: string;
  title: string;
  directory: string;
  timeCreated: number;   // epoch ms
  timeUpdated: number;
  msgCount: number;
  userMsgs: number;
  asstMsgs: number;
  outputTokens: number;
  additions: number;
  deletions: number;
  files: number;
}

interface OcModelUsage {
  model: string;
  provider: string;
  count: number;
  totalOutput: number;
}

interface OcToolUsage {
  tool: string;
  count: number;
}

interface OcOverview {
  totalSessions: number;
  totalMessages: number;
  totalTokensInput: number;
  totalTokensOutput: number;
  totalCacheRead: number;
  totalCost: number;
}
```

### API / Commands

```rust
// src-tauri/src/commands.rs
#[tauri::command]
fn query_sqlite(
    db_path: String,
    query: String,
    params: Vec<serde_json::Value>,
) -> Result<Vec<serde_json::Map<String, serde_json::Value>>, String>
```

Opens the SQLite database in **read-only** mode, executes the query with bound parameters, and returns rows as a `Vec` of JSON objects (column name -> value). The command:
- Opens with `SQLITE_OPEN_READ_ONLY` flag (no writes possible)
- Limits result set to 1000 rows
- Has a 5-second busy timeout
- Rejects queries starting with `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `CREATE` (defense in depth)

### Data Flow

```
1. User presses Cmd+Shift+O
2. InputRouter -> DashboardManager.toggle('opencode')
3. DashboardManager.open('opencode') -> calls onOpen(container)
4. OpenCode Dashboard fires 4 queries in parallel via invoke('query_sqlite'):
   a. Recent sessions (top 20, with message counts and token usage)
   b. Aggregate overview (total sessions, messages, tokens, cost)
   c. Model usage breakdown
   d. Tool usage breakdown (top 15)
5. Rust backend: rusqlite opens ~/.local/share/opencode/opencode.db read-only
6. Executes each query, maps rows to JSON, returns
7. Frontend renders: overview stats, recent sessions list, model chart, tool chart
```

### Keybindings

| Key | Context | Action |
|-----|---------|--------|
| `Cmd+Shift+O` | Normal / Dashboard(opencode) | Toggle OpenCode Dashboard |
| `Escape` | Dashboard(opencode) | Close |
| `r` | Dashboard(opencode) | Refresh data |

### UI Layout

The dashboard content area has 3 sections:

1. **Overview Stats** — 4 stat cards in a row: Total Sessions, Total Messages, Output Tokens (formatted with K/M suffix), Total Cost ($)
2. **Recent Sessions** — Table with columns: Title, Directory, Messages, Output Tokens, +/- Lines, Duration (relative time), updated-at timestamp. Rows sorted by `time_updated DESC`, limited to 20
3. **Usage Breakdown** — Two side-by-side sections:
   - **Models** — List of model+provider with message count and output tokens
   - **Tools** — List of tool names with invocation count (top 15)

### SQL Queries

**Overview:**
```sql
SELECT
  (SELECT COUNT(*) FROM session WHERE parent_id IS NULL) as total_sessions,
  (SELECT COUNT(*) FROM message) as total_messages,
  (SELECT COALESCE(SUM(json_extract(data, '$.tokens.input')), 0) FROM message WHERE json_extract(data, '$.role') = 'assistant') as total_input,
  (SELECT COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) FROM message WHERE json_extract(data, '$.role') = 'assistant') as total_output,
  (SELECT COALESCE(SUM(json_extract(data, '$.tokens.cache.read')), 0) FROM message WHERE json_extract(data, '$.role') = 'assistant') as total_cache_read,
  (SELECT COALESCE(SUM(json_extract(data, '$.cost')), 0) FROM message WHERE json_extract(data, '$.role') = 'assistant') as total_cost
```

**Recent sessions (top 20 parent-level):**
```sql
SELECT
  s.id, s.title, s.directory,
  s.summary_additions, s.summary_deletions, s.summary_files,
  s.time_created, s.time_updated,
  COUNT(m.id) as msg_count,
  SUM(CASE WHEN json_extract(m.data, '$.role') = 'user' THEN 1 ELSE 0 END) as user_msgs,
  SUM(CASE WHEN json_extract(m.data, '$.role') = 'assistant' THEN 1 ELSE 0 END) as asst_msgs,
  COALESCE(SUM(json_extract(m.data, '$.tokens.output')), 0) as output_tokens
FROM session s
LEFT JOIN message m ON m.session_id = s.id
WHERE s.parent_id IS NULL
GROUP BY s.id
ORDER BY s.time_updated DESC
LIMIT 20
```

**Model usage:**
```sql
SELECT
  json_extract(data, '$.modelID') as model,
  json_extract(data, '$.providerID') as provider,
  COUNT(*) as cnt,
  COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) as total_output
FROM message
WHERE json_extract(data, '$.role') = 'assistant'
  AND json_extract(data, '$.modelID') IS NOT NULL
GROUP BY model, provider
ORDER BY cnt DESC
```

**Tool usage (top 15):**
```sql
SELECT
  json_extract(data, '$.type') as tool_type,
  json_extract(data, '$.tool') as tool_name,
  COUNT(*) as cnt
FROM part
WHERE json_extract(data, '$.type') = 'tool'
GROUP BY tool_name
ORDER BY cnt DESC
LIMIT 15
```

## Edge Cases

- **Database not found:** Show "OpenCode database not found at ~/.local/share/opencode/opencode.db" message with the expected path.
- **Database locked:** rusqlite opens read-only with busy timeout; if still locked, return error message.
- **Empty database:** Show zero counts gracefully; "No sessions yet" in the session list.
- **Large database (1.8 GB):** Queries use indexed columns (`time_updated`, `session_id`). The aggregate queries over `message` may take 1-2 seconds on cold cache — show loading indicator.
- **`query_sqlite` security:** Read-only mode + write-statement rejection prevents any modification. The frontend passes the hardcoded DB path.

## Open Questions

None.

## Out of Scope

- Writing to the OpenCode database (staging, editing sessions)
- Live/streaming updates (auto-refresh)
- Filtering sessions by project or date range (future enhancement)
- Rendering message content or conversation threads
- Cost estimation (cost field is provider-dependent and often 0)
