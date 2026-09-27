# Review Threads Without Worktrees — Implementation Spec

> Status: Implemented in code; native UI smoke pending
> Date: 2026-09-26
> Milestone: M-ACP — Harness review
> Builds on: specs 145, 155, 158, 211, 244, 269 · ADR-0008

## Problem

`#review` ส่งงานให้ reviewer lanes แล้วสรุปลง Review Board ได้ แต่คนอ่านยังไม่มี review ที่ผูกกับงานต้นทางและ diff ชุดเดียวตลอดการตรวจ ไม่มี verdict แบบ Approve หรือ Request Changes และ diff สดอาจเปลี่ยนระหว่างอ่านจน comment ชี้คนละโค้ด

## Solution

เพิ่ม Review thread ที่คนเปิดจาก lane ต้นทางเมื่อพร้อมตรวจ งานแต่ละรอบมี diff snapshot ของตัวเอง, Guide ใน Review Board, comment และประวัติ verdict คนเป็น reviewer ในรอบนี้ ส่วน lane ต้นทางเขียน Guide และรับ verdict ไปแก้โค้ดต่อ ไม่มี reviewer ACP session ใหม่และไม่มี worktree ใหม่ `#review` เดิมยังใช้ขอความเห็นจาก reviewer lanes ได้ตามเดิม

Review thread เป็นบันทึกของแอปที่ผูกกับ ACP session ต้นทาง ไม่ใช่ lane อีกตัวใน roster เริ่มได้จาก action ใน lane head, Command Palette หรือ `#review-thread` ใน composer เปิดหน้าตรวจทันทีในสถานะ “กำลังเตรียม Guide”; เมื่อ Guide พร้อมจึงอ่านได้เต็มหน้า การส่ง verdict บันทึกลงดิสก์ก่อน แล้วส่งให้ lane ต้นทางเมื่อ idle การส่ง verdict ไม่ merge, commit, push หรือแก้ไฟล์เอง

## Research

- Delta เปิด review เป็น conversation ใต้ parent thread; agent ทำ change guide ตามลำดับที่ควรอ่าน, ผู้ใช้ comment และส่ง Approve/Request Changes กลับ parent. Delta ให้ review agent แก้ใน worktree แยกและต้อง Pull Changes เอง พฤติกรรมแก้ไฟล์และ Pull Changes จึงไม่อยู่ในแบบที่ใช้ `cwd` ร่วมกันนี้
- GitHub เก็บ inline comments ไว้ก่อน Submit review แล้วส่ง verdict ทีเดียว; Zed ให้ตรวจ diff และ accept/reject hunks ใน Agent Panel. แบบนี้ยืมการรวบ comment ก่อนส่ง แต่ไม่เพิ่ม hunk staging
- `AcpHarnessView` มี lane transcript, `#review` fan-out ผ่าน `peer_send`, Review Board bundle (`review.md`/`response.md`), response queue และ Diff Window อยู่แล้ว การทำอีกระบบเอกสารหรืออีกช่องส่งคำตอบจะซ้ำกับของเดิม
- `src-tauri/src/git.rs::collect_working_diff(false)` ใช้ `git diff -M` จึงไม่รวม staged changes; `#review` ใช้ diff เทียบ `HEAD` แต่จำกัด payload ที่ 40 KiB. Review thread ต้องมี collector แยกที่เก็บ snapshot เต็ม รวม committed changes จากฐานที่เลือก, staged, unstaged และ untracked
- `DiffContentView` รับ diff โดยไม่มี `refreshProvider` ได้อยู่แล้ว จึงใช้ตัว renderer เดิมอ่าน snapshot แบบคงที่ได้โดยไม่ต้องสร้าง diff renderer ใหม่
- ACP lanes ใน project เดียวกันใช้ `cwd` ร่วมกัน (`docs/72`). เพิ่ม reviewer agent ที่แก้ไฟล์ได้จะเปลี่ยนงานต้นทางทันที; permission mode ที่มีอยู่ไม่ได้เป็น OS sandbox สำหรับทุก backend
- Review Board bundle อยู่ใต้ `.krypton/reviews/` และอาจ auto-push ไป Xenon เมื่อ `[xenon].auto_push` มี `review` (spec 269). Snapshot เต็มและ comment/verdict ภายในจึงต้องเก็บแยกจาก bundle ที่ publisher เก็บไฟล์ทุกชิ้น
- Diff Window refresh ที่ lane quiet point (ADR-0008) เป็นเครื่องมืออ่านงานสด ส่วน verdict ต้องอ้าง snapshot ที่ไม่เปลี่ยน จึงต้องเปิด snapshot diff แบบไม่รับ refresh event

