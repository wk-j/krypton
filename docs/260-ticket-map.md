# Ticket Map — Implementation Spec

> Status: Draft
> Date: 2026-09-21
> Milestone: ACP Harness — local working context

## Problem

`#ticket` มี picker กับ Ticket Panel ที่อ่านทีละใบได้ดี แต่ไม่มีมุมมองที่เห็น ticket ทั้งโปรเจกต์
พร้อมกันแล้วบอกได้ว่า "งานส่วนใหญ่ของรอบนี้อยู่ตรงไหน" — list เรียงตาม `updatedAt` ทำให้ ticket
ใบใหญ่กับใบจิ๋วมีน้ำหนักทางสายตาเท่ากัน

## Solution

เพิ่ม **Ticket Map** เป็น loopback surface อ่านอย่างเดียวที่เปิดใน OS browser ด้วย `#ticket map`
— วาด ticket bundle เป็น area cartogram: หนึ่ง ticket คือหนึ่ง territory ที่พื้นที่แปรตามขนาดงาน
และ ticket group เดียวกันติดกันเป็นทวีป solver เป็น capacity-constrained power diagram บน
raster grid รันใน inline JS ของหน้าเว็บ

**ขนาดงานไม่ต้องมีใครกรอก** — Krypton ประเมินเองผ่าน TypeSafe `Choice` บนบันไดขนาด 6 ขั้น
(`xs`…`xxl`) โดยอ่าน title, บริบทใน `ticket.md` และ GitHub label แล้วถ่วงน้ำหนักด้วย probability
distribution ที่ TypeSafe คืนมา ผลถูก cache ลง `ticket.json` ประเมินซ้ำเฉพาะเมื่อบริบทเปลี่ยน
lane ที่ทำงานจริงรายงานทับได้ผ่าน `ticket_progress` เดิม ไม่มี command ให้คนพิมพ์ตัวเลขเอง

**แผนที่วาดเฉพาะ ticket ที่ยัง active** — เรียงตามเวลาที่ถูกแตะล่าสุดแล้วตัดที่ `limit` (ค่าเริ่มต้น
12) ไม่มีข้อยกเว้นตามสถานะ ใบที่เงียบก็ตกขอบแม้ยัง `in_progress` หรือ `blocked` แต่ยังอยู่ครบ
ใน aside list ไม่หายจากหน้า

**ความคืบหน้าเป็นเศษส่วนจริงจากงานย่อย** — ticket หนึ่งใบประกอบด้วยงานย่อยที่มีสถานะของ
ตัวเอง `ticket.json` จึงเก็บ `tasks[]` ได้ พื้นที่ทึบบน territory คือสัดส่วนงานย่อยที่เสร็จจริง
ไม่ใช่ขั้นบันได 0/0.5/1 จาก `status` ใบที่ยังไม่มี `tasks` ใช้ขั้นบันไดเดิมเป็น fallback

## Research

