# LLM-Managed Timeline — Implementation Spec

> Status: Implemented
> Date: 2026-10-20
> Milestone: ACP Harness — autonomous project provenance
> Supersedes: ขั้น human approval ของ specs 253–255, 257 และ 263; ขยาย agent-owned workflow ของ spec 267

## Problem

ก่อน cutover Timeline ให้คนตรวจข้อเสนอทีละรายการ แม้ผู้ใช้ต้องการให้ LLM เลือก บันทึก จัดกลุ่ม และจัดการข้อขัดกันเองทั้งหมด
การแก้ CSS หรือซ่อน `timeline 24` ไม่เปลี่ยน contract ที่ยังห้าม agent บันทึกและรวม topic เอง
ก่อน rollout มีข้อเสนอเดิม 24 รายการที่ต้องให้ LLM ประเมิน ไม่ใช่ยืนยันทั้งหมดโดยไม่ตรวจหลักฐาน

## Solution

ใช้ lane agent ที่ทำงานอยู่แล้วเป็นเจ้าของ Timeline ตลอด flow: เลือกข้อมูลที่ควรเก็บ อ่านประวัติ ตรวจซ้ำ บันทึก รวม topic และตรวจข้อขัดกันเอง
ไม่มีคำขออนุมัติ ไม่มีฟอร์ม ไม่มี pending badge และไม่ส่งการตัดสินใจ Timeline ไปให้คนผ่าน `attention_flag` หรือคำถามท้ายข้อความ
หน้า `/timeline` คงเป็น read-only history; แหล่งที่มาและเหตุผลทำให้ตรวจสอบย้อนหลังได้โดยไม่เป็น approval gate
เปลี่ยนทั้ง MCP contract, storage provenance, lane policy, permission handling และจัดการคิวเดิมใน working turn ปกติ ไม่เพิ่ม sidecar หรือ model call อีกชุด

## Research

ข้อมูลต่อไปนี้เป็น snapshot ก่อน implementation; ตำแหน่ง source เดิมอธิบายเหตุผลที่ต้องเปลี่ยน ไม่ใช่ contract ปัจจุบัน

- `src/acp/lane-context.ts:92-100` ยังสั่งให้ record/merge ได้เฉพาะเมื่อคนขอ และให้การเลือกบันทึกอัตโนมัติไปใช้ `timeline_suggest`
- `src-tauri/src/hook_server.rs:6737-6869` บังคับ `instruction_excerpt` ใน record/merge และระบุว่าข้อเสนอต้องรอคนตรวจ; prompt-only change จึงไม่พอ
- `timeline.rs:1815-1929` บันทึกตรง ตรวจ retry และ reuse topic ได้แล้ว แต่ระบุผู้บันทึกเป็น `Agent via explicit user instruction`; ต้องเปลี่ยนเพื่อไม่สร้างประวัติการอนุมัติที่ไม่จริง
- `timeline.rs:2134-2249` มี reserved-ID promotion และ pending archive แล้ว แต่การ dismiss ยังไม่มีเหตุผล/ผู้ดำเนินการและไม่ idempotent
- MCP `timeline_list` อ่าน pending หรือรายละเอียด evidence/rationale ของ event ไม่ได้; agent จึงยังตรวจคิวเก่าอย่างครบถ้วนผ่าน tools ไม่ได้
- `harness-permission-scan.ts:34-50,163-179` ไม่ auto-allow merge; `addPermission` ยังส่งรายการที่ไม่มี accept option เข้าคิวคน
- Spec 267 มี agent-managed conflict tools และ incremental checkpoints แล้ว ไม่ต้องสร้าง conflict engine อีกชุด
- คิวจริงมีทั้งหัวข้อคล้ายกัน นโยบายก่อน/หลังการเปลี่ยนแปลง และ implementation claims ที่อ้างเพียง `ok`; blanket promotion จึงไม่ใช่การประเมินโดย LLM
- Lane policy hash เปลี่ยนแล้วส่งใหม่ใน ordinary turn ถัดไปได้; system/slash turns บางประเภทไม่ส่ง policy จึงต้องใส่ contract ครบใน MCP descriptions ด้วย

