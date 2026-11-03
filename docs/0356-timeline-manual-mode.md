# Timeline Manual Mode — Implementation Spec

> Status: Implemented
> Date: 2026-11-03
> Milestone: ACP Harness — Timeline
> Amends: 0316 §5–§6 (ความหมายของ `#timeline auto off`), 0332 (บรรทัด Timeline ใน lane policy)

## Problem

เมื่อเปิดบันทึกอัตโนมัติ lane เรียก `timeline_list` → `timeline_record` → `timeline_conflict_checked` เองเกือบทุก working turn ผู้ใช้ต้องการให้ lane แตะ Timeline เฉพาะเมื่อสั่งเท่านั้น
`#timeline auto off` ที่มีอยู่หยุดการบันทึกเองได้ แต่ทำให้บันทึกตามคำสั่งไม่ได้ด้วย และยังให้ lane แก้คิว legacy เองทุก turn ที่ count > 0

## Solution

เปลี่ยนความหมายของ `#timeline auto off` เป็น manual mode: lane เรียก `timeline_*` เฉพาะเมื่อข้อความปัจจุบันของผู้ใช้หรือคำสั่ง `#timeline` ขอ
ใน manual mode backend รับ `timeline_record` เฉพาะเมื่อส่ง `user_request_excerpt` ที่อ้างคำขอของผู้ใช้มาด้วย และ header ไม่ส่งบรรทัด legacy pending
ใช้ setting `automaticRecording` เดิม ไม่เพิ่ม schema, IPC หรือคำสั่งใหม่ และ (revision 1) project ที่ยังไม่มี settings file เริ่มที่ manual mode

## Research

- `src/acp/lane-context.ts:157-159` — ตอนปิด policy บอกว่า "record no new intake; legacy resolution and conflict verdicts stay yours" lane จึงยังถือว่าการตรวจ conflict และคิว legacy เป็นงานของตัวเอง
- `src/acp/lane-context.ts:140-143` — บรรทัด `Timeline legacy pending: N` ไปกับ header ทุก turn ที่ count > 0 โดยไม่ดู setting
- `src-tauri/src/timeline.rs:1928-1930` — ตอนปิด `record_direct_project` คืน error ทุกครั้ง แม้ผู้ใช้สั่งบันทึกเอง
- `src-tauri/src/hook_server.rs:4953-4983` — ack ของ `timeline_record` ทุกครั้งแนบ `conflict_check` ซึ่งสั่งให้เรียก `timeline_list` + `timeline_conflict_checked` ต่อ ต้นเหตุของชุดการเรียกในภาพคือ record; ถ้ากั้น record ได้ การเรียกต่อเนื่องหายไปทั้งชุด
- `src-tauri/src/hook_server.rs:7057-7077` — descriptor ทุกตัวของ Timeline แนบ `TIMELINE_AUTONOMOUS_CONTRACT` ที่บอกว่า lane เป็นเจ้าของ Timeline "automatically" ไม่ขึ้นกับ setting; client cache descriptor ตลอด session และ system/slash turn บางแบบไม่ส่ง policy (spec 316:33) ข้อความ descriptor จึงต้องครอบคลุมทั้งสองโหมดในตัว
- `resolve_pending_project` (`timeline.rs:2257`) และ conflict tools ไม่อ่าน setting; `#timeline conflicts` (`harness-prompts.ts:284`) เป็นคำสั่งของคนที่ต้องใช้ tools เหล่านี้ต่อไป
- Backend ไม่เห็นข้อความของผู้ใช้ จึงพิสูจน์ไม่ได้ว่าผู้ใช้สั่งจริง `user_request_excerpt` เป็นด่านที่บังคับให้ agent ต้องชี้คำขอ และ error ของด่านนี้บอก lane ที่ใช้ policy เก่าว่าอยู่ manual mode ไม่ใช่หลักฐานด้านความปลอดภัย

ทางเลือกที่ไม่ใช้:

1. ให้ policy อย่างเดียว (ถอด block ใน backend) — เสียด่านที่ `off` มีอยู่ตอนนี้ ถ้า model ไม่ทำตาม policy ก็บันทึกเองได้อีก
2. คำสั่งใหม่ `#timeline record <text>` พร้อม flag อนุญาตราย turn จาก frontend ไป backend — นำคำสั่งที่ spec 316 ถอดออกกลับมา เพิ่ม IPC และยังไม่ครอบคลุมคำขอแบบภาษาธรรมชาติ
3. โหมดที่สาม `on | manual | off` — `off` ที่บันทึกไม่ได้เลยไม่มีกรณีใช้งานที่ผู้ใช้ขอ และ boolean เดิมหมายถึง "ไม่บันทึกเอง" อยู่แล้ว

## Prior Art

| App | Implementation | Notes |
|-----|---------------|-------|
| Claude Code auto memory | `/memory` toggle บันทึก `autoMemoryEnabled`; ตั้งรายโปรเจกต์ได้ ปิดแล้ว Claude ไม่เขียน memory เอง ผู้ใช้ยังสั่งให้จดลง `CLAUDE.md` ได้ | แยกการเขียนเองออกจากการเขียนเมื่อสั่ง |
| Krypton spec 254 (historical) | `#timeline auto off` ปิดเฉพาะข้อเสนออัตโนมัติ; `#timeline add` ยังเป็นทางให้ผู้ใช้สั่งบันทึก | เคยมีทาง manual คู่กับ off |
| Krypton spec 255 (historical) | `timeline_record` ต้องมี `instruction_excerpt` ที่อ้างคำสั่งบันทึกของผู้ใช้ | ใช้รูปแบบด่านเดียวกัน แต่เฉพาะ manual mode |

**Krypton delta:** Claude Code ส่งคำขอแบบ manual ไปอีกที่เก็บหนึ่ง (`CLAUDE.md`); Krypton คงที่เก็บเดียว คำขอบันทึกใน manual mode เขียนลง Timeline เดียวกันด้วย record contract เดิม

## Affected Files

| File | Change |
|------|--------|
| `src/acp/lane-context.ts` | บรรทัด policy ของ manual mode; `renderTimelinePendingLine` คืน `null` เมื่อ `timelineAutomaticRecording` เป็น false |
| `src/acp/lane-context.test.ts`, `src/acp/acp-harness-view.test.ts` | แก้ fixtures ที่ใช้ off + pending 24 แล้วคาดว่ามี pending line; เพิ่ม behavior case ของ manual mode |
| `src/acp/harness-timeline-controller.ts` | ข้อความ chip ของ `#timeline auto` |
| `src/acp/hash-commands.ts`, `src/acp/components/help-overlay/index.ts` | คำอธิบายคำสั่ง `#timeline` |
| `src-tauri/src/timeline.rs`, `src-tauri/src/xenon.rs` | field `user_request_excerpt` ใน `TimelineDirectRecordRequest`; ด่าน manual mode ใน `record_direct_project`; tests |
| `src-tauri/src/hook_server.rs` | schema ของ `timeline_record`; ข้อความ `TIMELINE_AUTONOMOUS_CONTRACT`; test ของ descriptor |
| `docs/0002`, `0004`, `0005`, `0006`, `0072`, `0254`, `0255`, `0289`, `0316`, `0332`, `README` | แก้ข้อความ "off blocks new intake, not legacy resolution" ทุกจุดให้เป็น manual mode |

## Design

### 1. Setting และคำสั่ง

