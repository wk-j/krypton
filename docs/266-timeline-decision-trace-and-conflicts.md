# Timeline Decision Trace and Conflict Review — Implementation Spec

> Status: Implemented — review/scan parts superseded by [spec 267](./267-timeline-conflicts-by-agent.md) (the in-app sheet, manual proposals, human verdicts, and TypeSafe scan were removed; the lane agent now does all of it)
> Date: 2026-09-23
> Milestone: ACP Harness — project provenance
> Issue: [wk-j/krypton#28](https://github.com/wk-j/krypton/issues/28)

## Problem

คนทำซอฟต์แวร์ต้องย้อนดูได้ว่าข้อกำหนดหนึ่งเปลี่ยนจากอะไรเป็นอะไร ใครเป็นผู้ตัดสินใจ
เมื่อไร และอ้างอิงหลักฐานใด แต่หน้า Timeline ตอนนี้แสดงบันทึกเรียงตามวันเป็นหลัก
จึงมองไม่ออกทันทีว่า A → B → A เป็นประวัติการเปลี่ยนแปลง หรือมีคำตัดสินสองชุดที่ยังขัดกันอยู่

## Solution

คงหน้า Timeline แบบรายการตามวัน แต่ไฮไลต์สีบนบันทึกในคู่ที่ยังต้องตรวจหรือ
ยืนยันว่าขัดกันและยังไม่แก้
ผู้ใช้เปิดแต่ละรายการเพื่ออ่านผู้ตัดสินใจ เหตุผล วันที่ แหล่งอ้างอิง และความสัมพันธ์
`supersedes` ได้โดยไม่แก้บันทึกต้นฉบับ
หน้าดูในเบราว์เซอร์ยังอ่านอย่างเดียว; การตรวจและบันทึกผลทำใน Krypton ผ่าน
`#timeline conflicts` เท่านั้น การสแกนด้วย TypeSafe เป็นคำสั่งที่ผู้ใช้เรียกเองและเป็น
ตัวช่วยหาคู่ที่น่าดู ไม่ใช่คำตัดสินว่าใครมีอำนาจหรือข้อใดมีผล

## Research

- `timeline.rs` เก็บ `topic_id`, `made_by`, `recorded_by`, เวลา, `source_ref` และ
  `relation`/`related_event` อยู่แล้ว; `scan_project()` หา `superseded` จากลิงก์
  `supersedes` แต่ยังไม่มีเส้นทางหรือผลตรวจคู่คำตัดสิน
- `/timeline.json` ส่งบันทึกที่ยืนยันแล้วครั้งเดียว หน้า `artifact-timeline.html`
  มีหัวข้อด้านซ้ายและแถวตามวัน; ความสัมพันธ์อยู่ในรายละเอียดและยังไม่กดไปหา
  `related_event` ได้ บางแถวซ่อน `made_by` เมื่อเป็น `Current user` ซึ่งทำให้
  คำถามว่า “ใครตัดสินใจ” ยังตอบไม่ครบ
- Spec 253/261 กำหนดว่า `topic_id` เป็นตัวรวมเรื่องและหน้าเบราว์เซอร์อ่านอย่างเดียว
  ส่วน spec 263 อนุญาตให้ merge หัวข้อพร้อม backup/undo จึงต้องคำนวณภาพจาก
  event ID ใหม่ทุกครั้ง ไม่ผูกผลตรวจกับชื่อหัวข้อที่เปลี่ยนได้
- TypeSafe ที่มีอยู่ช่วยเลือกหัวข้อจากข้อความได้ แต่ไม่เคยตัดสินเรื่องอำนาจ
  [Choice](https://docs.typesafe.ai/primitives/choice) ส่งผลเป็นตัวเลือกพร้อม
  ความน่าจะเป็นและความมั่นใจ ไม่สร้างเหตุผลหรือหลักฐานเอง จึงใช้ได้เฉพาะคัดคู่
  เพื่อให้คนตรวจ; ต้องแสดงข้อความต้นทางทั้งคู่เสมอ
- ทางเลือกที่ตัดออก: ใช้วันใหม่สุดเป็น “คำตัดสินปัจจุบัน” เพราะเวลาไม่ใช่หลักฐานว่า
  ใครอนุมัติ; ใช้คะแนน AI เปลี่ยนสถานะอัตโนมัติ เพราะผิดครั้งเดียวจะทำให้ประวัติ
  น่าเชื่อถือน้อยลง; เปิด POST จากหน้าเบราว์เซอร์ เพราะขัดกับขอบเขตอ่านอย่างเดียว
  ของ Timeline เดิม

## Prior Art

| ระบบ | วิธีที่ใช้ | สิ่งที่นำมาใช้ |
|---|---|---|
| [GitHub issue timeline](https://docs.github.com/en/rest/using-the-rest-api/issue-event-types) | event มีผู้กระทำ เวลา และ cross-reference ไปยัง issue/PR ต้นทาง | แต่ละจุดต้องตามกลับไปยังต้นทางได้ |
| [Linear issue history](https://linear.app/docs/editing-issues) | เปิดประวัติการแก้ description แยกจากข้อความล่าสุด | ให้ดูการเปลี่ยนเป็นลำดับ ไม่ทับเหตุการณ์เก่า |
| [Microsoft decision log](https://microsoft.github.io/code-with-engineering-playbook/design/design-reviews/decision-log/) | บันทึกการตัดสินใจเดิมไว้เมื่อมีข้อใหม่มาแทน | แยก “ถูกแทนที่” จาก “ยังขัดกัน” |
| [TypeSafe Choice](https://docs.typesafe.ai/primitives/choice) | เลือกจากกลุ่มคำตอบปิดพร้อม distribution/confidence | ใช้คัดกรองแบบมีทางเลือก “หลักฐานไม่พอ”; ไม่ยกผลโมเดลเป็นข้อเท็จจริง |

Krypton ต่างจาก activity feed ทั่วไปตรงที่แยกผู้ตัดสินใจจากผู้บันทึก และแสดง
ความไม่แน่ใจเมื่อข้อมูลไม่พอ ทุกทางเข้าหลักใช้คีย์บอร์ดได้

## Affected Files

| ไฟล์ | งาน |
|---|---|
| `src-tauri/src/timeline_conflicts.rs` (ใหม่), `src-tauri/src/timeline.rs` | module ใหม่สร้าง read model ของเส้นทาง, ตรวจลิงก์ผิด/วงจร, เก็บ proposal/review/scan แยกจาก event, สรุปจำนวนที่ยังค้าง และคำสั่ง Tauri ทั้งสี่; `timeline.rs` เปิด helper เดิม (lock, confined root, validate) ให้ใช้ร่วม |
| `src-tauri/src/typesafe.rs`, `src-tauri/src/config.rs` | เพิ่มการคัดคู่แบบเรียกเองด้วย TypeSafe; ใช้ client/credential/deadline เดิมและ config ที่ปิดไว้ก่อน |
| `src-tauri/src/hook_server.rs` | ให้ `/timeline.json` ส่ง read model เพิ่มโดยยังคง `events`/`diagnostics` เดิม |
| `src/acp/artifact-timeline.html` | คงรายการตามวันและรายละเอียดเดิม; ไฮไลต์บันทึกที่มีข้อเสนอว่าอาจขัดกัน |
| `src-tauri/src/lib.rs`, `src/acp/timeline.ts`, `src/acp/acp-harness-view.ts` | ลงทะเบียนคำสั่ง Tauri และ `#timeline conflicts`; เปิดแผ่นตรวจใน app |
| `src/acp/timeline-conflicts.ts`, `src/styles/acp-harness.css` | แผ่นเลือก/เทียบสองบันทึก, ผลตรวจและเหตุผล, ปุ่มสแกนที่กดเอง |
| `src/config.ts` | อ่าน config ที่ไม่ใช่ secret ของตัวช่วยสแกน |
| `docs/02-functional-requirements.md`, `docs/04-architecture.md`, `docs/05-data-flow.md`, `docs/06-configuration.md`, `docs/72-acp-harness-view.md`, `docs/253-project-decision-requirement-timeline.md`, `DESIGN.binance.md` | ปรับสัญญาหน้า Timeline, เส้นทางข้อมูล, คีย์บอร์ด และขอบเขตการเขียน |
| `docs/README.md` | ใส่ลิงก์ spec นี้ |

## Design

### ข้อมูลและสถานะ

บันทึก `.krypton/timeline/events/*.md` ยังเป็น schema 1 แบบเดิม ไม่แก้ย้อนหลัง
เพิ่มไฟล์ใน project เดียวกัน:

```text
.krypton/timeline/conflicts/proposals/<sorted-event-id-pair>.json
.krypton/timeline/conflicts/reviews/<review-id>.json
.krypton/timeline/conflicts/scans/<scan-id>.json
```

Proposal หนึ่งคู่มี `schema`, `event_a`, `event_b` (เรียง ID เพื่อกันคู่ซ้ำ;
`pair_id` คือ `<event_a>--<event_b>`),
`origin` (`manual` หรือ `typesafe`), `suggested_at`, `model`/`probability`
เมื่อมี, `input_hash` สำหรับผล TypeSafe, และ `basis` ซึ่งบอกเพียงเหตุที่นำคู่นี้มาดู
ไม่ใช้ข้อความ AI เป็นหลักฐาน
คู่ที่คนเลือกเองต้องใส่เหตุผลสั้น ๆ ก่อนบันทึก proposal

Review เป็นบันทึกเพิ่มใหม่ทุกครั้ง ไม่เขียนทับ proposal หรือ event: `id`, `pair_id`,
`verdict` (`confirmed`, `dismissed`, `insufficient_evidence`, `resolved`),
`rationale`, `source_ref?`, `reviewed_at`, `reviewed_by` ล่าสุดของคู่นั้นเป็น
สถานะที่หน้าอ่านแสดง ส่วนประวัติ review ทุกครั้งยังเปิดดูได้
ผู้ใช้แก้คำตรวจได้ด้วยการเพิ่ม review อีกครั้ง ไม่เปลี่ยนคำตรวจเก่า
`resolved` ต้องอ้าง event ที่ทำให้ข้อขัดกันสิ้นสุดหรือ `source_ref` ที่คนตรวจระบุ
ผลสแกนแต่ละครั้งเก็บ model, เวลา, จำนวนคู่ที่ตรวจ, จำนวนคู่ที่ข้าม และเหตุที่
ตรวจไม่ครบไว้ใน `scans/`; การเปิดหน้าใหม่จึงไม่ทำให้คำว่า “สแกนครบ” เปลี่ยนความหมาย
ไฟล์ sidecar ทุกชนิดมี schema/ขนาด/จำนวนจำกัด อ่านเฉพาะไฟล์ปกติใน project
และแสดง diagnostic เมื่อเสีย เช่นเดียวกับ event เดิม

`TimelineTraceResponse` เพิ่มบน `/timeline.json` แบบ additive:

```ts
type TimelineTraceResponse = TimelineListResponse & {
  chains: Array<{ topicId: string; eventIds: string[]; links: Array<{
    from: string; to: string; kind: 'supersedes' }> }>;
  conflictPairs: Array<{ pairId: string; eventA: string; eventB: string;
    state: 'unreviewed' | 'confirmed' | 'dismissed' | 'insufficient_evidence'
      | 'resolved' | 'historical';
    origin: 'manual' | 'typesafe'; basis: string; suggestedAt: string;
    model?: string; probability?: number;
    reviews: Array<{ id: string; verdict: string; rationale: string;
      sourceRef?: string; resolutionEventId?: string; reviewedBy: string;
      reviewedAt: string }> }>;
  // นับทั้ง project ครั้งเดียวต่อคู่
  conflictCounts: { needsReview: number; confirmed: number };
  scan: { enabled: boolean; state: 'never_run' | 'completed' | 'partial';
    lastCompletedAt?: string; checkedPairs: number; skippedPairs: number;
    inconclusivePairs: number; reason?: string };
};
```

`chains` เป็น projection จาก `supersedes` ที่ตรวจแล้ว ไม่ใช่การคาดเดาจากเวลา
ถ้ามี branch ให้แสดง branch ทั้งหมดแทนการบังคับเลือกเส้นเดียว Event ที่ไม่มี
ลิงก์ยังอยู่ในลำดับเวลา แต่ไม่ติดป้ายสถานะที่สรุปเกินหลักฐาน การไม่พบลิงก์
`supersedes` ไม่ได้ยืนยันว่าข้อความนั้นยังมีผลในปัจจุบัน `made_by` แสดงตามที่
บันทึกไว้ และ `recorded_by` อยู่ในรายละเอียด

คู่ที่มีเส้น `supersedes` ถึงกันเป็น “ประวัติการเปลี่ยนแปลง” ไม่ขึ้นจำนวนขัดแย้ง
หากพบวงจร, ลิงก์ไป event ที่หาย, หรือไฟล์อ่านไม่ได้ ให้ขึ้น diagnostic และไม่
สรุปสถานะของส่วนนั้น คู่ที่มี proposal แต่ภายหลังฝั่งใดฝั่งหนึ่งถูกแทนที่
จะเป็น `historical` โดยไม่ลบ review เดิม; การสแกนครั้งต่อไปจึงพิจารณาจุดใหม่
`insufficient_evidence` อยู่ในรายการให้ตรวจต่อ แต่ไม่นับเป็นข้อขัดแย้งที่ยืนยันแล้ว
ตัวเลข “ต้องตรวจ” นับ `unreviewed` และ `insufficient_evidence`;
ตัวเลข “ยังขัดกัน” นับ `confirmed` ที่ยังไม่ถูกแก้หรือแทนที่
คู่ข้ามหัวข้อปรากฏในจำนวนของทั้งสองหัวข้อ แต่จำนวนรวมทั้ง project นับครั้งเดียว

### การหาคู่ที่อาจขัดกัน

`#timeline conflicts` เปิดแผ่นตรวจที่ค้น event ได้ทุกหัวข้อ เลือกสองรายการ
เทียบกัน และบันทึก proposal ด้วยเหตุผลเองได้ จึงยังใช้งานได้แม้ไม่มี TypeSafe
ปุ่ม `s` ในแผ่นนี้เริ่ม `timeline_conflict_scan` เมื่อเปิดใช้
`[typesafe.timeline_conflicts] mode = "suggest"` และ `[typesafe] enabled = true`
ค่าเริ่มต้น `off`; การเปิดหน้า Timeline ไม่เรียกเครือข่ายหรือโมเดล

การสแกนทำงานกับ event ที่ยังไม่พบว่าถูกแทนที่ ไม่รวมคู่ที่มีเส้น `supersedes`
ถึงกันหรือข้อความ+แหล่งอ้างอิงซ้ำตรงกัน จัด shortlist ตามลำดับคงที่:
คู่ในหัวข้อเดียวกันก่อน, คู่ข้ามหัวข้อที่มี `source_ref` เดียวกัน,
แล้วคู่ที่มีคำสำคัญใน title/summary ตรงกัน เรียงภายในกลุ่มตามเวลาใหม่สุด
และ event ID ถ้าเท่ากัน
ส่งเพียง ID, หัวข้อ และ summary ที่ตัดความยาวแล้วของแต่ละคู่ให้ TypeSafe
ไม่ส่ง instruction, evidence, source URL, transcript หรือข้อมูลลับ
ครั้งหนึ่งตรวจได้ไม่เกิน 40 คู่ โดยแบ่งเป็น request ละไม่เกิน 8 KiB;
หากขอบเขตเต็มให้แสดง `partial` และจำนวนที่ยังไม่ได้ตรวจ ไม่ขึ้นว่า
“ไม่มีข้อขัดแย้ง” การเลือก shortlist ต้องเรียงแบบคงที่และเปิดเผยว่า
คู่ข้ามหัวข้ออาจตกหล่น ไม่กล่าวว่าได้ตรวจทั้ง project แล้ว

Choice ต่อคู่มี `possible_conflict`, `compatible_or_duplicate`, `unrelated`,
`insufficient_evidence` พร้อมเกณฑ์แยก “คำตัดสินคนละทางในเรื่องเดียวกัน”
ออกจาก “คนละเรื่อง”/“ข้อความซ้ำ” ผล `possible_conflict` ผ่านเกณฑ์
probability ≥ 0.70, confidence ≥ 0.65 และระยะห่างจากตัวเลือกอันดับสอง
≥ 0.15 จึงสร้าง proposal; ชุดตัวอย่างจริงต้องผ่านเกณฑ์ทดสอบก่อนเปิด `suggest`
ผลคลุมเครือขึ้นว่า “สแกนแล้ว ยังสรุปไม่ได้” โดยไม่เพิ่มยอด conflict
ระบบไม่แต่งคำอธิบายแทนโมเดล: `basis` ระบุว่าเป็นเพียงการคัดกรองด้วยข้อความ
และเปิด summary/source ของสอง event ให้คนตรวจเอง
ผลสแกนที่บันทึกแล้วเปิดซ้ำได้แบบ offline; การสแกนใหม่ไม่ทับ proposal,
review หรือ event เดิม และไม่คืนคู่ที่ dismiss แล้วโดยไม่มี event ใหม่เกี่ยวข้อง

### คำสั่งและการเขียน

```rust
// ทุกคำสั่งรับ harness_id; Rust หา project จาก Harness ที่ลงทะเบียนไว้
timeline_conflict_list(harness_id: String) -> Result<TimelineTraceResponse, String>
timeline_conflict_propose(harness_id: String, event_a: String,
  event_b: String, rationale: String) -> Result<TimelineConflictPair, String>
timeline_conflict_review(harness_id: String, pair_id: String,
  verdict: TimelineConflictVerdict, rationale: String,
  source_ref: Option<String>, resolution_event_id: Option<String>)
  -> Result<TimelineConflictPair, String>
timeline_conflict_scan(harness_id: String) -> Result<TimelineConflictScan, String>
```

คำสั่งเขียนตรวจ ID และขนาดข้อความก่อนแตะไฟล์; `review` ยอมรับเฉพาะคู่ที่มี
proposal และ `resolved` ตรวจหลักฐานเพิ่มเติมตามข้างบน `scan` ไม่รับข้อความ
จาก browser และไม่ใช้ MCP tool เพื่อไม่ให้ agent สร้าง/ตัดสิน conflict เอง
`reviewed_by` มาจากบริบทผู้ใช้ใน app ไม่รับชื่อผู้ตรวจจาก payload — ใช้ `Local user`
เหมือน `recorded_by` ของ `#timeline add`

ผลสแกนแต่ละครั้งเก็บรายการคู่ที่ตรวจแล้วพร้อม `input_hash` (ID + หัวข้อ + summary
ที่ส่งจริง); สแกนครั้งต่อไปข้ามคู่ที่ hash เดิม และข้ามคู่ที่มี proposal แล้วทุกสถานะ
คู่ที่ได้คำตอบผิดรูปแบบไม่ถูกนับว่าตรวจแล้ว จึงถูกส่งใหม่ในรอบหน้า
การสแกนเป็นงานที่ผู้ใช้สั่งเอง จึงใช้ attempt timeout อย่างน้อย 4 วินาทีและ deadline
ต่อ request 10–15 วินาที แทนงบของ topic suggestion แบบ interactive

### การแสดงผลและการตรวจ

หน้า `/timeline` คง layout เดิม: header ที่มีช่องค้นหา, หัวข้อด้านซ้าย และ
รายการตามวันด้านขวา ไม่เพิ่ม dashboard หรือแผงรายละเอียดคอลัมน์ที่สาม
แต่ละแถวยังคงกะทัดรัดและแสดง summary, วัน, `made_by` โดยไม่ใส่ป้ายสถานะ
ทั่วไป เช่น “ยังไม่พบว่าถูกแทนที่”, “ถูกแทนที่แล้ว” หรือ “อ้างอิง” ซ้ำทุกแถว
แหล่งอ้างอิงอยู่ในรายละเอียดที่เปิดใต้แถว
รายการสองฝั่งของคู่ที่ยังต้องตรวจหรือยังขัดกันไฮไลต์เฉพาะช่องเวลา (`.event-time`)
เป็นชิปพื้น `--accent` ตัวอักษร `--bg` ไม่ย้อมพื้นหลังทั้งแถว เพราะพื้นหลังแถว
(`--tint`) เป็นสัญญาณของแถวที่เลือกอยู่ ช่องเวลาอยู่คอลัมน์เดียวกันทุกแถว
จึงไล่สายตาหาคู่ได้เร็ว และแถวที่ทั้งขัดกันและถูกเลือกก็ยังเห็นครบสองสถานะ
สีแค่ชี้จุดให้เปิดอ่าน ไม่ตัดสินว่าฝั่งใดถูก หากมีหลายคู่ก็ใช้สีเดียวกัน
โดยไม่เพิ่มรหัสคู่ เส้นเชื่อม แถบแจ้งเตือน หรือกล่องเทียบในหน้า Timeline
เมื่อคู่ได้รับผลตรวจว่าไม่ขัดกัน แก้แล้ว หรือกลายเป็นประวัติที่มีข้อใหม่แทน
ให้เลิกไฮไลต์ทั้งสองรายการ แต่ยังเปิดประวัติและผลตรวจได้ตามปกติ
รายละเอียดเปิดใต้แถวที่เลือกด้วย `Space`/`i` แบบเดิม และแสดงเหตุผลกับ
source link ตามปกติ ชื่อรายการยังบอกข้อกำหนดจริง เช่น “เอา connection สำรองออก”
หรือ “คง connection สำรองไว้” ผู้ใช้จึงอ่านความต่างได้โดยไม่ต้องอ่านป้ายสถานะ
รายการที่มี `supersedes` แสดงความสัมพันธ์ในรายละเอียด ไม่เพิ่มแถวแทรกในลำดับเวลา
ลิงก์ deep link `?topic=<topic-id>&event=<event-id>` ใช้แชร์รายการที่ตรวจ
โดยอ้าง ID แทน title

หน้าเบราว์เซอร์ไม่เขียนไฟล์หรือส่ง POST การตรวจทำใน `#timeline conflicts`
ของ app ซึ่งมีปุ่ม/คีย์เลือก “ยืนยันว่าขัดกัน”,
“ไม่ขัดกัน”, “หลักฐานไม่พอ”, “แก้แล้ว” พร้อมช่องเหตุผลบังคับและ
แหล่งอ้างอิงเสริม; หลังบันทึกต้องเห็นผู้ตรวจและวันตรวจทันที

| คีย์ | ที่ใช้ | การทำงาน |
|---|---|---|
| `j` / `k` | หน้า Timeline / แผ่นตรวจ | เลื่อนรายการ |
| `p` | หน้า Timeline | ไปยังอีกรายการของคู่ |
| `1`–`4` | แผ่นตรวจ | เปิดฟอร์มผลตรวจ: ยืนยันว่าขัดกัน / ไม่ขัดกัน / หลักฐานไม่พอ / แก้แล้ว |
| `n` | แผ่นตรวจ | เลือกสองรายการจากทุกหัวข้อเพื่อเสนอคู่เอง |
| `Cmd/Ctrl+Enter` | แผ่นตรวจ | บันทึกผลตรวจหรือคู่ที่เสนอ |
| `[` / `]` | หน้า Timeline | เปลี่ยนหัวข้อ |
| `Space` / `i` | หน้า Timeline | เปิดเนื้อหา / ข้อมูลการบันทึก |
| `Enter` | ลิงก์ในรายละเอียด | เปิด source ที่เลือก |
| `s` | แผ่นตรวจ | เริ่มสแกนเมื่อเปิดใช้ TypeSafe |
| `Esc` | แผ่นตรวจ | ปิดโดยไม่บันทึก |

ลิงก์และปุ่มจริงใช้ `aria-expanded`/focus ที่ถูกต้อง รายการที่ไฮไลต์มี
`aria-label` บอกว่ามีบันทึกอีกข้อให้คำสั่งต่างกัน เพื่อให้ผู้ใช้ที่มองสีไม่เห็น
รับรู้ได้เช่นกัน ผลตรวจยังต้องอ่านจากหลักฐาน ไม่ใช้สีแทนคำตอบ หน้าเบราว์เซอร์ยังใช้
`textContent` สำหรับข้อความจากไฟล์, fetch ครั้งเดียว, ไม่มี polling/blur
และไม่สร้าง DOM รายละเอียดให้ทุกแถวพร้อมกัน

### เส้นทางข้อมูล

1. `scan_project()` อ่าน event ที่ยืนยันแล้วและ diagnostic; Rust ประกอบ graph
   และผลตรวจล่าสุดจากไฟล์แยกโดยอ้าง event ID
2. `/timeline.json` ส่ง graph, คู่ที่ควรตรวจ และจำนวนให้หน้าอ่านหนึ่งครั้ง
3. ผู้ใช้เปิด `#timeline conflicts` ใน Krypton เพื่อเลือกคู่เอง หรือกด `s`
   ให้ TypeSafe คัดคู่เมื่อเปิด config ไว้
4. Rust ตรวจว่า event ID ทั้งสองอยู่ใน project นี้, เป็นคนละ event, และคู่
   ไม่ซ้ำ; เขียน proposal ใหม่แบบ `create_new`
5. ผู้ใช้เปิดต้นทางสองฝั่งแล้วเลือก verdict พร้อมเหตุผล; Rust เขียน review
   ใหม่แบบ append-only ภายใต้ lock เดิม
6. Refresh หน้าเบราว์เซอร์แล้วเห็นสถานะใหม่จากข้อมูลในเครื่อง

## Edge Cases

- A → B → A ที่มี `supersedes` ครบ: แสดงทั้งสามจุดเป็นประวัติเดียว, 0 คู่ค้าง
- “เอา connection ออก” กับ “เก็บ connection ไว้” ที่ไม่มีลิงก์แทนที่:
  เมื่อคัดพบหรือเลือกเอง ให้เห็นทั้งสองต้นทางและให้คนตรวจ; ระบบไม่ชี้ผู้ชนะ
- คู่ข้ามหัวข้อ: ผูกกับ event ID จึงยังเปิดได้หลัง rename/merge topic
- เนื้อหาซ้ำตรงกันไม่สร้าง proposal; คำแปล/ข้อความใกล้กันที่ TypeSafe จัดว่า
  `compatible_or_duplicate` ไม่เพิ่มยอด แต่ผู้ใช้ยังเปิด event ทุกฉบับได้
- ขาด source, ไม่รู้ผู้ตัดสินใจ, วันที่มีผลไม่ชัด, TypeSafe ปิด/ล้มเหลว,
  หรือ scan ถูกตัดขอบเขต: ขึ้น “ยังสรุปไม่ได้/ยังไม่ได้สแกนครบ” ไม่แสดง 0
  ราวกับตรวจแล้วทั้งหมด
- Proposal/review เสียหรืออ้าง event ที่หาย: แสดง diagnostic; ไม่นับเป็นคู่ปัจจุบัน
- คู่ที่ได้รับ `confirmed` แล้วพบหลักฐานใหม่: คนตรวจเพิ่ม review ใหม่ได้;
  ไฟล์เดิมยังเปิดย้อนดูว่าใครเคยตัดสินอย่างไร
- เขียนซ้ำ/เปิดสอง Harness ของ project เดียว: lock, canonical pair ID และ
  `create_new` ทำให้คู่ไม่ซ้ำ; review เป็นคนละ ID และเรียงตามเวลา+ID
- Pending/dismissed timeline suggestions ไม่เข้ากราฟ; ไม่มีการนำคำเสนอที่
  ยังไม่ยืนยันมาเทียบกับคำตัดสินจริง

## Validation Before Implementation Is Complete

- Rust tests: chain/branch/cycle/missing link, cross-topic pair, merge-topic reuse,
  canonical pair/idempotency, append-only review และ malformed sidecar
- TypeSafe fixture ภาษาไทย/อังกฤษ: change ตามลำดับ, ข้อขัดกัน, duplicate,
  คำแปล, คนละเรื่อง, หลักฐานไม่พอ; วัด false positive และปรับเกณฑ์ก่อนเปิด `suggest`
  — **ยังไม่ได้ทำ**: unit test ครอบ gate/packing แล้ว แต่ยังไม่ได้ยิงชุดตัวอย่างจริงกับ
  System One จึงควรคง `mode = "off"` จนกว่าจะวัดผล
- Browser/UI tests: deep link ไป event, ไฮไลต์สองรายการในคู่ตัวอย่าง,
  keyboard/focus, มือถือ, no-source state, no automatic network call,
  ไม่มี event mutation
- `cargo test --lib`, `cargo clippy --lib -- -D warnings`, `cargo fmt -- --check`,
  `npm run check`, `npm test -- --run`, `npm run build`, และ perf-checklist ของหน้า Timeline

## Open Questions

ไม่มี ขอบเขตนี้ให้การอ่านเส้นทางเป็นแกนหลัก, แยกคำเสนอออกจากผลตรวจของคน,
เก็บประวัติเดิม, และให้การสแกนแบบ semantic เป็นตัวเลือกที่ผู้ใช้เริ่มเอง

## Out of Scope

- เปลี่ยน event เก่า, เดาผู้มีอำนาจจากชื่อผู้เขียน commit, หรือเลือกข้อกำหนด
  ที่ “มีผล” อัตโนมัติ
- สแกนทั้ง repository/อินเทอร์เน็ตหรือ sync หลักฐานจาก GitHub เอง
- เผยแพร่ proposal/review ไป Xenon; Xenon ยังรับเฉพาะ event ที่ยืนยันแล้ว
  ตาม spec 259 การทำ parity ต้องมีสัญญาเผยแพร่และการปกปิดข้อมูลแยกต่างหาก
- นับความขัดกันที่ระบบยังไม่มีข้อมูลพอจะคัดพบว่าเป็นศูนย์

## Resources

- [GitHub issue event types](https://docs.github.com/en/rest/using-the-rest-api/issue-event-types) — actor, เวลา และ cross-reference ของเหตุการณ์
- [Linear issue description history](https://linear.app/docs/editing-issues) — การย้อนดูข้อความเก่าที่เปลี่ยนไป
- [Microsoft decision log](https://microsoft.github.io/code-with-engineering-playbook/design/design-reviews/decision-log/) — การเก็บสถานะ superseded โดยไม่ลบการตัดสินใจเดิม
- [TypeSafe Choice](https://docs.typesafe.ai/primitives/choice) และ [confidence](https://docs.typesafe.ai/confidence) — ขอบเขตของคำตอบแบบมีความน่าจะเป็น
- [WAI-ARIA disclosure pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/) — ปุ่มเปิดรายละเอียดด้วยคีย์บอร์ด
- ภายใน: `docs/253`, `docs/257`, `docs/261`–`264`, `src-tauri/src/timeline.rs`, `src/acp/artifact-timeline.html`
