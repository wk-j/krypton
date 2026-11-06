# Harness Live Voice: Hold Left Option to Talk

> Status: Implemented
> Date: 2026-10-20
> Revised: 2026-11-06 — Left Option เปิด microphone เฉพาะเมื่อ active lane คือ lane ที่ผูก live
> Milestone: M-ACP — Harness convergence
> Extends: [280](./0280-harness-live-voice.md) · [302](./0302-harness-component-catalog.md)

## Problem

Live mode เปิด microphone ทันทีและใช้ toggle เพื่อปิด ผู้ใช้ต้องการให้ microphone ปิดตั้งแต่เริ่ม session เปิดเฉพาะตอนกดปุ่มค้าง และปิดทันทีที่ปล่อย

## Solution

ใช้ `Left Option` (`⌥` ซ้าย) เป็น push-to-talk ใน Harness ที่เป็นเจ้าของ live session เฉพาะบน lane ที่ผูก live (lane ที่แสดงแถบ `LIVE`) โดยเริ่ม session แบบ muted เสมอ กดปุ่มเปล่าค้างเพื่อพูด ปล่อยเพื่อปิด microphone โดยไม่จบ session และยังได้ยินเสียงตอบตามเดิม Right Option ยังใช้พิมพ์สัญลักษณ์ตามปกติ

แทนที่ toggle เดิมทั้งหมด ลบ `Cmd+Alt+L` และ `#live mute` คง `Cmd+Shift+L`, `#live [voice]` และ `#live stop` สำหรับเริ่มหรือจบ session

## Research

- ก่อนเปลี่ยน `HarnessLiveVoiceController.start()` ตั้ง `muted: false` และ `connect()` ส่ง audio tracks เข้า peer โดยไม่ปิดก่อน การแก้ต้องครอบคลุมทั้ง state และ `MediaStreamTrack.enabled`
- `enabled = false` ทำให้ audio track ส่ง silence ไม่ต้องหยุด track หรือขอ permission ใหม่ทุกครั้งที่พูด คำว่า microphone ปิดในสเปกนี้หมายถึงไม่ส่งเสียง ไม่ได้รับประกันว่า OS จะดับตัวแสดงการใช้ microphone
- `InputRouter` ส่ง `keydown` ให้เฉพาะ focused content view ใน Normal mode โดย global shortcuts และ summon overlays มีลำดับก่อน ไม่มี `keyup` route สำหรับ content views จึงต้องรับ release แยกจากเส้นทางเริ่มพูด
- `HarnessLiveVoiceHost` มี `element` อยู่แล้ว ใช้ตรวจ focus และยุติการส่งเสียงเมื่อ focus ออกจาก Harness ได้ โดยไม่เพิ่ม host API หรือ backend command
- `altKey` คือ Option บน macOS และสะท้อนสถานะหลังปล่อยปุ่มใน `keyup` แต่ repo เคยพบว่า Option chords เข้าแอปไม่สม่ำเสมอ ต้องตรวจ bare `AltLeft` แยกจาก chords และปิด microphone เมื่อ window blur หรือ document hidden ด้วย
- Live strip มีทั้ง component paint และ controller patch path ต้องปรับทั้งสองจุด และต้องไม่ render transcript ระหว่างเปลี่ยนสถานะ microphone

## Prior Art

| App | Implementation | Notes |
|-----|----------------|-------|
| Discord | Push-to-Talk ส่งเสียงเฉพาะตอนกดปุ่มที่กำหนดค้าง ตั้ง release delay ได้ ส่วน browser ต้องมี focus | ใช้รูปแบบกดค้างเหมือนกัน แต่ Krypton ปิดทันทีโดยไม่มี release delay |
| OMP `/live` | Live voice ผูกกับ session มี phase bar และส่งงานให้ agent ตาม spec 280 | คง delegation และ playback เดิม เปลี่ยนเฉพาะ microphone gate |

ผู้ใช้อนุมัติให้เปลี่ยนจาก Cmd เป็น Option หลังหารือเรื่อง shortcut ซ้อนกัน และขอใช้ Left Option เพราะ keyboard ไม่มีปุ่ม Right Option ไม่เพิ่มหน้า settings หรือ system-wide shortcut

