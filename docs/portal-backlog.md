# Portal backlog

Актуализировано: 2026-07-20.

Canonical code: private `source-ingest/master`.

## P0 — блокирующие

Нет открытых P0 на момент эксплуатационного аудита.

Новый auth/ACL/security дефект автоматически становится P0 и останавливает остальные улучшения до исправления и production smoke.

## P1 — ближайшая волна

### PORTAL-01 — moderated operational pilot

- Провести сценарии из `docs/portal-operational-acceptance.md` на 5–7 сотрудниках.
- Собрать время, успех без подсказки и точки остановки.
- Gate: P0 = 0, success ≥ 85%, медиана поиска ≤ 30 секунд.

### PORTAL-02 — UX fix batch по результатам пилота

- Создавать только из воспроизводимых наблюдений пилота.
- Не превращать субъективные пожелания в P1 без подтверждённого влияния на сценарий.
- После batch повторить затронутые сценарии и restricted-account smoke.

### PORTAL-03 — удалить legacy inline source block

Runtime уже отключён: `/portal-legacy` → `410`. В `serve-http.ts` остаётся большой недостижимый rollback source block.

Gate удаления:

- production стабилен минимум 7 дней после deployment;
- moderated pilot не выявил P0;
- rollback обеспечен Git tag/commit + проверенными backups, а не дублированием кода;
- после удаления пройдены Portal tests, typecheck, build, guard capture и два restart-smoke.

Статус на 2026-07-20: **не готово к удалению** — прошло менее недели и moderated pilot ещё не выполнен.

## P2 — после пилота

### PORTAL-04 — измерить и улучшить поиск

- Замерить p50/p95 на реальном ACL-scoped corpus.
- Цель API p95 < 500 ms.
- По фактам решить, нужны ли filters по source/type и улучшение snippets/ranking.

### PORTAL-05 — cross-device favorites/history

Сейчас recent/favorites/last source хранятся локально и разделены по authenticated account.

Реализовывать server-side только если пилот подтвердит регулярную работу одного пользователя с нескольких устройств. Риски: новый профиль данных, retention и ACL revalidation.

### PORTAL-06 — безопасный preview JSON/YAML

По умолчанию JSON/YAML/config/key/extensionless файлы не публикуются через Portal.

Предпочтительное направление, если появится потребность: allowlist только для явно опубликованных knowledge-каталогов, read-only preview, size cap, без общего снятия запрета.

### PORTAL-07 — context rail refinement

Кандидаты после наблюдений:

- группировка backlinks;
- related typed entities;
- улучшение metadata/tags/status/effective date;
- история обновления документа.

## P3 — отдельные продуктовые инициативы

### PORTAL-08 — graph visualization spike

Только contextual 1–2 hop view для трёх сценариев:

1. процесс/регламент → системы;
2. документ → backlinks/related entities;
3. встреча → люди → решения → проекты → системы.

Не использовать force-directed graph как основную навигацию. Gate: сценарий выполняется быстрее/понятнее списка.

### PORTAL-09 — editing/publishing workflow

Отдельный проект, не расширение read-only Portal одной кнопкой. Требует draft/review/approval, write ACL, Git-backed publication, audit и конфликтную модель.

## Порядок выполнения

1. PORTAL-01 — pilot.
2. PORTAL-02 — один ограниченный fix batch.
3. PORTAL-03 — legacy cleanup после gate.
4. Выбрать максимум один следующий P2 по данным пилота.
5. P3 запускать отдельным решением и roadmap.
