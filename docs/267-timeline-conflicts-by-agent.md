# Timeline Conflicts Completed by the Lane Agent — Implementation Spec

> Status: Implemented
> Date: 2026-09-24
> Milestone: ACP Harness — project provenance
> Supersedes: การหาคู่ / การตรวจ / TypeSafe scan ของ [spec 266](./266-timeline-decision-trace-and-conflicts.md)
> (read model, สถานะคู่, ไฟล์ sidecar และหน้า `/timeline` ของ 266 ยังใช้ต่อ)

## Problem

Spec 266 ให้คนทำงานเองทุกขั้น: กด `n` ค้นหาบันทึกแล้วเลือก A/B เอง พิมพ์เหตุผลเอง
กด `1`–`4` ให้ผลตรวจพร้อมเหตุผลบังคับ และสแกน TypeSafe ก็ปิดไว้เป็นค่าเริ่มต้นและต้องกด `s` เอง
ผู้ใช้ตัดสินแล้วว่า "Do not add feature that force user to manual, everything must
completed by LLM" งานหาคู่ ตัดสิน และปิดข้อขัดกันจึงต้องเป็นหน้าที่ของ LLM ทั้งหมด

## Solution

ให้ lane agent (LLM ที่มีอยู่แล้วในทุก Harness ไม่ต้องตั้งค่าหรือใช้ API key) เป็นผู้ทำทุกขั้น
ผ่าน MCP tool ใหม่ 3 ตัว คือ `timeline_conflict_list` (อ่านอย่างเดียว), `timeline_conflict_record`
(บันทึกคู่พร้อมผลตัดสินในการเรียกครั้งเดียว) และ `timeline_conflict_checked` (บันทึก checkpoint
ต่อ topic) มี 2 ทางที่ทำให้งานนี้เกิด และไม่มีทางไหนสแกนทั้ง project ซ้ำ:
(1) **อัตโนมัติ** — หลัง `timeline_record` ทุกครั้ง agent เทียบแค่บันทึกใหม่กับบันทึกเดิมใน topic
เดียวกัน แล้วบันทึกผลและ checkpoint เอง (2) **สั่งตรวจเฉพาะ topic** — `#timeline conflicts <topic>`
ส่ง prompt ให้ lane ตรวจ topic นั้นเท่านั้น ทางเดียวกับ `#timeline trace <topic>` ถ้าไม่ระบุ topic
จะตรวจเฉพาะ topic ที่มีบันทึกใหม่กว่า checkpoint (เช่นบันทึกที่คนเพิ่มผ่าน `#timeline add`
หรือบันทึกก่อนมี spec นี้) และเทียบเฉพาะบันทึกที่ยังไม่ได้ตรวจกับบันทึกเดิม
ค่าใช้จ่าย token จึงขึ้นกับจำนวนบันทึกใหม่ ไม่ใช่ขนาดของ timeline ทั้งหมด
ตัดแผ่นตรวจแบบ manual และ TypeSafe scan ออก คนมีหน้าที่อ่านผลบนหน้า `/timeline` อย่างเดียว

## Research

- `timeline_conflicts.rs` มี `propose_project()` / `review_project()` ที่ตรวจ ID, ความยาวเหตุผล,
  หลักฐานของ `resolved` และเขียน sidecar แบบ append-only อยู่แล้ว ใช้ต่อจาก MCP handler ได้ทันที
  ต่างกันแค่ `origin`/`reviewed_by` ที่ตอนนี้ตายตัวเป็น `manual` / `Local user`
- Spec 266 จงใจกันไว้ว่า "ไม่ใช้ MCP tool เพื่อไม่ให้ agent สร้าง/ตัดสิน conflict เอง"
  spec นี้ยกเลิกข้อห้ามนั้นตามคำสั่งผู้ใช้
- `#timeline trace` (`timelineTracePrompt` + `enqueueSystemPrompt`) เป็นแบบที่ใช้ได้เลย:
  เช็กว่า lane ว่าง แล้วส่ง system prompt ให้ agent ทำงาน