- **สถาปัตยกรรม loopback มีครบแล้ว** `/timeline` เป็น template ตรงตัว — `handle_timeline` คืน HTML ที่ `include_str!` มาจาก `src/acp/artifact-timeline.html`, `handle_timeline_json` อ่าน `project_dir_for_harness` แล้วคืน JSON, ฝั่งแอปมี `openTimelineBrowser()` ที่ `invoke('get_hook_server_port')` + `invoke('open_url')`
- **ข้อมูลที่มี vs ที่ขาด** `TicketMetadata` (`ticket_bundle.rs:51`) มี `id / title / status / github{…}` พอสำหรับ `id`, `label`, `href`, `progress` แต่ไม่มีขนาดงานและไม่มี `group`
- **TypeSafe client reuse ได้ทั้งก้อน** `typesafe.rs` (spec 257) มี API key ที่อ่านฝั่ง Rust เท่านั้น, retry + circuit breaker, deadline สองชั้น, cap request 8 KiB, validation ว่า probability รวมได้ 1 และ key set ตรงเป๊ะ, และ metrics ของ spec 258 — ตอนนี้มีคำถามเดียวคือ `suggest_timeline_topic` เพิ่มฟังก์ชันพี่น้องได้โดยไม่แตะ transport
- **ทำไมเป็น `Choice` ไม่ใช่ตัวเลขอิสระ** TypeSafe คืน distribution เต็มพร้อม confidence บนเซตปิด ถามเป็นบันได t-shirt แล้วคิด expected value (`Σ p(size) × value(size)`) จะ hedge เอง — โมเดลลังเลระหว่าง `m`=3 กับ `l`=5 ครึ่งต่อครึ่งได้ 4 แทนที่จะโยนหัวก้อย ซึ่งเป็นเหตุผลที่ TypeSafe คืน distribution มาให้ตั้งแต่แรก
- **`contextRevision` ใช้เป็นกุญแจ staleness ได้เลย** มีอยู่แล้วและขยับเมื่อ `ticket.md` เปลี่ยน เก็บ `weightRevision` คู่กับ `weight` แล้วเทียบกันก็รู้ว่าค่าล้าสมัยหรือยัง
- **การประเมินต้องเกิดตอนเปิด ไม่ใช่ตอน fetch** ถ้า handler ของ `/ticket-map.json` ยิง LLM หน้าเว็บจะค้างเงียบหลายวินาทีและ GET จะกลายเป็น side-effectful จึงย้ายไปทำตอน `#ticket map` ฝั่งแอป ซึ่งมี chip รายงานความคืบหน้าอยู่แล้ว
- **หนึ่ง request ต่อหนึ่ง ticket** cap 8 KiB ยัดทุกใบใน request เดียวไม่ไหว ชดเชยการเทียบกันเองด้วย calibration anchor สูงสุด 5 ใบที่ประเมินแล้ว แนบไปใน `state`
- **config มี precedent ของ sub-table ต่อ feature** `[typesafe.timeline_topics]` แยก mode/threshold ออกจาก `[typesafe]` ที่เป็น transport — เพิ่ม `[typesafe.ticket_weights]` ในรูปเดียวกัน
- **ACP plan entries คืองานย่อยที่มีอยู่แล้ว แต่ผูกผิดที่** spec 90 รับ `plan` ที่มี `entries[]` พร้อม `status: pending | in_progress | completed` (`src/acp/types.ts:64`) แล้ววาดเป็น panel ลอยต่อ lane — โครงสร้างตรงเป๊ะ แต่ **เป็นของ turn ปัจจุบัน อยู่ในหน่วยความจำ ไม่ผูกกับ ticket และหายเมื่อ session restart** แผนสามข้อของเทิร์นเดียวที่ทำครบจะอ่านว่า "3/3 เสร็จ" ทั้งที่ ticket เพิ่งเริ่ม — granularity ผิด ไม่ใช่แค่ที่เก็บผิด
- **`ticket.md` ใช้เก็บงานย่อยไม่ได้** ของจริงทั้ง 9 ใบใน `.krypton/tickets/` ไม่มี checklist เลย ทุกใบเป็นร้อยแก้วที่ `ticket_note` append — กติกาให้ parse `- [ ]` จึงเป็น convention ใหม่ที่ไม่มีใครทำตาม
- **spec ต้นทางเตือนเรื่องนี้และเราเลือกต่างโดยตั้งใจ** Work Atlas บอกว่า "interpolating from subtask counts … tends to be more precise than it is accurate" จริงกับ tracker ที่ subtask ถูกทิ้งค้าง แต่ใน Krypton คนเขียน `tasks` คือ lane เดียวกับที่ลงมือทำ ในเทิร์นเดียวกัน ความเสี่ยงจึงต่างกัน
- **`updatedAt` เป็นสัญญาณ activity ที่ใช้ได้เลย** ขยับเฉพาะเมื่อมีงานจริง — update status (`:394`), append note (`:513`), add resource (`:670`), link GitHub (`:726`) **แต่การเขียน weight จาก estimator ต้องไม่ขยับมัน** ไม่งั้น ticket ทุกใบจะ "เพิ่งถูกแตะ" พร้อมกันหลังประเมินรอบเดียว แล้วอันดับ activity พังทั้งชุด
- **เรียงตามเวลาล้วน ไม่มีการปักหมุดตามสถานะ** เคยออกแบบให้ `in_progress`/`blocked` ขึ้นแผนที่เสมอเพื่อกันงานค้างหลุดหาย แต่ผู้ใช้ปฏิเสธ: แผนที่ต้องตอบว่า "ตอนนี้กำลังยุ่งกับอะไร" ไม่ใช่ "อะไรยังไม่จบ" ใบที่เงียบจึงตกขอบตามกติกาเดียวกับทุกใบ ไปอยู่กลุ่ม `นอกแผนที่` ใน aside list
- **hue ถูกตัดทิ้งเพราะ design system** `DESIGN.binance.md` ห้าม accent hue ตัวที่สอง
  และสั่งว่า "if something needs to stand out and is not success/danger, it uses the accent
  or it uses weight/size/position instead" — ใน cartogram ตำแหน่งเป็น encoding ของ group
  อยู่แล้ว (ทวีปติดกันเป็นก้อน) hue จึงซ้ำซ้อน ตัดออกได้โดยไม่เสียข้อมูล