## Prior Art

| App | Implementation | สิ่งที่นำมาใช้ |
|---|---|---|
| Claude Code auto memory | Claude เลือกเองว่าอะไรมีประโยชน์ต่อ session ถัดไป แล้วเขียน memory ระหว่างทำงาน ไม่ต้องให้คนเขียนหรืออนุมัติทุกรายการ | LLM เป็นผู้เลือกและบันทึก; history/UI เป็นทางอ่าน ไม่ใช่ gate |
| Krypton spec 267 | Lane อ่าน event ใหม่ ตัดสิน conflict บันทึก verdict และ checkpoint เอง | ใช้ agent และ tools เดิม ไม่เพิ่มผู้ตัดสินหรือ model dependency |

**Krypton delta:** Timeline เป็นประวัติที่มี provenance ไม่ใช่ mutable preference memory; การแก้ข้อเท็จจริงใช้ event ใหม่และความสัมพันธ์ ไม่เขียนทับประวัติเก่า

## Affected Files

| File | Change |
|---|---|
| `src-tauri/src/timeline.rs` | Autonomous evidence-first recording, legacy intake resolution, audit receipts, settings migration, agent merge/undo provenance และ behavior tests |
| `src-tauri/src/hook_server.rs` | เปลี่ยน descriptors/handlers ของ record/list/merge; เพิ่ม legacy resolver; ถอด suggest; ส่ง continuation ในผล tool |
| `src-tauri/src/lib.rs` | ถอด manual capture/confirm/dismiss และ semantic-form commands; ลงทะเบียนเฉพาะ IPC ที่มีผู้เรียกจริงหลัง cutover |
| `src/acp/lane-context.ts`, `lane-context.test.ts` | เปลี่ยน human-only policy เป็น autonomous ownership และส่งงาน legacy intake ใน working turn |
| `src/acp/harness-permission-scan.ts`, `acp-harness-view.ts`, tests | Auto-handle built-in Timeline tools ทั้งชุด ไม่เข้าคิวคน; ถอด badge click, capture/focus gates และ wiring เก่า |
| `src/acp/harness-timeline-controller.ts`, `harness-view-host.ts` | คง history/trace/conflicts/settings; ถอดฟอร์มและ human review lifecycle; ส่งสถานะ migration ให้ lane |
| `src/acp/timeline.ts`, `hash-commands.ts`, `harness-prompts.ts`, tests | เปลี่ยน DTO/grammar/help และคง explicit read-only trace |
| `src/acp/components/lane-shell/`, `lane-head/`, `help-overlay/` | ถอด pending prop/badge และข้อความ manual-review; คง `Start Review` ซึ่งเป็นคนละ feature |
| `src/acp/timeline-capture.ts`, `timeline-capture.test.ts`, `src/acp/components/timeline-capture/`, `components/registry.ts` | ลบ runtime form และ catalog form พร้อม tests/registration; ไม่เก็บ shim |
| `src/styles/harness-shared.css` | ลบ title/subtitle ของฟอร์มที่ไม่มีผู้เรียกแล้ว |
| `src/config.ts`, `src-tauri/src/config.rs`, `src-tauri/src/typesafe.rs` และ tests ที่เกี่ยวข้อง | ถอด semantic topic-choice ของฟอร์มที่หมดผู้เรียก; คง generic TypeSafe transport/metrics เฉพาะส่วนที่ยังมีผู้เรียกจริง |
| `src/acp/artifact-timeline.html`, `src-tauri/src/xenon.rs` | แสดง/ส่งต่อ provenance ใหม่ โดยยังอ่านประวัติเก่าได้ และไม่เปลี่ยน explicit publish policy |
| `docs/0002`, `0004`, `0005`, `0006`, `0072`, `0096`, `0186`, `0253`–`0257`, `0263`, `0267`, `0289`, `0302`, `README` | อัปเดต live contracts ทั้งเอกสาร; ระบุส่วนของ historical specs ที่ถูกแทนที่ ไม่เขียนประวัติการออกแบบใหม่ |

