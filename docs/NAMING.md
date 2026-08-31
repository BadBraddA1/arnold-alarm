# Arnold Alert — naming guide

**Platform name:** **Arnold Alert**  
**Tagline (suggested):** *Campus bells & emergency codes — Arnold Church of Christ*

Use these names in UI, SOP, and staff training. Technical hostnames (`alarm.arnoldcoc.org`, `alarm-gw`) can stay unchanged.

---

## Naming pattern

| Layer | Pattern | Example |
|-------|---------|---------|
| **Staff-facing apps** | Alert + role | Alert Mobile, Alert Desk |
| **Features / panels** | Alert + function | Alert Emergency, Alert Bells |
| **Hardware on campus** | Alert + device | Alert Gateway, Alert Fobs |
| **Emergency codes** | Keep industry terms | Code Red, Code Blue, All clear |
| **Internal / engineering** | unchanged unless migrating | `arnold-alarm` repo, D1, Ably |

---

## The platform

| Current | **Arnold Alert name** | What it is |
|---------|----------------------|------------|
| Arnold Alarm (whole system) | **Arnold Alert** | Bells, codes, PA, fobs, desk — everything |

---

## Apps & consoles

| Current | **Arnold Alert name** | URL / access | Who uses it |
|---------|----------------------|--------------|-------------|
| Mobile app / PWA | **Alert Mobile** | `alarm.arnoldcoc.org` | All staff — panic, bells, fob arm |
| Desktop console | **Alert Desk** | `alarm.arnoldcoc.org/desk/` | Admins — roster, speakers, system |
| Phone home screen label | **Arnold Alert** | Add to Home Screen | Same as Alert Mobile |

**Staff sentence:** *“Open Arnold Alert on your phone; admins use Alert Desk on a computer.”*

---

## Mobile panels (inside Alert Mobile)

| Current | **Arnold Alert name** | Purpose |
|---------|----------------------|---------|
| Emergency codes | **Alert Emergency** | Code Red, Code Blue, All clear |
| Class bells | **Alert Bells** | First bell, second bell, schedule |
| Admin (mobile) | **Alert Control** | Arm/disarm, volumes, speaker check, mobile PIN admin |
| Quick access / home | **Alert Home** | Panel picker after PIN |
| Arm fob | **Alert Fob Link** | Pair + arm physical fob (3h) |

---

## Alert Desk sections

| Current nav label | **Arnold Alert name** | Purpose |
|-------------------|----------------------|---------|
| Overview | **Desk Overview** | Status, quick actions, recent activity |
| Speaker test | **Desk Test** | Speaker check + desk phone notify board |
| Speakers | **Desk Speakers** | Per-horn status + volume profiles |
| Activity | **Desk Activity** | Audit log (who played what, when) |
| Staff PINs | **Desk Staff** | PIN roster, scopes, temp PINs |
| Class bells | **Desk Bells** | Building clock + remote schedule |
| System | **Desk System** | Fobs, arm/disarm, links to mobile |

---

## Emergency codes (keep standard language)

| Name | Meaning | Campus audio |
|------|---------|--------------|
| **Code Red** | Evacuate | Red loop until all clear |
| **Code Blue** | Lockdown | Blue loop until all clear |
| **All clear** | Emergency over | Code Green tone ×2 |

Collectively: **Alert Codes** (the feature), not “evacuate panel” in docs.

**10s arming countdown** on phone: **Alert Countdown** (internal/training term).

---

## Class bells

| Current | **Arnold Alert name** |
|---------|----------------------|
| First bell | **First Bell** |
| Second bell | **Second Bell** |
| Building clock | **Campus Clock** |
| Schedule at building time | **Bell Schedule** |
| Void (cancel pending ring) | **Cancel Bell** |

---

## Campus hardware & services

| Current | **Arnold Alert name** | Notes |
|---------|----------------------|-------|
| Pi gateway (`alarm-gw`) | **Alert Gateway** | On-site audio engine |
| Cloud Worker + D1 | **Alert Cloud** | Staff only — engineering term |
| AI speakers (4 horns) | **Campus Horns** | Lobby, hallways, fellowship — friendly |
| | **Alert Speakers** | Same thing — use in desk UI |
| Physical fobs | **Alert Fobs** | Register in Desk System |
| Fob arm window (3h) | **Fob Arm** | Must arm before fob buttons work |
| UniFi Talk ext 9090 | **Alert Line** | IVR menu — not for emergencies |
| 9090 → press 1 | **Alert Page** | Convenience PA only |
| 9090 → press 2 | **Alert Line Test** | Earpiece test, horns silent |
| 9090 → press 3 | **Alert Line Codes** | PIN emergency from any phone |
| 9090 → press 4 | **Fob Arm** (phone path) | Same as app |
| 9090 → press 5 | **System Arm** | Admin arm/disarm |
| Ext 8080 (direct page) | **Quick Page** | Straight to campus mic |
| Ext 9099 | **SIP Test** | Engineering / softphone check |
| Caller ID “Campus Security” | **Alert Caller ID** | Desk notify before speaker test |
| Speaker check flow | **Alert Check** | Desk notify → tone → TEST ACOC |
| Desk phone notify | **Alert Notify** | Rings desks before horns |

---

## Staff permissions (PIN scopes)

Rename in UI over time; keep internal scope ids for now.

| Scope (internal) | **Arnold Alert name** | Can do |
|------------------|----------------------|--------|
| `bells` | **Bell Ringer** | Alert Bells only |
| `evacuate` | **Code Leader** | Alert Emergency + fobs |
| `admin` | **System Admin** | Alert Desk + Alert Control + arm |
| `remote` | **Remote Operator** | Queue plays off campus (rare) |

**Staff PIN** → **Alert PIN** in user-facing copy.

---

## System states

| Current | **Arnold Alert name** |
|---------|----------------------|
| Armed | **System Armed** — horns will play |
| Unarmed | **System Standby** — commands logged, horns silent |
| Held (unarmed play) | **Queued (standby)** |
| Evac phase: red | **Code Red Active** |
| Evac phase: blue | **Code Blue Active** |
| Evac phase: idle | **No active code** |

*Optional:* “Standby” reads softer than “Unarmed” on a church campus — discuss with leadership.

---

## Future (backlog)

| Planned | **Arnold Alert name** |
|---------|----------------------|
| ATEM + Companion slides | **Alert Display** |
| Full-screen slide player | **Alert Screen** |
| Companion cut macros | **Display Takeover** |

---

## What not to rename

- **Code Red / Code Blue** — staff and first responders know these
- **Domain** `alarm.arnoldcoc.org` — works fine; no need to change DNS
- **Repo** `arnold-alarm` — internal; rename only if you want a big migration
- **Pi hostname** `alarm-gw` — LAN/Tailscale; optional cosmetic change

---

## Quick reference (printable)

```
ARNOLD ALERT — campus safety system

Alert Mobile     phone app (codes, bells, fob)
Alert Desk       admin computer console

Code Red         evacuate
Code Blue        lockdown
All clear        IC only — ends active code

Alert Line       ext 9090 (page & menu — NOT for codes in an emergency;
                 use Alert Mobile or a fob)
Campus Horns     building speakers
Alert Fobs       physical buttons — arm first

System Armed     horns play  |  System Standby  horns silent
```

---

## Approval

Adjust any label before we rename UI copy. Flag items you want different:

- [ ] **Alert Desk** vs **Alert Console**
- [ ] **Alert Control** vs **Alert Admin** (mobile)
- [ ] **System Standby** vs **Unarmed**
- [ ] **Campus Horns** vs **Alert Speakers**