- คง `TimelineSettings { automaticRecording: boolean }`, settings schema 2, `timeline_settings` / `timeline_set_enabled` ตามเดิม
- Revision 1 (ผู้ใช้สั่ง "The timeline auto should off by default"): ค่าเริ่มต้นเป็น off คือ project ที่ไม่มี `.krypton/timeline/settings.json` อยู่ใน manual mode (`TimelineSettings::default()` และค่าเริ่มต้นของ `HarnessTimelineController.automaticRecording` ก่อนอ่าน setting) ส่วน project ที่มีไฟล์อยู่แล้วคงค่าที่เก็บไว้ ไม่เขียนทับ
- `#timeline auto off` = manual mode; `#timeline auto on` = autonomous mode
- chip: on → `บันทึก timeline · อัตโนมัติ`; off → `บันทึก timeline · เฉพาะเมื่อสั่ง`
- คำอธิบายใน `hash-commands.ts`: `เปิดดูหรือไล่ประวัติ ตรวจข้อขัดกัน และเลือกบันทึกอัตโนมัติหรือเฉพาะเมื่อสั่งของ project ในเครื่อง`

### 2. Lane policy

บรรทัด on คงเดิม บรรทัด off เปลี่ยนเป็น:

```text
- timeline_*: manual mode — call timeline_* tools only when the human's current message or a #timeline command asks for Timeline work (record, look up, merge, conflicts, legacy queue); no unprompted reads, records, conflict sweeps or legacy resolution, and never ask whether to record. A requested timeline_record passes user_request_excerpt and follows its own conflict_check. Never write Timeline state in a read-only turn.
```

- `renderTimelinePendingLine` คืน `null` ใน manual mode; คิว legacy อยู่ครบ แก้เมื่อผู้ใช้ขอ
- การสลับโหมดเปลี่ยน policy hash จึงส่ง policy ใหม่ใน ordinary turn ถัดไปตามกลไกเดิม (`planPolicyDelivery`)

### 3. MCP contract

`timeline_record_tool_descriptor` เพิ่ม optional field นี้เฉพาะใน schema ของ `timeline_record`; `timeline_record_input_schema` ที่ `timeline_pending_resolve` ใช้เป็น nested `record` ไม่มี field นี้ เพราะ legacy resolution ไม่ผ่านด่านนี้:

```json
"user_request_excerpt": { "type": "string", "minLength": 1, "maxLength": 1000,
  "description": "Exact quote from the human's current message asking to record this. Required in manual mode (automatic recording off); ignored otherwise and never stored." }
```

`TIMELINE_AUTONOMOUS_CONTRACT`:
- ประโยคแรกขึ้นต้นด้วย `With automatic recording on, the working lane owns ...`
- แทนประโยค `Automatic recording off blocks new intake, not legacy resolution.` ด้วยข้อความ manual mode: เรียก Timeline tools เฉพาะเมื่อข้อความปัจจุบันของผู้ใช้หรือคำสั่ง `#timeline` ขอ, `timeline_record` ต้องมี `user_request_excerpt`, คิว legacy รอคำขอ และห้ามถามว่าจะบันทึกไหม
- เพิ่มประโยคบอกวิธีรู้โหมด: lane policy ระบุโหมด และ error manual mode จาก `timeline_record` แปลว่าปิดบันทึกอัตโนมัติอยู่

### 4. Backend gate

```rust
pub struct TimelineDirectRecordRequest {
    // ...fields เดิม
    #[serde(default)]
    pub user_request_excerpt: Option<String>,
}
```

ใน `record_direct_project` แทน error เดิม (`timeline.rs:1928-1930`):

1. ถ้ามี `user_request_excerpt` ตรวจด้วย validator เดิม: trim แล้วไม่ว่าง ไม่เกิน 1000 ตัวอักษร
2. ถ้า `automatic_recording` เป็น false และไม่มี excerpt → `Err("timeline is in manual mode for this project: record only when the human's current message asks, and pass user_request_excerpt quoting that request")` ก่อนเขียนไฟล์ใด
3. ไม่เก็บ excerpt ลง event; event schema, duplicate identity และ provenance (`recorded_by: "Agent"`) คงเดิม

`resolve_pending_project`, `timeline_merge` และ conflict tools ไม่อ่าน setting เพิ่ม; ใน manual mode ใช้เมื่อผู้ใช้ขอตาม policy/descriptor

### Data Flow