### ทางเลือกที่พิจารณา

| ทางเลือก | ผล |
|---|---|
| เปิด reviewer ACP lane ใหม่ใน `cwd` เดียวกัน | ใกล้ Delta กว่า แต่การห้ามเขียนไฟล์ให้ได้จริงในทุก backend ยังไม่มีขอบเขตที่เชื่อถือได้ |
| ใช้ Diff Window สดแทน snapshot | comment และ Approve อาจอ้างคนละ diff เมื่อ lane อื่นแก้ไฟล์ |
| สร้าง Review Board ชุดใหม่ทั้งหมด | ซ้ำ parser, keyboard flow, archive และ response persistence ที่มีอยู่ |

## Prior Art

| ผลิตภัณฑ์ | วิธีใช้ | สิ่งที่นำมาใช้ |
|---|---|---|
| Delta | Start Review จาก parent thread; change guide, comments, verdict; review agent อยู่ใน worktree แยก | Guide ตามลำดับอ่าน, review หลายรอบและ verdict กลับ parent |
| GitHub Pull Requests | เก็บ line comments ระหว่างอ่าน แล้ว Submit review พร้อม Approve/Request Changes | comment draft กับ verdict เป็นการส่งครั้งเดียว |
| Zed Agent Panel | Review Changes เปิด diff และรับ/ปฏิเสธ hunk ในที่เดียว | เปิด diff จากงาน agent โดยตรงและใช้คีย์บอร์ดได้ |

Krypton ใช้ Review Board ที่มีอยู่และเก็บ snapshot ใน project แทนการเพิ่ม worktree หรือหน้าต่าง browser อีกแห่ง UI ยังคงอยู่ใน ACP Harness และ content window ของ Krypton

## Affected Files

| ไฟล์ | งานหลังอนุมัติ |
|---|---|
| `src-tauri/src/git.rs`, `review_threads.rs`, `commands.rs`, `lib.rs` | เก็บ diff snapshot แบบเต็มจาก base OID ที่เลือก รวม staged/unstaged/untracked; บันทึก private thread และคำสั่ง create/read/check/submit |
| `src-tauri/src/hook_server.rs` | ให้ Start Review ออก Review Board bundle ที่ผูกกับ thread ID โดยใช้ validation/registration เดิม |
| `src/acp/review-thread.ts`, `harness-view-types.ts` | model, session matching, prompt สร้าง Guide และ payload verdict |
| `src/acp/acp-harness-view.ts` | Start Review, parent card/child entry, queue verdict ตาม ACP session ที่ตรงกัน |
| `src/review-board/thread-view.ts`, `view.ts` | ครอบ Review Board เดิมด้วย Guide, snapshot Diff, Comments และ verdict; flush draft และเปิด record เก่า |
| `src/diff-view.ts`, `src/compositor.ts` | อ่าน snapshot แบบไม่ auto-refresh, anchor comment ไปยังบรรทัดใน snapshot |
| `src/view-bus-types.ts` | แจ้งแท็บที่เปิดอยู่เมื่อ Guide พร้อมหรือสร้างไม่สำเร็จ |
| `src/styles/acp-harness.css`, `src/styles/review-board.css` | action/status ของ thread และส่วน Diff/Comments/Verdict ตาม Krypton Dark |
| `docs/04-architecture.md`, `docs/05-data-flow.md`, `docs/211-review-board.md`, `docs/06-configuration.md` | อัปเดตสัญญาที่เปลี่ยนจริง; ไม่เพิ่ม config key |

