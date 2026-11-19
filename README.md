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
| `within` | The deadline: `30d`, `12h`, `45m` |
| `notice` | How long before the deadline the duty comes up. Left out: from the start |
| `owner`, `escalate` | Who must act, and who is told when the deadline has passed. Roles, not people's names |
| `per` | The meta keys that name the thing: one duty per distinct combination. Default `item`; `device, advisory` gives a duty per device and advisory |
| `approval` | `required`: a person approves first, and done without it is a finding. Default `none` |
| `where` | Only triggers whose meta equal these |

## Use

Node 20 or later.

```sh
npm install -g tsutome

tsutome check rules/delete-after-answer.md          # what is wrong, by line
tsutome adopt rules/delete-after-answer.md --by legal --name example.com/duties
tsutome record data.answered -m item=q1 -m form=contact --by support
tsutome duties
tsutome agenda                                      # whom to tell, what waits for approval, what can be done
tsutome approve DUTY --by support --plan plan.txt   # the chain keeps the plan's digest
tsutome record data.deleted -m item=q1 --by agent
tsutome audit                                       # findings, each with its line; exit 1 if any
```

The chain is `tsutome.jsonl` and the rules are in `rules/`, or as
`--chain` and `--rules` (`TSUTOME_CHAIN`, `TSUTOME_RULES`) say. There is
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
| `tsutome_duties`, `tsutome_duty`, `tsutome_rules`, `tsutome_audit` | Reading |
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
import { parseChain, parseRule, evaluate, audit, termsToMeta } from 'tsutome/core';

const rule = parseRule(text, 'delete-after-answer.md');       // the terms and the digest an adoption commits to
const chain = parseChain(lines);                               // every problem names its line
const { duties } = evaluate(chain.entries, new Date());        // what is due, from the chain alone
const findings = audit(chain.entries, new Date());             // what an auditor would point at
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