## Design

### 1. Autonomous record contract

`timeline_record` รับข้อมูลที่ agent เลือกเองได้ ไม่ต้องมีคำขอบันทึกจากคนใน current message และไม่จำกัดเป็นหนึ่งรายการต่อ turn
ก่อนเพิ่ม subject ครั้งแรก agent ต้องอ่าน `timeline_list`, reuse topic และตรวจ event ที่น่าจะซ้ำก่อน

```ts
type TimelineEvidenceKind = 'user_statement' | 'observed_outcome' | 'agent_decision';

timeline_record({
  topic_id?: string,
  topic_title: string,
  summary: string,
  made_by: string,
  evidence_kind: TimelineEvidenceKind,
  evidence_excerpt: string,
  occurred_at?: string,
  rationale?: string,
  impact?: string,
  source_ref?: string,
  relation?: TimelineRelation,
  related_event?: string,
})
// -> existing event_id/topic_id/path/disposition + conflict_check
```

- ถอด `instruction_excerpt` ออกจาก write API ไม่เก็บ alias; MCP input ยังคงปฏิเสธ unknown fields
- `user_statement` ต้องมีข้อความจากผู้ตัดสินจริง ไม่จำเป็นต้องเป็นคำสั่งให้บันทึก; `observed_outcome` ต้องมีผลที่ตรวจพบ; `agent_decision` ระบุการตัดสินใจของ agent เอง
- Backend เขียน `recorded_by: "Agent"`, lane จาก transport และ `evidence_kind`/Evidence; ไม่ใช้ `Local user` หรือ `Agent via explicit user instruction`
- `made_by` อ้างตามหลักฐานเท่านั้น; สำหรับ `agent_decision` backend ใช้ lane label เป็นผู้ตัดสิน ไม่เติม `Current user` ให้เอง
- คง event schema 1; เพิ่ม optional `evidence_kind` ที่ reader และอ่าน Evidence/Authorizing instruction เก่าต่อได้ ไม่ rewrite events เก่าเพื่อเดา provenance
- เก็บหลักฐานที่เกี่ยวข้องแบบ bounded ไม่เก็บ secrets หรือ tool-output dump; agent-composed prose เป็นไทย ส่วนข้อความอ้างอิงคงต้นฉบับ
- Duplicate identity ใช้ resolved topic ID, normalized summary, evidence kind/excerpt และ source; เปลี่ยนชื่อแสดง topic อย่างเดียวไม่สร้าง event ซ้ำ
- ถอด implicit title/summary promotion ของ pending จาก normal record; legacy promotion ต้องเลือก ID ผ่าน resolver เพื่อไม่เก็บ candidate ที่ยังไม่ได้ประเมิน
- Agent บันทึกเฉพาะข้อมูลถาวรที่มีหลักฐาน ไม่บันทึก routine status/tests หรือสร้าง human approval จากข้อสันนิษฐาน

### 2. Read APIs ที่ใช้ตัดสินได้จริง

ขยาย `timeline_list` โดยคง default topic digests และ topic-event listing เดิม:

```ts
timeline_list({ topic_id?: string, query?: string, limit?: number,
                event_id?: string, pending?: boolean })
// event_id -> event เดียวพร้อม evidence/rationale/impact/relation/recorder provenance
// pending:true -> candidates[], remaining_pending, diagnostics, truncated
```

`event_id` และ `pending:true` เป็นคนละ mode กับ topic/query; input ที่ผสม mode ถูกปฏิเสธก่อนอ่าน
Pending mode คืน candidate เดิมพร้อม reserved ID และข้อมูลทุก field; default 5/max 20 รายการ เก่าสุดก่อน
หลัง resolve กลุ่มหนึ่ง agent อ่าน pending ต่อจนหมด ไม่ใช้ once-per-turn หรือขอบเขต 5 topic ของ conflict เป็นข้อจำกัดการย้ายคิว
ไม่สแกน topic ทั้ง project ซ้ำทุก turn; event detail โหลดเฉพาะที่ต้องใช้ประเมินจริง