## Design

### ขอบเขตของ review หนึ่งรอบ

หนึ่ง Review thread อ้าง diff snapshot เดียว เมื่อคนเริ่ม review ใหม่หลังมีการแก้ไข จะได้ thread ใหม่ที่ชี้ `previousThreadId` ไปยังรอบก่อน Guide ของรอบใหม่ระบุสิ่งที่เปลี่ยนจาก snapshot ก่อนเมื่อมีข้อมูลพอให้เทียบ ไม่มี verdict ของรอบเก่าถูกนำมาแสดงว่าอนุมัติงานรอบใหม่

Start Review ใช้ได้เมื่อ parent lane มี ACP session และอยู่ `idle` เท่านั้น ระหว่าง `busy` action แสดง “รอให้ turn จบ” และไม่เก็บ diff กลางทาง หากไม่มี Git repo, ไม่มีการเปลี่ยนแปลง หรือ snapshot เกิน 4 MiB ให้หยุดก่อนสร้าง bundle พร้อมเหตุผลที่แก้ได้ ผู้ใช้เลือก base ใน dialog เล็ก ๆ:

1. upstream tracking ref ที่มีในเครื่อง: ใช้ merge-base กับ `HEAD` เป็นค่าเริ่มต้น
2. `HEAD`: ตรวจ committed changes ที่ยังไม่อยู่ upstream ไม่ได้ แต่เหมาะกับ working changes อย่างเดียว
3. repo ที่ยังไม่มี commit: ใช้ empty tree

ไม่มี fetch เครือข่ายตอนเปิด review Collector ใช้ `git diff <base-oid>` เพื่อรวม committed/staged/unstaged ที่ต่างจาก base, ต่อ untracked text เป็น additions เหมือน collector ปัจจุบัน และบันทึกชื่อไฟล์ binary/ใหญ่/อ่านไม่ได้เป็น `omitted` อย่างชัดเจน เก็บผลสองครั้งติดกัน; ถ้า hash หรือรายการ omitted ต่างกัน ให้ลองใหม่หนึ่งครั้งแล้วแจ้งว่า workspace เปลี่ยนระหว่างเก็บข้อมูล ไม่บันทึก snapshot ที่ไม่ตรงกัน Preview ส่ง fingerprint กลับมา และ `create` ต้องตรวจ fingerprint นี้ซ้ำก่อนบันทึก หากงานเปลี่ยนหลังเปิด dialog ให้ผู้ใช้ดู preview ใหม่

### Data structures และ storage

```ts
type ReviewVerdictKind = 'approve' | 'request_changes';
type ReviewThreadPhase = 'preparing' | 'ready' | 'guide_failed';
interface ReviewLineComment {
  id: string;
  file: string; side: 'old' | 'new';
  lineStart: number; lineEnd: number;
  quote: string; body: string;
}
interface ReviewVerdict {
  id: string; kind: ReviewVerdictKind; summary: string;
  snapshotHash: string; submittedAt: number;
  lineComments: ReviewLineComment[]; boardResponse: ReviewResponse;
  omitted: { path: string; reason: string }[];
  delivery: 'pending' | 'queued' | 'handed_off' | 'uncertain';
  handedOffAt: number | null;
}
interface ReviewThread {
  schemaVersion: 1; id: string; repoRoot: string;
  parentBackendId: string; parentSessionId: string;
  parentLaneName: string; previousThreadId: string | null;
  phase: ReviewThreadPhase;
  reviewId: string | null; reviewSlug: string | null; reviewDir: string | null;
  baseRef: string; baseOid: string; headOid: string | null;
  snapshotHash: string; createdAt: number;
  omitted: { path: string; reason: string }[];
  lineComments: ReviewLineComment[];
  verdicts: ReviewVerdict[];
}
```