- **ทางเลือกที่ตัดทิ้ง** (1) ให้ผู้ใช้กรอกขนาดเอง — ผู้ใช้ปฏิเสธชัดเจน (2) derive ขนาดจากขนาดไฟล์ `ticket.md` + จำนวน resource — ฟรีแต่วัด "คุยกันไปแล้วแค่ไหน" ตั๋วใหญ่ที่เพิ่งเปิดจะได้พื้นที่เล็กสุด กลับหัวกับความจริง (3) ทำเป็น window ใน Krypton — solver แย่ง main thread กับ compositor (4) squarified treemap — ง่ายกว่าแต่เสีย "ทวีปเป็นก้อนเดียว"

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| EstimAI (Atlassian Marketplace) | อ่าน issue, sub-task, ภาพ design, Figma frame, Confluence spec แล้วให้ story point พร้อมคำอธิบาย แยกแกน complexity / effort / uncertainty | ยืนยันว่า "ให้ AI ประเมินแทนคน" เป็นของที่มีในตลาดแล้ว และคำอธิบายว่าทำไมได้เท่านี้สำคัญพอ ๆ กับตัวเลข |
| งานวิจัย LLM story point (arXiv 2026) | ประเมิน LLM บน 16 โปรเจกต์; systematic mapping ปี 2026 พบว่ายังใช้จริงน้อยเพราะ explainability และ data sparsity | เหตุผลที่ค่าที่ประเมินต้องมีป้ายกำกับเสมอว่าเป็นค่าประเมิน ไม่ใช่ค่าที่ยืนยันแล้ว |
| Jira + SumMap | ในกล่องมี Epic Report / Burndown ที่บอก total กับ trend; treemap ตามแต้มต้องซื้อ add-on แยก | ของเดิมไม่เคย encode ขนาดงานเป็นพื้นที่ — การ์ด 21 แต้มกับ 1 แต้มสูงเท่ากัน และ treemap ยังต้องมีแต้มมาก่อน |
| CodeCity (Wettel & Lanza, ICSE 2008) | class เป็นตึก package เป็นเขต metric map ไปที่ความสูง/ฐานตึก ใช้ treemap เป็น layout | ต้นแบบของ software cartography; การทดลองวัดได้ +24% correctness, −12% time |
| Voronoi Treemaps (Balzer & Deussen, 2005) | treemap บน polygon อิสระ คำนวณด้วย iterative relaxation ของ Voronoi tessellation | อัลกอริทึมต้นทาง; งานต่อยอด (Nocaj & Brandes 2012) เปลี่ยนมาใช้ power diagram ให้เร็วและ resolution-independent |

**Krypton delta:** ในตลาด การประเมินด้วย AI กับการวาดเป็นแผนที่เป็นคนละ add-on และทั้งคู่ต้องมี Jira
ก่อน Krypton รวมสองอย่างบน bundle ในเครื่อง — ไม่มี tracker ไม่มี grooming ไม่มีช่องกรอกแต้ม
ห้าข้อที่ตั้งใจต่างจาก spec ต้นทาง: (1) ขนาดงานมาจากการประเมิน ไม่ใช่ field ที่คนใส่ (2) progress
เป็นเศษส่วนจากงานย่อย ไม่ใช่ขั้นบันไดสามขั้น (3) ไม่ใช้ hue แยก group ตาม `DESIGN.binance.md`
ใช้ตำแหน่ง + น้ำหนักเส้นขอบแทน (4) keyboard-first — ต้นทางเป็น hover/click ล้วน (5) ไม่มี metric
switcher เพราะมีแกนขนาดแกนเดียว

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/ticket_bundle.rs` | `TicketMetadata` เพิ่ม `weight` / `weight_source` / `weight_revision` / `group` / `tasks` / `tasks_updated_at`; `TicketTask` + `TicketTaskStatus`; เพิ่ม `list_bundles_for_project()` (แยก body ออกจาก `acp_list_ticket_bundles` แบบ `*_for_project` ของ spec 239); `update_ticket_sizing_for_project()`; command `acp_estimate_ticket_weights` |
| `src-tauri/src/typesafe.rs` | `TicketSizingRequest` / `TicketSizingResult` / `TicketSizingFallbackReason`; `estimate_ticket_size()` reuse `call_once`, circuit, deadline, metrics เดิม; `build_sizing_request_body()`; `gate_sizing_response()` |
| `src-tauri/src/config.rs` | `TicketWeightsConfig` ใต้ `TypeSafeConfig`; `TicketMapConfig` (`limit`) |
| `src-tauri/src/lib.rs` + `hook_server.rs` | ลงทะเบียน `acp_estimate_ticket_weights`; route `/ticket-map` + `/ticket-map.json`; `TICKET_MAP_HTML` via `include_str!`; handler สองตัว; `ticket_progress` schema เพิ่ม `weight` / `group` / `tasks` |
| `src/acp/artifact-ticket-map.html` | **ไฟล์ใหม่** — หน้าเว็บทั้งใบ: style, solver, topology, renderer, keyboard (ไฟล์เดียวจบแบบ `artifact-timeline.html`) |
| `src/acp/hash-commands.ts` | `TICKET_COMMAND_ARGS` เพิ่ม `map [refresh \| <n>]` |
| `src/acp/harness-view-types.ts` | `LocalTicketSummary` (`:710`) เพิ่ม `weight` / `weightSource` / `weightRevision` / `group` / `tasks` |
| `src/acp/acp-harness-view.ts` | `runTicketCommand()` รับ `map [refresh \| <n>]`; `openTicketMapBrowser()`; listener `acp-ticket-sizing` → chip; help `<dt>` |
| `docs/06-configuration.md` | `[typesafe.ticket_weights]` ทั้ง block และตาราง reference |
| `DESIGN.binance.md` | เพิ่ม Ticket Map ใน `appliesTo` + ตาราง surface; บันทึกว่า map เลี่ยง multi-hue อย่างไร |
| `docs/README.md` + `docs/04-architecture.md` | index row 260; เพิ่ม Ticket Map ในรายการ loopback surface |
| `docs/238-local-ticket-bundles.md` / `docs/239-agent-ticket-management.md` | amended-by note |

## Design

### Data Structures

```rust
// ticket_bundle.rs — ต่อท้าย TicketMetadata, optional ทุกตัว, bundle เก่าอ่านได้ไม่ต้อง migrate
// ทุก field ประกาศคู่กับ #[serde(skip_serializing_if = "Option::is_none")]
pub weight: Option<f64>,               pub weight_source: Option<WeightSource>,
pub weight_revision: Option<u64>,      pub group: Option<String>,
pub tasks: Option<Vec<TicketTask>>,    pub tasks_updated_at: Option<u64>,