### 3. ให้ LLM จัดการ 24 รายการเดิม

เพิ่ม MCP tool เดียวสำหรับ terminal resolution ของ legacy intake; ไม่มี API สร้าง pending ใหม่:

```ts
timeline_pending_resolve({
  pending_id: string,
  outcome: 'record' | 'duplicate' | 'discard',
  rationale: string,
  record?: TimelineDirectRecordRequest, // บังคับเฉพาะ record: shape ตาม §1
  event_id?: string,                   // บังคับเฉพาะ duplicate
})
// -> pending_id, outcome, event_id?, resolution_path, remaining_pending
```

- `record`: LLM ตรวจหลักฐานและเขียนข้อความสุดท้าย ใช้ reserved event ID เดิม เก็บ suggesting lane/evidence และเวลาต้นฉบับ; normal post-record conflict continuation ยังทำงาน
- `duplicate`: อ้าง event จริงใน project เดียวกัน ไม่สร้าง event เพิ่ม; LLM อ่าน detail ก่อนเลือก canonical event
- `discard`: candidate ไม่มีหลักฐานพอ ไม่ใช่ข้อมูลถาวร หรือเป็นข้อสรุปที่ไม่มีแหล่งรองรับ; เก็บเหตุผล ไม่ถามคนและไม่เดาให้เป็นจริง
- Candidate ที่เป็นประวัติก่อนเปลี่ยนนโยบายยังบันทึกได้พร้อม event ใหม่ที่แทนที่ ไม่ทิ้งเพียงเพราะเก่า
- เก็บ receipt ที่ `.krypton/timeline/resolutions/<pending_id>.json`: schema 1, outcome, event ID ถ้ามี, rationale, resolved lane/time และ original candidate Markdown แบบ verbatim
- ใช้ mutation mutex เดิมครั้งเดียว; อ่าน terminal receipt/event, snapshot candidate และ validate/serialize ข้อมูลที่อาจเกิดข้อผิดพลาดก่อนเริ่ม mutation
- ตรวจ candidate/event IDs, confined project paths, symlink และขนาดไฟล์ตามข้อกำหนด storage เดิม; resolver ไม่รับ arbitrary filesystem path
- เขียน/flush event ก่อนสำหรับ outcome record แล้วเขียน receipt ด้วย temp+rename; ลบ pending หลัง receipt สำเร็จเท่านั้น
- Retry หลัง event/receipt สำเร็จแต่ cleanup/response ไม่สำเร็จ คืนผลเดิมและเก็บ pending ให้เรียบร้อย; ห้ามสร้าง event ซ้ำหรือเปลี่ยน terminal outcome
- สอง lane ประเมิน ID เดียวกันพร้อมกันได้ แต่ resolver คืน terminal winner ให้ผู้เรียกที่ตามมา; ไม่ต้องเพิ่ม lease service
- Malformed candidate คงไฟล์และ diagnostic ไม่ถูกนับว่า resolve แล้ว; ห้ามรายงานว่าคิวหมดหากยังมีไฟล์ที่อ่านไม่ได้
- `remaining_pending` ต้องรวม candidate ที่ยังอ่านไม่ได้ด้วย ไม่คืน 0 จากการนับเฉพาะรายการที่ parse สำเร็จ

### 4. Topic grouping และ conflicts ไม่ย้อนมาถามคน

`timeline_merge` เปลี่ยน required `instruction_excerpt` เป็น `rationale`; agent อ่าน topic IDs/detail แล้วเลือกเอง
คง unique-selector validation, same-topic refusal, backup-before-rewrite และการเปลี่ยนเฉพาะ `topic_id`
Manifest เก็บ acting lane/rationale; undo เก็บ undone lane/rationale เพิ่มด้วย โดยอ่าน manifests เก่าที่ไม่มี field ใหม่ได้
ไม่ใช้ merge เพื่อซ่อนข้อขัดกันหรือแก้ข้อความ event