`.krypton/review-threads/<id>/thread.json` เก็บ metadata/comment/verdict แบบ atomic replace และ `snapshot.diff` เก็บ diff ที่เปลี่ยนไม่ได้ ทั้ง directory ถูก gitignore แบบ fail closed และตรวจ path/symlink ก่อนอ่านเขียน ส่วน `.krypton/reviews/<slug>/review.md` และ `response.md` ยังเป็น Review Board ตาม spec 211; `reviewSlug` เชื่อมสองฝั่ง ไม่คัดลอก snapshot เต็มไปใน Review Board bundle เพราะ Xenon อาจ publish bundle นั้น

Line comment ผูกกับ path/side/line/quote ของ snapshot ไม่ย้าย anchor ไปหาไฟล์สด หาก Guide เปลี่ยนข้อความ `response.md` ยัง reattach block comments ตาม block ID เดิม Verdict แต่ละครั้งเก็บสำเนา comment และ Board response ณ เวลาที่ส่งไว้กับ ID ใหม่; latest verdict เป็นสถานะที่แสดง แต่รายการเก่ายังอ่านได้

### API และ data flow

```text
review_thread_preview { cwd, base } -> { fingerprint, baseRef, baseOid, files, omitted }
review_thread_create { cwd, harnessId, parentBackendId, parentSessionId,
                       parentLaneName, base, fingerprint }
  -> { threadId, reviewId, reviewSlug, reviewDir, reviewPath, snapshotHash, omitted }
review_thread_reissue_guide { cwd, harnessId, threadId } -> { reviewId, reviewSlug, reviewDir, reviewPath }
review_thread_cancel_guide { cwd, harnessId, laneLabel, threadId, reviewId } -> ()
review_thread_list { cwd } -> ReviewThread[]
review_thread_read { cwd, threadId } -> { thread, diff }
review_thread_save_draft { cwd, threadId, comments } -> ()
review_thread_submit { cwd, threadId, verdict, summary, response, acceptOmitted }
  -> ReviewVerdict
review_thread_mark_delivery { cwd, threadId, verdictId, state } -> ()
review_thread_mark_guide { cwd, threadId, ready } -> ()
review_thread_check { cwd, threadId } -> { stale, currentHash, omitted }
```

คำสั่ง Rust ตรวจ repo root ที่ canonical, base ref ที่ resolve เป็น OID, session ID, ขนาดไฟล์ และ thread path ทุกครั้ง `create` เก็บ snapshot กับ metadata ก่อนออก Review Board pending event หากขั้นใดล้มเหลว ให้เก็บเฉพาะ record ที่สมบูรณ์หรือ rollback directory ใหม่

1. ผู้ใช้เปิด Start Review บน parent lane; dialog แสดง base, จำนวนไฟล์, รายการ omitted และปุ่มยืนยันจาก preview ที่มี fingerprint
2. Rust เก็บ snapshot, สร้าง private thread record และออก Review Board pending bundle ภายใต้ lane ต้นทาง
3. ACP Harness เปิด Review Board แบบ thread mode ทันที พร้อม “กำลังเตรียม Guide”; ส่ง system turn ให้ parent lane อ่าน `snapshot.diff` จาก path ใน prompt, เขียน `review.md` แล้วเรียก `review_register` โดยไม่ยัด diff ทั้งก้อนลง prompt
4. Registered event ที่ผูก review ID กับ thread เปลี่ยน phase เป็น `ready` แล้วส่ง `harness:review-thread-status` ให้แท็บที่เปิดอยู่ refresh; Guide ปรากฏใน Board และ card ใน parent transcript; หาก turn fail ให้คง snapshot เปลี่ยน phase เป็น `guide_failed` และมี Retry Guide
5. คนอ่าน Guide/Review Map, เปิด snapshot Diff, ใส่ line/block comments; draft save ก่อนปิดหน้าต่าง
6. Submit Review flush draft แล้วบันทึก verdict ลง private record ก่อน Frontend เรียก control op `review.thread.deliver` เพื่อเข้า queue เฉพาะ Review thread ของ parent session ที่ตรง ID ข้อมูลผู้ใช้และ code quote ส่งเป็น JSON data หลัง trusted framing
7. เมื่อ parent lane idle queue ส่งหนึ่ง system turn พร้อม verdict ID, summary และ comments; หลัง `dispatchTurn` เริ่ม turn สำเร็จจึงเรียก `review_thread_mark_delivery` เป็น `handed_off` หาก lane ไม่อยู่ ให้คง verdict บนดิสก์และแสดงปุ่ม Send again เมื่อ session เดิมกลับมา