#[derive(Serialize, Deserialize)] #[serde(rename_all = "snake_case")]
pub enum WeightSource { Estimated, Reported }  // TypeSafe | lane ที่ทำงานจริง

#[derive(Serialize, Deserialize)] #[serde(rename_all = "camelCase")]
pub struct TicketTask { pub title: String, pub status: TicketTaskStatus }

#[derive(Serialize, Deserialize)] #[serde(rename_all = "snake_case")]
pub enum TicketTaskStatus { Pending, InProgress, Completed }
```

`update_ticket_sizing_for_project` **ต้องไม่แตะ `updated_at`** — ไม่งั้นการประเมินรอบเดียวจะรีเซ็ต
อันดับ activity ของทุกใบพร้อมกัน `tasks` เขียนแทนทั้งชุด (ไม่ append) เพราะ lane ถือแผนเต็มเสมอ สูงสุด 40 ชิ้น
ชื่อละ 200 ตัวอักษร รายการว่างเท่ากับลบทิ้ง ส่วน `reported` มาจาก lane ที่ทำ ticket ใบนั้นจริง
ถือว่ารู้ดีกว่า estimator เย็น ๆ จึงไม่เคยถูก `estimated` เขียนทับ (เว้นแต่ `#ticket map refresh`)
บันไดขนาด `xs`=1 · `s`=2 · `m`=3 · `l`=5 · `xl`=8 · `xxl`=13 แล้ว
`weight = Σ p(size) × value(size)` ปัดทศนิยมหนึ่งตำแหน่ง ต่ำสุด 0.5

`/ticket-map.json` คืน record ที่แบนแล้ว หน้าเว็บไม่รู้จัก `TicketBundleSummary`:

```jsonc
{ "project": "krypton", "dropped": 0,   // dropped = ticket.json ที่เสียรูป
  "tickets": [{
    "id": "2026-09-19-wk-j-krypton-26", "label": "…ticket title…", "group": "bug",
    "weight": 4.2, "weightSource": "estimated",  // "estimated" | "reported" | null
    "progress": 0.57,                   // เศษส่วนจาก tasks หรือขั้นบันไดจาก status
    "tasksDone": 4, "tasksTotal": 7,    // ไม่ส่งเมื่อ ticket ไม่มี tasks
    "status": "in_progress",            // ส่งดิบไปให้ border styling
    "activityAt": 1789012345678,        // max(lastProgressAt, updatedAt)
    "href": "https://github.com/wk-j/krypton/issues/26" }] }
```

`tickets` เรียงมาแล้วตาม `activityAt` มากไปน้อย หน้าเว็บแค่ตัดที่ `limit`

Resolution rules (ทำฝั่ง Rust ที่เดียว หน้าเว็บไม่ต้องรู้เรื่อง GitHub):

| field | ที่มา | fallback |
|---|---|---|
| `weight` | `ticket.json → weight` | `1.0` + `weightSource: null` |
| `group` | `ticket.json → group` | `github.labels[0]` → `"Ungrouped"` |
| `progress` | `tasks` → `(completed + 0.5 × in_progress) / total` | ไม่มี `tasks`: `done`=1, `in_progress`=0.5, `todo`/`blocked`=0 |
| `href` | `github.issueUrl` | ไม่ส่ง field |
| `activityAt` | `max(lastProgressAt, updatedAt)` — เกณฑ์เดียวที่ตัดสินว่าใบไหนขึ้นแผนที่ | — |

### API / Commands

```rust
#[tauri::command]  // { requested, estimated, skipped, failed }
pub async fn acp_estimate_ticket_weights(harness_id: String, force: bool)
    -> Result<TicketSizingSummary, String>;
async fn handle_ticket_map() -> Response;         // GET /ticket-map
async fn handle_ticket_map_json(...) -> Response; // GET /ticket-map.json?harness=<id>
```

ระหว่างประเมิน emit `acp-ticket-sizing { harnessId, done, total }` ให้ chip เดินหน้า
TypeSafe request — `state` มีเฉพาะสิ่งที่ช่วยตัดสิน ไม่มี path, env หรือ lane data:

```jsonc
{ "model": "<config.model>",
  "state": { "ticket": { "title": "…", "context": "<≤ max_context_chars แรกของ ticket.md>", "labels": ["bug"] },
             "calibration": [{ "title": "…", "size": "m" }] },   // ≤ 5 ใบที่ประเมินแล้ว
  "questions": { "size": { "type": "choice",
    "instructions": { "question": "How much work does this ticket represent?",
                      "rule": "Judge remaining engineering effort, not how much has been discussed." },
    "criteria": {
      "xs":  "A one-line or single-file change with an obvious fix and no design decision.",
      "s":   "A contained change inside one module; the cause is known or trivially findable.",
      "m":   "A few files in one subsystem; needs investigation but the approach is already clear.",
      "l":   "Spans two or more subsystems, or the root cause is still unknown and must be found first.",
      "xl":  "Needs a new mechanism or a design decision before coding, across several subsystems.",
      "xxl": "Architectural — a new subsystem, a cross-cutting invariant, or rewriting an existing mechanism."
    } } } }
```