## Affected Files

| File | Change |
|------|--------|
| `src/acp/harness-live-voice-controller.ts` | Muted startup, hold/release gate, focus safety, listener teardown, strip patch |
| `src/acp/acp-harness-view.ts` | ส่ง Left Option press ให้ controller และลบ mute chord เดิม |
| `src/acp/live-voice.ts`, `src/acp/hash-commands.ts` | ลบ mute command และปรับ help ของ `#live` |
| `src/acp/components/live-voice-strip/index.ts` | เปลี่ยน hint เป็น hold/release โดยใช้ markup และ styles เดิม |
| `src/acp/live-voice.test.ts`, `src/acp/components/live-voice-strip/live-voice-strip.test.ts` | ปรับ contract ที่เปลี่ยน ลบ tests ที่ pin wording หรือ markup แทนการเปลี่ยนข้อความที่ pin |
| `src/acp/harness-live-voice-controller.test.ts` (new) | ทดสอบ microphone gate และ async capture boundary ตาม conventions ของ controller tests |
| `docs/0280-harness-live-voice.md`, `docs/0072-acp-harness-view.md`, `docs/0002-functional-requirements.md`, `docs/0004-architecture.md`, `docs/0005-data-flow.md` | แทนที่ default-on และ toggle contract เดิม รวม background behavior |
| `docs/0302-harness-component-catalog.md`, `docs/images/0302-layer6-composer.svg` | ปรับตัวอย่าง live strip ให้ตรงกับ hold-to-talk |
| `src/acp/harness-live-voice-controller.ts`, `src/acp/harness-live-voice-controller.test.ts` (2026-11-06) | Left Option เปิด mic เฉพาะ lane ที่ผูก live, เจ้าของ session ร่วมกันทุก Harness view พร้อม tests |
| `src-tauri/src/live_voice.rs`, `src/acp/live-voice.ts` (2026-11-06) | แก้พร้อมกันตาม contract ของ spec 280 ไม่ใช่ขอบเขตของ spec นี้: supersede ส่ง `live-voice-closed` (`superseded`) ให้ generation เก่า และข้อความ `live replaced by a newer session` |
| `docs/0280-harness-live-voice.md`, `docs/0002-functional-requirements.md`, `docs/0004-architecture.md`, `docs/0005-data-flow.md`, `docs/0072-acp-harness-view.md`, `docs/0206-assistant-response-resources.md`, `docs/0296-open-to-side-split.md` (2026-11-06) | ปรับ contract ของ gate และ session เดียวทั้งแอป |

## Design

### State and API

คง `LiveSession.muted` เป็นสถานะจริงของ microphone เพิ่มสถานะภายใน controller เพื่อจำ Left Option ที่กดค้างและการยกเลิก hold เมื่อใช้ shortcut ไม่มี IPC, config หรือ protocol ใหม่

```ts
// HarnessLiveVoiceController: called only through the focused Harness key route.
handleKeyDown(event: KeyboardEvent): boolean;
// Private, idempotent microphone transition used by press/release/focus handlers.
private setMuted(muted: boolean): void;
```

`handleKeyDown` รับ bare `AltLeft` ที่ไม่ใช่ repeat และไม่มี Shift, Meta หรือ Ctrl เริ่ม hold ได้เฉพาะ session ที่มีอยู่แล้ว และเฉพาะเมื่อ `host.activeLaneId` คือ lane ที่ผูก live ไว้ ซึ่งเป็น lane เดียวที่แสดงแถบ `LIVE` ถ้าเป็น lane อื่น `handleKeyDown` คืน `false` และไม่เริ่ม hold เหมือนกรณีไม่มี session ไม่เปิด microphone เพียงเพราะพบ `altKey: true` บนปุ่มอื่น

### Data Flow