`AcpHarnessView` ใช้ `pendingThreadVerdicts` แยกจาก Review Board response queue เดิม โดยจับคู่ทั้ง backend ID และ session ID: ชื่อ lane เปลี่ยนได้เมื่อ restart ส่วน session ใหม่ใน lane เดิมต้องไม่รับ verdict ของงานเก่า `enqueueSystemPrompt` คืนผลว่าเริ่ม turn จริง สถานะ `handed_off` หมายถึงส่ง turn ให้ client แล้ว ไม่ได้ยืนยันว่า agent อ่านหรือทำตาม หากแอปหยุดหลังเริ่ม dispatch แต่ก่อนบันทึกผล verdict ที่ค้างอยู่ยังอ่านได้ใน private record และผู้ใช้กด Send again เองได้ ไม่มี replay อัตโนมัติ Verdict ID คงเดิมเมื่อ retry เพื่อให้ parent เห็นว่าเป็นรายการเดียว

### UI และ keyboard

- Parent lane head มี action “Start Review”; card “Review #N” ใน transcript เปิด thread เดิมได้; ใน stacked/zen roster แสดงจำนวน review ของ parent โดยไม่ทำ sidebar ใหม่ตามภาพ concept; `Leader Shift+R` picker อ่านทั้ง Review Board เดิมและ Review threads ที่มี private record
- ReviewThreadView ครอบ Review Board เดิม ใช้ Guide เป็นหน้าแรก, `D` เปิด snapshot Diff, `C` เปิด Comments, `V` เปิด Submit Review; `Esc` กลับ Guide ก่อนปิด หน้าปกติของ Review Board และ `#review` เดิมไม่เปลี่ยน keybinding
- ใน snapshot Diff, `c` เขียน line comment บน new/old side, `j`/`k` เดินบรรทัด, `n`/`N` เดิน hunk; หัวหน้าระบุ base OID แบบสั้นและเวลา snapshot ไม่มี live refresh
- `#review-thread` ใน composer และ “Start Review Thread” ใน Command Palette เป็นทางเข้าแบบ keyboard-first; action ใน lane head รองรับ mouse
- Submit Review ให้ตรวจ comments กับ summary ก่อน `Cmd+Enter` ยืนยัน; `Approve` และ `Request Changes` เป็น verdict เดียวต่อการส่งหนึ่งครั้ง `s` ของ Review Board ใน thread mode เปิดหน้า Submit Review เดียวกัน จึงไม่ส่งคำตอบที่ไม่มี verdict
- เมื่อ `review_thread_check` พบ diff ปัจจุบันต่างจาก snapshot แสดง “งานเปลี่ยนหลังเริ่ม review”; `Approve` ต้องเริ่ม thread ใหม่จาก snapshot ล่าสุด ส่วน `Request Changes` ยังส่ง comment ที่อ้าง snapshot เดิมได้พร้อมป้าย stale
- รายการ omitted ไม่ถูกซ่อน; ก่อน Approve ต้องยืนยันว่าตรวจไฟล์เหล่านั้นด้วยวิธีอื่น Verdict บันทึกรายการ omitted ไปด้วย
- รูปแบบใช้ CSS tokens ของ Krypton, ไม่ใช้ `backdrop-filter`, ไม่เพิ่ม left accent rail หรือเส้นขอบเลือก lane ที่เด่นเกินไป

### Configuration

