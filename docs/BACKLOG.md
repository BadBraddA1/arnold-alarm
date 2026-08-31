# Arnold Alarm — backlog

Items parked for later implementation.

## Emergency display takeover (ATEM + Companion)

**Requested:** 2026-08-30  
**Priority:** After emergency SOP is approved and staff-trained.

### Goal

When Code Red / Code Blue fires, campus TVs switch to full-screen emergency slides (not just campus horns).

### On-site hardware

- Blackmagic **ATEM** switcher
- **Bitfocus Companion** server on LAN
- Slide PC (or Pi) on an ATEM HDMI input running a kiosk browser

### Proposed approach

1. **Desk console** — upload slides for Red / Blue / All clear; preview + test.
2. **Display player** — public `/display/` page; Ably-driven by evac phase.
3. **Pi gateway** — on evac phase change, HTTP press to Companion buttons → ATEM Program cut.
4. **Restore** — All clear presses “normal” Companion macro.

### Open questions (fill in before build)

- [ ] ATEM model and which HDMI input is the slide source
- [ ] Companion host IP/hostname (reachable from alarm Pi)
- [ ] Existing Companion page/bank/button numbers for emergency vs. normal
- [ ] Which displays are in scope (lobby only vs. sanctuary + hallways)

### Related docs

- [EMERGENCY-SOP.md](./EMERGENCY-SOP.md) — human response (priority #1)