ใช้ conflict tools/checkpoints ของ spec 267 ต่อ `confirmed` หมายถึงพบ conflict ไม่ใช่เลือกข้อใดเป็นความจริง
เมื่อหลักฐานแสดงการเปลี่ยนนโยบาย ให้ record event ที่มี `supersedes` และแหล่งที่มา แล้วบันทึก verdict/checkpoint
หากหลักฐานตัดสินไม่ได้ LLM บันทึก `insufficient_evidence` พร้อมเหตุผลเอง ไม่ส่งคำถามหรือ approval queue ให้คน
ไม่แต่งคำตัดสินทางธุรกิจของผู้ใช้ขึ้นมาเพื่อทำให้ conflict ดูปิดแล้ว

### 5. Permission และ lane execution

- Auto-handle เฉพาะชื่อ Timeline tools สุดท้ายที่จับคู่กับ built-in Harness identity จาก qualified adapter title, top-level server พร้อม title, standalone qualified `Tool:` label หรือ Junie option-label wrapper; third-party/same-name tools ไม่ได้รับสิทธิ์เพิ่ม
- ไม่ใช้ `rawInput`/arguments ยืนยันตัวตน; explicit foreign qualified title ไม่ถูกแทนที่ด้วยข้อความใน arguments, content หรือ option labels
- มี accept option: ใช้ `respondPermission(requestId, optionId)` ตามเดิม
- เป็น built-in Timeline call แต่ adapter ไม่มี accept option: ตอบ `respondPermission(requestId, null)` และแสดง diagnostic ว่าดำเนินการไม่ได้; ห้ามเข้า `pendingPermissions` หรือ `needs_permission` เพื่อให้คนตัดสิน
- ตอน register local Harness อ่าน legacy count; ส่ง migration obligation ใน ordinary lane policy เมื่อ count > 0
- Agent จัดการ legacy intake ภายใน working turn ปกติของ local MCP-capable lane แล้วทำงานผู้ใช้ต่อ ไม่เปิด turn ใหม่จาก startup/event/finishTurn
- Tool results ส่ง remaining count/continuation จน 0; count ที่ stale จากอีก Harness ไม่ทำให้เขียนซ้ำ เพราะ resolver idempotent
- ไม่มีการบังคับให้ผู้ใช้พิมพ์ `#timeline review`; remote/Pi ที่ไม่มี project-backed tools ไม่แตะ local storage
- Descriptor เป็น contract หลักและมี autonomous rule ครบ; policy ใหม่ระบุว่าแทนที่ Timeline human-approval guidance เก่า
- หลังอัปเดตแอป ต้องให้ lane session เชื่อม MCP descriptors/schema ใหม่ตาม lifecycle ปกติ; ห้ามใช้ payload ใหม่กับ tool contract เก่าที่ session ยัง cache อยู่ หรือหยุด turn ที่กำลังทำงานเพื่อ force-restart

### 6. UI, commands และ settings

- ถอด `timeline N`, pending-review click handler, runtime/catalog capture forms และ focus/key gates ที่เป็นของฟอร์มนี้เท่านั้น
- ถอด `#timeline add`, `review`, `merge ...` และ `merge undo` จาก parser/help/manifest; การบันทึกและซ่อม topic เป็นหน้าที่ของ LLM tools ไม่เก็บ command aliases
- คง `#timeline [open [topic] | trace topic | conflicts [topic] | auto [on|off] | topic]` เป็นทางอ่าน/สั่ง agent/ตั้งความต้องการ ไม่ใช่การอนุมัติทีละรายการ
- คง `Start Review`, general attention และ permission flow ของ feature อื่น
- เปลี่ยน settings DTO/IPC เป็น `TimelineSettings { automaticRecording: boolean }`, `timeline_settings`, `timeline_set_enabled`; `timeline_pending_count` คืนจำนวน backlog ให้ policy โดยไม่สร้าง UI หรือ model turn
- ย้าย settings schema 1 `automaticSuggestions` เป็น settings schema 2 `automaticRecording` แบบ atomic โดยรักษาค่าเดิม; event schema ไม่เปลี่ยนตาม settings
- Default เปิด; off ปิด autonomous intake ใหม่ แต่ไม่ทำให้ legacy candidates กลับไปเป็นงานของคน การย้ายคิวเดิมยังทำจนจบผ่าน resolver
- Tool record คืน disabled error เมื่อ autonomous intake ถูกปิด; ไม่มี fallback เป็นฟอร์มหรือ pending candidate
- ถอด Timeline-only TypeSafe topic-choice และ config ที่หมดผู้เรียก ไม่เก็บ hidden semantic dependency
- หน้า `/timeline` แสดง evidence kind/agent provenance และ refresh เมื่อกลับมา focus ตามเดิม; ไม่มี mutation UI หรือ automatic Xenon publish