`ticket_progress` เติมสาม property ที่ไม่ required (ไม่แตะ `required` เดิม) — เขียนแล้วได้
`weight_source: reported` และใช้ gate เดิมทุกประการ คือ worker-owned พร้อม auto-claim:

```jsonc
"weight": { "type": "number", "exclusiveMinimum": 0,
            "description": "Optional relative size of this ticket now that you have worked it. Only send a number you can justify from the work itself." },
"group":  { "type": "string", "maxLength": 40,
            "description": "Optional grouping key (epic, area, component) shared by related tickets." },
"tasks":  { "type": "array", "maxItems": 40,
            "description": "Optional full replacement of this ticket's subtask list — the units of work it breaks into, not the steps of your current turn. Send the whole list every time; an empty array clears it.",
            "items": { "type": "object", "required": ["title", "status"], "properties": {
              "title": { "type": "string", "maxLength": 200 },
              "status": { "enum": ["pending", "in_progress", "completed"] } } } }
```

### Data Flow

```
1. ผู้ใช้พิมพ์ `#ticket map` (หรือ `#ticket map refresh`)
2. frontend → invoke('acp_estimate_ticket_weights', { harnessId, force })
3. Rust: list_bundles_for_project() → เลือกใบที่ weight ว่าง หรือ weightRevision != contextRevision
   (force = ทุกใบที่ weightSource != reported)
4. Rust: ยิง typesafe.estimate_ticket_size() ขนาน 4 งาน, emit acp-ticket-sizing ทุกใบที่จบ,
   ค่าที่ผ่าน gate → update_ticket_sizing_for_project()
