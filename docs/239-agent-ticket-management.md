# Agent Ticket Management — Implementation Spec

> Status: Implemented
> Date: 2026-09-01
> Milestone: ACP Harness — local working context

## Problem

Spec 238 ให้ lane เขียน active ticket ได้แค่ช่องเดียวคือ `ticket_progress` (status + summary)
และต้องรอผู้ใช้ผูก worker ด้วย `#ticket work` ก่อน ส่วน note, resource และ GitHub link
เป็นคำสั่ง `#ticket` ของผู้ใช้เท่านั้น ผลคือระหว่างที่ agent ทำงานจริง มันบันทึกสิ่งที่พบ
ลง ticket เองไม่ได้ และถ้าผู้ใช้ลืม bind worker การรายงานสถานะทั้งหมดจะถูก reject

## Solution

เพิ่ม MCP tool ฝั่ง hook server อีก 3 ตัว — `ticket_note`, `ticket_add_resource`,
`ticket_link` — ให้ lane จัดการ active ticket ได้ครบระหว่างทำงาน โดย reuse ฟังก์ชัน
`*_for_project` ใน `ticket_bundle.rs` เดิมทั้งหมด (path validation, symlink guard,
atomic write) สิทธิ์เขียนแยกสองชั้น (ผู้ใช้เลือก option B):

- **append-only เปิดทุก lane:** `ticket_note` และ `ticket_add_resource` — การ append
  ไม่ชนกัน หลาย lane ช่วยกันทิ้ง findings ลงตั๋วเดียวกันได้ ขอแค่ ticket ตรงกับ active pointer
- **ค่าเดี่ยวเป็นของ worker:** `ticket_progress` และ `ticket_link` — คง gate เดิม
  พร้อม **auto-claim**: เมื่อยังไม่มี worker binding การเขียนสำเร็จครั้งแรกจะผูก lane
  นั้นเป็น worker อัตโนมัติ (pattern auto-bind ของ `issue_progress`, spec 190)

ทุกการเขียน emit event เดิม `acp-ticket-progress` ให้ Ticket Panel refresh ทันที

## Research

- `ticket_bundle.rs` มี `update_ticket_status_for_project` และ
  `add_ticket_resource_for_project` เป็น `pub(crate)` อยู่แล้ว ส่วน append note กับ
  update github ยังฝัง logic ใน `#[tauri::command]` ต้อง extract เป็น `_for_project`
- `ticket_progress` ใน `hook_server.rs` เป็น template ที่ใช้ได้เลย: validate binding →
  เรียก `ticket_bundle` → emit `acp-ticket-progress { harnessId, ticketId, ticket }` →
  frontend listener แทนที่ `activeTicket` แล้ว `renderTicketDock()` — ไม่มี bus
  round-trip เหมือน `issue_progress`
- spec 190 มี precedent auto-bind ในโค้ดแล้ว: `issue_progress` จาก lane ที่ไม่มี binding
  จะ self-register แทนที่จะ reject
- `validate_ticket_progress_binding` เทียบเฉพาะ `lane_display_name` กับ `ticket_id`
  ไม่เคยใช้ `laneId` ฝั่ง Rust ดังนั้น hook server auto-claim ได้โดยไม่รู้ frontend lane id
  แล้วให้ frontend reconcile ผ่าน event
- active pointer ถูก persist ที่ `*.active-ticket.json` (`get_active_ticket_path`)
  hook server อ่านเองได้ จึงตรวจว่า ticket ที่ขอเขียนคือ active ticket จริงก่อน claim