1. เริ่ม session ด้วย `muted: true` ติด release/safety listeners ก่อนรอ `getUserMedia` ปุ่มที่ค้างมาก่อนเริ่ม session ไม่ถือว่าเป็น hold ใหม่
2. เมื่อได้ stream ตั้ง `track.enabled = !session.muted` ก่อน `addTrack` เสมอ ถ้าผู้ใช้กดแล้วปล่อยขณะรอ permission ผล capture ที่มาทีหลังต้องยัง muted
3. Focused Harness ส่ง bare Left Option press ให้ controller ถ้า active lane คือ lane ที่ผูก live จะเปิด audio tracks ทันที ไม่ต้องกด toggle และไม่แทรกข้อความใน composer ถ้าเป็น lane อื่น press นั้นไม่ใช่ hold
4. Window-capture `keyup` ปิด microphone ทันทีเมื่อปล่อย Left Option แม้ overlay หรือ view อื่นรับ keyboard ไปแล้ว ไม่รอ level timer
5. Window-capture `keydown` ใช้ยกเลิก hold เท่านั้น เมื่อกดปุ่มอื่นร่วมกับ Left Option ให้ปิด microphone และอย่าเปิดกลับจนกว่าจะปล่อย Left Option แล้วกดใหม่ listener นี้ไม่ consume event จึงไม่แย่ง shortcut เดิม
6. Window blur, document hidden หรือ focus ออกจาก Harness ปิด microphone และล้าง hold ต้องกดใหม่หลังกลับมา ไม่เปิดเองเมื่อ focus กลับ
7. เปลี่ยน gate แล้ว patch live strip และ reset input meter เป็นศูนย์เมื่อ muted ไม่ render composer หรือ sealed transcript ส่วน playback และ delegation ทำงานต่อ
8. Stop/dispose ถอด listeners ทุกตัวและหยุด media ตาม teardown เดิม session ใหม่เริ่ม muted เสมอ

### Keybindings and UI

| Key | Context | Action |
|-----|---------|--------|
| Hold bare `Left Option` | Live session ใน focused Harness ขณะ active lane คือ lane ที่ผูก live | เปิด microphone ระหว่างกดค้าง |
| Release `Left Option` | Live session | ปิด microphone ทันที |
| `Cmd+Shift+L` | Harness focused | เริ่มหรือจบ live session ตามเดิม |
| `#live [voice]`, `#live stop` | Harness composer | เริ่มหรือจบ session ตามเดิม |

Muted hint: `⌘⇧L stop · hold left ⌥ to talk` ระหว่างพูด: `⌘⇧L stop · release left ⌥ to mute` ใช้สีและ phase classes เดิม ช่วงเชื่อมต่อยังแสดง `connecting` แล้วเปลี่ยนเป็น `muted` หากไม่ได้กดค้าง

## Edge Cases and Tradeoffs

- กด Left Option ซ้ำจาก key repeat ไม่ toggle และไม่เปิดซ้ำหลัง shortcut ยกเลิก hold
- Right Option ไม่เปิด microphone และการกดร่วมกับ Left Option ยกเลิก hold เหมือนปุ่มอื่น
- Cmd shortcuts และ leader ยังทำงานตามเดิม หากใช้ Left Option ร่วมกับปุ่มอื่น microphone อาจเปิดช่วงสั้น ๆ ก่อนกดปุ่มถัดไป ไม่มี delay เพื่อเดาว่าผู้ใช้จะกด shortcut หรือไม่
- Capture ที่มาถึงหลัง stop ต้องหยุด tracks และห้ามเปิดกลับ stale release จาก session เก่าต้องไม่เปลี่ยน session ใหม่
- Left Option บน lane อื่นของ Harness เดียวกันไม่เปิด microphone เพราะ lane นั้นไม่มีแถบ `LIVE` ให้เห็นว่ามี session อยู่ ก่อนแก้ การกด Option ร่วมกับปุ่มอื่นบน lane ใดก็ได้ (เช่น Option+ลูกศร) เปิด microphone ของ session ที่มองไม่เห็นได้ช่วงสั้น ๆ
- เปลี่ยน lane ระหว่างกดค้าง: ถ้าเปลี่ยนด้วย keyboard ปุ่มนั้นยกเลิก hold ตามข้อ 5 ถ้าเปลี่ยนด้วย mouse microphone ยังเปิดจนกว่าจะปล่อย Left Option เพราะผู้ใช้ยังกดค้างเพื่อพูดอยู่ กดครั้งถัดไปบน lane อื่นจะไม่เปิด
- Harness อื่นเปิด live ซ้อนไม่ได้ (spec 280 ใช้เจ้าของ session ร่วมกันทุก controller) และถ้า Rust supersede call ระหว่างที่หน้าเดิมยังทำงาน controller จะได้ `live-voice-closed` (`superseded`) แล้วหยุดและปล่อย microphone ทันที
- Microphone permission ยังขอเมื่อเริ่ม session และปิด session เมื่อไม่ได้รับ permission ตามเดิม