## Edge Cases

- Explicit read-only turns รวม `#timeline trace` ห้าม record/merge/resolve intake เป็น side effect; งาน maintenance รอ working turn ที่อนุญาตให้เขียน ไม่เริ่ม turn เพิ่มและไม่ถามให้คนยกเว้นข้อห้าม
- ไม่มี capable lane หรือ MCP/storage ใช้ไม่ได้: คงข้อมูลเดิมและแจ้งข้อผิดพลาดทางเทคนิค ไม่สร้างฟอร์ม/approval queue หรืออ้างว่าบันทึกแล้ว
- หลาย Harness ของ project เดียวกันอาจเห็น count เก่า: resolver ต้องตรวจ terminal receipt ภายใต้ lock และคืนผลที่มีอยู่
- Source เดิมอ้างชื่อเอกสารก่อนเปลี่ยนชื่อ: LLM หาเอกสารปัจจุบันเพื่อประเมินได้ แต่ receipt ต้องรักษา source reference ต้นฉบับ
- Settings เดิมที่ปิด suggestions ยังรักษาความต้องการปิด intake ใหม่; ไม่ทำให้การจัดการ legacy candidates ต้องรอคน
- ทุก platform flush เนื้อหาไฟล์ก่อน atomic publication; directory flush ใช้เฉพาะ Unix ไม่เรียก POSIX-style directory open บน Windows และไม่อ้าง portable directory-fsync guarantee

## Validation / Acceptance

1. Local agent บันทึก requirement, observed outcome และ agent decision ได้โดยไม่มี current-human persistence instruction; round-trip evidence/actor ถูกต้อง และ retry ไม่เพิ่ม event ซ้ำ
2. Topic reuse ข้ามชื่อแสดงยังใช้ ID เดิม; unknown IDs/relations ถูกปฏิเสธก่อนเขียน
3. Fixture คิว legacy มี valid/duplicate/unsupported/older-superseded candidates: LLM flow resolve ครบโดยไม่ใช้ UI; ทุก original candidate มี receipt และ provenance ครบ
4. Competing/repeated resolution, response loss, event-saved/stale-pending cleanup และ failed writes ไม่สร้าง event ซ้ำหรือทำ candidate หาย
5. Merge/undo ทำงานโดยไม่มี human quote/permission UI; backup และ bytes นอก `topic_id` คงเดิม พร้อม acting-lane rationale
6. Built-in record/merge/resolver ไม่สร้าง pending permission หรือ notification ให้คน; third-party lookalikes ไม่ auto-allow; missing accept option ถูกยกเลิกพร้อม diagnostic
7. Browser smoke ใช้ runtime lane shell/command paths จริง: ไม่มี Timeline badge/form, `Start Review` ยังอยู่, history ยังอ่านและแสดง provenance เก่า/ใหม่ได้
8. Changed lane policy ถูกส่งใน ordinary turn ถัดไป และ startup/events ไม่สร้าง follow-up model turn
9. Backend temp-project smoke เรียก MCP handlers จริงสำหรับ record/list/resolve/merge/conflict จน pending count 0 โดยไม่มี human-confirm API; ยังไม่แตะ 24 ไฟล์จริงระหว่างทดสอบ
10. เปลี่ยน tests ที่ pin wording/source implementation เป็น behavior tests หรือลบทิ้ง; ตรวจ frontend/backend แล้ว smoke flow ก่อนแก้เอกสาร live ให้ตรงทั้งหมด
11. หลัง rollout ให้ active LLM จัดการ 24 รายการจริงผ่าน contract ใหม่และรายงาน recorded/duplicate/discarded/diagnostic counts; ห้ามรายงานว่าย้ายแล้วจาก fixture เพียงอย่างเดียว