- ทางเลือกที่ตัดทิ้ง: (1) tool เดียวแบบ multiplex `ticket_update { action }` — ผิด style
  เดิมของ bus tools (handoff_*, artifact_* แยกเป็น tool เล็ก) และ schema ซับซ้อนกว่า
  (2) bus round-trip ผ่าน frontend ทุกการเขียน — ช้ากว่าและ `ticket_progress` พิสูจน์แล้วว่า
  Rust-side validation พอ (3) ให้ agent แก้ `ticket.md` ตรง ๆ ด้วย edit tool — ข้าม
  contextRevision, ไม่มี event ให้ panel refresh และเปิดทางเขียนนอก schema

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Linear MCP | ~21 tools รวม `update_issue`, `create_comment`; agent ทั้ง create/update ได้เต็ม | granular tool ต่อ operation, ไม่มี binding gate |
| GitHub MCP server | `issue_write`, `add_issue_comment` แยก toolset; ยังไม่มี `update_issue_comment` (feature request #1083) | write tools แคบและ append-first เหมือนแนวทางนี้ |
| Claude Code TodoWrite | agent เป็นเจ้าของ task list เต็มรูปแบบ ไม่ต้องขอ approve ต่อรายการ | สถานะงานของ agent ควรอัปเดตได้โดยไม่มี friction |
| Krypton spec 190 | `issue_progress` auto-bind lane แรกที่รายงานเมื่อไม่มี binding | pattern auto-claim ที่ nำมาใช้ซ้ำตรง ๆ |

**Krypton delta:** ต่างจาก Linear/GitHub MCP ตรงที่การเขียนถูกจำกัดใน local bundle
(`.krypton/tickets/<id>/`) ผ่าน validation ของ Rust เท่านั้น, มี worker-binding gate
(lane อื่นที่ไม่ใช่ worker ยัง reject), และ operation ฝั่งทำลาย (unlink, clear, delete,
สร้าง/เปลี่ยน active ticket) ยังเป็น keyboard command ของผู้ใช้เท่านั้น

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/ticket_bundle.rs` | extract `append_ticket_note_for_project`, `update_ticket_github_for_project`; helper parse issue ref (`owner/repo#123` หรือ URL) + tests |
| `src-tauri/src/hook_server.rs` | descriptors + dispatch ของ 3 tools ใหม่, shared `resolve_ticket_write_binding` (validate-or-claim), อ่าน active pointer, emit events, `tool_category` map เพิ่ม + tests |
| `src/acp/harness-permission-scan.ts` | เพิ่ม 3 ชื่อ tool ใน `HARNESS_ISSUE_TOOL_NAMES` และ regex |
| `src/acp/harness-prompts.ts` | pin บรรทัด worker เปลี่ยนเป็น ticket-tools line; `TICKET_PIN_MAX_CHARS` 700 → 780 |
| `src/acp/acp-harness-view.ts` | listener `acp-ticket-worker` (reconcile binding + journal), gh refresh เมื่อ link เปลี่ยน |
| `src/acp/harness-prompts.test.ts`, `src/acp/acp-harness-view.test.ts` | pin ใหม่, claim/reconcile, link refresh |
| `docs/04-architecture.md`, `docs/05-data-flow.md`, `docs/README.md` | agent-side ticket writes + index |

## Design

### MCP Tools

```jsonc
// เปิดทุก lane (ตรวจแค่ว่าเป็น active ticket) — append-only
ticket_note         { ticket_id: string, markdown: string }        // append ลง ticket.md, ≤ 2000 Unicode chars/call
ticket_add_resource { ticket_id: string, path: string }            // copy regular file → resources/

// worker-gated + auto-claim — ค่าเดี่ยว
ticket_link         { ticket_id: string, issue_key: string }       // set/replace GitHub reference
ticket_progress     { ticket_id, status: in_progress|blocked|done, summary? }  // เดิม ไม่เปลี่ยน schema
```

- `ticket_note` reuse ตรรกะ append เดิม: ขึ้นย่อหน้าใหม่, bump `contextRevision`
- `ticket_add_resource` reuse `resolve_resource_source` + `add_ticket_resource_for_project`
  ครบทุก guard เดิม: regular file เท่านั้น, reject symlink, 25 MiB, sanitize ชื่อ, copy inert
- `ticket_link` รับ `owner/repo#123` หรือ GitHub issue URL; Rust เขียน reference ขั้นต่ำ
  (issueKey, issueUrl, repo, number, title = title เดิมของ ticket, fetchedAt = now,
  ไม่มี state) แล้ว frontend ดึง snapshot จริงผ่าน `gh` ใน background ตาม flow refresh เดิม

### Worker Binding: validate-or-claim

`ticket_note` / `ticket_add_resource` ตรวจแค่ว่า `ticket_id` ตรงกับ active pointer
(อ่านจาก `*.active-ticket.json`) — ไม่แตะ binding ไม่ claim

`ticket_progress` / `ticket_link` ใช้ `resolve_ticket_write_binding(state, harness_id, ticket_id, from_lane)`:

1. มี binding และ `lane_display_name == from_lane` และ ticket ตรง → ผ่าน
2. มี binding เป็น lane อื่น → reject เหมือนเดิม (consulted lane อ่านได้แต่เขียนไม่ได้)
3. ไม่มี binding → อ่าน active pointer จาก `*.active-ticket.json`; ถ้า `ticket_id` ตรงกับ
   active ticket ให้ insert binding `{ ticketId, laneId: from_lane, laneDisplayName: from_lane,
   assignedAt: now }` แล้วผ่าน; ถ้าไม่ตรง → reject `not the active ticket`
4. เมื่อ claim สำเร็จ emit `acp-ticket-worker { harnessId, ticketId, laneDisplayName }`

`laneId` ชั่วคราวเป็น display name ได้เพราะ Rust validation ไม่เคยใช้ field นี้ —
frontend reconcile เป็น lane id จริงทันทีที่รับ event (ด้านล่าง)

### Data Flow

```
1. Lane เรียก ticket_note { ticket_id, markdown }
2. hook server ตรวจ ticket_id ตรงกับ active pointer (open tools)
   — หรือ resolve_ticket_write_binding สำหรับ ticket_progress/ticket_link
   (claim ถ้ายังว่าง + emit acp-ticket-worker)
3. ticket_bundle::append_ticket_note_for_project เขียนไฟล์ + bump revision
4. hook server emit acp-ticket-progress { harnessId, ticketId, ticket: detail }
5. frontend listener เดิมแทนที่ activeTicket → renderTicketDock()
6. (เฉพาะ claim) frontend จับ acp-ticket-worker: หา lane จาก displayName,
   set this.ticketWorker + invoke acp_set_ticket_worker ด้วย laneId จริง,
   recordJournal('ticket', 'claimed <ticket-id>') แล้ว render
7. (เฉพาะ ticket_link) frontend เห็น github ref เปลี่ยน → kick gh snapshot refresh เดิม
```

### Ticket Pin

แทนบรรทัด `Only the bound worker reports ticket_progress for …` ด้วย:

```text
Any lane may ticket_note / ticket_add_resource this ticket; ticket_progress and ticket_link are worker tools — the first successful call claims the binding if unassigned.
```

เพดาน pin ขยับ 700 → 780 Unicode characters (บรรทัดใหม่ยาวกว่าเดิม ~100 ตัว
ไม่ควรไปเบียดพื้นที่ title จน clip) พฤติกรรม clip เดิมคงไว้

### Permissions

`harness-permission-scan.ts` เพิ่ม `ticket_note`, `ticket_add_resource`, `ticket_link`
เข้า `HARNESS_ISSUE_TOOL_NAMES` และ regex — auto-allow ชั้นเดียวกับ `ticket_progress`
เพราะผลเขียนถูกจำกัดใน `.krypton/tickets/<id>/` ด้วย validation ฝั่ง Rust ทั้งหมด
`tool_category` (หน้า /tools.json) map สามตัวใหม่เป็น `issues`

## Edge Cases

- **ไม่มี active pointer หรือ ticket_id ไม่ใช่ active ticket:** reject
  `ticket <id> is not the active ticket; ask the user to activate it` — ไม่ claim ข้าม ticket
- **binding เป็นของ lane อื่น (progress/link):** reject ข้อความเดิม ไม่มี takeover ฝั่ง Rust
  (lane หาย/restart แล้ว frontend เคลียร์ binding อยู่แล้ว → เขียนครั้งถัดไป claim ใหม่ได้)
  ส่วน note/resource จาก lane อื่นยังเขียนได้เสมอ — append-only ไม่แตะสถานะ
- **restart:** binding หาย แต่ active pointer อยู่ → worker เดิมเขียนต่อได้ทันทีผ่าน auto-claim
- **note ยาวเกิน 2000 chars:** reject พร้อมบอกเพดาน ให้แบ่งเรียกหลายครั้ง
- **resource path ผิด / symlink / เกิน 25 MiB / project read-only:** error เดิมจาก
  `ticket_bundle` ส่งกลับเป็น tool error ตรง ๆ
- **issue_key ผิดรูป:** reject `issue_key must be owner/repo#123 or a GitHub issue URL`
- **link ทับ reference เดิม:** อนุญาต (replace) — snapshot เก่าถูกแทน, frontend refresh ใหม่
- **สอง lane เขียนพร้อมกันตอนยังไม่มี worker:** race ใต้ mutex ของ `ticket_workers`
  — ตัวแรก claim, ตัวหลัง reject เป็น wrong-lane ปกติ
- **event มาแต่ panel ปิด/ticket อื่น active:** listener เดิม filter ด้วย harnessId +
  activeTicket.id อยู่แล้ว ไม่มี state ค้าง

## Verification

- `npm run check`, `npm test -- --run` (1,043 tests / 63 files) และ `npm run build` ผ่าน
- `cargo fmt -- --check`, `cargo clippy --lib -- -D warnings` และ `cargo test --lib`
  ผ่าน 340 tests รวม note append/revision, github link/unlink, issue-ref parsing
  (key + URL + reject forms) และ atomic first-writer-wins claim
- Frontend tests ครอบ pin wording ใหม่, auto-allow ของ 3 tools ใหม่ และ
  `handleTicketWorkerClaim` (reconcile lane id จริง, ignore ticket ที่ไม่ active,
  placeholder เมื่อไม่พบ lane)

## Open Questions

ไม่มี — ผู้ใช้เลือกโมเดลสิทธิ์แบบแยกชั้น (B): note/resource เปิดทุก lane,
status/link เป็นของ worker พร้อม auto-claim ตาม pattern spec 190; unlink/clear
ยังเป็นของผู้ใช้ และ status `todo` ยังตั้งจาก agent ไม่ได้ (การถอยงานกลับ backlog
เป็นการตัดสินใจของคน)

## Out of Scope

- agent สร้าง ticket ใหม่, activate/clear active ticket, unlink GitHub reference,
  ลบ resource หรือแก้ title — ยังเป็น `#ticket` ของผู้ใช้ทั้งหมด
- takeover binding จาก lane ที่ยังมีชีวิต, persist binding ข้าม restart
- `todo` ใน `ticket_progress`, แก้ไข/ลบ note เดิม (append-only)
- UI ใหม่ — Ticket Panel เดิมแสดงผลได้ครบผ่าน event เดิม

## Resources

- [Linear MCP server](https://linear.app/docs/mcp) และ [tool catalog](https://www.speakeasy.com/product/mcp-gateway/catalog/linear/) — granular issue-management tools (`update_issue`, `create_comment`) ที่ agent เรียกตรง
- [GitHub MCP server](https://github.com/github/github-mcp-server) และ [issue #1083](https://github.com/github/github-mcp-server/issues/1083) — issues toolset (`issue_write`, `add_issue_comment`) แบบ append-first และช่องว่างที่ยังไม่มี update_comment
- Internal: spec 238 (local ticket bundles), spec 190 (issue_progress auto-bind), spec 194 (ticket pin), ADR-0007 (frontend authority ของ active state)