## Verification

- Controller tests ตรวจ track เริ่ม disabled ก่อนเข้า peer, hold → enabled, release → disabled, repeat, shortcut cancellation, blur/hidden/focusout และการปล่อยก่อน capture resolve
- ตรวจ session restart และ teardown ว่า event ของ session เก่าไม่เปิด microphone ใหม่
- รัน `npm run check` และ tests ที่เกี่ยวข้องหลังแก้ครบ
- Smoke บน browser ที่ใช้ controller/component จริง ตรวจ DOM phase และ audio-track state ระหว่าง hold/release พร้อมใช้ native WKWebView ตรวจ Left Option routing และเสียงจริงเมื่อเข้าถึง runtime ได้ รายงานข้อจำกัดแยก ไม่ใช้ browser simulation อ้างว่าได้พิสูจน์ native audio แล้ว

### Initial Right Option Results (2026-10-20, before switching to Left Option)

- `npm run check` ผ่าน
- Focused suites 5 ไฟล์ผ่านทั้งหมด 358 tests ครอบคลุม controller, command grammar, live strip และ Harness view
- Native WKWebView smoke ใช้ `AcpHarnessView.onKeyDown`, controller และ live strip จริง รับ `AltRight` keydown/keyup เป็น trusted native events: เริ่ม track แบบ disabled, กดค้างแล้ว enabled และ phase เป็น `listening`, ปล่อยแล้ว disabled และ phase เป็น `muted` โดย input meter กลับเป็นศูนย์
- Left Option ไม่เปิด microphone การกดปุ่มอื่นร่วมกับ Right Option และ native window เสีย focus ปิด track ตามที่กำหนด ตรวจ live strip จาก native snapshot แล้ว
- Smoke ใช้ audio track ที่สร้างจาก oscillator ในเครื่อง แทน microphone จริง และแทน IPC/WebRTC transport ด้วย local fixtures จึงไม่ได้พิสูจน์ physical microphone, full Tauri app หรือการสนทนากับ voice endpoint จริง

### Left Option Results (2026-10-20)

- ก่อนแก้ Chromium smoke รับ `AltLeft` เป็น trusted event แต่ track ยัง disabled และ phase ยังเป็น `muted`
- หลังแก้ `npm run check` ผ่าน และ focused suites 5 ไฟล์ผ่านทั้งหมด 358 tests โดย controller tests ใช้ Left Option สำหรับ hold/release และตรวจว่า Right Option ไม่เปิด microphone
- Chromium smoke เรียก `AcpHarnessView.onKeyDown`, controller และ live strip จริง: `AltLeft` เปิด track และ phase เป็น `listening`; ปล่อยแล้ว track disabled, phase เป็น `muted` และ input meter เป็นศูนย์
- ตรวจภาพ live strip แล้ว hint เปลี่ยนจาก `hold left ⌥ to talk` เป็น `release left ⌥ to mute` ระหว่างกดค้าง Right Option ไม่เปิด track และการกดปุ่มอื่นร่วมกับ Left Option ปิด track
- Smoke ใช้ audio track จาก oscillator และ local IPC/WebRTC fixtures ไม่ได้ทดสอบ physical microphone, native WKWebView หรือการสนทนากับ voice endpoint จริงในรอบนี้

