# Arnold Church of Christ — Emergency Response SOP

**Status:** Draft — leadership review required  
**Live site:** https://emergency.arnoldcoc.org (source of truth — clone [arnold-emergency](https://github.com/BadBraddA1/arnold-emergency))  
**System:** Arnold Alert (`alarm.arnoldcoc.org`) — campus audio + staff triggers  
**Related (future):** ATEM / Companion display takeover — see [`BACKLOG.md`](./BACKLOG.md)

This file is a **mirror** for engineers working in the alarm repo. Edit procedures on GitHub in **arnold-emergency**; this copy may lag until synced.

---

## 1. Purpose

- Give staff a single, agreed-upon response when Code Red or Code Blue is declared.
- Clarify authority: who may declare, who may call all clear, who leads movement vs. shelter-in-place.
- Align human action with what the alarm system does (and does not do).

**The alarm system announces the code on campus speakers. It does not replace 911, leadership judgment, or room-by-room accountability.**

---

## 2. Code definitions

| Code | Meaning at Arnold | Campus audio | Typical human response |
|------|-------------------|--------------|------------------------|
| **Code Red** | **Evacuate** — leave the building / move to designated assembly | `Code_Red_Full_Master` loops until all clear | Exit routes, head count, reunification |
| **Code Blue** | **Lockdown** — shelter in place, secure rooms | `Code_Blue_Master` loops until all clear | Lock doors, lights out, silence phones, await instructions |
| **All clear** | Emergency over — return to normal | Code Green tone ×2 (not a “Code Green” button) | Stand down; debrief as needed |

Only **one** code (Red or Blue) may be active at a time. **All clear** is only available after a code has been issued.

---

## 3. Roles and responsibilities

Fill in names and backups. Review quarterly.

### 3.1 Incident commander (primary authority on site)

| Field | Assignment |
|-------|------------|
| **Primary** | _[e.g. Lead elder on duty]_ |
| **Backup** | _[e.g. Second elder / designated security lead]_ |
| **May declare Code Red/Blue** | ☐ Yes — via app, fob, or authorized delegate |
| **May call All clear** | ☐ Yes — only after threat is resolved and areas are checked |

**Responsibilities:**

- Decide Red vs. Blue based on the situation (fire/smoke/gas → usually Red; active threat inside → usually Blue).
- Ensure **911 is called** when life safety requires it (the alarm does not dial 911).
- Assign someone to **account for children / nursery / classrooms** immediately.
- Authorize **All clear** — no one else should clear the code without IC approval unless IC is unavailable and backup assumes command (document in post-incident review).

### 3.2 Security / facilities lead

| Field | Assignment |
|-------|------------|
| **Primary** | _[name]_ |
| **Backup** | _[name]_ |

**Responsibilities:**

- Know alarm app, fob carry procedure, and desk console basics.
- Confirm system is **armed** before services/events (default: armed).
- After a code: help verify building zones before all clear.
- Run **monthly speaker check** (desk notify → horns) when building is empty — see README.

### 3.3 Nursery / children’s ministry lead

| Field | Assignment |
|-------|------------|
| **Primary** | _[name]_ |
| **Backup** | _[name]_ |

**Responsibilities:**

- **Code Red:** evacuate children per written nursery evacuation plan; bring roster; reunify only with authorized guardians.
- **Code Blue:** lock nursery suite; silence; keep children calm; do not open for unknown persons until all clear.

### 3.4 Worship / teaching lead (pulpit)

| Field | Assignment |
|-------|------------|
| **Primary** | _[name]_ |

**Responsibilities:**

- On hearing campus code: **stop service**, give brief calm direction matching active code (evacuate vs. lockdown).
- Do **not** contradict the code type (if Blue is playing, do not tell everyone to exit unless IC overrides).
- Defer to incident commander for all clear.

### 3.5 Office / front desk

| Field | Assignment |
|-------|------------|
| **Primary** | _[name]_ |

**Responsibilities:**

- Monitor phones; **call 911** if not already done.
- **Do not use ext 9090 (PA)** for lockdown or evacuate — PA is convenience paging only.
- Desk phones may ring before speaker check horns; press **0** to delay horns during tests only.

### 3.6 All staff (general)

- Have **Arnold Alarm** on phone home screen (`alarm.arnoldcoc.org` → Share → Add to Home Screen).
- Know your PIN scope (bells only / evacuation / admin).
- If carrying a **fob:** arm it when you take it (`Arm fob` in app, or 9090 → 4 → PIN). Fobs do nothing when unarmed.
- Report to your area lead; do not independently call all clear unless you are the designated IC/backup.

---

## 4. Who may trigger a code (technical)

| Method | Who | Notes |
|--------|-----|-------|
| **Phone app** — Code Red / Blue | Staff with **Evacuation** or **Admin** PIN | 10s arming countdown on phone; campus silent until Send |
| **Physical fob** — buttons 1 Red, 2 Blue, 4 All clear | Staff who **armed** that fob (3h window) | Activity log shows who had fob armed |
| **9090 IVR** → 3 → PIN | Staff with evacuation PIN | Same codes as app |
| **Desk console** | **Admin** PIN only | Management, not primary panic path |

