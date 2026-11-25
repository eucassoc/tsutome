# tsutome

**Duties that arise from rules, and close by evidence.**

Tsutome (務め, "tsu-to-me") is the Japanese word for a duty: what one is
bound to do. This is task management for work done by agents. Nobody writes
the tasks. A rule says what must follow what, and by when; a record says
what happened; tsutome reads the two and tells what is due, whose it is,
and whether it was done in time. A duty is not ticked off: it closes when
the record shows the thing was done.

[日本語](README.ja.md)

- **Rules are files.** A rule is a Markdown file a person can read and
  review: its terms at the top, the words of the policy below. An agent may
  draft one; it gives rise to nothing until a person adopts it.
- **Duties are computed, not stored.** Everything is read from one
  append-only record, the rules as they were adopted included. Anyone
  holding the record computes the same duties, and what was due yesterday
  cannot be quietly changed today.
- **People decide, agents do.** Adopting a rule, approving an action and
  setting a duty aside are a person's, and each is recorded with who did
  it. Looking at what is due, telling the owner, doing the work and
  recording it are an agent's.
- **The record is a [deedlog](https://github.com/eucassoc/deedlog) chain.**
  Tsutome appends to it; `dlog` signs checkpoints, has witnesses cosign
  them and verifies. It holds names of events and identifiers, never
  personal data.

It is small on purpose. It does not run agents, send notifications, ask
for approvals or call the systems where the work is done: use whatever
does those already.

## A rule

```markdown
---
id: delete-after-answer
title: Delete inquiries 30 days after they are answered
source: Personal data policy, article 12.1
when: data.answered
expect: data.deleted
within: 30d
notice: 7d
owner: support
escalate: legal
approval: required
where:
  form: contact
---
Inquiries are deleted within 30 days of the day they are answered.
```

When `data.answered` is recorded for an item, `data.deleted` must follow
for the same item within 30 days. Seven days before, the duty comes up and
`support` is told; if the deadline passes, `legal` is. A person approves
before the deletion.

| Key | |
|---|---|
| `when`, `expect` | The event that starts the clock, and the one that must follow |
| `within` | The deadline: `30d`, `12h`, `45m`, or `3bd` in business days (see [Deadlines in business days](#deadlines-in-business-days)) |
| `notice` | How long before the deadline the duty comes up. Left out: from the start |
| `calendar` | The id of the calendar business days are counted on. Given when `within` is in business days, and only then |
| `owner`, `escalate` | Who must act, and who is told when the deadline has passed. Roles, not people's names |
| `per` | The meta keys that name the thing: one duty per distinct combination. Default `item`; `device, advisory` gives a duty per device and advisory |
| `approval` | `required`: a person approves first, and done without it is a finding. Default `none` |
| `where` | Only triggers whose meta equal these |

## Deadlines in business days

A deadline such as "within three business days of receipt" is written
`within: 3bd`, and names the calendar it is counted on.

```markdown
---
id: handle-inquiry
title: Handle inquiries within three business days of receipt
when: inquiry.received
expect: inquiry.answered
within: 3bd
calendar: jp
owner: support
---
Inquiries are handled within three business days of the day they are received.
```

### How the days are counted

**The day of the trigger is not counted. Business days are counted from
the day after it, and the deadline is the end of the N-th of them:
midnight in the calendar's time zone.** It is the same whether the day of
the trigger is a business day or not.

| Trigger (Tokyo time) | Days counted | Deadline |
|---|---|---|
| Saturday Nov 21, 20:37 (Sunday follows; Monday Nov 23 is a holiday) | Tue 24, Wed 25, Thu 26 | the end of Thursday Nov 26 |
| Friday Nov 13, 17:30 | Mon 16, Tue 17, Wed 18 | the end of Wednesday Nov 18 |
| Monday Dec 28, 10:00 (closed Dec 29 to Jan 1; Jan 2 and 3 are a weekend) | Mon Jan 4, Tue 5, Wed 6 | the end of Wednesday Jan 6 |

What happens on a closed day comes out as if it had happened at the start
of the next business day.

The deadline is not "the same time of day, three business days later",
for three reasons.

- "Within three business days" speaks of days and says nothing of a time
  of day. With the end of the day as the deadline it reads as written:
  done on or before the third business day. Leaving out the first day of
  a period is also how Japanese civil law counts one (Civil Code,
  article 140).
- Carrying the time of day over needs a second rule for what happens on a
  closed day, and there is no good account of why something received at
  20:37 on a Saturday falls due at 20:37 on a Thursday.
- Everything received on one day falls due on one day. The owner and the
  auditor can check it against a calendar on the wall.

The price is that what arrives in the morning has more hours than what
arrives in the evening. Both have N whole business days.

`notice` can be in business days too: with `notice: 1bd` the duty comes
up when the last business day begins. Written as `12h`, it is that long
before the deadline. Left out, the duty comes up from the start, as
before.

### The calendar

Which days are closed cannot be computed. Holidays move by law, and an
office has closed days of its own. So the calendar is data from outside,
and if it could be swapped afterwards to move a deadline, the promise
that anyone holding the chain computes the same duties, and that what was
due yesterday cannot be quietly changed today, would not hold. Tsutome
treats a calendar as it treats a rule.

```markdown
---
id: jp
title: Holidays in Japan and the days the office is closed
source: Cabinet Office, "National holidays"
timezone: +09:00
weekend: sat, sun
from: 2026-01-01
until: 2027-12-31
---
2026-01-01 New Year's Day
2026-01-12 Coming of Age Day
2026-12-29 closed over the New Year
```

- **A calendar is a file, and a person adopts it**:
  `tsutome adopt-calendar calendars/jp.md --by manager`. Nothing changes
  until then. No tool an agent can call adopts a calendar.
- **An adoption puts every day of the calendar in the chain**
  (`tsutome.calendar_adopted`: the closed days, the weekend, the time
  zone, the days it covers, and the digest of the file). The chain alone
  is enough to count business days; the file need not be kept with it.
  What the file calls each day ("New Year's Day") stays out of the chain.
- **A duty under way keeps the version of the calendar it started
  under.** Adopting a changed calendar makes a new version, and only
  duties that start after it are counted by it. Each duty says which
  calendar, which version and which digest it was counted by (`counted`).
- **The time zone is a fixed offset from UTC**, `+09:00` for Japan. A
  zone by name, such as `Asia/Tokyo`, is refused: the table that turns a
  name into an offset differs between machines and changes over the
  years, and two readers of one chain would find different midnights.
  Where clocks change with the seasons, one of the two offsets has to be
  chosen.
- **Days beyond the calendar are counted by the weekend alone, and the
  duty says so.** Outside `from` to `until` the holidays are not known.
  Refusing to read would lose every duty for the sake of one, and
  counting silently would hide the error, so the duty carries
  `beyondCalendar` and `tsutome audit` reports it as `beyond_calendar`.
  Adopting next year's calendar afterwards does not move that deadline
  (the duty keeps the version it started under); a person who has checked
  it can set the duty aside (`tsutome except`), which ends the finding.
  Adopt a calendar that covers the next year before the year turns.
- **A rule in business days cannot be adopted before its calendar.** If
  a service that writes its own records puts such a rule in the chain,
  its triggers give rise to no duty and are reported as `no_calendar`.
  Once the calendar is adopted, they are counted by its first version,
  from the trigger.

Where a deadline is shown, it says that it was counted in business days:

```
51bd925b4465  due        due 2026-11-26T15:00:00Z (the end of 2026-11-26 +09:00, 3 business days by calendar jp version 1)  support  handle-inquiry: inquiry.answered for item …
```

`examples/calendars/jp.md` holds the holidays of Japan for 2026 and 2027
as an example. Before adopting it, check it against the government's
announcement and add the days your office is closed.

A chain written by 0.1 gives the same duties as before: what a rule in
`d`, `h` or `m` puts in the chain has not changed. The other way round,
tsutome 0.1 reading a chain that holds a rule in business days does not
compute a different deadline; it stops with `"3bd" is not a duration`.
Bring everything that reads the chain to 0.2 or later before adopting
such a rule.

## Use

Node 20 or later.

```sh
npm install -g tsutome

tsutome check rules/delete-after-answer.md          # what is wrong, by line
tsutome adopt rules/delete-after-answer.md --by legal --name example.com/duties
tsutome check-calendar calendars/jp.md              # for deadlines in business days: a calendar is checked the same way,
tsutome adopt-calendar calendars/jp.md --by manager # and adopted before a rule that names it
tsutome record data.answered -m item=q1 -m form=contact --by support
tsutome duties
tsutome agenda                                      # whom to tell, what waits for approval, what can be done
tsutome approve DUTY --by support --plan plan.txt   # the chain keeps the plan's digest
tsutome record data.deleted -m item=q1 --by agent
tsutome audit                                       # findings, each with its line; exit 1 if any
```

The chain is `tsutome.jsonl`, the rules are in `rules/` and the calendars
in `calendars/` next to them, or as `--chain`, `--rules` and `--calendars`
(`TSUTOME_CHAIN`, `TSUTOME_RULES`, `TSUTOME_CALENDARS`) say. There is
no other state, and no server.

A duty is `waiting` until its notice, then `due`, then `overdue`; `done`
or `done_late` once the expected event is recorded; `excepted` when a
person set it aside (`tsutome except`); `withdrawn` when its rule was
retired.

A rule adopted later covers what was already there, with the clock
starting at the adoption. A changed rule file changes nothing until it is
adopted again, and what was under way keeps the version it started under.

Identifiers in the chain should not be guessable. `--hmac item=Q-0001`
records an HMAC of the reference under `TSUTOME_HMAC_KEY` in its place.

## With an agent

`tsutome-mcp` is an MCP server over the same chain and rules.

```json
{
  "mcpServers": {
    "tsutome": {
      "command": "tsutome-mcp",
      "env": { "TSUTOME_CHAIN": "tsutome.jsonl", "TSUTOME_RULES": "rules", "TSUTOME_ACTOR": "agent" }
    }
  }
}
```

| Tool | |
|---|---|
| `tsutome_draft_rule` | Writes a rule file from a conversation. A draft: a person adopts it with `tsutome adopt` |
| `tsutome_agenda` | What there is to do now. Meant to be called on a schedule; each call is noted, so that an agent that stops looking shows |
| `tsutome_duties`, `tsutome_duty`, `tsutome_rules`, `tsutome_calendars`, `tsutome_audit` | Reading |
| `tsutome_told` | Records that the owner was told |
| `tsutome_record` | Records a trigger, or the event that meets a duty |
| `tsutome_request_exception` | Asks that a duty be set aside. A person grants it with `tsutome except` |
| `tsutome_approve` | Records a person's approval. Only when the server was started with `TSUTOME_APPROVER`; the client's permission prompt is then that person's decision |

A schedule of the agent's own (a scheduled task in Claude or ChatGPT, a
cron job) calls `tsutome_agenda`, tells the owners, takes approvals through
whatever the organization uses, does the work with the tools of the
systems concerned, and records what it did.

## In a service

A service that keeps its chain somewhere other than a file, such as a
Worker with its own storage, can use the reading half alone. `tsutome/core`
needs no files and no MCP: it reads a chain from its lines and a rule from
its text, and works out what is due. Writing the records, and keeping
them, is the service's own.

```ts
import { parseChain, parseRule, parseCalendar, evaluate, audit, termsToMeta, calendarToMeta, CALENDAR_ADOPTED } from 'tsutome/core';

const rule = parseRule(text, 'delete-after-answer.md');       // the terms and the digest an adoption commits to
const chain = parseChain(lines);                               // every problem names its line
const { duties } = evaluate(chain.entries, new Date());        // what is due, from the chain alone
const findings = audit(chain.entries, new Date());             // what an auditor would point at

// For deadlines in business days, the service writes this record when a person adopts a calendar.
const cal = parseCalendar(calendarText, 'jp.md');
const meta = calendarToMeta(cal.terms, cal.digest, 'manager'); // the meta of an event named CALENDAR_ADOPTED
```

## What it does not do

- **It is not a gate.** It cannot stop an agent from acting without
  approval. It shows it afterwards: `tsutome audit` reports what was done
  without the approval its rule requires, or differently from the plan
  that was approved. To prevent it, put a policy gate between the agent
  and its tools.
- **What is recorded is what was reported.** A record made by the party
  that did the work is its own statement, fixed in time. Where it matters,
  have the record written by something other than the agent (an MCP proxy,
  the system's own audit log), and have the chain witnessed with deedlog.
- **An agent that stops is not replaced.** `tsutome agenda` from a plain
  cron job, mailed to someone, is a cheap second look.

## What goes in the chain

| Event | Written by | |
|---|---|---|
| `rule.adopted`, `rule.retired` | `tsutome adopt`, `retire` | The rule's terms and the digest of its file |
| `tsutome.calendar_adopted` | `tsutome adopt-calendar` | Every day of the calendar, its time zone, the days it covers, and the digest of its file |
| any other name | `tsutome record` | Triggers and the events that meet duties |
| `duty.alerted` | `told` | Who was told, at which stage |
| `duty.approved` | `approve` | Who approved, the digest of the plan, a pointer to the evidence |
| `duty.exception_requested`, `duty.excepted`, `duty.exception_ended` | `except`, `unexcept` | The reason's digest, never its words |
| `tsutome.looked` | the MCP server | That an agent looked at the agenda |

## Related

[deedlog](https://github.com/eucassoc/deedlog) is the record tsutome reads
and writes. [shinten](https://shinten.dev/en/) keeps form input encrypted
on every server, and [kangoh](https://kangoh.com/en/) runs shared reward
points with no customer database: sister projects built on holding
nothing more than is needed.

## Development

```sh
npm install
npm test
DLOG=/path/to/dlog npm test     # also checks that deedlog verifies a chain tsutome wrote
```

## License

Apache-2.0