5. frontend: invoke('open_url', http://127.0.0.1:<port>/ticket-map?harness=<id>)
6. หน้าเว็บโหลดแล้ว fetch /ticket-map.json?harness=<id>
7. หน้าเว็บ: island mask → partition ระดับ group → partition ระดับ item ในแต่ละทวีป
8. หน้าเว็บ: mask → blur ×2 → marching squares 0.5 → project เป็นพิกัด canvas
9. หน้าเว็บ: วาด SVG (coast → ทวีป → territory → settled land → label) แล้ว bind keyboard
```

ขั้น 2–4 ข้ามทั้งหมดเมื่อ TypeSafe ปิดอยู่ ขั้น 7–8 รันครั้งเดียวต่อการโหลดแล้ว cache geometry ไว้
ส่วน interaction ที่เหลือเป็น repaint attribute ล้วน ยกเว้น `[` / `]` ที่ solve ใหม่

### Layout algorithm

ยกมาจาก spec ต้นทางทั้งชุดเพราะพารามิเตอร์ถูก tune มาแล้ว:

- **Island mask** — `r(θ) = 1 + 0.10·sin(3θ+1.1) + 0.07·sin(5θ+0.3) + 0.045·sin(8θ+2.4)` cell ที่
  polar radius ต่ำกว่านี้คือแผ่นดิน amplitude รวมต้อง < 0.25 ไม่งั้นชายฝั่งตัดตัวเอง และ **รัศมีฐาน
  ต้องคิดเผื่อ amplitude** (`R × 1.215 ≤ ครึ่งด้านสั้นของกริด`) ไม่งั้นเกาะล้นกรอบ
- **Partition** — cell เป็นของ region ที่ `distance² − weight` ต่ำสุด (power diagram)
  แล้วแก้ `wⱼ += γ·(qⱼ−aⱼ)/n` พร้อมขยับ seed `sⱼ = 0.4·sⱼ + 0.6·cⱼ` ([Xin et al. 2016](https://brunolevy.github.io/papers/CPD_SIGASIA_2016.pdf) พิสูจน์ว่าลู่เข้า)
- **สองชั้น** — รอบแรกทั้งเกาะ หนึ่ง region ต่อหนึ่ง group (weight รวมของ group) รอบสอง
  ภายใน cell set ของแต่ละทวีป หนึ่ง region ต่อหนึ่ง ticket — ความติดกันของทวีปเป็นผล
  ของโครงสร้าง ไม่ต้องบังคับด้วย constraint
- **พารามิเตอร์** cell 4px · 110 iteration · หยุด Lloyd ที่ 80 · γ = 2600 · damping 0.4/0.6 ·
  ยอมรับเมื่อทุก region คลาดจากโควตาไม่เกิน 3% relative
- **Topology** mask → box filter 3×3 สองรอบ → **บังคับขอบกริดรอบนอกเป็น 0** → marching squares
  ที่ isoline 0.5 → chain segment เป็นวงปิด → คูณ cell size
- **Determinism** seed วางจาก FNV-1a hash ของ `ticket.id` ห้ามใช้ลำดับ iteration หรือ random
- **วัดจริงแล้ว** prototype ที่รันพารามิเตอร์ชุดนี้บน ticket จริงใช้ 46 ms (7,217 land cell) และคลาด
  จากโควตาสูงสุด 0.24% — ห่างจากเพดาน 3% มาก
- **contour ต้องปิดวงเสมอ** prototype เจอของจริง: ถ้า mask แตะขอบกริด marching squares จะได้ chain ปลายเปิด แล้วการปิดด้วย `Z` จะลากเส้นตรงพาดข้ามทั้งแผนที่ กัน 3 ชั้น — คิดรัศมีเผื่อ amplitude, zero-pad ขอบกริด, และทิ้ง chain ที่ไม่ปิดวงแทนที่จะฝืนปิด

### Keybindings

หน้าเว็บ ไม่ใช่ input-router ของแอป แต่ต้องใช้ได้ครบโดยไม่แตะเมาส์:

| Key | Action |
|-----|--------|
| `j` / `k` / `↓` / `↑` | เลื่อน focus ไป territory ถัดไป/ก่อนหน้า (เรียงตามขนาดมากไปน้อย) |
| `h` / `l` | ข้ามไปทวีปก่อนหน้า/ถัดไป |
| `Enter` | เปิด `href` ใน tab ใหม่ (ไม่มี href = ไม่ทำอะไร) |
| `/` | โฟกัสช่องกรอง; `Esc` ล้างและคืน focus ให้แผนที่ |
| `m` / `g` | สลับโหมด progress (settled land ↔ shading) / หรี่ทวีปของ territory ที่ focus |
| `[` / `]` | ลด/เพิ่มจำนวน ticket บนแผนที่ แล้ว solve ใหม่ (62 ms — interaction เดียวที่ re-solve) |
| `r` | โหลด `/ticket-map.json` ใหม่แล้ววาดซ้ำ (ไม่สั่งประเมินใหม่) |
| `?` | แถบช่วยเหลือปุ่มลัด |

### UI Changes

โครงหน้าเหมือน `artifact-timeline.html` — `header` 48px (ชื่อ project + ชิป `local` + ช่องค้นหา)
แล้ว grid สองคอลัมน์: `aside` เป็นลิสต์ ticket จัดกลุ่มตามทวีป และ `main` เป็น SVG แผนที่
Visual encoding — สองแกนพอดีตามเพดานที่ spec ต้นทางกำหนด:

| Channel | Encodes | Rule |
|---|---|---|
| พื้นที่ territory | ขนาดงาน | ตรงโควตาภายใน 3% |
| พื้นที่ทึบจาก centroid | `progress` | settled land (ค่าเริ่มต้น): เรียง cell ตามระยะจาก centroid แล้วเติมทึบ `progress × n` cell แรก — เมื่อมี `tasks` พื้นที่ทึบคือสัดส่วนงานย่อยที่เสร็จจริง |
| ความสว่างพื้น | `progress` | shading mode (ทางเลือก): ไล่จาก `--code-bg` ไป `--accent` |
| น้ำหนักเส้นขอบ | frontier rank | item 0.7px · ทวีป 1.6px · ชายฝั่ง 2.2px |
| สีเส้นขอบ | `status` | ปกติ `--border`; `blocked` เป็น `--del` เส้นประ (semantic ตามที่ design system อนุญาต) |
| โทนพื้นทวีป | group | วน 3 ระดับความสว่างของ neutral (`--bg` / `--card` / `--code-bg`) จัดให้ทวีปที่ติดกันไม่ซ้ำระดับ |
| ลาย hatch จาง | `weightSource: null` | ขนาดยังไม่เคยถูกประเมิน — พื้นที่ที่เห็นไม่ได้แปลว่าอะไร |

header มีชิปบอกจำนวนที่ตกขอบ (`+3 นอกแผนที่`) และ aside list ยังแสดง ticket ครบทุกใบ โดยใบที่
ไม่ได้อยู่บนแผนที่รวมอยู่กลุ่มท้ายชื่อ `นอกแผนที่` — list เป็น output ชั้นหนึ่ง จะตัดข้อมูลทิ้งไม่ได้

ไม่มี hue ต่อ group และไม่มี palette 8 สีแบบ spec ต้นทาง territory ที่ถูก focus ได้ ring สี
accent 1 เส้น readout มุมล่างบอก label, ขนาด, ที่มาของขนาด (`ประเมิน` / `รายงานโดย lane`),
progress (`4/7 งานย่อย` เมื่อมี `tasks`) และ group ส่วน aside list แสดงตัวนับงานย่อยต่อแถว

label วางที่ centroid วาดเฉพาะ territory ที่เกิน 230 cell (3 คำแรกเมื่อเกิน 700 cell) ไม่หมุนและ
ไม่ล้นขอบ — ชื่อ ticket เป็นข้อความที่ผู้ใช้พิมพ์ จึงไม่ uppercase

### Configuration

```toml
[ticket_map]
limit = 12                 # ticket ที่ active ล่าสุดกี่ใบบนแผนที่; clamp 4–200

[typesafe.ticket_weights]
mode = "auto"              # auto | off
min_confidence = 0.55      # ต่ำกว่านี้ไม่เขียนค่าลง ticket.json
concurrency = 4            # จำนวน request ที่ยิงพร้อมกัน; clamp 1–8
max_context_chars = 600    # ตัวอักษรแรกของ ticket.md ที่แนบไป; clamp 0–2000
```

`[typesafe] enabled = false` เป็นค่าเริ่มต้น จึงไม่มี request ใดถูกยิงจนกว่าผู้ใช้จะเปิดสวิตช์แม่เอง
— `mode = "auto"` แปลว่า "เมื่อ TypeSafe เปิดแล้ว ให้ประเมินเอง" ส่วน `min_confidence = 0.55`
**เป็นค่าตั้งต้นที่ยังไม่ calibrate** ตาม precedent ของ spec 257 (threshold ผูกกับ model ที่ pin ไว้)
ต้องรัน `jev-1.13.0` จริงกับ ticket ในเครื่องแล้วเทียบกับสายตาคน ก่อนถือว่าค่านี้เชื่อได้

### Tests

- `ticket_bundle.rs` — sizing write ไม่แตะ `updated_at`; `list_bundles_for_project` เรียงตาม
  `max(lastProgressAt, updatedAt)`; `ticket.json` เสียรูปถูกนับใน `dropped` ไม่ทำให้ทั้ง listing พัง;
  `weight ≤ 0` ถูก reject; `tasks` แทนทั้งชุดและ array ว่างลบทิ้ง
- `typesafe.rs` — offline fixture แบบ spec 257: distribution ที่รวมไม่ได้ 1, key set ผิด และ
  confidence ต่ำกว่าเกณฑ์ ต้องไม่เขียนค่าลง `ticket.json` เลย
- `hook_server.rs` — `TICKET_MAP_HTML.contains("/ticket-map.json?harness=")` ตาม pattern ที่
  `:9325` ใช้กับ timeline; `/ticket-map.json` คืน 404 เมื่อ harness ไม่รู้จัก
- frontend — parsing ของ `#ticket map` / `map refresh` / `map <n>`; listener `acp-ticket-sizing`
- ค่าตัวเลขของ solver (area error ≤ 3%, contour ปิดวงครบ) พิสูจน์แล้วใน prototype ที่แนบมากับ
  spec นี้ ไม่ต้องทำ test ซ้ำใน production build

## Edge Cases

| กรณี | พฤติกรรม |
|---|---|
| TypeSafe ปิด / ไม่มี API key / circuit เปิดอยู่ | ข้ามการประเมินทั้งหมด เปิดแผนที่ด้วย weight ที่มี พร้อม chip "ประเมินขนาดไม่ได้" แผนที่ยังบอก group กับ progress ได้ |
| confidence ต่ำเกิน หรือ response ผิดรูป (probability ไม่รวมเป็น 1 / key set ไม่ตรง) | ไม่เขียนค่า ใบนั้นคง `weightSource: null` วาด hatch และนับเป็น failure ใน summary — ค่าที่เดาไม่มั่นใจแย่กว่าไม่มีค่า |
| `ticket.md` ถูกแก้หลังประเมิน | `contextRevision` ขยับ ทำให้ `weightRevision` ไม่ตรง ประเมินใหม่ครั้งถัดไปที่เปิดแผนที่ |
| `tasks` ว่างหรือ `total = 0` | ถือว่าไม่มี tasks ตกกลับไปใช้ขั้นบันไดจาก `status` |
| `status = done` แต่ `tasks` ยังไม่ติ๊กครบ | `progress` = 1 เสมอ — ticket ที่ปิดแล้วต้องไม่ขึ้นว่าทำครึ่งเดียวเพราะลืมติ๊ก และขึ้น chip เตือนว่ารายการงานย่อยค้าง |
| `tasks` ถูกเขียนจากแผนของ turn เดียว | ป้องกันด้วยคำอธิบายใน tool schema ที่บอกตรง ๆ ว่าเป็นงานย่อยของ ticket ไม่ใช่ขั้นตอนของเทิร์นนี้ ตรวจอัตโนมัติไม่ได้ |
| lane เคยรายงาน weight มาแล้ว | `weightSource: reported` ไม่ถูกเขียนทับ เว้นแต่ `#ticket map refresh` |
| ticket < 4 ใบ หรือไม่มีเลย | ไม่วาดแผนที่ (แผ่นดินถูกซอยหยาบจนอ่านไม่ได้) แสดง aside list เต็มหน้าแทน พร้อมคำแนะนำ `#ticket new <title>` เมื่อว่างเปล่า; เกิน 200 ใบ ขยาย cell เป็น 6px พร้อมชิปเตือนว่า label บางส่วนถูกตัด |
| `in_progress` / `blocked` ที่เงียบจนตกขอบ | หลุดจากแผนที่ตามกติกาเดียวกับทุกใบ — ตั้งใจ ยังอยู่ในกลุ่ม `นอกแผนที่` ของ aside list, Ticket Panel และ `#ticket` picker เหมือนเดิม |
| ตัดที่ `limit` แล้วพื้นที่แปลว่าอะไร | พื้นที่คือสัดส่วนของ **งานที่แสดงอยู่** ไม่ใช่ทั้ง backlog readout เขียนกำกับตรง ๆ |
| `weight ≤ 0` (แก้ไฟล์มือ) หรือขนาดต่างกันสุดขั้ว | ค่าพังข้าม ticket นั้นแล้วนับใน `dropped`; ใบที่เล็กเกินบังคับพื้นที่ต่ำสุด 12 cell แล้วชิปเตือนว่าคลาดเกิน 3% |
| ทวีปแตกเป็นหลายเกาะหลัง blur | ยังวาดทุกวง แต่ log warning (blur 2 รอบเลื่อนขอบไม่เกิน 1 cell) |
| group เกิน 8 กลุ่ม | ยุบกลุ่มที่ weight รวมน้อยสุดเป็น `Other` — ทวีปเล็กเกินไปอ่านไม่ออก |
| `harness` param ผิด / project ยังไม่ register | 404 เหมือน `/timeline.json` |
| ticket ถูกแก้ระหว่างเปิดหน้าอยู่ | หน้านี้เป็น snapshot ตอนโหลด กด `r` โหลดใหม่ ไม่มี polling ไม่มี event stream |

## Open Questions

ไม่มี — ห้าข้อที่ค้างระหว่างออกแบบถูกตัดสินแล้ว: (1) ขนาดงานมาจาก TypeSafe ไม่ใช่จากผู้ใช้ (ผู้ใช้สั่ง)
(2) ถามเป็น `Choice` บนบันได 6 ขั้นแล้วคิด expected value แทนตัวเลขอิสระ (3) ต่อ `ticket_progress`
แทนสร้าง MCP tool ใหม่ (4) ตัด hue channel ตาม `DESIGN.binance.md` (5) นิยาม "active" = `max(lastProgressAt, updatedAt)`
ล้วน ไม่มีข้อยกเว้นตามสถานะ (ผู้ใช้สั่ง)

## Out of Scope

- **`group` ยังไม่ใช้ LLM** — มาจาก `github.labels[0]` ซึ่งในโปรเจกต์นี้แม่นและฟรีอยู่แล้ว ถ้าวันหนึ่ง
  ticket ส่วนใหญ่ไม่มี label ค่อยเพิ่มเป็นคำถามที่สองใน request เดิม
- **ไม่วาดงานย่อยเป็น territory ย่อย และไม่ทำแผนที่สองชั้น** (initiative ครอบ epic) — ต้องใช้ partition ชั้นที่สามและเกินเพดานสองแกน งานย่อยแสดงผ่านสัดส่วนพื้นที่ทึบ readout และ aside list; และไม่ snapshot ACP plan entries ลง ticket อัตโนมัติ เพราะ granularity เป็นของ turn ไม่ใช่ของ ticket
- แก้ไข ticket จากบนแผนที่ และ command ให้ผู้ใช้พิมพ์ขนาดเอง — เป็น read view ล้วน การเขียนอยู่ที่
  `#ticket` และ MCP tool เดิม ส่วน `#ticket weight` ถูกปฏิเสธไปแล้ว
- animation ตอนสลับ layout และการลาก/จัดวาง territory เอง — ตำแหน่งเป็นผลลัพธ์ของ solver
- ความหมายของการอยู่ติดกัน — ทวีปติดกันไม่ได้แปลว่างานเกี่ยวข้องหรือมีลำดับก่อนหลัง
- GitHub issue ทั้ง repo — วาดเฉพาะ ticket bundle ที่มีใน `.krypton/tickets/`

## Resources

- [EstimAI — AI Story Point Estimator (Atlassian Marketplace)](https://marketplace.atlassian.com/apps/2215915680/estimai-ai-story-point-estimator) — market comparison ของการให้ AI ประเมินขนาดงานแทนคน
- [Agile Story Point Estimation with Large Language Models (arXiv 2026)](https://arxiv.org/html/2603.06276) — ผลประเมิน LLM บน 16 โปรเจกต์ และข้อจำกัดด้าน explainability ที่ทำให้ต้องติดป้ายว่าเป็นค่าประเมิน
- [Voronoi Treemaps — Balzer & Deussen, SoftVis 2005](https://dl.acm.org/doi/10.1145/1056018.1056041) และ [Computing Voronoi Treemaps — Nocaj & Brandes](https://www.uni-konstanz.de/mmsp/pubsys/publishedFiles/NoBr12a.pdf) — ต้นทางของ layout แบบ polygon อิสระ และเหตุผลที่ใช้ power diagram แทน Voronoi ธรรมดา
- [Centroidal Power Diagrams with Capacity Constraints — Xin et al., SIGGRAPH Asia 2016](https://brunolevy.github.io/papers/CPD_SIGASIA_2016.pdf) — รองรับว่าลูป weight-adaptation + Lloyd ลู่เข้าหาโควตาพื้นที่ได้จริง
- [CodeCity: 3D visualization of large-scale software — Wettel & Lanza, ICSE 2008](https://dl.acm.org/doi/10.1145/1370175.1370188) — prior art ของ software cartography พร้อมผลการทดลองที่วัดได้
- Work Atlas — software specification (Claude doc `2tm4dskXudVdP1UHRZViEp`) — spec ต้นทางที่ผู้ใช้ส่งมา: พารามิเตอร์ solver, ขั้น topology, และเพดาน encoding สองแกน