```text
1. ผู้ใช้พิมพ์ #timeline auto off → timeline_set_enabled(false) → chip "เฉพาะเมื่อสั่ง"
2. Ordinary turn ถัดไป: policy hash เปลี่ยน → ส่งบรรทัด manual mode; header ไม่มี legacy pending
3. Turn ทั่วไป: lane ไม่เรียก timeline_* → ไม่มี record, ไม่มี conflict_check ต่อท้าย
4. ผู้ใช้พิมพ์ "บันทึกลง timeline ว่า ..." → lane เรียก timeline_list แล้ว timeline_record { ..., user_request_excerpt }
5. Backend เห็น manual mode + excerpt → บันทึก → ack มี conflict_check → lane ตรวจเฉพาะ event นั้น
6. Lane ที่ใช้ policy เก่าเรียก record โดยไม่มี excerpt → error manual mode → ไม่มีไฟล์ใหม่
```

## Edge Cases

- **Harness อื่นของ project เดียวกันยังเห็นค่า on ในหน่วยความจำ:** policy ของ harness นั้นยังเป็นแบบ autonomous จนกว่าจะ refresh แต่ backend อ่าน setting จากไฟล์ใต้ lock จึงตอบ error manual mode และไม่เขียน
- **Session ที่ cache descriptor เก่า:** schema เก่าไม่มี `user_request_excerpt` client ที่ตรวจ schema อาจไม่ยอมส่ง field นี้ จนกว่า lane เชื่อม MCP ใหม่ตาม lifecycle ปกติ (spec 316:166) ระหว่างนั้นการบันทึกใน manual mode ได้ error ไม่มีการเขียนผิดโหมด
- **`#timeline conflicts` / `#timeline trace`:** เป็นคำสั่งของคน ทำงานใน manual mode ตามเดิม; trace ยัง read-only
- **คำขอบันทึกหลายรายการในข้อความเดียว:** ใช้ excerpt เดียวกันได้ทุก record
- **Retry ของ record เดิม:** duplicate identity ไม่รวม excerpt ผลเป็น `existing` เหมือนเดิม
- **ส่ง excerpt ตอน on:** ตรวจรูปแบบแล้วไม่ใช้ ไม่ทำให้ event ต่างกัน
- **คิว legacy > 0 ใน manual mode:** ไม่มีบรรทัดใน header; `timeline_pending_count` และ resolver ทำงานเหมือนเดิมเมื่อผู้ใช้ขอ
- **Remote/Pi lanes:** ไม่มี Timeline tools อยู่แล้ว ไม่เปลี่ยน
- **Project ที่มี `settings.json` ค่า `automaticRecording: true` อยู่แล้ว:** ไฟล์นี้เกิดจาก `#timeline auto` หรือการย้าย schema 1 ที่ผู้ใช้เคยตั้งเอง จึงคงเป็นโหมดอัตโนมัติจนกว่าจะพิมพ์ `#timeline auto off`; ไม่ bump schema เพื่อล้างค่าที่ผู้ใช้เลือก
- **ก่อน `timeline_settings` ตอบกลับ:** frontend ถือว่าเป็น manual mode จึงไม่ส่งคำสั่งให้บันทึกเองระหว่างรอ

## Validation / Acceptance

1. `timeline.rs`: manual mode + ไม่มี excerpt → error และไม่มีไฟล์ event; manual mode + excerpt → created; excerpt ว่างหรือยาวเกิน → error; on + ไม่มี excerpt → created
2. `lane-context.test.ts`: manual mode ส่งบรรทัด manual และไม่ส่ง pending line; on + pending > 0 ยังส่ง pending line; การสลับโหมดทำให้ policy ถูกส่งใหม่
3. `acp-harness-view.test.ts`: fixture backlog ใช้ on แล้วยังผ่าน; manual fixture ไม่มี `Timeline legacy pending`
4. Throwaway smoke เรียก MCP handler `timeline_record` จริงกับ temp project ทั้งสองโหมด แล้วลบ runner
5. `cargo test --lib`, `cargo clippy --lib -- -D warnings`, `npm test -- --run`, `npm run build` ผ่าน
6. Grep เอกสารทั้ง repo ไม่เหลือข้อความ "off blocks new intake/recording, not legacy resolution"