- `timeline_merge` (spec 263) เคยเป็นงานของคนเท่านั้นแล้วเปิดให้ lane ทำ แบบเดียวกับ spec นี้
- TypeSafe scan (`classify_timeline_conflicts`) ปิดไว้เป็นค่าเริ่มต้น ต้องมี API key และส่งได้แค่
  summary ที่ตัดสั้น ส่วน lane agent อ่าน rationale/source ได้ครบ จึงตัดสินได้ดีกว่าและไม่ต้องตั้งค่า
  ถ้าเก็บไว้ทั้งสองทางจะมีผู้ตัดสิน 2 ราย ผลอาจไม่ตรงกัน และ config ก็ไม่มีประโยชน์แล้ว — ตัดออก

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Krypton `timeline_merge` (spec 263) | งานของคนที่เปิดให้ agent เรียก tool แทน | แบบเดียวกันสำหรับการเปลี่ยนสิทธิ์ |
| Krypton `#timeline trace` | hash command ส่ง prompt แล้ว agent ทำ | ใช้เป็นทางกวาดทั้ง project |
| ADR tools (adr-tools, log4brains) | สถานะ `superseded by` เขียนด้วยมือ | Krypton ให้ LLM อนุมานและบันทึกแทน |

**Krypton delta:** ไม่มีเครื่องมือในตลาดที่ตรวจความขัดกันของ decision log อัตโนมัติ ส่วนนี้เป็นของใหม่

## Affected Files

| File | Change |
|------|--------|
| `src-tauri/src/timeline_conflicts.rs` | `record_project()` = propose + review ในครั้งเดียว, `origin: "agent"`, `reviewed_by` = lane label; ลบ shortlist/scan/persist_scan และคำสั่ง `timeline_conflict_propose/review/scan` |
| `src-tauri/src/hook_server.rs` | descriptor + handler ของ `timeline_conflict_list` / `timeline_conflict_record` / `timeline_conflict_checked`; เพิ่มเข้าตระกูล `"timeline"` และ auto-allow |
| `src-tauri/src/typesafe.rs`, `config.rs`, `src/config.ts` | ลบ `classify_timeline_conflicts` และ `[typesafe.timeline_conflicts]` (key เก่าใน TOML ถูกละไว้เฉย ๆ ผ่าน `serde(default)`) |
| `src-tauri/src/lib.rs` | ถอดคำสั่ง `timeline_conflict_*` ทั้งหมด |
| `src/acp/timeline-conflicts.ts` + test | ลบทั้งไฟล์ |
| `src/acp/harness-prompts.ts` + test | `timelineConflictsPrompt(topic: string \| null)` |
| `src/acp/hash-commands.ts` + test | `conflicts` รับ `<topic>` ต่อท้ายได้ |
| `src/acp/acp-harness-view.ts` | `#timeline conflicts` → `enqueueSystemPrompt`; เพิ่มย่อหน้า conflict ใน lane-context; ลบ `openTimelineConflicts` |
| `src/acp/timeline.ts`, `src/styles/acp-harness.css` | ลบ type/CSS ของแผ่นตรวจ (`acp-conflicts__*`) และ scan summary |
| `docs/266…`, `04`, `05`, `06`, `72`, `README` | ชี้มาที่ 267, ลบ config key, อัปเดต data flow |

## Design

### MCP tools

```jsonc
// read-only; ไม่เปิด UI
timeline_conflict_list { topic_id?: string, state?: "open" | "all" }
→ { pairs: [{ pair_id, event_a, event_b, state, verdict_by, rationale, updated_at }],
    counts: { needs_review, confirmed }, diagnostics: number,
    unchecked: [{ topic_id, topic_title, new_event_ids: string[] }] } // ≤20 topic, ใหม่สุดก่อน

// เรียกหลังตรวจ topic เสร็จ แม้ไม่พบข้อขัดกัน
timeline_conflict_checked { topic_id: string, event_ids: string[] }
→ { topic_id, checked_event_count, remaining_unchecked }

timeline_conflict_record {
  event_a: string, event_b: string,                 // event ID จาก timeline_list
  verdict: "confirmed" | "dismissed" | "insufficient_evidence" | "resolved",
  rationale: string,                                // ≤1000, ภาษาไทย
  resolution_event_id?: string, source_ref?: string // resolved ต้องมีอย่างใดอย่างหนึ่ง
}
→ { pair_id, state, new_pair: boolean }
```

