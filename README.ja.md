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
| `within` | 期限。`30d`、`12h`、`45m`。営業日で数えるなら `3bd`（[営業日の期限](#営業日の期限)） |
| `notice` | 期限のどれだけ前に務めが期限に入るか。省くと最初から |
| `calendar` | 営業日を数える暦の id。`within` が営業日のときだけ書き、そのときは必ず書きます |
| `owner`、`escalate` | 動くべき担当と、期限を過ぎたときに知らせる相手。人の名前ではなく役割で書きます |
| `per` | 対象を表すメタ情報のキー。値の組み合わせごとに一つの務めになります。既定は `item`。`device, advisory` と書くと、機器と勧告の組ごとになります |
| `approval` | `required` なら人の承認が先に要り、承認なしの実行は指摘になります。既定は `none` |
| `where` | メタ情報がこの値に一致する出来事だけを起点にします |

## 営業日の期限

「受付から3営業日以内」のような期限は、`within: 3bd` と書き、数える暦を名指しします。

```markdown
---
id: handle-inquiry
title: 受付から3営業日以内に対応する
when: inquiry.received
expect: inquiry.answered
within: 3bd
calendar: jp
owner: support
---
お問い合わせは、受け付けた日から3営業日以内に対応する。
```

### 数え方

**起点の日は数えません。その翌日から営業日を数え、N 個目の営業日が終わる時刻（暦のタイムゾーンで
24時）が期限です。** 起点の日が営業日でも休みでも同じです。

| 起点（日本時間） | 数える日 | 期限 |
|---|---|---|
| 土曜 11/21 20:37（翌日は日曜、月曜 11/23 は祝日） | 火 11/24、水 11/25、木 11/26 | 木曜 11/26 の終わり |
| 金曜 11/13 17:30 | 月 11/16、火 11/17、水 11/18 | 水曜 11/18 の終わり |
| 月曜 12/28 10:00（12/29〜1/1 は休業、1/2・1/3 は土日） | 月 1/4、火 1/5、水 1/6 | 水曜 1/6 の終わり |

休みの日に起きたことは、次の営業日の始まりから数えたのと同じ結果になります。

「3営業日後の同じ時刻」にはしていません。理由は三つです。

- 規程の「3営業日以内」は日を単位にした言葉で、時刻の決まりを含みません。日の終わりを期限にすれば、
  「3つ目の営業日のうちに済ませる」とそのまま読めます。期間の初日を数えないのは、日本の民法
  （第140条）の数え方とも同じです。
- 同じ時刻にすると、休みの日に起きたものの時刻をどう扱うかを別に決めなければなりません（土曜の
  20:37 に受け付けたものの期限が木曜の 20:37 になる理由を、説明できません）。
- 同じ日に受け付けたものは、同じ日に期限が来ます。担当も監査する人も、暦を見れば確かめられます。

その分、朝に受け付けたものは、夕方に受け付けたものより長い時間が与えられます。どちらも、
まるごとの営業日が N 日あることは変わりません。

`notice` も営業日で書けます。`notice: 1bd` なら、最後の営業日が始まる時刻に務めが期限に入ります。
`12h` のように書けば、期限のその時間だけ前です。省くと、これまでと同じく最初からです。

### 暦

どの日が休みかは、計算では決まりません。祝日は法律で動き、会社には会社の休業日があります。
そこで暦は外から与えるデータになりますが、あとから暦を差し替えて期限を動かせると、「記録を持つ人は
誰でも同じ務めを計算でき、昨日の期限をこっそり変えられない」という約束が破れます。tsutome は
暦をルールと同じに扱います。

```markdown
---
id: jp
title: 日本の祝日と会社の休業日
source: 内閣府「国民の祝日について」
timezone: +09:00
weekend: sat, sun
from: 2026-01-01
until: 2027-12-31
---
2026-01-01 元日
2026-01-12 成人の日
2026-12-29 年末休業
```

- **暦はファイルで、人が採用します。** `tsutome adopt-calendar calendars/jp.md --by manager`。
  採用するまで何も変わりません。エージェントが使える道具に、暦を採用するものはありません。
- **採用すると、暦のすべての日が記録に入ります**（`tsutome.calendar_adopted`。休みの日、週の休み、
  タイムゾーン、対象の期間、ファイルのダイジェスト）。記録だけで営業日を数えられ、暦のファイルを
  別に持っている必要はありません。日に付けた名前（「元日」など）は記録に入りません。
- **始まっている務めは、始まったときの版の暦のままです。** 暦を採用し直すと新しい版になり、
  そのあとに始まる務めだけが新しい版で数えられます。務めには、どの暦のどの版で数えたかと、
  その版のダイジェストが付きます（`counted`）。
- **タイムゾーンは UTC からの固定の差で書きます**（日本時間は `+09:00`）。`Asia/Tokyo` のような
  名前は受け付けません。名前から時差を引く表は計算機ごとに違い、年とともに変わるので、同じ記録から
  違う日付の境目が出てしまうからです。夏時間のある地域では、どちらかの時差を選ぶことになります。
- **暦が及ばない先の日は、週の休みだけで数え、そう数えたことを示します。** `from` から `until` の
  外にある日は、祝日が分かりません。エラーにすると一つの務めのために全部が読めなくなり、黙って数えると
  誤りに気づけないので、務めに `beyondCalendar` を付け、`tsutome audit` が `beyond_calendar` として
  指摘します。先の年の暦を採用しても、その務めの期限は動きません（始まったときの版のまま）。
  人が確かめて保留する（`tsutome except`）と、指摘は消えます。年が変わる前に、翌年を含む暦を
  採用してください。
- **暦が採用されていない営業日のルールは、採用できません。** 記録を自分で書くサービスがそういう
  ルールを記録に入れた場合、起点になる出来事は務めを生まず、`no_calendar` として指摘されます。
  暦が採用されると、その最初の版で、起点の時点から数えます。

期限の表示には、営業日で数えたことが出ます。

```
51bd925b4465  due        due 2026-11-26T15:00:00Z (the end of 2026-11-26 +09:00, 3 business days by calendar jp version 1)  support  handle-inquiry: inquiry.answered for item …
```

`examples/calendars/jp.md` に、2026年と2027年の日本の祝日の例があります。採用する前に、内閣府の
発表と照らし合わせ、会社の休業日を足してください。

0.1 で書かれた記録は、そのまま同じ務めになります（`d`、`h`、`m` のルールが記録に入る形は変わって
いません）。逆に、営業日のルールが入った記録を 0.1 の tsutome で読むと、違う期限を出すのではなく、
`"3bd" is not a duration` と言って止まります。営業日のルールを採用する前に、記録を読むものを
すべて 0.2 以上にしてください。

## 使い方

Node 20 以上が必要です。

```sh
npm install -g tsutome

tsutome check rules/delete-after-answer.md          # 誤りを行番号つきで示す
tsutome adopt rules/delete-after-answer.md --by legal --name example.com/duties
tsutome check-calendar calendars/jp.md              # 営業日の期限を使うときは、暦も同じように確かめ、
tsutome adopt-calendar calendars/jp.md --by manager # その暦を名指しするルールより先に採用する
tsutome record data.answered -m item=q1 -m form=contact --by support
tsutome duties
tsutome agenda                                      # 誰に知らせるか、何が承認待ちか、何を実行できるか
tsutome approve DUTY --by support --plan plan.txt   # 記録には計画のダイジェストが残る
tsutome record data.deleted -m item=q1 --by agent
tsutome audit                                       # 指摘を行番号つきで示す。あれば終了コード1
```

記録は `tsutome.jsonl`、ルールは `rules/`、暦はその隣の `calendars/` です。`--chain`、`--rules`、
`--calendars`（`TSUTOME_CHAIN`、`TSUTOME_RULES`、`TSUTOME_CALENDARS`）で変えられます。ほかに状態はなく、サーバーもありません。

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
| `tsutome_duties`、`tsutome_duty`、`tsutome_rules`、`tsutome_calendars`、`tsutome_audit` | 読み取り |
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
import { parseChain, parseRule, parseCalendar, evaluate, audit, termsToMeta, calendarToMeta, CALENDAR_ADOPTED } from 'tsutome/core';

const rule = parseRule(text, 'delete-after-answer.md');       // 条件と、採用が指すダイジェスト
const chain = parseChain(lines);                               // 問題があれば、行を名指しする
const { duties } = evaluate(chain.entries, new Date());        // 記録だけから、何が期限か
const findings = audit(chain.entries, new Date());             // 監査で指摘になること

// 営業日の期限を使うなら、人が暦を採用したときに、サービスがこの記録を書きます。
const cal = parseCalendar(calendarText, 'jp.md');
const meta = calendarToMeta(cal.terms, cal.digest, 'manager'); // CALENDAR_ADOPTED という出来事のメタ情報
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
| `tsutome.calendar_adopted` | `tsutome adopt-calendar` | 暦のすべての日、タイムゾーン、対象の期間と、ファイルのダイジェスト |
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