ไม่เพิ่ม TOML key. ถ้า `[xenon].auto_push` มี `review` การ register Guide จะยังทำตาม spec 269; private snapshot/comment/verdict directory ไม่อยู่ในชุดไฟล์ที่ Xenon เก็บ `response.md` ยังต้อง push เองตามสัญญาเดิม

## Edge Cases

- Start Review ระหว่าง parent busy, ไม่มี session, non-Git directory, diff ว่าง หรือ snapshot เกินขนาด: แสดงเหตุผลและไม่สร้าง thread ครึ่งเดียว
- Parent lane ปิด, `#new` หรือ app restart: thread ยังอ่านและแก้ draft ได้; การส่ง verdict รอ session ID เดิมกลับมา ไม่มีการส่งให้ lane ที่บังเอิญได้ชื่อเดิม
- Guide generation fail หรือ agent ไม่เรียก `review_register`: คง snapshot, แสดง Retry Guide; ไม่ให้ Approve ก่อน Guide พร้อม แต่ยังเปิด Diff/Comments ได้
- ไฟล์เปลี่ยนหลังเก็บ snapshot: snapshot viewer และ anchors คงเดิม; ตรวจ stale ก่อน Submit และเมื่อ parent idle; review รอบใหม่สร้าง ID ใหม่
- Upstream ref หายหรือเลื่อนไป: ใช้ base OID ที่เก็บไว้กับ thread; ถ้าเลือก upstream แล้ว resolve ไม่ได้ ให้ใช้ `HEAD` พร้อมป้ายบอก base ที่ใช้จริง
- Snapshot มี binary/large/unreadable file: แสดงรายการ omitted ทั้งใน dialog และ verdict; ไม่มีการรายงานว่ารีวิวครบโดยเงียบ
- Review Board เก่าที่ไม่มี `threadId` เปิดด้วย flow เดิม; `#review` และ review quality matrix ไม่ถูกเปลี่ยนเป็น verdict score

## Verification

- ตรวจอัตโนมัติแล้ว: Rust ครอบคลุม upstream ref ที่เลื่อน, committed/staged/unstaged/untracked, preview ที่เปลี่ยน, snapshot ที่ stale, binary omitted และขนาด 4 MiB; TypeScript ตรวจ session-ID routing กับ prompt; `npm run check`, `npm run build`, targeted Vitest, `cargo test`, `cargo fmt -- --check` และ `cargo clippy` ผ่าน
- ยังไม่ได้ตรวจใน Tauri UI จริง: เปิด review จาก lane, Guide สำเร็จ/ล้มเหลวและ Retry, comment แล้ว Submit, ส่ง Request Changes ถึง parent, ปิด/เปิดแอปแล้วอ่าน record, และ `auto_push=review` กับ private snapshot จึงยังไม่เรียกว่า visual/integration verified

## Open Questions

ไม่มีสำหรับขอบเขตนี้: คนเป็น reviewer; parent lane สร้าง Guide และรับ verdict ส่วน reviewer agent แยกเป็นงานอีกชิ้นหากต้องการ isolation ที่บังคับได้จริง

## Out of Scope

Reviewer ACP session ใหม่, การแก้ source จาก review, Pull Changes, Git merge/commit/push, PR integration, การแทนที่ `#review` multi-reviewer และการทำ Review Board archive ให้แสดง private verdict

## Resources

- [Delta — Reviewing & Syncing Changes](https://delta.dev/docs/agents/review-and-sync) — review thread, change guide, verdict และ Pull Changes
- [GitHub — Reviewing pull requests](https://docs.github.com/en/pull-requests/get-started/reviewing-pull-requests-quickstart) — inline comments กับ Submit review
- [Zed — Agent Panel](https://zed.dev/docs/ai/agent-panel) — diff review และการเปิดงาน agent
- `docs/72-acp-harness-view.md`, `docs/145-harness-design-review-panel.md`, `docs/155-live-working-diff.md`, `docs/158-diff-review-comments.md`, `docs/211-review-board.md`, `docs/269-review-auto-push-xenon.md` — สัญญาใน Krypton ที่ใช้กำหนดขอบเขต