### Bound-lane Gate Results (2026-11-06)

- ที่มา: `Krypton.log` วันที่ 2026-11-06 มี `live voice call superseded (generation 2 -> 3)` โดยไม่มี `WebContent reload` ระหว่างนั้น แปลว่า Harness อีกตัวเปิด session ซ้อน ส่วน generation 2 ไม่มีบรรทัด `closed` จนปิดแอป ผู้ใช้รายงานว่าเสียง AI ตอบเสียงรอบตัวหลังสั่งหยุด live แล้ว ก่อนแก้ การทดลองด้วย controller จริงสองตัวพบว่า Harness ที่สองเริ่ม session ได้โดยไม่มีคำเตือน Harness แรกไม่ปิด peer และไม่หยุด mic track ส่วน Left Option ใน Harness แรกยังเปิด track ของ call ที่ไม่มีใครเห็นได้
- หลังแก้ `npm run check` ผ่าน, `npx vitest run src/acp` ผ่าน 180 ไฟล์ 2346 tests, `cargo test live_voice` ผ่าน 16 tests และ `cargo fmt --check` ของ `live_voice.rs` ผ่าน ส่วน `cargo clippy --all-targets` เหลือ warning เดิมใน test ของ `timeline.rs` ซึ่งไม่เกี่ยวกับงานนี้
- Controller tests เพิ่ม 3 กรณี: Left Option บน lane อื่นคืน `false` และ track ยัง disabled, Harness ที่สองถูกปฏิเสธโดยไม่เรียก `live_voice_signal` และเริ่มได้หลัง session แรกจบ, และเมื่อได้ `live-voice-closed` (`superseded`) controller หยุด ปิด peer และหยุด track
- Smoke ด้วย `AcpHarnessView` จริงสองตัวใน happy-dom กับ fake ของ Rust slot ที่ส่ง `superseded`: `Cmd+Shift+L` ใน Harness B ขึ้น `live already active on OMP-1` และมี signal แค่ครั้งเดียว Left Option บน lane อื่นของ Harness A ไม่ถูก consume และ mic ยังปิด บน lane ที่ผูก live กดแล้วเปิด ปล่อยแล้วปิด เมื่อ call ถูก supersede Harness A ขึ้น `live: live replaced by a newer session` ปิด peer และหยุด mic track แล้ว Harness B เริ่ม session ได้
- ไม่ได้ทดสอบ native WKWebView, microphone จริง หรือ voice endpoint จริงในรอบนี้ การส่ง `live-voice-closed` ตอน supersede ฝั่ง Rust ผ่าน build, clippy และ unit tests เดิม แต่ยังไม่ได้รันกับแอปจริง


## Open Questions

ไม่มีคำถามค้าง ผู้ใช้ขอใช้ Left Option เพราะ keyboard ไม่มีปุ่ม Right Option

## Out of Scope

On-screen talk button, เลือกปุ่มเอง, toggle microphone, release delay, global shortcut ตอนแอปไม่อยู่ด้านหน้า และการเปลี่ยน backend, voice model, delegation หรือ playback การแจ้ง supersede ฝั่ง Rust ที่แก้วันที่ 2026-11-06 เป็น contract ของ spec 280

## Resources

- [MDN: MediaStreamTrack.enabled](https://developer.mozilla.org/en-US/docs/Web/API/MediaStreamTrack/enabled) อธิบาย disabled track และ silence
- [MDN: KeyboardEvent.altKey](https://developer.mozilla.org/en-US/docs/Web/API/KeyboardEvent/altKey) อธิบาย Option และสถานะหลัง release
- [MDN: keyup event](https://developer.mozilla.org/en-US/docs/Web/API/Element/keyup_event) อธิบาย event target ที่เปลี่ยนตาม focus และ bubbling ถึง Window
- [Discord: Voice Input Modes 101](https://support.discord.com/hc/en-us/articles/211376518-Voice-Input-Modes-101-Push-to-Talk-Voice-Activated) ตัวอย่าง hold-to-talk และข้อจำกัด browser focus
