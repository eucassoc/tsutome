# tsutome

**ルールから生まれ、証拠で閉じる務め。**

務め（つとめ）は、果たすべきことです。tsutome は、エージェントが仕事をする時代のタスク管理です。
タスクは誰も書きません。ルールが「何のあとに、何を、いつまでに」を定め、記録が「何が起きたか」を
示します。tsutome はこの二つを読んで、いま何が期限か、誰の務めか、期限内に済んだかを出します。
務めはチェックを付けて閉じるのではなく、実際に行われたことが記録に載ると閉じます。

[English](README.md)

- **ルールはファイルです。** 人が読んで確かめられる Markdown で、冒頭に条件、その下に規程の文言を
  書きます。エージェントが下書きを作れますが、人が採用するまで何も生みません。
- **務めは保存せず、計算します。** 採用されたルールも含めて、すべてを一本の追記専用の記録から
  読みます。記録を持つ人は誰でも同じ務めを計算でき、昨日の期限をあとからこっそり変えることは
  できません。
- **決めるのは人、動くのはエージェントです。** ルールの採用、実行の承認、務めの保留は人が行い、
  誰が行ったかが記録に残ります。期限を見に来る、担当に知らせる、実行する、記録するのは
  エージェントの仕事です。
- **記録は [deedlog](https://github.com/eucassoc/deedlog) のチェーンです。** tsutome は追記し、
  `dlog` がチェックポイントに署名し、連署を受け、検証します。記録にあるのは出来事の名前と識別子で、
  個人情報は入れません。

意図して小さく作っています。エージェントを動かすこと、通知を送ること、承認を取ること、仕事をする
システムを呼ぶことは、tsutome の仕事ではありません。すでにある道具を使ってください。

## ルール

```markdown
---
id: delete-after-answer
title: 回答後30日で削除
source: 個人情報取扱規程 第12条 第1項
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
お問い合わせの内容は、回答が完了した日から30日以内に削除する。
```

ある対象に `data.answered` が記録されると、同じ対象の `data.deleted` が30日以内に続かなければ
なりません。7日前に務めが期限に入り、`support` に知らせます。期限を過ぎると `legal` に知らせます。
削除の前に、人が承認します。

| キー | |
|---|---|
| `when`、`expect` | 期限の起点になる出来事と、そのあとに続くべき出来事 |
| `within` | 期限。`30d`、`12h`、`45m` |
| `notice` | 期限のどれだけ前に務めが期限に入るか。省くと最初から |
| `owner`、`escalate` | 動くべき担当と、期限を過ぎたときに知らせる相手。人の名前ではなく役割で書きます |
| `per` | 対象を表すメタ情報のキー。値の組み合わせごとに一つの務めになります。既定は `item`。`device, advisory` と書くと、機器と勧告の組ごとになります |
| `approval` | `required` なら人の承認が先に要り、承認なしの実行は指摘になります。既定は `none` |
| `where` | メタ情報がこの値に一致する出来事だけを起点にします |

## 使い方

Node 20 以上が必要です。

```sh
npm install -g tsutome

tsutome check rules/delete-after-answer.md          # 誤りを行番号つきで示す
tsutome adopt rules/delete-after-answer.md --by legal --name example.com/duties
tsutome record data.answered -m item=q1 -m form=contact --by support
tsutome duties
tsutome agenda                                      # 誰に知らせるか、何が承認待ちか、何を実行できるか
tsutome approve DUTY --by support --plan plan.txt   # 記録には計画のダイジェストが残る
tsutome record data.deleted -m item=q1 --by agent
tsutome audit                                       # 指摘を行番号つきで示す。あれば終了コード1
```

記録は `tsutome.jsonl`、ルールは `rules/` です。`--chain` と `--rules`（`TSUTOME_CHAIN`、
`TSUTOME_RULES`）で変えられます。ほかに状態はなく、サーバーもありません。

務めの状態は次のように移ります。`notice` までは `waiting`、そのあと `due`、期限を過ぎると
`overdue` です。期待する出来事が記録されると `done` か `done_late` になります。人が保留すると
（`tsutome except`）`excepted`、ルールが廃止されると `withdrawn` です。

あとから採用したルールは、すでにあった対象にも当てはまります。その場合、期限は採用の時点から
数えます。ルールのファイルを変えても、もう一度採用するまで何も変わりません。すでに始まっていた
務めは、始まったときの版のままです。

記録に入れる識別子は、推測できないものにします。`--hmac item=Q-0001` と書くと、受付番号の代わりに
`TSUTOME_HMAC_KEY` で計算した HMAC を記録します。

## エージェントから使う

`tsutome-mcp` は、同じ記録とルールを扱う MCP サーバーです。

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

| ツール | |
|---|---|
| `tsutome_draft_rule` | 対話の内容からルールのファイルを書きます。下書きなので、人が `tsutome adopt` で採用します |
| `tsutome_agenda` | いまやるべきこと。定期的に呼ぶ想定です。呼ぶたびに記録するので、見に来なくなったエージェントは記録から分かります |
| `tsutome_duties`、`tsutome_duty`、`tsutome_rules`、`tsutome_audit` | 読み取り |
| `tsutome_told` | 担当に知らせたことを記録します |
| `tsutome_record` | 起点になる出来事や、務めを果たした出来事を記録します |
| `tsutome_request_exception` | 務めの保留を申請します。認めるのは人で、`tsutome except` で行います |
| `tsutome_approve` | 人の承認を記録します。サーバーを `TSUTOME_APPROVER` つきで起動したときだけ使えます。その場合、クライアントの許可の確認がその人の判断になります |

エージェントの側のスケジュール（Claude や ChatGPT のスケジュール実行、cron など）が
`tsutome_agenda` を呼び、担当に知らせ、組織で使っている道具で承認を取り、対象のシステムの道具で
実行して、行ったことを記録します。

## サービスに組み込む

記録をファイル以外の場所（たとえば Worker の保存領域）に置くサービスは、読む側だけを使えます。
`tsutome/core` はファイルも MCP も要りません。記録を行の並びから、ルールを文章から読み、
何が期限かを計算します。記録を書くことと保管することは、サービスの側で行います。

```ts
import { parseChain, parseRule, evaluate, audit, termsToMeta } from 'tsutome/core';

const rule = parseRule(text, 'delete-after-answer.md');       // 条件と、採用が指すダイジェスト
const chain = parseChain(lines);                               // 問題があれば、行を名指しする
const { duties } = evaluate(chain.entries, new Date());        // 記録だけから、何が期限か
const findings = audit(chain.entries, new Date());             // 監査で指摘になること
```

## しないこと

- **門ではありません。** エージェントが承認なしに動くことを、tsutome は止められません。あとから
  示します。`tsutome audit` が、ルールの求める承認なしに行われたことや、承認された計画と違う
  ことを報告します。事前に止めたい場合は、エージェントと道具の間にポリシーの門を置いてください。
- **記録は、報告されたことです。** 仕事をした当事者が書いた記録は、時刻の決まった本人の申告です。
  重要なところでは、エージェント以外のもの（MCP の中継や、システム自身の監査ログ）に記録を書かせ、
  deedlog で連署を受けてください。
- **止まったエージェントの代わりはしません。** 単純な cron で `tsutome agenda` を実行して誰かに
  メールで送るだけでも、もう一つの目になります。

## 記録に入るもの

| 出来事 | 書くもの | |
|---|---|---|
| `rule.adopted`、`rule.retired` | `tsutome adopt`、`retire` | ルールの条件と、ファイルのダイジェスト |
| そのほかの名前 | `tsutome record` | 起点になる出来事と、務めを果たした出来事 |
| `duty.alerted` | `told` | 誰に、どの段階で知らせたか |
| `duty.approved` | `approve` | 誰が承認したか、計画のダイジェスト、承認の証拠への参照 |
| `duty.exception_requested`、`duty.excepted`、`duty.exception_ended` | `except`、`unexcept` | 理由のダイジェスト。文面は入れません |
| `tsutome.looked` | MCP サーバー | エージェントがやるべきことを見に来たこと |

## 関連

[deedlog](https://github.com/eucassoc/deedlog) は、tsutome が読み書きする記録です。
[shinten](https://shinten.dev/) はフォームの入力をどのサーバーでも暗号化したまま保存し、
[kangoh](https://kangoh.com/) は顧客データベースなしで共通ポイントを運営します。
どれも「必要以上に持たない」設計の姉妹プロジェクトです。

## 開発

```sh
npm install
npm test
DLOG=/path/to/dlog npm test     # deedlog が tsutome の書いた記録を検証できることも確かめます
```

## ライセンス

Apache-2.0