**Remote play** (cellular, off campus): only staff with explicit **Remote** scope — grant sparingly.

**Class bells** (first/second bell): separate scope — not for emergencies.

---

## 5. Response procedures

### 5.1 Code Red — Evacuate

**When to use:** Fire, smoke, gas, structural hazard, or IC orders full building evacuation.

1. **Trigger** Code Red (app, fob, or IC delegate).
2. **Call 911** if not already in progress.
3. **Incident commander** directs assembly area(s): _[document locations — e.g. south parking lot, far corner from building]_.
4. **Area leads** sweep assigned zones if safe to do so; report missing persons to IC.
5. **Nursery / classes** follow their evacuation routes; bring rosters.
6. **No re-entry** until IC authorizes, after fire/official clearance as applicable.
7. **All clear** only when IC confirms — triggers Code Green on speakers.

### 5.2 Code Blue — Lockdown

**When to use:** Threat inside building, violent person, or IC orders shelter-in-place.

1. **Trigger** Code Blue.
2. **Call 911** if not already in progress.
3. **Everyone:** behind locked doors if possible; lights off; phones silent; away from windows/doors.
4. **Do not** gather in lobby or open areas. **Do not** evacuate unless IC or law enforcement directs (some scenarios switch Red after Blue).
5. **Nursery:** lock suite; adults between children and door.
6. **Pulpit / lobby:** stop movement; short calm instruction only.
7. **All clear** only when IC confirms with law enforcement / internal sweep as needed.

### 5.3 Switching Red ↔ Blue

Only **incident commander** (or backup) should change code type mid-incident. The system blocks conflicting codes until all clear.

If situation changes (e.g. lockdown → ordered evacuation): IC calls **All clear**, then issues the new code — or delegates someone with evacuation PIN to do so.

### 5.4 All clear

1. **Only IC or backup** authorizes.
2. Authorized person taps **Stop & All clear** in app or fob button 4 (when armed).
3. Brief staff announcement: normal operations resume; counseling / debrief as needed.

---

## 6. System arm / disarm (not the same as codes)

| State | Meaning |
|-------|---------|
| **Armed** | Bells and emergency audio **play** on campus (normal default). |
| **Unarmed** | Commands are **logged but held** — speakers stay silent until an admin arms again. |

**Who may arm/disarm:** Admin PIN holders — app Admin panel, desk console, or 9090 → 5 → admin PIN.

**Use unarmed for:** maintenance, empty-building work, false-alarm prevention during AV tests.  
**Do not** leave unarmed during public gatherings without explicit reason.

---

## 7. What the system does *not* do

- Does **not** call 911 or text parents automatically.
- Does **not** lock doors (access control is separate).
- Does **not** show slides on TVs yet (planned — ATEM + Companion; see backlog).
- **9090 / 9099** are **not** emergency triggers — paging and SIP test only.

---

## 8. Communication checklist

During an incident, IC should ensure:

- [ ] 911 called (if required)
- [ ] Code type matches situation (Red vs. Blue)
- [ ] Nursery / children accounted for
- [ ] Assembly or lockdown areas communicated
- [ ] One person on official communication with first responders
- [ ] All clear authorized only by IC/backup
- [ ] Post-incident debrief scheduled within 72 hours

**External messaging** (congregation text, social media): only _[designated spokesperson]_ — _[name]_.

---

## 9. Training and drills

| Activity | Frequency | Owner |
|----------|-----------|-------|
| Staff read this SOP | On hire + annually | _[HR / ministry lead]_ |
| Tabletop (Red vs. Blue scenarios) | Quarterly | _[Security lead]_ |
| Silent drill (no horns) | _[optional]_ | _[IC]_ |
| Live Code Blue + all clear (empty building) | Annually | _[Security lead]_ |
| Speaker walk + bell test | When building empty after changes | _[Facilities]_ |
| PIN / fob access audit | Quarterly | _[Admin PIN holder]_ |

---

## 10. Post-incident

Within **72 hours:**

1. Short debrief: timeline, what worked, gaps.
2. Review **Activity log** in desk console (`alarm.arnoldcoc.org/desk/` → Activity).
3. Update this SOP if roles or assembly points changed.
4. File any insurance / incident reports per church policy.

---

## 11. Quick reference card

```
CODE RED  = EVACUATE     → leave building → assembly: _______________
CODE BLUE = LOCKDOWN     → secure room, lights off, quiet
ALL CLEAR = IC only      → Stop & All clear in app / fob button 4

911 first when life is at risk.
Do NOT use phone PA (9090) for codes.
App: alarm.arnoldcoc.org
```

---

## 12. Approval

| Role | Name | Signature | Date |
|------|------|-----------|------|
| Elders / leadership | | | |
| Security / facilities | | | |
| Children’s ministry | | | |

---

*Technical reference: [README](../README.md) · Fobs: [FOB-NOTES.md](./FOB-NOTES.md)*