## Implementation and Verification

- Implemented ทั้ง storage/MCP/lane policy/permission handling และถอด runtime/catalog capture forms, pending badge, manual mutation commands และ TypeSafe ที่หมดผู้เรียก
- `cargo test --lib`: 520 passed; `cargo clippy --lib -- -D warnings`: passed
- `npm test -- --run`: 200 files / 2,615 tests passed; `npm run build`: passed ทั้ง app และ GenUI gallery
- Throwaway smoke เรียก MCP handlers จริงกับ temporary project: legacy candidates 4 รายการ → record 2, duplicate 1, discard 1, remaining 0; ตรวจ direct record, merge/undo, supersession, conflicts และ checkpoints ด้วย แล้วลบ smoke runner ออกจาก source
- Browser smoke ใช้ production `LaneShell`: ไม่มี Timeline approval badge/form และ `Start Review` ยังแสดง/กดได้; หน้า history ใช้ JSON trace จาก MCP smoke จริง ตรวจ agent/user/observed evidence kinds, คำอนุญาตเก่า, search และ read-only GET โดยไม่มี mutation form
- Permission regressions ครอบคลุม Junie option labels, qualified adapter identity, raw-argument namespace spoofing, server lookalikes, missing content และ missing accept option; review blockers ที่พบถูกแก้แล้ว
- Runtime verification ทำบน macOS arm64 เท่านั้น; Windows ไม่มี runtime/target ให้ตรวจ จึงไม่อ้างว่ารัน Windows หรือพิสูจน์ crash durability บน Windows แล้ว
- Rollout คิวจริงเสร็จเมื่อ 2026-10-20: working lane `OMP-1` ใช้ mounted `timeline_list` / `timeline_pending_resolve` contract ใหม่ประเมินครบ 24 รายการ → record 19, duplicate 1, discard 4; ผลอ่านคิวสุดท้ายคือ `remaining_pending: 0`, `diagnostics: []` โดยไม่ bypass filesystem หรือเปิด approval UI เก็บ receipt ทุก ID และตรวจความสัมพันธ์พร้อม checkpoint ของ events ที่สร้าง; รายการที่มีเพียง `ok` / `Yes` โดยไม่มีข้อเสนออ้างอิงไม่ได้ถูกยกเป็นประวัติอนุมัติ

## Open Questions

ไม่มี ประเมิน candidate ตามหลักฐานโดย LLM ไม่เลือก blanket promotion และไม่เพิ่ม approval gate ให้คน

## Out of Scope

- การเปลี่ยน general permissions, `attention_flag`, connected-computer approval หรือ workflow ของ feature อื่น
- การอนุมานคำอนุมัติของคน หรือการแก้/ลบข้อความ event เก่า
- Sidecar, scheduler, model/API key หรือ dependency ใหม่; การเริ่ม turn เพิ่มเพื่อกวาด Timeline
- Remote project storage, automatic publication และการเปลี่ยนหลักฐานที่ไม่พอให้กลายเป็นข้อเท็จจริง
- การใช้งานผ่าน mounted tools ที่ยังมี contract เก่าเพื่อข้ามข้อกำหนดระหว่างพัฒนา

## Resources

- [Claude Code — How Claude remembers your project](https://code.claude.com/docs/en/memory#auto-memory) — LLM เลือกและเขียน memory ระหว่างทำงานโดยไม่ต้องอนุมัติทุกครั้ง
- Internal: specs 255, 263, 267 และ 289; `timeline.rs`, `hook_server.rs`, `lane-context.ts`, `harness-timeline-controller.ts`, `harness-permission-scan.ts`