`record` สร้าง proposal (`origin: "agent"`, `basis` = rationale) ถ้ายังไม่มี แล้วเพิ่ม review
แบบ append-only (`reviewed_by` = lane label จาก transport ไม่รับจาก payload) คู่เดิมที่บันทึกซ้ำ
ได้ review ใหม่ต่อท้าย และผลล่าสุดมีผลเหมือนเดิม คู่ที่มี `supersedes` ถึงกันถูกปฏิเสธ พร้อมข้อความ
"เป็นประวัติการเปลี่ยนแปลง ไม่ใช่ข้อขัดกัน" ไม่ต้องบันทึกคู่ `dismissed` ทุกคู่ เพราะ checkpoint
กันการตรวจซ้ำอยู่แล้ว (บันทึก `dismissed` เฉพาะตอนปิดคู่ที่เคยเปิดไว้)

Checkpoint เก็บที่ `.krypton/timeline/conflicts/checked/<topic_id>.json` เป็น
`{ schema, topic_id, checked_event_ids, checked_by, checked_at }` (เขียนทับแบบ atomic)
บันทึกที่ยังไม่ถูกแทนที่และไม่อยู่ใน `checked_event_ids` ถือว่ายังไม่ได้ตรวจ ถ้า merge topic
(spec 263) บันทึกที่ย้ายเข้ามาจะไม่อยู่ในชุดของ topic ปลายทาง จึงขึ้นใน `unchecked` เอง

> **Deviation (ตอน implement):** ร่างแรกใช้ `through_event_id` + เวลา แต่บันทึกที่ `occurred_at`
> ย้อนหลัง หรือบันทึกที่ merge เข้ามา จะหลุดจากการตรวจ จึงเปลี่ยนเป็นเก็บชุด event ID ที่ตรวจแล้ว
> และให้ tool รับ `event_ids` ที่ agent เทียบจริง บันทึกที่เข้ามาระหว่าง agent อ่านจึงยังค้างให้รอบหน้า
> Tauri command `timeline_conflict_list` ก็ลบด้วย เพราะไม่มี UI ในแอปเรียกแล้ว

### เกณฑ์ที่ agent ใช้ (อยู่ใน tool description และ lane-context)

- `confirmed` — เรื่องเดียวกัน ตัดสินคนละทาง และไม่มีบันทึกที่ใหม่กว่ามาแทนที่
- `resolved` — เคยขัดกัน แต่มีบันทึกที่ใหม่กว่าซึ่งตัดสินเรื่องนั้นแล้ว (ต้องระบุ `resolution_event_id`)
- `dismissed` — คนละเรื่อง, ข้อความซ้ำ หรือความเข้าใจที่พัฒนาต่อเนื่องกัน
- `insufficient_evidence` — ใช้เมื่อหลักฐานในบันทึกไม่พอจะตัดสินจริง ๆ เท่านั้น
- ห้ามเดา `made_by` หรืออำนาจตัดสิน และห้ามแก้ event ต้นฉบับ

### Data Flow

