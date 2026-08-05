# Release C — DB-backed Portal ACL: production gates

> **Статус:** подготовительный пакет. Этот документ не является разрешением на production-операции.
>
> **Candidate SHA:** `REPLACE_WITH_EXACT_CANDIDATE_SHA`
>
> Все действия ниже выполняются по одному gate за раз. Миграция схемы, импорт, compare, DB authority и вывод JSON из эксплуатации требуют отдельных явных подтверждений Вячеслава.

## Неизменяемые границы

- Keycloak отвечает только за authentication и exact client role `resource_access[gbrain-portal].roles = gbrain-admin`.
- Keycloak Admin API/service account не добавляется.
- Source grants, заявки и audit принадлежат GBrain DB.
- Keycloak role не превращается в MCP scope `admin` и не расширяет source grants.
- `json` остаётся authority до завершения compare и отдельного DB-cutover approval.
- Неизвестный `GBRAIN_PORTAL_ACL_MODE` должен останавливать запуск.
- `compare` авторизует по JSON; DB используется только как shadow comparison. При мутациях в compare ожидается расхождение до контролируемой повторной синхронизации — не трактовать его как безопасный ноль.
- `db` не имеет fallback к JSON.
- JSON удаляется/архивируется только после отдельного rollback observation gate.

## Перед каждым gate

1. Подтвердить текущий live SHA и что candidate является его потомком.
2. Повторно проверить отсутствие collision миграции `v138` в source и live DB watermark.
3. Проверить update guard: installed file, versioned guard copy, manifest hashes и markers.
4. Проверить отсутствие активных/ожидающих background jobs, способных писать ACL.
5. Не печатать environment, connection strings, cookies, tokens или содержимое ACL.
6. Снять evidence только в виде SHA, counts, hashes, HTTP statuses и aggregate mismatch counts.
7. Проверить health до и после операции.

## Gate C1 — код + schema migration v138

**Отдельное approval:** разрешение на exact-SHA deploy, restart и автоматическое применение schema migration `137 → 138`.

Важно: `serve` применяет migrations при запуске, поэтому deploy/restart candidate одновременно является schema-migration action. Не маскировать это как «только код».

Preconditions:

- candidate SHA зафиксирован и проверен;
- `GBRAIN_PORTAL_ACL_MODE=json` задан явно;
- production JSON backup сделан с mode `0600`;
- DB backup/restore point подтверждён;
- миграционные PGLite/PostgreSQL tests зелёные.

Postconditions:

- DB version = `138`;
- существуют пять `portal_*` таблиц и индексы;
- authority всё ещё `json`;
- anonymous Admin APIs = `401`;
- authenticated Portal/Admin/OAuth behavior не изменилось;
- health = HTTP 200;
- update guard соответствует exact deployed SHA.

**Stop:** не импортировать JSON без Gate C2.

## Gate C2 — initial JSON import

**Отдельное approval:** разрешение на запись текущего JSON snapshot в пустые DB ACL tables.

Dry-run:

```bash
bun run scripts/migrate-portal-access-control.ts --dry-run
```

Ожидаемые production counts на момент подготовки пакета:

- users: `13`;
- requests: `10`;
- pending: `1`.

Перед apply повторить inventory; старые числа не использовать как текущую истину.

Apply:

```bash
bun run scripts/migrate-portal-access-control.ts \
  --apply \
  --actor-email vyacheslav.zakharov@avers.kz
```

Immediate compare:

```bash
bun run scripts/migrate-portal-access-control.ts --compare
```

Acceptance:

- apply exit `0`;
- compare exit `0`, `total=0`;
- counts/hash соответствуют pre-apply snapshot;
- все status/history, включая `approved_partial`, `already_granted`, `rejected`, `pending`, `note`, approved/denied rows и legacy decision actor, восстановимы через export;
- runtime остаётся в `json`.

**Stop:** не включать compare runtime без Gate C3.

## Gate C3 — compare-mode observation

**Отдельное approval:** разрешение установить `GBRAIN_PORTAL_ACL_MODE=compare` и перезапустить exact candidate.

Acceptance:

- authorization фактически остаётся JSON;
- aggregate mismatch telemetry не содержит email/source identities;
- объяснённых mismatch после новых JSON mutations может быть больше нуля;
- DB outage/invalid DB rows не расширяют authority;
- health, Admin, Portal, OAuth и reviewer paths работают;
- observation window и допустимый mismatch budget заданы до старта.

Перед cutover требуется короткий mutation freeze, повторный controlled reconciliation/import и `compare total=0`.

**Stop:** не переключать на `db` без Gate C4.

## Gate C4 — final freeze/reconciliation и DB authority

**Отдельное approval:**

1. начать mutation freeze;
2. выполнить final reconciliation;
3. установить `GBRAIN_PORTAL_ACL_MODE=db`;
4. перезапустить exact candidate.

До переключения:

```bash
bun run scripts/migrate-portal-access-control.ts --compare
```

Требование: exit `0`, `total=0`, без необъяснённых различий.

После переключения доказать:

- missing/disabled DB user fail closed;
- Portal visibility соответствует DB snapshot;
- OAuth authorization code получает exact DB grants без scope widening;
- снятие write grant немедленно убирает reviewer eligibility;
- Admin permissions/request APIs возвращают numeric versions;
- stale mutation = HTTP `409`;
- mutation response содержит fresh read-back и audit actor/time;
- personal source остаётся R/W;
- unmanaged grants не удаляются Admin-формой;
- anonymous Admin APIs = `401`;
- health = HTTP 200.

Mutation freeze снимается только после этих проверок.

## Gate C5 — rollback observation и JSON retirement

**Отдельное approval:** вывод JSON из authority/rollback plane.

До этого JSON остаётся защищённым rollback artifact. Проверить DB→JSON export в отдельный каталог:

```bash
rollback_dir="/home/avers/release-packages/gbrain/portal-acl-rollback-REPLACE_SHA"
mkdir -p "$rollback_dir"
chmod 700 "$rollback_dir"
bun run scripts/migrate-portal-access-control.ts --export-json "$rollback_dir"
```

Acceptance:

- оба файла regular, owner соответствует service user, mode `0600`;
- exported JSON успешно проходит `--dry-run` через явные `--permissions` и `--requests`;
- counts/status/history совпадают;
- rollback drill документирован без фактического production rollback.

## Rollback

### До DB authority

- вернуть explicit `GBRAIN_PORTAL_ACL_MODE=json`;
- restart;
- проверить Admin/Portal/OAuth/reviewer behavior;
- DB shadow tables не удалять.

### После DB authority

- остановить ACL mutations;
- экспортировать DB → новый JSON rollback directory;
- проверить export dry-run/counts/history;
- только после отдельного approval заменить production JSON атомарно;
- установить mode `json`, restart, выполнить полный smoke;
- сохранить DB audit и incident evidence.

## Обязательный receipt для каждого gate

- approved-by + timestamp;
- pre/live/candidate SHA и ancestor proof;
- schema version до/после;
- authority mode до/после;
- migration/import/compare counts и hashes без identities;
- exact bounded tests/build outputs;
- update-guard detect result;
- old/new PID, listener owner и health;
- authenticated behavior matrix;
- rollback artifacts и permissions;
- явно перечисленные невыполненные последующие gates.