## Implementation and Verification

- ส่วนที่ต่างจาก draft: field `user_request_excerpt` อยู่ใน schema ของ `timeline_record` เท่านั้น ไม่อยู่ใน nested `record` ของ `timeline_pending_resolve` เพื่อไม่ให้ agent เข้าใจว่า legacy resolution ต้องอ้างคำขอ; descriptor มีประโยคบอกวิธีรู้โหมดเพิ่ม; help overlay ใช้คำอธิบายเดียวกับ `hash-commands.ts`
- `cargo test --lib`: 630 passed; `cargo clippy --lib -- -D warnings` และ `cargo fmt -- --check` ผ่าน (`hurl::tests::confine_accepts_files_under_cwd` ไม่ผ่านเป็นบางรอบเมื่อรันทั้งชุด เพราะ `temp_tree()` ตั้งชื่อ directory จาก `now_ms()` ทำให้ test ที่รันพร้อมกันใช้ directory เดียวกัน ไม่เกี่ยวกับงานนี้ รันเดี่ยวและรันซ้ำผ่าน)
- `npm test -- --run`: 279 files / 3,348 tests passed; `npm run build` ผ่าน
- Throwaway smoke เรียก MCP handler `timeline_record` จริงกับ temp project แล้วลบ runner: manual mode ไม่มี excerpt → error manual mode; มี excerpt → `created` พร้อม `conflict_check`; event detail และไฟล์ไม่มีข้อความที่อ้าง; automatic mode ไม่มี excerpt → `created`; excerpt ว่าง → error
- Grep เอกสารไม่เหลือข้อความ "off blocks new intake/recording, not legacy resolution" นอกส่วน historical และข้อความอ้างอิงใน spec นี้
- ยังไม่ได้ทดสอบบนแอปที่ build ใหม่: ต้องติดตั้งแอปใหม่และให้ lane เชื่อม MCP ใหม่ จึงจะเห็น schema และ policy ใหม่
- Revision 1 (ค่าเริ่มต้น off): `cargo test --lib` 630 passed, clippy และ fmt ผ่าน; `npm test -- --run` 3,348 passed และ `npm run build` ผ่าน; test fixtures ที่บันทึกใส่ `user_request_excerpt` แทนการเปิดโหมดอัตโนมัติ เพื่อคง invariant ว่าการอ่านไม่สร้าง `.krypton/timeline`; throwaway smoke กับ project ใหม่ที่ไม่มี settings file: `settings_project` ได้ `automatic_recording: false`, `timeline_record` ไม่มี excerpt ได้ error manual mode และไม่มีการสร้าง `settings.json`

## Open Questions

ไม่มี ตัดสินแล้ว: ใช้ boolean เดิม (ไม่มีโหมดที่สาม), ด่าน `user_request_excerpt` อยู่ที่ backend และไม่เก็บลง event, คิว legacy รอคำขอใน manual mode

## Out of Scope

- Bump settings schema เพื่อเปลี่ยนค่าที่ project เก็บไว้แล้วเป็น off
- Timeline setting ระดับ global หรือใน `krypton.toml` (ยังตั้งราย project ด้วย `#timeline auto`)
- ด่านใน backend สำหรับ `timeline_list`, `timeline_merge`, `timeline_pending_resolve` และ conflict tools
- คำสั่งบันทึกใหม่, approval queue, ฟอร์ม หรือ badge
- พิสูจน์ว่าข้อความใน excerpt มาจากผู้ใช้จริง

## Resources

- [Claude Code — How Claude remembers your project](https://code.claude.com/docs/en/memory.md) — `autoMemoryEnabled` ตั้งได้รายโปรเจกต์ และทางเขียนเมื่อผู้ใช้สั่งแยกจากการเขียนเอง
- Internal: specs 254, 255, 267, 316, 332; `lane-context.ts`, `timeline.rs`, `hook_server.rs`, `harness-timeline-controller.ts`