```
อัตโนมัติ:
1. agent เรียก timeline_record → ได้ event ID ใหม่
2. ตาม lane-context: timeline_list { topic_id } อ่านบันทึกเดิมใน topic
3. ถ้ามีข้อขัดกัน/ปิดข้อขัดกันเดิม → timeline_conflict_record (ไม่มีก็ไม่ต้องเรียก)
4. timeline_conflict_checked { topic_id, through_event_id: ID ใหม่ }

สั่งตรวจ:
1. ผู้ใช้พิมพ์ #timeline conflicts <topic> หรือ #timeline conflicts (lane ต้องว่าง เหมือน trace)
2. enqueueSystemPrompt(timelineConflictsPrompt(topic | null))
3. agent: timeline_conflict_list { topic_id? } → ได้ unchecked (มี topic → เฉพาะ topic นั้น)
4. ต่อ topic: timeline_list { topic_id } → เทียบ new_event_ids กับบันทึกเดิมของ topic
   (ไม่เทียบบันทึกเก่ากับบันทึกเก่าซ้ำ) → timeline_conflict_record เฉพาะคู่ที่มีผล
   → timeline_conflict_checked
5. ไม่ไล่หาคู่ข้าม topic เอง เทียบเฉพาะเมื่อบันทึกใหม่มี source_ref ตรงกับบันทึกใน topic อื่น
6. agent รายงานเป็นภาษาไทยว่าตรวจกี่ topic บันทึกกี่คู่ และยังเหลือ topic ไหน
7. หน้า /timeline อ่าน sidecar เดิม → chip ที่ช่องวันของคู่ที่ยังเปิด (เหมือน 266)
```

### UI Changes

- ลบแผ่น `#timeline conflicts` ทั้งแผ่น (ไม่มี overlay, keybinding หรือฟอร์ม)
- ระหว่าง agent ทำงาน chip แสดง "กำลังตรวจข้อขัดกันใน timeline"
- `/timeline` ยังอ่านอย่างเดียว; ตรงที่เคยแสดง "เลือกเอง"/TypeSafe เปลี่ยนเป็นชื่อ lane ที่ตัดสิน
- เมื่อกลับมาที่แท็บ `/timeline` หน้าเว็บอ่านข้อมูลจาก disk อีกครั้ง เพื่อให้คู่ที่ agent เพิ่งบันทึกแสดงโดยไม่ต้อง refresh เอง
- หน้า `/timeline` ซ่อนบันทึกที่มี `supersedes` มาแทนที่แล้วเป็นค่าเริ่มต้น; กดปุ่มหรือ `h` เพื่อแสดงอีกครั้ง และ deep link ไปยังบันทึกที่ซ่อนอยู่จะเปิดให้เห็นเอง

### Configuration

ลบ `[typesafe.timeline_conflicts]` (`mode`, `min_*`) งานนี้ไม่ต้องตั้งค่าใด ๆ

## Edge Cases

- **Lane ไม่ว่าง** ตอนพิมพ์ `#timeline conflicts` → chip "lane busy - #cancel first" เหมือน trace
- **Remote Harness** → ใช้ได้ถ้า MCP tool ไปถึง project local ไม่อย่างนั้นแจ้งแบบเดียวกับ `#timeline review`
- **Sidecar เดิม** ที่มี `origin: manual`/`typesafe` → ยังอ่านและแสดงได้ (enum เก่ายังรองรับตอนอ่าน)
- **ครั้งแรกหลังอัปเกรด** ทุก topic ยังไม่มี checkpoint จึงขึ้นเป็น `unchecked` ทั้งหมด → bare
  `#timeline conflicts` ตรวจได้ไม่เกิน 5 topic ต่อรอบ (ใหม่สุดก่อน) แล้วบอกว่ายังเหลือกี่ topic
  ผู้ใช้เลือกได้ว่าจะรันต่อ หรือสั่งเฉพาะ topic ที่สนใจ ไม่มีการกวาดทั้ง project ในครั้งเดียว
- **Topic ใหญ่** (บันทึกเกิน 50 รายการ) → อ่านเฉพาะ 50 รายการล่าสุดที่ยังไม่ถูกแทนที่ เพราะบันทึกที่
  ถูกแทนที่แล้วไม่ขัดกับอะไร
- **ID ไม่ถูกต้อง / event ถูกลบ** → tool คืน error, agent ข้ามคู่นั้น

## Open Questions

ไม่มี

## Out of Scope

- การแก้หรือลบ event ต้นฉบับ และการสร้างลิงก์ `supersedes` อัตโนมัติ
- UI แก้ผลตัดสินของ agent (ถ้าไม่เห็นด้วย ให้บอก agent ในแชตให้บันทึกผลใหม่)

## Resources

N/A — purely internal change (prior art จาก spec 263 และ `#timeline trace` ในโค้ดนี้)
