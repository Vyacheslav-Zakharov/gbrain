# cas-backup-executor-v4 — только кандидат для review

Отдельный режим `hosted-disposable` предназначен только для синтетического одноразового PostgreSQL 16. Production admission не расширен; production host, cluster и database запрещены в hosted-режиме. `owner-capture.sh` — неизменная историческая копия для regression-теста, НЕ команда для запуска v4 или разрешение production capture.

`qualify.py` запускается только workflow `.github/workflows/cas-backup-hosted-v1.yml` на точной ветке `acceptance/cas-backup-hosted-v1`. Он создаёт отдельный initdb, использует только Unix socket и отдельный порт, наполняет две строки и схему, запускает реальный `capture.py --execute`, расшифровывает CMS, восстанавливает dump в другую БД и сравнивает непустые строки и описание столбцов. Все receipts явно test-only; это не production authority.

Admission сверяет kernel hostname/boot ID, локальный pg_controldata и SQL identity/data_directory по фиксированному сокету. Корневой TEST_ONLY marker сам по себе недостаточен. Fixed dump/runuser grammar; произвольные argv/env запрещены. PG и loader/Python environment overrides отвергаются. Scratch paths имеют отдельную фиксированную грамматику.

Offline: `timeout -k 3 120 python3 -B -m unittest -v test_capture test_regressions test_output_bounds test_hosted`.

Hosted ещё НЕ запускался. Не выполнять qualify локально. На ошибке scratch остаётся; уничтожение ephemeral runner — внешний предел containment, не доказательство reap всех потомков. На штатном завершении cluster останавливается и scratch удаляется. Внешний timeout может не дать записать receipt; отсутствие receipt означает отсутствие доказательства.
