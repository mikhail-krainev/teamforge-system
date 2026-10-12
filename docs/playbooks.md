# Сценарии маршрута проекта (playbooks)

Дата: 2026-10-12. Фаза 2. Источник содержания: `docs/research/methodologies.md` (главный), `docs/research/components.md` (автоматические проверки, числа), `docs/orchestrator.md` (раздел «Продукт», п. 4), `docs/status.md` (принятые решения).

Метка **[решение автора]** означает решение, принятое автором документа без прямого ответа в исходных материалах. Все такие решения вынесены на вычитку в разделе 6. Метки **[оценка]** и **[не проверено]** унаследованы от `methodologies.md` и означают то же самое.

Сценарий хранится как данные. YAML в конце каждого сценария станет сид-данными модуля `playbooks`. Таблицы выше YAML сгенерированы из тех же данных и содержат то же самое в удобном для чтения виде.

## 1. Принятые условия

- Базовая длительность веб-сервиса 12 недель (84 дня). Срок этапа это рекомендованное значение: просрочка не останавливает проект, а считается по проекту целиком как фактическая дата завершения минус плановая (сумма сроков этапов).
- ML-продукт: 13 недель (91 день) **[решение автора]**. `methodologies.md` даёт для ML сумму 12 недель при этапе данных в 2 недели, но оговаривает «до 4 недель для задач с реальной разметкой»; для данных взято 3 недели, остальное как в источнике. Итог лежит внутри допустимых 12-16 недель.
- Платформа даёт собственные шаблоны (устав, мини design doc, PR/FAQ, model card и другие, раздел 5). Хостинг релизов студентам не навязывается: шаблон release checklist содержит список вариантов, доступных из РФ/СНГ (раздел 5.2); платформа проверяет только ответ ссылки.
- Минимальные сроки этапов и другие числа антифрода (24 ч на этап, этапы закрываются только последовательно, 14 дней минимум на проект) заданы в `components.md`, разделы 5.2 и 6, и в сценариях не дублируются: они действуют поверх любого сценария.
- Закрытие этапа: все обязательные шаги выполнены, чек-листы ревью пройдены (все пункты «да»), либо пункты «нет» явно приняты как риск в протоколе (`methodologies.md`, раздел 2). Критерий перехода каждого этапа дополнительно записан в сценарии текстом.

## 2. Формат сценария

Сценарий (playbook) это набор данных. Новый тип продукта добавляется записью в формате ниже, без правки кода.

### 2.1. Поля

**Сценарий (playbook)**

| Поле | Тип | Описание |
|---|---|---|
| `product_type` | строка (ключ) | Тип продукта: `web_service`, `ml_product`. Ключ неизменяемый |
| `title` | строка | Название для интерфейса |
| `version` | строка (semver) | Версия сценария. Проект фиксирует версию в момент создания и проходит её до конца |
| `total_days` | число | Сумма `duration_days` этапов; вычисляется, хранится для проверки. Основа расчёта просрочки |
| `stages` | список | Этапы в порядке прохождения |

**Этап (stage)**

| Поле | Тип | Описание |
|---|---|---|
| `key` | строка | Уникальный ключ в сценарии |
| `title` | строка | Название |
| `goal` | строка | Цель этапа одним-двумя предложениями |
| `duration_days` | число | Рекомендованный срок в днях (целое положительное число) |
| `exit_criteria` | строка | Критерий перехода на следующий этап в человекочитаемом виде |
| `steps` | список | Шаги этапа |

**Шаг (step)**

| Поле | Тип | Описание |
|---|---|---|
| `key` | строка | Уникальный ключ в сценарии |
| `title` | строка | Название |
| `description` | строка | Что нужно сделать и что считается результатом |
| `type` | `artifact` или `ritual` | Артефакт или ритуал |
| `submission` | `link`, `file`, `either` | Только для артефакта: ссылка, файл или любое из двух |
| `ritual_kind` | `call`, `retro`, `brainstorm`, `code_review` | Только для ритуала: созвон, ретроспектива, мозговой штурм, код-ревью. Пункт ритуала содержит дату, внешнюю ссылку и поле итогов |
| `required` | bool | Обязательный ли шаг. Обязательные шаги нужны для закрытия этапа и проекта; необязательный шаг (`false`) переход этапа и завершение не блокирует, и при отсутствии роли исполнитель запасного шага можно не назначать |
| `owner_role` | ключ роли или `any` | Роль-владелец; `any` значит «любая» |
| `alt_roles` | список ключей ролей | **[решение автора]** Роли, любая из которых тоже может выполнить шаг. Запасной шаг включается, только если в команде нет ни `owner_role`, ни одной из `alt_roles`. Пусто для `any` |
| `fallback` | объект или `null` | Запасной шаг. `null` только при `owner_role: any` |
| `review_checklist` | bool | Есть ли у шага чек-лист ревью (да/нет) |
| `review_items` | список строк | **[решение автора]** Пункты чек-листа, если он есть. Ответ по каждому «да» или «нет». Формулировки взяты из чек-листов этапов `methodologies.md`, раздел 2, и распределены по шагам |
| `auto_checks` | список ключей | Автоматические проверки артефакта (каталог в 2.4) |
| `sources` | список URL | Источники из `methodologies.md`; не пустой у каждого шага |

**Запасной шаг (fallback)**

| Поле | Тип | Описание |
|---|---|---|
| `title` | строка | Название упрощённого шага |
| `instruction` | строка | Что делает исполнитель вместо роли |
| `template` | ключ шаблона | Шаблон платформы (раздел 5) |
| `url` | строка, необязательно | Внешняя ссылка на шаблон или инструкцию |

### 2.2. Справочник ролей

Ключи ролей: `pm` (менеджер проекта), `frontend`, `backend`, `mobile`, `ba` (бизнес-аналитик), `product_analyst` (продуктовый аналитик), `system_analyst` (системный аналитик), `designer` (дизайнер), `ml_engineer` (ML-инженер), `data_engineer` (data-инженер), `qa`, `devops`. Справочник расширяемый; сценарий ссылается на роль по ключу, неизвестный ключ при импорте сценария отклоняется.

### 2.3. Правила, которые соблюдает каждый сценарий

1. Шаг не пропускается, а упрощается. Если роли нет, тимлид назначает исполнителя запасного шага. Зачёт по отсутствующей роли за запасной шаг не даётся (`orchestrator.md`, п. 4).
2. У каждого шага с `owner_role` не `any` есть `fallback` с шаблоном платформы или внешней ссылкой на шаблон/инструкцию.
3. У каждого шага минимум один источник из `methodologies.md`. Если источник косвенный, шаг внесён в раздел 6.
4. Последний этап содержит обязательный шаг со ссылкой на работающий релиз и на репозиторий. Проверки этого шага выполняются при сдаче и повторно при завершении проекта.
5. Вклад в ритуалы и артефакты с `owner_role: any` учитывается автором загрузки; как делить такой вклад при совмещении ролей, определяет спецификация (`docs/backlog.md`, MEDIUM про совмещение).

### 2.4. Каталог автоматических проверок

Выполняются в воркере при загрузке и повторно при завершении проекта (`components.md`, 6.2). Общие правила проверки ссылок (SSRF, редиректы, таймауты) применяются ко всем ссылкам.

| Ключ | Что проверяет |
|---|---|

| `file_ok` | Файл: тип по magic bytes из разрешённого списка, не больше 10 МБ, не меньше 1 КБ, лимиты проекта (50 МБ, 30 файлов) |
| `sha_dedup` | Сигнал: SHA-256 файла совпадает с файлом другого проекта (не блок) |
| `link_https` | Ссылка: только https и защита от SSRF (нарушение отклоняет сохранение); ответ 200 после не более 3 редиректов, таймаут 10 с (не 2xx помечает ссылку `broken`, это предупреждение: пункт закрываем, ссылка проверяется заново при завершении проекта) |
| `repo_exists` | Репозиторий существует по repository.id, не архивирован, публичный |
| `repo_final` | Репозиторий для зачёта: не пуст (минимум 10 коммитов), коммиты минимум от 2 разных аккаунтов участников, не форк без своих изменений, публичный |
| `release_alive_web` | Релиз веб-сервиса: ответ 200 после редиректов при двух проверках с интервалом не менее 24 ч, тело не меньше 500 байт, заголовок не из типовых заглушек, полный адрес (имя хоста и путь) не повторяется в других зачтённых проектах |
| `release_alive_ml` | Релиз ML-продукта: те же проверки, что для веб-сервиса, плюс допускается непустой JSON-ответ `/health` любого размера (страница документации `/docs` или демо-страница проверяются как HTML от 500 байт); принимается только публичный адрес, определение релиза в разделе 4.1 |
| `ritual_fields` | Ритуал: заполнены дата, внешняя ссылка и поле итогов |
| `min_files` | Минимум N файлов в пункте (параметр после двоеточия) [решение автора] |
| `md_headings` | Сигнал: для md/txt-файла найдены заголовки шаблона из раздела «Шаблоны платформы» [решение автора] |
| `pr_cross_review` | GitHub: не менее N слитых PR, у которых ревьюер не автор (параметр после двоеточия) [решение автора] |
| `ci_workflow` | GitHub: в репозитории есть workflow в .github/workflows и последний запуск на основной ветке успешен [решение автора] |

Проверки `file_ok`, `sha_dedup`, `link_https`, `ritual_fields` подставляются по типу шага автоматически; в колонке «Авто-проверки» таблиц они показаны явно. Проверки с пометкой **[решение автора]** отсутствуют в `components.md` и предложены здесь; без них сценарий работает, они усиливают защиту от фиктивных артефактов. Все проверки, кроме `file_ok`, `link_https`, `repo_exists`, `repo_final`, `release_alive_*`, `ritual_fields`, дают сигнал для ручной проверки, а не блокировку (**[решение автора]**).

### 2.5. Как работает чек-лист ревью

Один участник, не автор, проходит каждый пункт по ссылке на артефакт и отвечает «да» или «нет». Старшего ревьюера на платформе нет, поэтому пункты сформулированы для новичков; термины (appetite, no-gos, DoD, WIP-лимит, baseline, seed, утечка и другие) платформа показывает подсказкой рядом с пунктом по словарю из `methodologies.md`, раздел 2. Чек-лист шага «Перекрёстное код-ревью PR» применяется к каждому PR отдельно.

## 3. Сценарий «Веб-сервис» (`web_service`, версия 1.0.0)

Маршрут: 8 этапов, 12 недель. Основа: Scrum (спринты и DoD), Kanban (доска), Shape Up (pitch, appetite, circuit breaker), Design Sprint (прототип), design docs Google, PR/FAQ Amazon, практики ревью кода Google, SRE launch checklist.

### 3.1. Этапы


| Этап | Название | Срок, дней | Цель | Критерий перехода |
|---|---|---|---|---|
| 1 (`w1_start`) | Старт и проблема | 7 | Договориться, какую проблему решаем, для кого и в какие сроки; собрать репозиторий и доску. | Проблема описана историей; есть 3+ проверяемых допущения; appetite утверждён. Все обязательные шаги выполнены, пункты ревью «да» либо нет-пункты приняты как риск в протоколе. |
| 2 (`w2_research`) | Исследование пользователей | 14 | Проверить проблему на реальных людях из целевой группы и принять решение продолжать, менять или остановиться. | Проведено минимум 5 интервью; на каждое есть snapshot; записано явное решение продолжаем, меняем или стоп. |
| 3 (`w3_shaping`) | Объём и требования | 7 | Превратить результаты исследования в фиксированный по сроку объём: pitch, истории, критерии приёмки. | Appetite и no-gos утверждены; у каждой must-истории есть критерии приёмки. |
| 4 (`w4_prototype`) | Прототип и UI | 7 | Проверить интерфейс на людях вне команды до начала разработки. | Тест проведён; главные проблемы исправлены или осознанно отложены. |
| 5 (`w5_architecture`) | Архитектура и API-контракт | 7 | Принять и записать ключевые технические решения до написания основного кода. | Альтернативы записаны; контракт согласован frontend и backend; дизайн-ревью закрыто. |
| 6 (`w6_build`) | Реализация (2 спринта) | 25 | Сделать вертикальные срезы в двух спринтах (первый 14 дней, второй 11 дней), довести все must-истории до работающего состояния на staging. | В каждом спринте Increment отвечает DoD. В конце этапа все must-истории работают на staging. |
| 7 (`w7_release`) | Усиление и релиз | 10 | Закрыть баги must-историй, проверить продукт вручную, выкатить на прод с планом отката и мониторингом. | Все пункты release checklist «да»; smoke-тест на проде пройден. |
| 8 (`w8_wrapup`) | Ретроспектива и итоги | 7 | Разобрать проект, зафиксировать действия и подготовить итоговое описание для портфолио; сдать ссылки на релиз и репозиторий. | Не более 3 действий с владельцем и сроком; ссылка на работающий релиз и на репозиторий проверены платформой. |

Сумма: 84 дней = 12 недель.

#### Этап 1. Старт и проблема (7 дн.)

| Ключ | Название и описание | Тип | Обяз. | Роль (запасные роли) | Запасной шаг | Ревью | Авто-проверки | Источник |
|---|---|---|---|---|---|---|---|---|
| `w1_kickoff` | **Kickoff команды.** Созвон 1 ч: цель проекта, роли, правила работы, договорённости о связи. Итоги записываются в поле итогов. | ритуал: созвон | да | любая | не нужен | нет | `ritual_fields` | [Scrum Guide](https://scrumguides.org/scrum-guide.html), [Shape Up: pitch](https://basecamp.com/shapeup/1.5-chapter-06) |
| `w1_repo_board` | **Репозиторий и доска задач.** Ссылка на репозиторий GitHub и на доску (Issues/Projects) с колонками и WIP-лимитом. | артефакт: ссылка | да | любая | не нужен | нет | `link_https`, `repo_exists` | [Kanban Guide](https://kanbanguides.org/english/), [Scrum Guide](https://scrumguides.org/scrum-guide.html) |
| `w1_charter` | **Устав команды, DoD v0 и appetite.** Документ: цель, состав и роли, правила общения, Definition of Done v0, appetite в неделях, no-gos. Один человек назначен владельцем продукта. | артефакт: файл | да | менеджер проекта (бизнес-аналитик) | Устав по шаблону платформы (`tpl_charter`) | да | `file_ok`, `sha_dedup`, `md_headings` | [Scrum Guide](https://scrumguides.org/scrum-guide.html), [Shape Up: pitch](https://basecamp.com/shapeup/1.5-chapter-06) |
| `w1_problem` | **Problem statement.** Проблема как история одного конкретного человека, текущие способы решения, альтернативы, 3+ проверяемых допущения. | артефакт: файл | да | продуктовый аналитик (бизнес-аналитик) | Problem statement по шаблону (`tpl_problem_statement`) | да | `file_ok`, `sha_dedup`, `md_headings` | [Shape Up: pitch](https://basecamp.com/shapeup/1.5-chapter-06), [PR/FAQ](https://www.workingbackwards.com/resources/working-backwards-pr-faq/) |
| `w1_prfaq` | **PR/FAQ-lite.** Одностраничный «пресс-релиз из будущего» и 5-10 вопросов с ответами. | артефакт: файл | да | менеджер проекта (бизнес-аналитик, продуктовый аналитик) | PR/FAQ по шаблону платформы (`tpl_prfaq`) | да | `file_ok`, `sha_dedup`, `md_headings` | [PR/FAQ](https://www.workingbackwards.com/resources/working-backwards-pr-faq/) |
| `w1_prfaq_review` | **Ревью PR/FAQ всей командой.** Созвон: команда читает PR/FAQ и Problem statement, фиксирует замечания и утверждает appetite. | ритуал: созвон | да | любая | не нужен | нет | `ritual_fields` | [PR/FAQ](https://www.workingbackwards.com/resources/working-backwards-pr-faq/), [Shape Up: pitch](https://basecamp.com/shapeup/1.5-chapter-06) |

#### Этап 2. Исследование пользователей (14 дн.)

| Ключ | Название и описание | Тип | Обяз. | Роль (запасные роли) | Запасной шаг | Ревью | Авто-проверки | Источник |
|---|---|---|---|---|---|---|---|---|
| `w2_plan` | **План интервью.** Список вопросов о конкретных прошлых случаях, критерии отбора респондентов, распределение пар «интервьюер и писарь». | артефакт: файл | да | продуктовый аналитик (бизнес-аналитик) | Готовый список вопросов о прошлом поведении (`tpl_interview_kit`) | да | `file_ok`, `sha_dedup`, `md_headings` | [Product Talk](https://www.producttalk.org/interview-snapshot/), [Cagan](https://www.svpg.com/dual-track-agile/) |
| `w2_interviews` | **Интервью с целевой группой.** 5-8 интервью (не друзья из команды), работают парами. Ритуал фиксирует даты и общий итог, подробности в snapshot. | ритуал: созвон | да | продуктовый аналитик (бизнес-аналитик) | Интервью силами любых двух участников (`tpl_interview_kit`) | нет | `ritual_fields` | [Product Talk](https://www.producttalk.org/interview-snapshot/), [Patton](https://www.jpattonassociates.com/dual-track-development/) |
| `w2_snapshots` | **Snapshot каждого интервью.** Одностраничная выжимка на каждое интервью: кто, что рассказал, потребности. Минимум 5 файлов. | артефакт: файл | да | продуктовый аналитик (бизнес-аналитик) | Snapshot по шаблону (`tpl_interview_kit`) | да | `file_ok`, `sha_dedup`, `min_files:5` | [Product Talk](https://www.producttalk.org/interview-snapshot/) |
| `w2_synthesis` | **Обсуждение выводов.** Созвон 1 ч: общие темы, список возможностей (opportunities). | ритуал: созвон | да | любая | не нужен | нет | `ritual_fields` | [Product Talk](https://www.producttalk.org/interview-snapshot/), [Cagan](https://www.svpg.com/dual-track-agile/) |
| `w2_decision` | **Список возможностей и решение.** Документ: найденные возможности и решение «продолжаем / меняем / стоп» с обоснованием. | артефакт: файл | да | продуктовый аналитик (бизнес-аналитик, менеджер проекта) | Запись решения по шаблону (`tpl_decision_record`) | да | `file_ok`, `sha_dedup`, `md_headings` | [Cagan](https://www.svpg.com/dual-track-agile/), [Product Talk](https://www.producttalk.org/interview-snapshot/) |

#### Этап 3. Объём и требования (7 дн.)

| Ключ | Название и описание | Тип | Обяз. | Роль (запасные роли) | Запасной шаг | Ревью | Авто-проверки | Источник |
|---|---|---|---|---|---|---|---|---|
| `w3_pitch` | **Pitch.** Документ: проблема, appetite, решение, rabbit holes, no-gos; must отделены от «~» (необязательное). | артефакт: файл | да | бизнес-аналитик (менеджер проекта, системный аналитик) | Pitch по шаблону платформы (`tpl_pitch`) | да | `file_ok`, `sha_dedup`, `md_headings` | [Shape Up: pitch](https://basecamp.com/shapeup/1.5-chapter-06), [Shape Up: circuit breaker](https://basecamp.com/shapeup/3.5-chapter-14) |
| `w3_stories` | **Story map и user stories.** Карта историй по пути пользователя и user stories с проверяемыми критериями приёмки у каждой must-истории. | артефакт: ссылка или файл | да | бизнес-аналитик (системный аналитик, продуктовый аналитик) | User stories по шаблону и проверка INVEST (`tpl_user_story_kit`) | да | `file_ok`, `sha_dedup`, `link_https` | [Story mapping](https://www.jpattonassociates.com/user-story-mapping/), [INVEST](https://www.agilealliance.org/glossary/invest/) |
| `w3_pitch_review` | **Pitch-ревью и решение владельца продукта.** Созвон 1-1,5 ч: обсуждение, владелец продукта утверждает объём. | ритуал: созвон | да | любая | не нужен | нет | `ritual_fields` | [Shape Up: pitch](https://basecamp.com/shapeup/1.5-chapter-06), [Shape Up: circuit breaker](https://basecamp.com/shapeup/3.5-chapter-14) |

#### Этап 4. Прототип и UI (7 дн.)

| Ключ | Название и описание | Тип | Обяз. | Роль (запасные роли) | Запасной шаг | Ревью | Авто-проверки | Источник |
|---|---|---|---|---|---|---|---|---|
| `w4_sprint` | **Мини-спринт дизайна.** 2-3 сессии по 2-3 ч: карта, скетчи (fat marker), выбор решения, сборка прототипа. | ритуал: мозговой штурм | да | любая | не нужен | нет | `ritual_fields` | [Design Sprint](https://www.gv.com/sprint/) |
| `w4_prototype` | **Кликабельный прототип.** Ссылка на прототип, выглядящий как настоящий продукт (фасад). | артефакт: ссылка | да | дизайнер | Экраны из готового UI-кита (`tpl_ui_kit_guide`) | да | `link_https` | [Design Sprint](https://www.gv.com/sprint/), [Bootstrap](https://getbootstrap.com/docs/5.3/getting-started/introduction/), [shadcn/ui](https://ui.shadcn.com/docs) |
| `w4_test_script` | **Скрипт теста с задачами.** Сценарные задачи для респондентов; что наблюдаем и что считаем проблемой. | артефакт: файл | да | дизайнер (продуктовый аналитик, бизнес-аналитик) | Скрипт теста по шаблону (`tpl_usability_test`) | да | `file_ok`, `sha_dedup`, `md_headings` | [Design Sprint](https://www.gv.com/sprint/) |
| `w4_user_test` | **Тест на 3-5 людях вне команды.** Сессии тестирования прототипа; даты и итоги в ритуале. | ритуал: созвон | да | любая | не нужен | нет | `ritual_fields` | [Design Sprint](https://www.gv.com/sprint/) |
| `w4_test_report` | **Протокол тестов, топ-3 проблемы.** Протокол с наблюдениями и тремя главными проблемами: исправлены или отложены с причиной. | артефакт: файл | да | продуктовый аналитик (дизайнер, бизнес-аналитик) | Протокол по шаблону (`tpl_usability_test`) | да | `file_ok`, `sha_dedup`, `md_headings` | [Design Sprint](https://www.gv.com/sprint/) |

#### Этап 5. Архитектура и API-контракт (7 дн.)

| Ключ | Название и описание | Тип | Обяз. | Роль (запасные роли) | Запасной шаг | Ревью | Авто-проверки | Источник |
|---|---|---|---|---|---|---|---|---|
| `w5_designdoc` | **Мини design doc.** Документ на 1-3 страницы: контекст, цели и не-цели, решение, альтернативы, trade-offs, безопасность, приватность, наблюдаемость. | артефакт: файл | да | системный аналитик (backend) | Мини design doc по шаблону из пяти секций (`tpl_design_doc`) | да | `file_ok`, `sha_dedup`, `md_headings` | [Design docs](https://www.industrialempathy.com/posts/design-docs-at-google/) |
| `w5_api` | **API-контракт и схема данных.** Описание эндпоинтов (запрос, ответ, коды ошибок), например OpenAPI, и схема данных. | артефакт: ссылка или файл | да | backend (системный аналитик) | Таблица эндпоинтов по шаблону (`tpl_api_contract`) | да | `file_ok`, `sha_dedup`, `link_https` | [Design docs](https://www.industrialempathy.com/posts/design-docs-at-google/) |
| `w5_adr` | **ADR: хостинг, CI, стек.** Короткие записи решений: контекст, варианты, выбор, последствия. | артефакт: файл | да | backend (системный аналитик, DevOps) | ADR по шаблону (`tpl_adr`) | нет | `file_ok`, `sha_dedup`, `md_headings` | [Design docs](https://www.industrialempathy.com/posts/design-docs-at-google/) |
| `w5_review` | **Дизайн-ревью всей командой.** Созвон 1 ч: обсуждение комментариев в документе. | ритуал: созвон | да | любая | не нужен | нет | `ritual_fields` | [Design docs](https://www.industrialempathy.com/posts/design-docs-at-google/) |

#### Этап 6. Реализация (2 спринта) (25 дн.)

| Ключ | Название и описание | Тип | Обяз. | Роль (запасные роли) | Запасной шаг | Ревью | Авто-проверки | Источник |
|---|---|---|---|---|---|---|---|---|
| `w6_board` | **Доска со Sprint Backlog и WIP-лимитом.** Ссылка на доску: колонки, WIP-лимит, возраст задач. | артефакт: ссылка | да | менеджер проекта | Доска по шаблону Kanban (`tpl_kanban_board`) | да | `link_https` | [Kanban Guide](https://kanbanguides.org/english/), [Scrum Guide](https://scrumguides.org/scrum-guide.html) |
| `w6_ci` | **CI на GitHub Actions.** Ссылка на workflow: тесты на каждом PR, красный CI блокирует слияние. | артефакт: ссылка | да | DevOps (backend) | Готовый шаблон CI GitHub Actions (`tpl_ci_github_actions`) | да | `link_https`, `ci_workflow` | [GitHub starter workflows](https://docs.github.com/en/actions/writing-workflows/using-starter-workflows), [Scrum Guide](https://scrumguides.org/scrum-guide.html) |
| `w6_pr_template` | **Шаблон описания PR.** Файл шаблона PR в репозитории: что и зачем сделано, как проверить. | артефакт: ссылка | нет | любая | не нужен | нет | `link_https` | [Шаблон PR](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/creating-a-pull-request-template-for-your-repository), [Google: малые PR](https://google.github.io/eng-practices/review/developer/small-cls.html) |
| `w6_s1_planning` | **Спринт 1: планирование.** Созвон 1 ч: зачем, что, как; цель спринта. | ритуал: созвон | да | любая | не нужен | нет | `ritual_fields` | [Scrum Guide](https://scrumguides.org/scrum-guide.html) |
| `w6_frontend` | **Реализация интерфейса (frontend).** Ссылка на слитые PR с UI: вертикальные срезы, тесты в тех же PR. | артефакт: ссылка | да | frontend | Срезы одним человеком, ревью у второго (`tpl_ui_kit_guide`) | нет | `link_https`, `pr_cross_review:5` | [Scrum Guide](https://scrumguides.org/scrum-guide.html), [Google: малые PR](https://google.github.io/eng-practices/review/developer/small-cls.html) |
| `w6_backend` | **Реализация серверной части (backend).** Ссылка на слитые PR с API и данными по контракту; тесты в тех же PR. | артефакт: ссылка | да | backend | Срезы одним человеком, ревью у второго (`tpl_api_contract`) | нет | `link_https`, `pr_cross_review:5` | [Scrum Guide](https://scrumguides.org/scrum-guide.html), [Google: малые PR](https://google.github.io/eng-practices/review/developer/small-cls.html) |
| `w6_mobile` | **Мобильный клиент (необязательный шаг).** Веб-сервис не требует мобильного клиента. Если в команде есть роль mobile, ссылка на слитые PR мобильного клиента; если роли нет, по желанию адаптивный веб или PWA. | артефакт: ссылка | нет | mobile | Адаптивная вёрстка или PWA (`tpl_responsive_checklist`) | нет | `link_https` | [web.dev PWA](https://web.dev/learn/pwa), [Scrum Guide](https://scrumguides.org/scrum-guide.html) |
| `w6_code_review` | **Перекрёстное код-ревью PR.** Ревью каждого PR участником, не автором. Ссылка на PR с ревью, итоги в поле итогов. | ритуал: код-ревью | да | любая | не нужен | да | `ritual_fields`, `pr_cross_review:5` | [Google ревью: что смотреть](https://google.github.io/eng-practices/review/reviewer/looking-for.html), [Google: малые PR](https://google.github.io/eng-practices/review/developer/small-cls.html), [Google: скорость ревью](https://google.github.io/eng-practices/review/reviewer/speed.html), [Google: комментарии](https://google.github.io/eng-practices/review/reviewer/comments.html) |
| `w6_s1_review` | **Спринт 1: Review и ретро + срез объёма.** Созвон 1-1,5 ч в конце спринта: Increment по DoD, ретроспектива, сверка с appetite (конец недели 8), срез объёма по circuit breaker. | ритуал: ретроспектива | да | любая | не нужен | нет | `ritual_fields` | [Scrum Guide](https://scrumguides.org/scrum-guide.html), [Shape Up: circuit breaker](https://basecamp.com/shapeup/3.5-chapter-14) |
| `w6_s2_planning` | **Спринт 2: планирование.** Созвон 1 ч с учётом среза объёма. | ритуал: созвон | да | любая | не нужен | нет | `ritual_fields` | [Scrum Guide](https://scrumguides.org/scrum-guide.html) |
| `w6_staging` | **Все must-истории работают на staging.** Ссылка на staging-стенд и список must-историй с отметками. | артефакт: ссылка | да | любая | не нужен | нет | `link_https` | [Scrum Guide](https://scrumguides.org/scrum-guide.html) |
| `w6_s2_review` | **Спринт 2: Review и ретро.** Созвон 1-1,5 ч: Increment по DoD, ретроспектива. | ритуал: ретроспектива | да | любая | не нужен | нет | `ritual_fields` | [Scrum Guide](https://scrumguides.org/scrum-guide.html) |

#### Этап 7. Усиление и релиз (10 дн.)

| Ключ | Название и описание | Тип | Обяз. | Роль (запасные роли) | Запасной шаг | Ревью | Авто-проверки | Источник |
|---|---|---|---|---|---|---|---|---|
| `w7_regression` | **Ручная регрессия по чек-листу.** Файл с результатами прохода чек-листа ручного тестирования по must-историям; найденные баги заведены. | артефакт: файл | да | QA | Чек-лист ручного тестирования (`tpl_manual_test_checklist`) | нет | `file_ok`, `sha_dedup` | [SRE launch checklist](https://sre.google/sre-book/launch-checklist/), [Scrum Guide](https://scrumguides.org/scrum-guide.html) |
| `w7_release_checklist` | **Release checklist.** Заполненный чек-лист запуска: безопасность (аутентификация, HTTPS), отказ внешних зависимостей, поэтапная выкатка. | артефакт: ссылка или файл | да | DevOps (backend) | Release checklist по шаблону (`tpl_release_checklist`) | да | `file_ok`, `sha_dedup`, `link_https` | [SRE launch checklist](https://sre.google/sre-book/launch-checklist/) |
| `w7_deploy` | **Прод и staging, повторяемый деплой.** Ссылка на прод-стенд; деплой описан и повторяем. Хостинг выбирается из списка вариантов, доступных из РФ/СНГ. | артефакт: ссылка | да | DevOps (backend) | Выбор хостинга из списка и деплой по инструкции (`tpl_release_checklist`) | да | `link_https` | [SRE launch checklist](https://sre.google/sre-book/launch-checklist/), [Render Free](https://render.com/docs/free), [Vercel Hobby](https://vercel.com/docs/plans/hobby), [Fly.io](https://docs.fly.io/about/pricing) |
| `w7_rollback` | **План отката и резервная копия.** Документ: как откатить версию, как делается резервная копия данных и как проверено восстановление. | артефакт: файл | да | DevOps (backend) | План отката по шаблону (`tpl_release_checklist`) | да | `file_ok`, `sha_dedup`, `md_headings` | [SRE launch checklist](https://sre.google/sre-book/launch-checklist/) |
| `w7_monitoring` | **Мониторинг доступности и алерт.** Ссылка на проверку доступности и описание алерта «сервис недоступен». | артефакт: ссылка или файл | да | DevOps (backend) | Точка проверки и внешняя проверка доступности (`tpl_release_checklist`) | да | `file_ok`, `sha_dedup`, `link_https` | [SRE launch checklist](https://sre.google/sre-book/launch-checklist/) |
| `w7_smoke` | **Smoke-тест на проде.** Ссылка на прод и файл или запись результата smoke-теста главного сценария. | артефакт: ссылка | да | QA | Чек-лист smoke-теста (`tpl_manual_test_checklist`) | нет | `link_https` | [SRE launch checklist](https://sre.google/sre-book/launch-checklist/) |
| `w7_gonogo` | **Go/no-go встреча.** Созвон 30-60 мин: проход по release checklist, решение о выкладке. | ритуал: созвон | да | любая | не нужен | нет | `ritual_fields` | [SRE launch checklist](https://sre.google/sre-book/launch-checklist/) |

#### Этап 8. Ретроспектива и итоги (7 дн.)

| Ключ | Название и описание | Тип | Обяз. | Роль (запасные роли) | Запасной шаг | Ревью | Авто-проверки | Источник |
|---|---|---|---|---|---|---|---|---|
| `w8_demo` | **Итоговое демо.** Созвон: показ работающего продукта (запись допускается). | ритуал: созвон | да | любая | не нужен | нет | `ritual_fields` | [SRE launch checklist](https://sre.google/sre-book/launch-checklist/), [Scrum Guide](https://scrumguides.org/scrum-guide.html) |
| `w8_retro` | **Ретроспектива проекта.** Созвон 1-1,5 ч: что получилось, что нет, что меняем. | ритуал: ретроспектива | да | менеджер проекта | Ретро по шаблону из трёх вопросов (`tpl_retro`) | нет | `ritual_fields` | [Scrum Guide](https://scrumguides.org/scrum-guide.html) |
| `w8_retro_doc` | **Retro-документ и backlog улучшений.** Не более 3 действий с владельцем и сроком; проверены действия прошлых ретро. | артефакт: файл | да | менеджер проекта | Retro-документ по шаблону (`tpl_retro`) | да | `file_ok`, `sha_dedup`, `md_headings` | [Scrum Guide](https://scrumguides.org/scrum-guide.html) |
| `w8_portfolio` | **Описание проекта для портфолио.** Описание: проблема, решение, роли, стек, результаты, ссылки. | артефакт: ссылка или файл | да | менеджер проекта | Описание проекта по шаблону (`tpl_portfolio`) | нет | `file_ok`, `sha_dedup`, `link_https`, `md_headings` | [Scrum Guide](https://scrumguides.org/scrum-guide.html), [PR/FAQ](https://www.workingbackwards.com/resources/working-backwards-pr-faq/) |
| `w8_final_links` | **Ссылка на работающий релиз и репозиторий.** Две ссылки: публичный URL работающего релиза и репозиторий GitHub. Обязательны для завершения проекта. | артефакт: ссылка | да | любая | не нужен | нет | `link_https`, `release_alive_web`, `repo_final` | [SRE launch checklist](https://sre.google/sre-book/launch-checklist/), [Scrum Guide](https://scrumguides.org/scrum-guide.html) |

### 3.2. YAML (сид-данные)

```yaml
product_type: web_service
title: "Веб-сервис"
version: "1.0.0"
total_days: 84
stages:
  - key: w1_start
    title: "Старт и проблема"
    goal: "Договориться, какую проблему решаем, для кого и в какие сроки; собрать репозиторий и доску."
    duration_days: 7
    exit_criteria: "Проблема описана историей; есть 3+ проверяемых допущения; appetite утверждён. Все обязательные шаги выполнены, пункты ревью «да» либо нет-пункты приняты как риск в протоколе."
    steps:
      - key: w1_kickoff
        title: "Kickoff команды"
        description: "Созвон 1 ч: цель проекта, роли, правила работы, договорённости о связи. Итоги записываются в поле итогов."
        type: ritual
        ritual_kind: call
        required: true
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["ritual_fields"]
        sources:
          - "https://scrumguides.org/scrum-guide.html"
          - "https://basecamp.com/shapeup/1.5-chapter-06"
      - key: w1_repo_board
        title: "Репозиторий и доска задач"
        description: "Ссылка на репозиторий GitHub и на доску (Issues/Projects) с колонками и WIP-лимитом."
        type: artifact
        submission: link
        required: true
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["link_https", "repo_exists"]
        sources:
          - "https://kanbanguides.org/english/"
          - "https://scrumguides.org/scrum-guide.html"
      - key: w1_charter
        title: "Устав команды, DoD v0 и appetite"
        description: "Документ: цель, состав и роли, правила общения, Definition of Done v0, appetite в неделях, no-gos. Один человек назначен владельцем продукта."
        type: artifact
        submission: file
        required: true
        owner_role: pm
        alt_roles: ["ba"]
        fallback:
          title: "Устав по шаблону платформы"
          instruction: "Тимлид назначает владельца продукта, один человек заполняет шаблон устава, остальные комментируют. Шаблон заменяет менеджера и аналитика."
          template: tpl_charter
        review_checklist: true
        review_items:
          - "Записаны no-gos?"
          - "Указан appetite в неделях?"
          - "Определение готовности (DoD v0) записано?"
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://scrumguides.org/scrum-guide.html"
          - "https://basecamp.com/shapeup/1.5-chapter-06"
      - key: w1_problem
        title: "Problem statement"
        description: "Проблема как история одного конкретного человека, текущие способы решения, альтернативы, 3+ проверяемых допущения."
        type: artifact
        submission: file
        required: true
        owner_role: product_analyst
        alt_roles: ["ba"]
        fallback:
          title: "Problem statement по шаблону"
          instruction: "Любой участник заполняет шаблон: история человека, как решает сейчас, альтернативы, допущения; самое рискованное отмечается первым."
          template: tpl_problem_statement
        review_checklist: true
        review_items:
          - "Проблема описана как история конкретного человека, а не «неудобно»?"
          - "Указано, как люди решают проблему сейчас?"
          - "Названы альтернативы и чем мы лучше?"
          - "Есть 3+ проверяемых допущения, самое рискованное отмечено?"
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://basecamp.com/shapeup/1.5-chapter-06"
          - "https://www.workingbackwards.com/resources/working-backwards-pr-faq/"
      - key: w1_prfaq
        title: "PR/FAQ-lite"
        description: "Одностраничный «пресс-релиз из будущего» и 5-10 вопросов с ответами."
        type: artifact
        submission: file
        required: true
        owner_role: pm
        alt_roles: ["ba", "product_analyst"]
        fallback:
          title: "PR/FAQ по шаблону платформы"
          instruction: "Заполнить шаблон PR/FAQ: заголовок, абзац-резюме, проблема, решение, цитата пользователя, 5-10 вопросов. Ведущий выбирается любой участник."
          template: tpl_prfaq
        review_checklist: true
        review_items:
          - "PR/FAQ умещается в одну страницу плюс 5-10 вопросов?"
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://www.workingbackwards.com/resources/working-backwards-pr-faq/"
      - key: w1_prfaq_review
        title: "Ревью PR/FAQ всей командой"
        description: "Созвон: команда читает PR/FAQ и Problem statement, фиксирует замечания и утверждает appetite."
        type: ritual
        ritual_kind: call
        required: true
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["ritual_fields"]
        sources:
          - "https://www.workingbackwards.com/resources/working-backwards-pr-faq/"
          - "https://basecamp.com/shapeup/1.5-chapter-06"
  - key: w2_research
    title: "Исследование пользователей"
    goal: "Проверить проблему на реальных людях из целевой группы и принять решение продолжать, менять или остановиться."
    duration_days: 14
    exit_criteria: "Проведено минимум 5 интервью; на каждое есть snapshot; записано явное решение продолжаем, меняем или стоп."
    steps:
      - key: w2_plan
        title: "План интервью"
        description: "Список вопросов о конкретных прошлых случаях, критерии отбора респондентов, распределение пар «интервьюер и писарь»."
        type: artifact
        submission: file
        required: true
        owner_role: product_analyst
        alt_roles: ["ba"]
        fallback:
          title: "Готовый список вопросов о прошлом поведении"
          instruction: "Использовать шаблон набора для интервью. Интервью проводят любые двое участников."
          template: tpl_interview_kit
        review_checklist: true
        review_items:
          - "Вопросы про конкретные прошлые случаи, а не «стали бы вы пользоваться»?"
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://www.producttalk.org/interview-snapshot/"
          - "https://www.svpg.com/dual-track-agile/"
      - key: w2_interviews
        title: "Интервью с целевой группой"
        description: "5-8 интервью (не друзья из команды), работают парами. Ритуал фиксирует даты и общий итог, подробности в snapshot."
        type: ritual
        ritual_kind: call
        required: true
        owner_role: product_analyst
        alt_roles: ["ba"]
        fallback:
          title: "Интервью силами любых двух участников"
          instruction: "Тимлид назначает пары из любых участников; используется набор для интервью с готовым списком вопросов."
          template: tpl_interview_kit
        review_checklist: false
        auto_checks: ["ritual_fields"]
        sources:
          - "https://www.producttalk.org/interview-snapshot/"
          - "https://www.jpattonassociates.com/dual-track-development/"
      - key: w2_snapshots
        title: "Snapshot каждого интервью"
        description: "Одностраничная выжимка на каждое интервью: кто, что рассказал, потребности. Минимум 5 файлов."
        type: artifact
        submission: file
        required: true
        owner_role: product_analyst
        alt_roles: ["ba"]
        fallback:
          title: "Snapshot по шаблону"
          instruction: "Каждый писарь заполняет шаблон snapshot сразу после интервью."
          template: tpl_interview_kit
        review_checklist: true
        review_items:
          - "Минимум 5 интервью с целевой группой?"
          - "На каждое интервью есть snapshot?"
          - "Факты и выводы не смешаны?"
        auto_checks: ["file_ok", "sha_dedup", "min_files:5"]
        sources:
          - "https://www.producttalk.org/interview-snapshot/"
      - key: w2_synthesis
        title: "Обсуждение выводов"
        description: "Созвон 1 ч: общие темы, список возможностей (opportunities)."
        type: ritual
        ritual_kind: call
        required: true
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["ritual_fields"]
        sources:
          - "https://www.producttalk.org/interview-snapshot/"
          - "https://www.svpg.com/dual-track-agile/"
      - key: w2_decision
        title: "Список возможностей и решение"
        description: "Документ: найденные возможности и решение «продолжаем / меняем / стоп» с обоснованием."
        type: artifact
        submission: file
        required: true
        owner_role: product_analyst
        alt_roles: ["ba", "pm"]
        fallback:
          title: "Запись решения по шаблону"
          instruction: "Тимлид или любой участник заполняет шаблон записи решения."
          template: tpl_decision_record
        review_checklist: true
        review_items:
          - "Записано решение продолжать / менять / остановить?"
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://www.svpg.com/dual-track-agile/"
          - "https://www.producttalk.org/interview-snapshot/"
  - key: w3_shaping
    title: "Объём и требования"
    goal: "Превратить результаты исследования в фиксированный по сроку объём: pitch, истории, критерии приёмки."
    duration_days: 7
    exit_criteria: "Appetite и no-gos утверждены; у каждой must-истории есть критерии приёмки."
    steps:
      - key: w3_pitch
        title: "Pitch"
        description: "Документ: проблема, appetite, решение, rabbit holes, no-gos; must отделены от «~» (необязательное)."
        type: artifact
        submission: file
        required: true
        owner_role: ba
        alt_roles: ["pm", "system_analyst"]
        fallback:
          title: "Pitch по шаблону платформы"
          instruction: "Заполнить шаблон pitch из пяти разделов. Автор любой, утверждает владелец продукта."
          template: tpl_pitch
        review_checklist: true
        review_items:
          - "Must отделены от «~»?"
          - "Можно выпустить продукт без любого nice-to-have?"
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://basecamp.com/shapeup/1.5-chapter-06"
          - "https://basecamp.com/shapeup/3.5-chapter-14"
      - key: w3_stories
        title: "Story map и user stories"
        description: "Карта историй по пути пользователя и user stories с проверяемыми критериями приёмки у каждой must-истории."
        type: artifact
        submission: either
        required: true
        owner_role: ba
        alt_roles: ["system_analyst", "product_analyst"]
        fallback:
          title: "User stories по шаблону и проверка INVEST"
          instruction: "Использовать шаблон «Как..., я хочу..., чтобы...» и проверить каждую историю по INVEST."
          template: tpl_user_story_kit
          url: "https://www.agilealliance.org/glossary/invest/"
        review_checklist: true
        review_items:
          - "Каждая история называет пользователя, цель и ценность?"
          - "Истории разложены по пути пользователя, дыры видны?"
          - "У каждой must-истории проверяемые критерии приёмки?"
        auto_checks: ["file_ok", "sha_dedup", "link_https"]
        sources:
          - "https://www.jpattonassociates.com/user-story-mapping/"
          - "https://www.agilealliance.org/glossary/invest/"
      - key: w3_pitch_review
        title: "Pitch-ревью и решение владельца продукта"
        description: "Созвон 1-1,5 ч: обсуждение, владелец продукта утверждает объём."
        type: ritual
        ritual_kind: call
        required: true
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["ritual_fields"]
        sources:
          - "https://basecamp.com/shapeup/1.5-chapter-06"
          - "https://basecamp.com/shapeup/3.5-chapter-14"
  - key: w4_prototype
    title: "Прототип и UI"
    goal: "Проверить интерфейс на людях вне команды до начала разработки."
    duration_days: 7
    exit_criteria: "Тест проведён; главные проблемы исправлены или осознанно отложены."
    steps:
      - key: w4_sprint
        title: "Мини-спринт дизайна"
        description: "2-3 сессии по 2-3 ч: карта, скетчи (fat marker), выбор решения, сборка прототипа."
        type: ritual
        ritual_kind: brainstorm
        required: true
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["ritual_fields"]
        sources:
          - "https://www.gv.com/sprint/"
      - key: w4_prototype
        title: "Кликабельный прототип"
        description: "Ссылка на прототип, выглядящий как настоящий продукт (фасад)."
        type: artifact
        submission: link
        required: true
        owner_role: designer
        alt_roles: []
        fallback:
          title: "Экраны из готового UI-кита"
          instruction: "Собрать экраны из готового UI-кита (Bootstrap или shadcn/ui) без кастомного дизайна в первой итерации. Один кит на весь проект."
          template: tpl_ui_kit_guide
          url: "https://getbootstrap.com/docs/5.3/getting-started/introduction/"
        review_checklist: true
        review_items:
          - "Прототип выглядит реалистично (фасад), а не схема?"
        auto_checks: ["link_https"]
        sources:
          - "https://www.gv.com/sprint/"
          - "https://getbootstrap.com/docs/5.3/getting-started/introduction/"
          - "https://ui.shadcn.com/docs"
      - key: w4_test_script
        title: "Скрипт теста с задачами"
        description: "Сценарные задачи для респондентов; что наблюдаем и что считаем проблемой."
        type: artifact
        submission: file
        required: true
        owner_role: designer
        alt_roles: ["product_analyst", "ba"]
        fallback:
          title: "Скрипт теста по шаблону"
          instruction: "Заполнить шаблон скрипта и протокола тестов."
          template: tpl_usability_test
        review_checklist: true
        review_items:
          - "Есть скрипт теста с задачами-сценариями?"
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://www.gv.com/sprint/"
      - key: w4_user_test
        title: "Тест на 3-5 людях вне команды"
        description: "Сессии тестирования прототипа; даты и итоги в ритуале."
        type: ritual
        ritual_kind: call
        required: true
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["ritual_fields"]
        sources:
          - "https://www.gv.com/sprint/"
      - key: w4_test_report
        title: "Протокол тестов, топ-3 проблемы"
        description: "Протокол с наблюдениями и тремя главными проблемами: исправлены или отложены с причиной."
        type: artifact
        submission: file
        required: true
        owner_role: product_analyst
        alt_roles: ["designer", "ba"]
        fallback:
          title: "Протокол по шаблону"
          instruction: "Заполнить шаблон протокола тестов."
          template: tpl_usability_test
        review_checklist: true
        review_items:
          - "Тест прошёл с 3-5 людьми не из команды?"
          - "Топ-3 проблемы исправлены или отложены с причиной?"
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://www.gv.com/sprint/"
  - key: w5_architecture
    title: "Архитектура и API-контракт"
    goal: "Принять и записать ключевые технические решения до написания основного кода."
    duration_days: 7
    exit_criteria: "Альтернативы записаны; контракт согласован frontend и backend; дизайн-ревью закрыто."
    steps:
      - key: w5_designdoc
        title: "Мини design doc"
        description: "Документ на 1-3 страницы: контекст, цели и не-цели, решение, альтернативы, trade-offs, безопасность, приватность, наблюдаемость."
        type: artifact
        submission: file
        required: true
        owner_role: system_analyst
        alt_roles: ["backend"]
        fallback:
          title: "Мини design doc по шаблону из пяти секций"
          instruction: "Заполнить шаблон мини design doc; ревью проводит вся команда."
          template: tpl_design_doc
        review_checklist: true
        review_items:
          - "Есть контекст, объём и цели/не-цели?"
          - "Рассмотрено 2+ альтернативы, указано почему выбрана эта?"
          - "Описаны trade-offs, а не вставлен весь код?"
          - "Учтены безопасность, приватность, наблюдаемость?"
          - "Документ прочитал и прокомментировал каждый участник?"
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://www.industrialempathy.com/posts/design-docs-at-google/"
      - key: w5_api
        title: "API-контракт и схема данных"
        description: "Описание эндпоинтов (запрос, ответ, коды ошибок), например OpenAPI, и схема данных."
        type: artifact
        submission: either
        required: true
        owner_role: backend
        alt_roles: ["system_analyst"]
        fallback:
          title: "Таблица эндпоинтов по шаблону"
          instruction: "Описать каждый эндпоинт в таблице: метод, путь, запрос, ответ, коды ошибок. Формат OpenAPI не обязателен."
          template: tpl_api_contract
        review_checklist: true
        review_items:
          - "Для каждого эндпоинта указаны запрос, ответ, коды ошибок?"
        auto_checks: ["file_ok", "sha_dedup", "link_https"]
        sources:
          - "https://www.industrialempathy.com/posts/design-docs-at-google/"
      - key: w5_adr
        title: "ADR: хостинг, CI, стек"
        description: "Короткие записи решений: контекст, варианты, выбор, последствия."
        type: artifact
        submission: file
        required: true
        owner_role: backend
        alt_roles: ["system_analyst", "devops"]
        fallback:
          title: "ADR по шаблону"
          instruction: "Заполнить шаблон ADR на каждое решение (минимум: хостинг, CI)."
          template: tpl_adr
        review_checklist: false
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://www.industrialempathy.com/posts/design-docs-at-google/"
      - key: w5_review
        title: "Дизайн-ревью всей командой"
        description: "Созвон 1 ч: обсуждение комментариев в документе."
        type: ritual
        ritual_kind: call
        required: true
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["ritual_fields"]
        sources:
          - "https://www.industrialempathy.com/posts/design-docs-at-google/"
  - key: w6_build
    title: "Реализация (2 спринта)"
    goal: "Сделать вертикальные срезы в двух спринтах (первый 14 дней, второй 11 дней), довести все must-истории до работающего состояния на staging."
    duration_days: 25
    exit_criteria: "В каждом спринте Increment отвечает DoD. В конце этапа все must-истории работают на staging."
    steps:
      - key: w6_board
        title: "Доска со Sprint Backlog и WIP-лимитом"
        description: "Ссылка на доску: колонки, WIP-лимит, возраст задач."
        type: artifact
        submission: link
        required: true
        owner_role: pm
        alt_roles: []
        fallback:
          title: "Доска по шаблону Kanban"
          instruction: "Использовать шаблон доски GitHub Projects (колонки, WIP-лимит). Ведёт любой участник."
          template: tpl_kanban_board
        review_checklist: true
        review_items:
          - "WIP-лимит не нарушен, просроченные по возрасту задачи обсуждены?"
        auto_checks: ["link_https"]
        sources:
          - "https://kanbanguides.org/english/"
          - "https://scrumguides.org/scrum-guide.html"
      - key: w6_ci
        title: "CI на GitHub Actions"
        description: "Ссылка на workflow: тесты на каждом PR, красный CI блокирует слияние."
        type: artifact
        submission: link
        required: true
        owner_role: devops
        alt_roles: ["backend"]
        fallback:
          title: "Готовый шаблон CI GitHub Actions"
          instruction: "Взять шаблон CI платформы или starter workflow GitHub под стек проекта и подключить к репозиторию."
          template: tpl_ci_github_actions
          url: "https://docs.github.com/en/actions/writing-workflows/using-starter-workflows"
        review_checklist: true
        review_items:
          - "Тесты запускаются на каждом PR и красный CI блокирует слияние?"
        auto_checks: ["link_https", "ci_workflow"]
        sources:
          - "https://docs.github.com/en/actions/writing-workflows/using-starter-workflows"
          - "https://scrumguides.org/scrum-guide.html"
      - key: w6_pr_template
        title: "Шаблон описания PR"
        description: "Файл шаблона PR в репозитории: что и зачем сделано, как проверить."
        type: artifact
        submission: link
        required: false
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["link_https"]
        sources:
          - "https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/creating-a-pull-request-template-for-your-repository"
          - "https://google.github.io/eng-practices/review/developer/small-cls.html"
      - key: w6_s1_planning
        title: "Спринт 1: планирование"
        description: "Созвон 1 ч: зачем, что, как; цель спринта."
        type: ritual
        ritual_kind: call
        required: true
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["ritual_fields"]
        sources:
          - "https://scrumguides.org/scrum-guide.html"
      - key: w6_frontend
        title: "Реализация интерфейса (frontend)"
        description: "Ссылка на слитые PR с UI: вертикальные срезы, тесты в тех же PR."
        type: artifact
        submission: link
        required: true
        owner_role: frontend
        alt_roles: []
        fallback:
          title: "Срезы одним человеком, ревью у второго"
          instruction: "Если frontend нет, backend делает срез целиком, а ревью выполняет другой участник. Использовать готовый UI-кит."
          template: tpl_ui_kit_guide
          url: "https://getbootstrap.com/docs/5.3/getting-started/introduction/"
        review_checklist: false
        auto_checks: ["link_https", "pr_cross_review:5"]
        sources:
          - "https://scrumguides.org/scrum-guide.html"
          - "https://google.github.io/eng-practices/review/developer/small-cls.html"
      - key: w6_backend
        title: "Реализация серверной части (backend)"
        description: "Ссылка на слитые PR с API и данными по контракту; тесты в тех же PR."
        type: artifact
        submission: link
        required: true
        owner_role: backend
        alt_roles: []
        fallback:
          title: "Срезы одним человеком, ревью у второго"
          instruction: "Если backend нет, frontend делает срез целиком по таблице эндпоинтов, ревью выполняет другой участник."
          template: tpl_api_contract
        review_checklist: false
        auto_checks: ["link_https", "pr_cross_review:5"]
        sources:
          - "https://scrumguides.org/scrum-guide.html"
          - "https://google.github.io/eng-practices/review/developer/small-cls.html"
      - key: w6_mobile
        title: "Мобильный клиент (необязательный шаг)"
        description: "Веб-сервис не требует мобильного клиента. Если в команде есть роль mobile, ссылка на слитые PR мобильного клиента; если роли нет, по желанию адаптивный веб или PWA."
        type: artifact
        submission: link
        required: false
        owner_role: mobile
        alt_roles: []
        fallback:
          title: "Адаптивная вёрстка или PWA"
          instruction: "Проверить адаптивность по чек-листу и при необходимости сделать PWA."
          template: tpl_responsive_checklist
          url: "https://web.dev/learn/pwa"
        review_checklist: false
        auto_checks: ["link_https"]
        sources:
          - "https://web.dev/learn/pwa"
          - "https://scrumguides.org/scrum-guide.html"
      - key: w6_code_review
        title: "Перекрёстное код-ревью PR"
        description: "Ревью каждого PR участником, не автором. Ссылка на PR с ревью, итоги в поле итогов."
        type: ritual
        ritual_kind: code_review
        required: true
        owner_role: any
        fallback: null
        review_checklist: true
        review_items:
          - "PR делает одну вещь (ориентир Google: ~100 строк норма, 1000 слишком много)?"
          - "Тесты в том же PR, и они упали бы при поломке кода?"
          - "Первая строка описания в императиве, в теле «зачем»?"
          - "Ревьюер прочитал каждую строку?"
          - "Нет лишней сложности и функций «на будущее»?"
          - "Края и ошибки обработаны?"
          - "Имена понятны, комментарии объясняют «почему»?"
          - "README обновлён, если изменился запуск?"
          - "Ревью дано за один рабочий день?"
          - "Комментарии помечены (Nit / Optional / обязательно), без личных нападок?"
        auto_checks: ["ritual_fields", "pr_cross_review:5"]
        sources:
          - "https://google.github.io/eng-practices/review/reviewer/looking-for.html"
          - "https://google.github.io/eng-practices/review/developer/small-cls.html"
          - "https://google.github.io/eng-practices/review/reviewer/speed.html"
          - "https://google.github.io/eng-practices/review/reviewer/comments.html"
      - key: w6_s1_review
        title: "Спринт 1: Review и ретро + срез объёма"
        description: "Созвон 1-1,5 ч в конце спринта: Increment по DoD, ретроспектива, сверка с appetite (конец недели 8), срез объёма по circuit breaker."
        type: ritual
        ritual_kind: retro
        required: true
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["ritual_fields"]
        sources:
          - "https://scrumguides.org/scrum-guide.html"
          - "https://basecamp.com/shapeup/3.5-chapter-14"
      - key: w6_s2_planning
        title: "Спринт 2: планирование"
        description: "Созвон 1 ч с учётом среза объёма."
        type: ritual
        ritual_kind: call
        required: true
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["ritual_fields"]
        sources:
          - "https://scrumguides.org/scrum-guide.html"
      - key: w6_staging
        title: "Все must-истории работают на staging"
        description: "Ссылка на staging-стенд и список must-историй с отметками."
        type: artifact
        submission: link
        required: true
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["link_https"]
        sources:
          - "https://scrumguides.org/scrum-guide.html"
      - key: w6_s2_review
        title: "Спринт 2: Review и ретро"
        description: "Созвон 1-1,5 ч: Increment по DoD, ретроспектива."
        type: ritual
        ritual_kind: retro
        required: true
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["ritual_fields"]
        sources:
          - "https://scrumguides.org/scrum-guide.html"
  - key: w7_release
    title: "Усиление и релиз"
    goal: "Закрыть баги must-историй, проверить продукт вручную, выкатить на прод с планом отката и мониторингом."
    duration_days: 10
    exit_criteria: "Все пункты release checklist «да»; smoke-тест на проде пройден."
    steps:
      - key: w7_regression
        title: "Ручная регрессия по чек-листу"
        description: "Файл с результатами прохода чек-листа ручного тестирования по must-историям; найденные баги заведены."
        type: artifact
        submission: file
        required: true
        owner_role: qa
        alt_roles: []
        fallback:
          title: "Чек-лист ручного тестирования"
          instruction: "Любые двое участников проходят по шаблону чек-листа ручного тестирования все must-истории и фиксируют результат."
          template: tpl_manual_test_checklist
          url: "https://sre.google/sre-book/launch-checklist/"
        review_checklist: false
        auto_checks: ["file_ok", "sha_dedup"]
        sources:
          - "https://sre.google/sre-book/launch-checklist/"
          - "https://scrumguides.org/scrum-guide.html"
      - key: w7_release_checklist
        title: "Release checklist"
        description: "Заполненный чек-лист запуска: безопасность (аутентификация, HTTPS), отказ внешних зависимостей, поэтапная выкатка."
        type: artifact
        submission: either
        required: true
        owner_role: devops
        alt_roles: ["backend"]
        fallback:
          title: "Release checklist по шаблону"
          instruction: "Заполнить шаблон release checklist платформы по мотивам SRE launch checklist."
          template: tpl_release_checklist
          url: "https://sre.google/sre-book/launch-checklist/"
        review_checklist: true
        review_items:
          - "Рассмотрены безопасность (аутентификация, HTTPS) и отказ внешних зависимостей?"
          - "Выкатка поэтапная или сначала для узкой группы?"
        auto_checks: ["file_ok", "sha_dedup", "link_https"]
        sources:
          - "https://sre.google/sre-book/launch-checklist/"
      - key: w7_deploy
        title: "Прод и staging, повторяемый деплой"
        description: "Ссылка на прод-стенд; деплой описан и повторяем. Хостинг выбирается из списка вариантов, доступных из РФ/СНГ."
        type: artifact
        submission: link
        required: true
        owner_role: devops
        alt_roles: ["backend"]
        fallback:
          title: "Выбор хостинга из списка и деплой по инструкции"
          instruction: "Выбрать хостинг из списка вариантов в шаблоне release checklist (раздел про хостинг) и выполнить пошаговую инструкцию деплоя; запасной вариант демо: локальный запуск или запись."
          template: tpl_release_checklist
          url: "https://render.com/docs/free"
        review_checklist: true
        review_items:
          - "Есть staging и prod, деплой повторяем?"
        auto_checks: ["link_https"]
        sources:
          - "https://sre.google/sre-book/launch-checklist/"
          - "https://render.com/docs/free"
          - "https://vercel.com/docs/plans/hobby"
          - "https://docs.fly.io/about/pricing"
      - key: w7_rollback
        title: "План отката и резервная копия"
        description: "Документ: как откатить версию, как делается резервная копия данных и как проверено восстановление."
        type: artifact
        submission: file
        required: true
        owner_role: devops
        alt_roles: ["backend"]
        fallback:
          title: "План отката по шаблону"
          instruction: "Заполнить раздел плана отката в шаблоне release checklist; восстановление из копии проверить вручную."
          template: tpl_release_checklist
        review_checklist: true
        review_items:
          - "Есть резервная копия данных и проверено восстановление?"
          - "Есть план отката?"
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://sre.google/sre-book/launch-checklist/"
      - key: w7_monitoring
        title: "Мониторинг доступности и алерт"
        description: "Ссылка на проверку доступности и описание алерта «сервис недоступен»."
        type: artifact
        submission: either
        required: true
        owner_role: devops
        alt_roles: ["backend"]
        fallback:
          title: "Точка проверки и внешняя проверка доступности"
          instruction: "Сделать endpoint проверки состояния и подключить любой бесплатный сервис проверки доступности с уведомлением; инструкция в шаблоне release checklist."
          template: tpl_release_checklist
        review_checklist: true
        review_items:
          - "Есть мониторинг и алерт «сервис недоступен»?"
        auto_checks: ["file_ok", "sha_dedup", "link_https"]
        sources:
          - "https://sre.google/sre-book/launch-checklist/"
      - key: w7_smoke
        title: "Smoke-тест на проде"
        description: "Ссылка на прод и файл или запись результата smoke-теста главного сценария."
        type: artifact
        submission: link
        required: true
        owner_role: qa
        alt_roles: []
        fallback:
          title: "Чек-лист smoke-теста"
          instruction: "Любой участник проходит короткий чек-лист smoke-теста главного сценария на проде."
          template: tpl_manual_test_checklist
        review_checklist: false
        auto_checks: ["link_https"]
        sources:
          - "https://sre.google/sre-book/launch-checklist/"
      - key: w7_gonogo
        title: "Go/no-go встреча"
        description: "Созвон 30-60 мин: проход по release checklist, решение о выкладке."
        type: ritual
        ritual_kind: call
        required: true
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["ritual_fields"]
        sources:
          - "https://sre.google/sre-book/launch-checklist/"
  - key: w8_wrapup
    title: "Ретроспектива и итоги"
    goal: "Разобрать проект, зафиксировать действия и подготовить итоговое описание для портфолио; сдать ссылки на релиз и репозиторий."
    duration_days: 7
    exit_criteria: "Не более 3 действий с владельцем и сроком; ссылка на работающий релиз и на репозиторий проверены платформой."
    steps:
      - key: w8_demo
        title: "Итоговое демо"
        description: "Созвон: показ работающего продукта (запись допускается)."
        type: ritual
        ritual_kind: call
        required: true
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["ritual_fields"]
        sources:
          - "https://sre.google/sre-book/launch-checklist/"
          - "https://scrumguides.org/scrum-guide.html"
      - key: w8_retro
        title: "Ретроспектива проекта"
        description: "Созвон 1-1,5 ч: что получилось, что нет, что меняем."
        type: ritual
        ritual_kind: retro
        required: true
        owner_role: pm
        alt_roles: []
        fallback:
          title: "Ретро по шаблону из трёх вопросов"
          instruction: "Любой участник ведёт ретро по шаблону: что получилось, что нет, что меняем."
          template: tpl_retro
        review_checklist: false
        auto_checks: ["ritual_fields"]
        sources:
          - "https://scrumguides.org/scrum-guide.html"
      - key: w8_retro_doc
        title: "Retro-документ и backlog улучшений"
        description: "Не более 3 действий с владельцем и сроком; проверены действия прошлых ретро."
        type: artifact
        submission: file
        required: true
        owner_role: pm
        alt_roles: []
        fallback:
          title: "Retro-документ по шаблону"
          instruction: "Заполнить шаблон ретро."
          template: tpl_retro
        review_checklist: true
        review_items:
          - "Обсуждено, что получилось, что нет, что меняем?"
          - "Не более 3 действий с владельцем и сроком?"
          - "Действия прошлой ретроспективы проверены?"
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://scrumguides.org/scrum-guide.html"
      - key: w8_portfolio
        title: "Описание проекта для портфолио"
        description: "Описание: проблема, решение, роли, стек, результаты, ссылки."
        type: artifact
        submission: either
        required: true
        owner_role: pm
        alt_roles: []
        fallback:
          title: "Описание проекта по шаблону"
          instruction: "Заполнить шаблон описания проекта для портфолио."
          template: tpl_portfolio
        review_checklist: false
        auto_checks: ["file_ok", "sha_dedup", "link_https", "md_headings"]
        sources:
          - "https://scrumguides.org/scrum-guide.html"
          - "https://www.workingbackwards.com/resources/working-backwards-pr-faq/"
      - key: w8_final_links
        title: "Ссылка на работающий релиз и репозиторий"
        description: "Две ссылки: публичный URL работающего релиза и репозиторий GitHub. Обязательны для завершения проекта."
        type: artifact
        submission: link
        required: true
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["link_https", "release_alive_web", "repo_final"]
        sources:
          - "https://sre.google/sre-book/launch-checklist/"
          - "https://scrumguides.org/scrum-guide.html"
```

## 4. Сценарий «ML-продукт» (`ml_product`, версия 1.0.0)

Маршрут: 8 этапов, 13 недель. Основа: CRISP-DM 1.0 и CRISP-ML(Q) (фазы и выходы), Google Rules of Machine Learning, ML Test Score, Model Cards, Datasheets for Datasets, MLOps level 0; спринты и ретро из Scrum.

### 4.1. Что считается ссылкой на работающий релиз ML-продукта

Закрывает пункт LOW из `docs/backlog.md` (этап «Релиз» для ML). Определение **[решение автора]**, вынесено на вычитку.

Релизом считается только работающий публичный адрес `https`, по которому видна работа модели вне ноутбука разработчика. Допустимы:

1. **Демо-страница** с формой или готовыми примерами, возвращающая предсказание модели.
2. **API**: ссылка на страницу документации API (например, `/docs`) либо на `GET /health` (проверка состояния), отвечающий HTTP 200; в README репозитория указан пример запроса и ответа.

Вариантов без публичного адреса (архив, контейнер или страница GitHub Releases без работающего сервиса) нет: они не удовлетворяют требованию «ссылка на работающий релиз» и платформой не принимаются, даже по решению тимлида. Если разворачивать сервис негде, команда выбирает хостинг из списка в разделе 5.2 (в том числе собственный VPS); локальный запуск и запись экрана остаются только запасным вариантом демо на go/no-go (раздел 5.2).

Проверка платформы (`release_alive_ml`): адрес отвечает HTTP 200 при двух проверках с интервалом не менее 24 ч; тело не пустое (HTML не меньше 500 байт или непустой корректный JSON, для `/health` достаточно JSON любого размера); полный адрес (имя хоста и путь) не повторяется в других зачтённых проектах. Что модель действительно отвечает, не проверяется автоматически: это ручная проверка на встрече go/no-go (выполнить пример запроса из README) и проверка человеком в очереди ручной проверки при подозрениях. Репозиторий проверяется так же, как у веб-сервиса (`repo_final`).

### 4.2. Этапы


| Этап | Название | Срок, дней | Цель | Критерий перехода |
|---|---|---|---|---|
| 1 (`m1_problem`) | Постановка задачи | 7 | Сформулировать бизнес-метрику, ML-метрику и минимально приемлемый уровень; решить, нужен ли ML вообще. | Метрики и минимальный уровень записаны; ML оправдан перед эвристикой; есть правило остановки при нехватке данных. Все обязательные шаги выполнены, пункты ревью «да» либо нет-пункты приняты как риск. |
| 2 (`m2_data`) | Сбор и разметка данных | 21 | Получить данные нужного объёма, описать их, разметить и зафиксировать версию набора; либо вовремя остановиться. | Данные есть в достаточном объёме или принято решение остановиться/сменить задачу; версия набора зафиксирована. |
| 3 (`m3_eda`) | Разведочный анализ и качество данных | 7 | Описать данные и принять решения по очистке до построения моделей. | Отчёт ревьюирован; решения по очистке записаны. |
| 4 (`m4_baseline`) | Разбиение данных и базовая модель | 7 | Зафиксировать правила оценки до моделирования и получить точку отсчёта (baseline). | Baseline посчитан и записан; тестовый набор нетронут. |
| 5 (`m5_experiments`) | Эксперименты | 21 | Пройти путь от простых моделей к сложным, получить воспроизводимую модель лучше baseline. | Модель лучше baseline на согласованную заранее величину; обучение воспроизводится из чистого checkout. |
| 6 (`m6_evaluation`) | Оценка и model card | 7 | Один раз честно оценить модель на тестовом наборе, разобрать ошибки и решить, идти ли дальше. | Минимально приемлемый уровень достигнут; решение «идём дальше / возвращаемся / останавливаемся» записано. |
| 7 (`m7_serving`) | Сервинг, API и интеграция | 11 | Обернуть модель в API с той же предобработкой, что при обучении, и подключить к интерфейсу. | Модель на сервинге даёт те же ответы на контрольной выборке; интеграционный тест проходит. |
| 8 (`m8_release`) | Деплой, мониторинг, релиз и ретро | 10 | Выкатить сервис с запасным вариантом и мониторингом, подвести итоги, сдать ссылки на релиз и репозиторий. | Запасной вариант работает; мониторинг включён; отчёт готов; ссылка на работающий релиз и на репозиторий проверены платформой. |

Сумма: 91 дней = 13 недель.

#### Этап 1. Постановка задачи (7 дн.)

| Ключ | Название и описание | Тип | Обяз. | Роль (запасные роли) | Запасной шаг | Ревью | Авто-проверки | Источник |
|---|---|---|---|---|---|---|---|---|
| `m1_kickoff` | **Kickoff команды.** Созвон 1 ч: цель проекта, роли, правила работы. | ритуал: созвон | да | любая | не нужен | нет | `ritual_fields` | [CRISP-ML(Q)](https://arxiv.org/pdf/2003.05155), [TDSP Charter](https://raw.githubusercontent.com/Azure/Azure-TDSP-ProjectTemplate/master/Docs/Project/Charter.md) |
| `m1_repo` | **Репозиторий проекта.** Ссылка на репозиторий GitHub; структура: данные (ссылки), код, документы. | артефакт: ссылка | да | любая | не нужен | нет | `link_https`, `repo_exists` | [TDSP Charter](https://raw.githubusercontent.com/Azure/Azure-TDSP-ProjectTemplate/master/Docs/Project/Charter.md), [DVC](https://doc.dvc.org/start) |
| `m1_charter` | **Charter проекта.** Бизнес-фон, бизнес-метрика и её текущее значение, ML-метрика и минимально приемлемый уровень, план, архитектура на одном слайде. | артефакт: файл | да | менеджер проекта (продуктовый аналитик, бизнес-аналитик) | Charter по шаблону ML (`tpl_charter_ml`) | да | `file_ok`, `sha_dedup`, `md_headings` | [CRISP-ML(Q)](https://arxiv.org/pdf/2003.05155), [CRISP-DM 1.0](https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf), [Rules of ML](https://developers.google.com/machine-learning/guides/rules-of-ml), [TDSP Charter](https://raw.githubusercontent.com/Azure/Azure-TDSP-ProjectTemplate/master/Docs/Project/Charter.md) |
| `m1_no_ml` | **Заметка об осуществимости и вариант без ML.** Оценка: хватит ли эвристики; если нет, почему нужен ML; какие данные нужны. | артефакт: файл | да | продуктовый аналитик (ML-инженер, бизнес-аналитик) | Вопрос «а можно без ML?» по шаблону (`tpl_charter_ml`) | да | `file_ok`, `sha_dedup`, `md_headings` | [Rules of ML](https://developers.google.com/machine-learning/guides/rules-of-ml), [CRISP-ML(Q)](https://arxiv.org/pdf/2003.05155) |
| `m1_risks` | **Риски, правило остановки, ограничения.** Реестр рисков; правило остановки при нехватке данных; юридические ограничения и персональные данные. | артефакт: файл | да | менеджер проекта (бизнес-аналитик, продуктовый аналитик) | Реестр рисков по шаблону (`tpl_risk_register`) | да | `file_ok`, `sha_dedup`, `md_headings` | [CRISP-ML(Q)](https://arxiv.org/pdf/2003.05155), [TDSP Charter](https://raw.githubusercontent.com/Azure/Azure-TDSP-ProjectTemplate/master/Docs/Project/Charter.md) |
| `m1_review` | **Ревью Charter командой.** Созвон: команда утверждает метрики, минимальный уровень и правило остановки. | ритуал: созвон | да | любая | не нужен | нет | `ritual_fields` | [CRISP-ML(Q)](https://arxiv.org/pdf/2003.05155), [TDSP Charter](https://raw.githubusercontent.com/Azure/Azure-TDSP-ProjectTemplate/master/Docs/Project/Charter.md) |

#### Этап 2. Сбор и разметка данных (21 дн.)

| Ключ | Название и описание | Тип | Обяз. | Роль (запасные роли) | Запасной шаг | Ревью | Авто-проверки | Источник |
|---|---|---|---|---|---|---|---|---|
| `m2_collection` | **Отчёт о сборе данных.** Источник, лицензия, способ получения, объём, ограничения использования. | артефакт: файл | да | data-инженер (ML-инженер) | Готовый набор данных и шаблон отчёта (`tpl_data_report`) | да | `file_ok`, `sha_dedup`, `md_headings` | [CRISP-DM 1.0](https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf), [HF Datasets](https://huggingface.co/docs/datasets/index) |
| `m2_datasheet` | **Словарь данных и datasheet-lite.** Поля, типы, смысл; разделы datasheet: зачем собраны, состав, как собраны, допустимое использование. | артефакт: файл | да | data-инженер (ML-инженер) | Datasheet по шаблону (`tpl_datasheet`) | да | `file_ok`, `sha_dedup`, `md_headings` | [Datasheets](https://arxiv.org/pdf/1803.09010), [CRISP-DM 1.0](https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf) |
| `m2_guide` | **Инструкция разметки.** Правила разметки с примерами; если разметка не нужна, описание происхождения меток. | артефакт: файл | да | data-инженер (ML-инженер, продуктовый аналитик) | Инструкция разметки по шаблону (`tpl_labeling_guide`) | да | `file_ok`, `sha_dedup`, `md_headings` | [CRISP-DM 1.0](https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf) |
| `m2_labeling` | **Разметка парами и сверка расхождений.** Созвоны сверки: расхождения между разметчиками, правки инструкции. | ритуал: созвон | да | любая | не нужен | нет | `ritual_fields` | [CRISP-DM 1.0](https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf) |
| `m2_version` | **Версия набора данных.** Ссылка на тег/хеш набора в репозитории или DVC. | артефакт: ссылка | да | data-инженер (ML-инженер) | Хеш файла и тег в README или DVC (`tpl_data_report`) | да | `link_https` | [CRISP-ML(Q)](https://arxiv.org/pdf/2003.05155), [DVC](https://doc.dvc.org/start) |
| `m2_enough` | **Решение: данных достаточно / стоп / смена задачи.** Запись решения со ссылкой на правило остановки из Charter. | артефакт: файл | да | ML-инженер (менеджер проекта, data-инженер) | Запись решения по шаблону (`tpl_decision_record`) | нет | `file_ok`, `sha_dedup`, `md_headings` | [CRISP-ML(Q)](https://arxiv.org/pdf/2003.05155), [CRISP-DM 1.0](https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf) |

#### Этап 3. Разведочный анализ и качество данных (7 дн.)

| Ключ | Название и описание | Тип | Обяз. | Роль (запасные роли) | Запасной шаг | Ревью | Авто-проверки | Источник |
|---|---|---|---|---|---|---|---|---|
| `m3_quality` | **Отчёт о качестве данных.** Пропуски, дубликаты, баланс классов, выбросы; решения по очистке с обоснованием. | артефакт: файл | да | data-инженер (ML-инженер, продуктовый аналитик) | Чек-лист качества данных и шаблон отчёта (`tpl_dq_checklist`) | да | `file_ok`, `sha_dedup`, `md_headings` | [CRISP-DM 1.0](https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf), [ML Test Score](https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf) |
| `m3_schema` | **Схема и ожидания по данным.** Типы и допустимые диапазоны значений по полям. | артефакт: ссылка или файл | да | data-инженер (ML-инженер) | Схема по чек-листу (`tpl_dq_checklist`) | да | `file_ok`, `sha_dedup`, `link_https` | [CRISP-DM 1.0](https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf), [ML Test Score](https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf) |
| `m3_review` | **Разбор отчёта командой.** Созвон 1 ч: обсуждение отчёта и решений по очистке. | ритуал: созвон | да | любая | не нужен | нет | `ritual_fields` | [CRISP-DM 1.0](https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf) |

#### Этап 4. Разбиение данных и базовая модель (7 дн.)

| Ключ | Название и описание | Тип | Обяз. | Роль (запасные роли) | Запасной шаг | Ревью | Авто-проверки | Источник |
|---|---|---|---|---|---|---|---|---|
| `m4_design` | **Дизайн теста.** Схема разбиения train/val/test, метрики, защита от утечки. | артефакт: файл | да | ML-инженер (data-инженер, продуктовый аналитик) | Дизайн теста по шаблону (`tpl_test_design`) | да | `file_ok`, `sha_dedup`, `md_headings` | [CRISP-DM 1.0](https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf), [CRISP-ML(Q)](https://arxiv.org/pdf/2003.05155), [Rules of ML](https://developers.google.com/machine-learning/guides/rules-of-ml) |
| `m4_baseline` | **Baseline: метрика и код.** Ссылка на код/ноутбук и значение метрики простой или эвристической модели. | артефакт: ссылка | да | ML-инженер (data-инженер) | Dummy-модель из scikit-learn (`tpl_test_design`) | да | `link_https` | [CRISP-DM 1.0](https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf), [scikit-learn Dummy](https://scikit-learn.org/stable/modules/generated/sklearn.dummy.DummyClassifier.html), [Rules of ML](https://developers.google.com/machine-learning/guides/rules-of-ml) |
| `m4_review` | **Ревью дизайна теста.** Созвон 30-60 мин. | ритуал: созвон | да | любая | не нужен | нет | `ritual_fields` | [CRISP-ML(Q)](https://arxiv.org/pdf/2003.05155), [Rules of ML](https://developers.google.com/machine-learning/guides/rules-of-ml) |

#### Этап 5. Эксперименты (21 дн.)

| Ключ | Название и описание | Тип | Обяз. | Роль (запасные роли) | Запасной шаг | Ревью | Авто-проверки | Источник |
|---|---|---|---|---|---|---|---|---|
| `m5_log` | **Журнал экспериментов.** Таблица или трекер: версия данных, параметры, seed, окружение, метрика по каждому запуску. | артефакт: ссылка или файл | да | ML-инженер (data-инженер) | Журнал в таблице по шаблону (`tpl_experiment_log`) | да | `file_ok`, `sha_dedup`, `link_https` | [CRISP-ML(Q)](https://arxiv.org/pdf/2003.05155), [ML Test Score](https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf) |
| `m5_code` | **Код обучения в репозитории.** Ссылка на код обучения, запускаемый из чистого репозитория одной инструкцией. | артефакт: ссылка | да | ML-инженер (data-инженер, backend) | Один простой алгоритм и инструкция запуска (`tpl_experiment_log`) | да | `link_https`, `pr_cross_review:3` | [CRISP-ML(Q)](https://arxiv.org/pdf/2003.05155), [ML Test Score](https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf) |
| `m5_code_review` | **Код-ревью кода обучения.** Ревью PR с кодом обучения участником, не автором. | ритуал: код-ревью | да | любая | не нужен | да | `ritual_fields`, `pr_cross_review:3` | [ML Test Score](https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf), [Google ревью: что смотреть](https://google.github.io/eng-practices/review/reviewer/looking-for.html) |
| `m5_weekly` | **Еженедельный разбор экспериментов.** Созвон 1 ч: что пробовали, что дальше. | ритуал: созвон | нет | любая | не нужен | нет | `ritual_fields` | [CRISP-ML(Q)](https://arxiv.org/pdf/2003.05155) |
| `m5_selected` | **Выбранная модель и сравнение с baseline.** Документ: выбранная модель, метрики, сравнение с baseline на согласованную величину. | артефакт: файл | да | ML-инженер (data-инженер) | Сравнение по шаблону журнала (`tpl_experiment_log`) | да | `file_ok`, `sha_dedup`, `md_headings` | [CRISP-ML(Q)](https://arxiv.org/pdf/2003.05155), [ML Test Score](https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf) |
| `m5_retro` | **Review и ретро спринта.** Созвон 1-1,5 ч в конце каждого спринта (две записи за этап допустимы одной). | ритуал: ретроспектива | да | любая | не нужен | нет | `ritual_fields` | [CRISP-ML(Q)](https://arxiv.org/pdf/2003.05155) |

#### Этап 6. Оценка и model card (7 дн.)

| Ключ | Название и описание | Тип | Обяз. | Роль (запасные роли) | Запасной шаг | Ревью | Авто-проверки | Источник |
|---|---|---|---|---|---|---|---|---|
| `m6_eval` | **Отчёт об оценке.** Однократная оценка на тестовом наборе; метрики общие и по срезам. | артефакт: файл | да | ML-инженер (продуктовый аналитик, QA) | Отчёт об оценке по шаблону (`tpl_eval_report`) | да | `file_ok`, `sha_dedup`, `md_headings` | [CRISP-DM 1.0](https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf), [CRISP-ML(Q)](https://arxiv.org/pdf/2003.05155), [ML Test Score](https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf) |
| `m6_errors` | **Ручной разбор ошибок.** Разбор топ-ошибок по чек-листу. | артефакт: файл | да | QA (ML-инженер, продуктовый аналитик) | Чек-лист ручного разбора ошибок (`tpl_error_analysis`) | да | `file_ok`, `sha_dedup`, `md_headings` | [CRISP-DM 1.0](https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf), [ML Test Score](https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf) |
| `m6_model_card` | **Model card.** Назначение, неподдерживаемые применения, данные, метрики, ограничения. | артефакт: файл | да | ML-инженер (продуктовый аналитик) | Model card по шаблону (`tpl_model_card`) | да | `file_ok`, `sha_dedup`, `md_headings` | [Model Cards](https://arxiv.org/pdf/1810.03993), [CRISP-ML(Q)](https://arxiv.org/pdf/2003.05155) |
| `m6_decision` | **Запись решения.** Идём дальше / возвращаемся / останавливаемся, с обоснованием. | артефакт: файл | да | менеджер проекта (ML-инженер) | Запись решения по шаблону (`tpl_decision_record`) | да | `file_ok`, `sha_dedup`, `md_headings` | [CRISP-DM 1.0](https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf), [CRISP-ML(Q)](https://arxiv.org/pdf/2003.05155) |
| `m6_review` | **Ревью оценки.** Созвон 1 ч. | ритуал: созвон | да | любая | не нужен | нет | `ritual_fields` | [CRISP-DM 1.0](https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf), [ML Test Score](https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf) |

#### Этап 7. Сервинг, API и интеграция (11 дн.)

| Ключ | Название и описание | Тип | Обяз. | Роль (запасные роли) | Запасной шаг | Ревью | Авто-проверки | Источник |
|---|---|---|---|---|---|---|---|---|
| `m7_api_spec` | **Спецификация API.** Эндпоинты предсказания и проверки состояния: вход, выход, ошибки, ограничения. | артефакт: ссылка или файл | да | backend (ML-инженер, системный аналитик) | Мини-спецификация по шаблону (`tpl_ml_api_spec`) | да | `file_ok`, `sha_dedup`, `link_https` | [Rules of ML](https://developers.google.com/machine-learning/guides/rules-of-ml), [ML Test Score](https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf) |
| `m7_inference` | **Код инференса с общей предобработкой.** Ссылка на код сервиса; предобработка общая с обучением. | артефакт: ссылка | да | ML-инженер (backend) | Минимальный API-сервис в одном контейнере (`tpl_ml_api_spec`) | да | `link_https`, `pr_cross_review:3` | [Rules of ML](https://developers.google.com/machine-learning/guides/rules-of-ml), [ML Test Score](https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf) |
| `m7_parity` | **Тест «сервинг равен обучению».** Контрольная выборка: ответы сервиса совпадают с результатами обучения; интеграционный тест. | артефакт: ссылка или файл | да | QA (ML-инженер, backend) | Ручной тест на контрольной выборке (`tpl_ml_test_score_checklist`) | да | `file_ok`, `sha_dedup`, `link_https` | [Rules of ML](https://developers.google.com/machine-learning/guides/rules-of-ml), [ML Test Score](https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf) |
| `m7_ci` | **CI на GitHub Actions.** Ссылка на workflow: тесты и проверка сборки образа. | артефакт: ссылка | да | DevOps (backend) | Готовый шаблон CI GitHub Actions (`tpl_ci_github_actions`) | нет | `link_https`, `ci_workflow` | [GitHub starter workflows](https://docs.github.com/en/actions/writing-workflows/using-starter-workflows), [ML Test Score](https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf) |
| `m7_latency` | **Замеры задержки и ресурсов.** Задержка и потребление памяти на типичной нагрузке. | артефакт: файл | да | backend (DevOps, ML-инженер) | Замер по инструкции шаблона (`tpl_ml_api_spec`) | да | `file_ok`, `sha_dedup` | [ML Test Score](https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf), [Rules of ML](https://developers.google.com/machine-learning/guides/rules-of-ml) |
| `m7_ui` | **Интерфейс или демо-страница.** Ссылка на страницу, где можно получить предсказание. | артефакт: ссылка | да | frontend (дизайнер) | Готовый UI-кит и простая демо-страница (`tpl_ui_kit_guide`) | нет | `link_https` | [Rules of ML](https://developers.google.com/machine-learning/guides/rules-of-ml), [Bootstrap](https://getbootstrap.com/docs/5.3/getting-started/introduction/), [shadcn/ui](https://ui.shadcn.com/docs) |
| `m7_api_review` | **Ревью API командой.** Созвон 1 ч. | ритуал: созвон | да | любая | не нужен | нет | `ritual_fields` | [Rules of ML](https://developers.google.com/machine-learning/guides/rules-of-ml), [ML Test Score](https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf) |
| `m7_retro` | **Review и ретро спринта.** Созвон 1-1,5 ч. | ритуал: ретроспектива | да | любая | не нужен | нет | `ritual_fields` | [CRISP-ML(Q)](https://arxiv.org/pdf/2003.05155) |

#### Этап 8. Деплой, мониторинг, релиз и ретро (10 дн.)

| Ключ | Название и описание | Тип | Обяз. | Роль (запасные роли) | Запасной шаг | Ревью | Авто-проверки | Источник |
|---|---|---|---|---|---|---|---|---|
| `m8_deploy` | **План деплоя и отката.** Как выкладывается версия, как откатывается на предыдущую или эвристику; автоматическая проверка на отложенных данных перед выкладкой. | артефакт: файл | да | DevOps (backend, ML-инженер) | План деплоя уровня MLOps 0 (`tpl_mlops0_deploy`) | да | `file_ok`, `sha_dedup`, `md_headings` | [CRISP-DM 1.0](https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf), [CRISP-ML(Q)](https://arxiv.org/pdf/2003.05155), [MLOps levels](https://docs.cloud.google.com/architecture/mlops-continuous-delivery-and-automation-pipelines-in-machine-learning), [Rules of ML](https://developers.google.com/machine-learning/guides/rules-of-ml) |
| `m8_monitoring` | **План мониторинга и логирование.** Логирование статистики входов и распределения предсказаний; условие переобучения; владелец тихих сбоев. | артефакт: файл | да | DevOps (backend, ML-инженер) | Лог входов и предсказаний и один алерт (`tpl_mlops0_deploy`) | да | `file_ok`, `sha_dedup`, `md_headings` | [CRISP-ML(Q)](https://arxiv.org/pdf/2003.05155), [ML Test Score](https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf), [Rules of ML](https://developers.google.com/machine-learning/guides/rules-of-ml) |
| `m8_fallback` | **Запасной вариант в работе.** Предыдущая версия или эвристика из заметки об осуществимости; ссылка и описание переключения. | артефакт: ссылка или файл | да | ML-инженер (backend) | Эвристика из заметки об осуществимости (`tpl_mlops0_deploy`) | нет | `file_ok`, `sha_dedup`, `link_https` | [CRISP-ML(Q)](https://arxiv.org/pdf/2003.05155), [Rules of ML](https://developers.google.com/machine-learning/guides/rules-of-ml) |
| `m8_user_guide` | **Руководство пользователя и отказ от ответственности.** Как пользоваться, что модель не умеет, ответственность. | артефакт: файл | да | продуктовый аналитик (менеджер проекта, бизнес-аналитик) | Руководство по шаблону (`tpl_user_guide_ml`) | да | `file_ok`, `sha_dedup`, `md_headings` | [Model Cards](https://arxiv.org/pdf/1810.03993), [CRISP-ML(Q)](https://arxiv.org/pdf/2003.05155) |
| `m8_test_score` | **Самопроверка ML Test Score.** Заполненный чек-лист ML Test Score с оценкой. | артефакт: файл | да | QA (ML-инженер) | Чек-лист ML Test Score как ручная самопроверка (`tpl_ml_test_score_checklist`) | нет | `file_ok`, `sha_dedup` | [ML Test Score](https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf) |
| `m8_exit` | **Exit Report.** Итоговый отчёт: что сделано, результаты, ограничения, что дальше. | артефакт: файл | да | менеджер проекта (продуктовый аналитик) | Exit Report по шаблону (`tpl_exit_report`) | да | `file_ok`, `sha_dedup`, `md_headings` | [TDSP Exit Report](https://raw.githubusercontent.com/Azure/Azure-TDSP-ProjectTemplate/master/Docs/Project/Exit%20Report.md), [CRISP-DM 1.0](https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf) |
| `m8_gonogo` | **Go/no-go встреча.** Созвон 30-60 мин: проход по плану деплоя и чек-листу. | ритуал: созвон | да | любая | не нужен | нет | `ritual_fields` | [CRISP-DM 1.0](https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf), [ML Test Score](https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf) |
| `m8_retro` | **Ретроспектива.** Созвон 1-1,5 ч. | ритуал: ретроспектива | да | менеджер проекта | Ретро по шаблону из трёх вопросов (`tpl_retro`) | нет | `ritual_fields` | [CRISP-ML(Q)](https://arxiv.org/pdf/2003.05155) |
| `m8_final_links` | **Ссылка на работающий релиз и репозиторий.** Публичный URL работающего ML-сервиса (демо или API, см. определение релиза) и репозиторий GitHub. Обязательны для завершения проекта. | артефакт: ссылка | да | любая | не нужен | нет | `link_https`, `release_alive_ml`, `repo_final` | [CRISP-ML(Q)](https://arxiv.org/pdf/2003.05155), [MLOps levels](https://docs.cloud.google.com/architecture/mlops-continuous-delivery-and-automation-pipelines-in-machine-learning) |

### 4.3. YAML (сид-данные)

```yaml
product_type: ml_product
title: "ML-продукт"
version: "1.0.0"
total_days: 91
stages:
  - key: m1_problem
    title: "Постановка задачи"
    goal: "Сформулировать бизнес-метрику, ML-метрику и минимально приемлемый уровень; решить, нужен ли ML вообще."
    duration_days: 7
    exit_criteria: "Метрики и минимальный уровень записаны; ML оправдан перед эвристикой; есть правило остановки при нехватке данных. Все обязательные шаги выполнены, пункты ревью «да» либо нет-пункты приняты как риск."
    steps:
      - key: m1_kickoff
        title: "Kickoff команды"
        description: "Созвон 1 ч: цель проекта, роли, правила работы."
        type: ritual
        ritual_kind: call
        required: true
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["ritual_fields"]
        sources:
          - "https://arxiv.org/pdf/2003.05155"
          - "https://raw.githubusercontent.com/Azure/Azure-TDSP-ProjectTemplate/master/Docs/Project/Charter.md"
      - key: m1_repo
        title: "Репозиторий проекта"
        description: "Ссылка на репозиторий GitHub; структура: данные (ссылки), код, документы."
        type: artifact
        submission: link
        required: true
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["link_https", "repo_exists"]
        sources:
          - "https://raw.githubusercontent.com/Azure/Azure-TDSP-ProjectTemplate/master/Docs/Project/Charter.md"
          - "https://doc.dvc.org/start"
      - key: m1_charter
        title: "Charter проекта"
        description: "Бизнес-фон, бизнес-метрика и её текущее значение, ML-метрика и минимально приемлемый уровень, план, архитектура на одном слайде."
        type: artifact
        submission: file
        required: true
        owner_role: pm
        alt_roles: ["product_analyst", "ba"]
        fallback:
          title: "Charter по шаблону ML"
          instruction: "Заполнить шаблон Charter платформы (по мотивам TDSP). Метрику и минимальный уровень задаёт тимлид вместе с командой."
          template: tpl_charter_ml
          url: "https://raw.githubusercontent.com/Azure/Azure-TDSP-ProjectTemplate/master/Docs/Project/Charter.md"
        review_checklist: true
        review_items:
          - "Бизнес-метрика, её текущее значение и способ измерения записаны?"
          - "До моделирования задан минимально приемлемый уровень ML-метрики?"
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://arxiv.org/pdf/2003.05155"
          - "https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf"
          - "https://developers.google.com/machine-learning/guides/rules-of-ml"
          - "https://raw.githubusercontent.com/Azure/Azure-TDSP-ProjectTemplate/master/Docs/Project/Charter.md"
      - key: m1_no_ml
        title: "Заметка об осуществимости и вариант без ML"
        description: "Оценка: хватит ли эвристики; если нет, почему нужен ML; какие данные нужны."
        type: artifact
        submission: file
        required: true
        owner_role: product_analyst
        alt_roles: ["ml_engineer", "ba"]
        fallback:
          title: "Вопрос «а можно без ML?» по шаблону"
          instruction: "Заполнить раздел шаблона Charter про вариант без ML (Rule 1 из Rules of ML): опишите эвристику и оцените её."
          template: tpl_charter_ml
          url: "https://developers.google.com/machine-learning/guides/rules-of-ml"
        review_checklist: true
        review_items:
          - "Описан вариант без ML (эвристика) и оценён?"
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://developers.google.com/machine-learning/guides/rules-of-ml"
          - "https://arxiv.org/pdf/2003.05155"
      - key: m1_risks
        title: "Риски, правило остановки, ограничения"
        description: "Реестр рисков; правило остановки при нехватке данных; юридические ограничения и персональные данные."
        type: artifact
        submission: file
        required: true
        owner_role: pm
        alt_roles: ["ba", "product_analyst"]
        fallback:
          title: "Реестр рисков по шаблону"
          instruction: "Заполнить шаблон реестра рисков и ограничений."
          template: tpl_risk_register
        review_checklist: true
        review_items:
          - "Есть правило остановки, если данных недостаточно?"
          - "Перечислены юридические ограничения и персональные данные?"
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://arxiv.org/pdf/2003.05155"
          - "https://raw.githubusercontent.com/Azure/Azure-TDSP-ProjectTemplate/master/Docs/Project/Charter.md"
      - key: m1_review
        title: "Ревью Charter командой"
        description: "Созвон: команда утверждает метрики, минимальный уровень и правило остановки."
        type: ritual
        ritual_kind: call
        required: true
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["ritual_fields"]
        sources:
          - "https://arxiv.org/pdf/2003.05155"
          - "https://raw.githubusercontent.com/Azure/Azure-TDSP-ProjectTemplate/master/Docs/Project/Charter.md"
  - key: m2_data
    title: "Сбор и разметка данных"
    goal: "Получить данные нужного объёма, описать их, разметить и зафиксировать версию набора; либо вовремя остановиться."
    duration_days: 21
    exit_criteria: "Данные есть в достаточном объёме или принято решение остановиться/сменить задачу; версия набора зафиксирована."
    steps:
      - key: m2_collection
        title: "Отчёт о сборе данных"
        description: "Источник, лицензия, способ получения, объём, ограничения использования."
        type: artifact
        submission: file
        required: true
        owner_role: data_engineer
        alt_roles: ["ml_engineer"]
        fallback:
          title: "Готовый набор данных и шаблон отчёта"
          instruction: "Взять готовый открытый набор данных (например, из Hugging Face Datasets) и заполнить шаблон отчёта о данных, включая лицензию."
          template: tpl_data_report
          url: "https://huggingface.co/docs/datasets/index"
        review_checklist: true
        review_items:
          - "Источник и лицензия данных записаны?"
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf"
          - "https://huggingface.co/docs/datasets/index"
      - key: m2_datasheet
        title: "Словарь данных и datasheet-lite"
        description: "Поля, типы, смысл; разделы datasheet: зачем собраны, состав, как собраны, допустимое использование."
        type: artifact
        submission: file
        required: true
        owner_role: data_engineer
        alt_roles: ["ml_engineer"]
        fallback:
          title: "Datasheet по шаблону"
          instruction: "Заполнить шаблон datasheet-lite платформы."
          template: tpl_datasheet
        review_checklist: true
        review_items:
          - "Заполнены разделы datasheet-lite (зачем собраны, состав, как собраны, допустимое использование)?"
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://arxiv.org/pdf/1803.09010"
          - "https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf"
      - key: m2_guide
        title: "Инструкция разметки"
        description: "Правила разметки с примерами; если разметка не нужна, описание происхождения меток."
        type: artifact
        submission: file
        required: true
        owner_role: data_engineer
        alt_roles: ["ml_engineer", "product_analyst"]
        fallback:
          title: "Инструкция разметки по шаблону"
          instruction: "Заполнить шаблон инструкции разметки; выборку размечают двое."
          template: tpl_labeling_guide
        review_checklist: true
        review_items:
          - "Инструкция разметки написана, выборка размечена двумя людьми?"
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf"
      - key: m2_labeling
        title: "Разметка парами и сверка расхождений"
        description: "Созвоны сверки: расхождения между разметчиками, правки инструкции."
        type: ritual
        ritual_kind: call
        required: true
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["ritual_fields"]
        sources:
          - "https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf"
      - key: m2_version
        title: "Версия набора данных"
        description: "Ссылка на тег/хеш набора в репозитории или DVC."
        type: artifact
        submission: link
        required: true
        owner_role: data_engineer
        alt_roles: ["ml_engineer"]
        fallback:
          title: "Хеш файла и тег в README или DVC"
          instruction: "Записать хеш файлов набора в README и поставить тег; по возможности использовать DVC."
          template: tpl_data_report
          url: "https://doc.dvc.org/start"
        review_checklist: true
        review_items:
          - "Версия набора зафиксирована (хеш/тег)?"
        auto_checks: ["link_https"]
        sources:
          - "https://arxiv.org/pdf/2003.05155"
          - "https://doc.dvc.org/start"
      - key: m2_enough
        title: "Решение: данных достаточно / стоп / смена задачи"
        description: "Запись решения со ссылкой на правило остановки из Charter."
        type: artifact
        submission: file
        required: true
        owner_role: ml_engineer
        alt_roles: ["pm", "data_engineer"]
        fallback:
          title: "Запись решения по шаблону"
          instruction: "Тимлид заполняет шаблон записи решения."
          template: tpl_decision_record
        review_checklist: false
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://arxiv.org/pdf/2003.05155"
          - "https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf"
  - key: m3_eda
    title: "Разведочный анализ и качество данных"
    goal: "Описать данные и принять решения по очистке до построения моделей."
    duration_days: 7
    exit_criteria: "Отчёт ревьюирован; решения по очистке записаны."
    steps:
      - key: m3_quality
        title: "Отчёт о качестве данных"
        description: "Пропуски, дубликаты, баланс классов, выбросы; решения по очистке с обоснованием."
        type: artifact
        submission: file
        required: true
        owner_role: data_engineer
        alt_roles: ["ml_engineer", "product_analyst"]
        fallback:
          title: "Чек-лист качества данных и шаблон отчёта"
          instruction: "Пройти чек-лист качества данных и заполнить шаблон отчёта."
          template: tpl_dq_checklist
        review_checklist: true
        review_items:
          - "Доли пропусков и дубликатов указаны?"
          - "Баланс классов указан?"
          - "Решения по очистке и обоснование записаны?"
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf"
          - "https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf"
      - key: m3_schema
        title: "Схема и ожидания по данным"
        description: "Типы и допустимые диапазоны значений по полям."
        type: artifact
        submission: either
        required: true
        owner_role: data_engineer
        alt_roles: ["ml_engineer"]
        fallback:
          title: "Схема по чек-листу"
          instruction: "Заполнить раздел схемы в шаблоне отчёта о качестве данных."
          template: tpl_dq_checklist
        review_checklist: true
        review_items:
          - "Схема с типами и диапазонами записана?"
        auto_checks: ["file_ok", "sha_dedup", "link_https"]
        sources:
          - "https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf"
          - "https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf"
      - key: m3_review
        title: "Разбор отчёта командой"
        description: "Созвон 1 ч: обсуждение отчёта и решений по очистке."
        type: ritual
        ritual_kind: call
        required: true
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["ritual_fields"]
        sources:
          - "https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf"
  - key: m4_baseline
    title: "Разбиение данных и базовая модель"
    goal: "Зафиксировать правила оценки до моделирования и получить точку отсчёта (baseline)."
    duration_days: 7
    exit_criteria: "Baseline посчитан и записан; тестовый набор нетронут."
    steps:
      - key: m4_design
        title: "Дизайн теста"
        description: "Схема разбиения train/val/test, метрики, защита от утечки."
        type: artifact
        submission: file
        required: true
        owner_role: ml_engineer
        alt_roles: ["data_engineer", "product_analyst"]
        fallback:
          title: "Дизайн теста по шаблону"
          instruction: "Заполнить шаблон дизайна теста: разбиение, метрики, проверка утечки и дубликатов."
          template: tpl_test_design
        review_checklist: true
        review_items:
          - "Разбиение train/val/test задано до моделирования, тест не трогали?"
          - "Разбиение учитывает время или группы (один пользователь не в двух частях)?"
          - "Дубликаты между частями проверены?"
          - "Признаки проверены на утечку целевой переменной?"
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf"
          - "https://arxiv.org/pdf/2003.05155"
          - "https://developers.google.com/machine-learning/guides/rules-of-ml"
      - key: m4_baseline
        title: "Baseline: метрика и код"
        description: "Ссылка на код/ноутбук и значение метрики простой или эвристической модели."
        type: artifact
        submission: link
        required: true
        owner_role: ml_engineer
        alt_roles: ["data_engineer"]
        fallback:
          title: "Dummy-модель из scikit-learn"
          instruction: "Использовать DummyClassifier или DummyRegressor и записать метрику."
          template: tpl_test_design
          url: "https://scikit-learn.org/stable/modules/generated/sklearn.dummy.DummyClassifier.html"
        review_checklist: true
        review_items:
          - "Метрика baseline записана?"
        auto_checks: ["link_https"]
        sources:
          - "https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf"
          - "https://scikit-learn.org/stable/modules/generated/sklearn.dummy.DummyClassifier.html"
          - "https://developers.google.com/machine-learning/guides/rules-of-ml"
      - key: m4_review
        title: "Ревью дизайна теста"
        description: "Созвон 30-60 мин."
        type: ritual
        ritual_kind: call
        required: true
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["ritual_fields"]
        sources:
          - "https://arxiv.org/pdf/2003.05155"
          - "https://developers.google.com/machine-learning/guides/rules-of-ml"
  - key: m5_experiments
    title: "Эксперименты"
    goal: "Пройти путь от простых моделей к сложным, получить воспроизводимую модель лучше baseline."
    duration_days: 21
    exit_criteria: "Модель лучше baseline на согласованную заранее величину; обучение воспроизводится из чистого checkout."
    steps:
      - key: m5_log
        title: "Журнал экспериментов"
        description: "Таблица или трекер: версия данных, параметры, seed, окружение, метрика по каждому запуску."
        type: artifact
        submission: either
        required: true
        owner_role: ml_engineer
        alt_roles: ["data_engineer"]
        fallback:
          title: "Журнал в таблице по шаблону"
          instruction: "Вести журнал в таблице шаблона и использовать один предобученный или простой классический алгоритм вместо подбора архитектур."
          template: tpl_experiment_log
        review_checklist: true
        review_items:
          - "Каждый запуск записан: версия данных, параметры, seed, окружение?"
          - "Результаты указаны как среднее и разброс по seed, а не лучший запуск?"
        auto_checks: ["file_ok", "sha_dedup", "link_https"]
        sources:
          - "https://arxiv.org/pdf/2003.05155"
          - "https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf"
      - key: m5_code
        title: "Код обучения в репозитории"
        description: "Ссылка на код обучения, запускаемый из чистого репозитория одной инструкцией."
        type: artifact
        submission: link
        required: true
        owner_role: ml_engineer
        alt_roles: ["data_engineer", "backend"]
        fallback:
          title: "Один простой алгоритм и инструкция запуска"
          instruction: "Реализовать один простой алгоритм и записать команду запуска в README."
          template: tpl_experiment_log
        review_checklist: true
        review_items:
          - "Скрипт обучения запускается из чистого репозитория?"
        auto_checks: ["link_https", "pr_cross_review:3"]
        sources:
          - "https://arxiv.org/pdf/2003.05155"
          - "https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf"
      - key: m5_code_review
        title: "Код-ревью кода обучения"
        description: "Ревью PR с кодом обучения участником, не автором."
        type: ritual
        ritual_kind: code_review
        required: true
        owner_role: any
        fallback: null
        review_checklist: true
        review_items:
          - "Код обучения прошёл ревью другого участника?"
        auto_checks: ["ritual_fields", "pr_cross_review:3"]
        sources:
          - "https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf"
          - "https://google.github.io/eng-practices/review/reviewer/looking-for.html"
      - key: m5_weekly
        title: "Еженедельный разбор экспериментов"
        description: "Созвон 1 ч: что пробовали, что дальше."
        type: ritual
        ritual_kind: call
        required: false
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["ritual_fields"]
        sources:
          - "https://arxiv.org/pdf/2003.05155"
      - key: m5_selected
        title: "Выбранная модель и сравнение с baseline"
        description: "Документ: выбранная модель, метрики, сравнение с baseline на согласованную величину."
        type: artifact
        submission: file
        required: true
        owner_role: ml_engineer
        alt_roles: ["data_engineer"]
        fallback:
          title: "Сравнение по шаблону журнала"
          instruction: "Заполнить итоговую таблицу в шаблоне журнала экспериментов."
          template: tpl_experiment_log
        review_checklist: true
        review_items:
          - "Модель лучше baseline на согласованную величину?"
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://arxiv.org/pdf/2003.05155"
          - "https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf"
      - key: m5_retro
        title: "Review и ретро спринта"
        description: "Созвон 1-1,5 ч в конце каждого спринта (две записи за этап допустимы одной)."
        type: ritual
        ritual_kind: retro
        required: true
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["ritual_fields"]
        sources:
          - "https://arxiv.org/pdf/2003.05155"
  - key: m6_evaluation
    title: "Оценка и model card"
    goal: "Один раз честно оценить модель на тестовом наборе, разобрать ошибки и решить, идти ли дальше."
    duration_days: 7
    exit_criteria: "Минимально приемлемый уровень достигнут; решение «идём дальше / возвращаемся / останавливаемся» записано."
    steps:
      - key: m6_eval
        title: "Отчёт об оценке"
        description: "Однократная оценка на тестовом наборе; метрики общие и по срезам."
        type: artifact
        submission: file
        required: true
        owner_role: ml_engineer
        alt_roles: ["product_analyst", "qa"]
        fallback:
          title: "Отчёт об оценке по шаблону"
          instruction: "Заполнить шаблон отчёта об оценке."
          template: tpl_eval_report
        review_checklist: true
        review_items:
          - "Тестовый набор использован один раз?"
          - "Метрики по срезам указаны?"
          - "Минимально приемлемый уровень достигнут?"
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf"
          - "https://arxiv.org/pdf/2003.05155"
          - "https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf"
      - key: m6_errors
        title: "Ручной разбор ошибок"
        description: "Разбор топ-ошибок по чек-листу."
        type: artifact
        submission: file
        required: true
        owner_role: qa
        alt_roles: ["ml_engineer", "product_analyst"]
        fallback:
          title: "Чек-лист ручного разбора ошибок"
          instruction: "Любой участник проходит чек-лист и записывает типы ошибок."
          template: tpl_error_analysis
        review_checklist: true
        review_items:
          - "Топ ошибок разобраны вручную?"
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf"
          - "https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf"
      - key: m6_model_card
        title: "Model card"
        description: "Назначение, неподдерживаемые применения, данные, метрики, ограничения."
        type: artifact
        submission: file
        required: true
        owner_role: ml_engineer
        alt_roles: ["product_analyst"]
        fallback:
          title: "Model card по шаблону"
          instruction: "Заполнить шаблон model card платформы."
          template: tpl_model_card
          url: "https://arxiv.org/pdf/1810.03993"
        review_checklist: true
        review_items:
          - "В model card есть назначение, неподдерживаемые применения, ограничения?"
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://arxiv.org/pdf/1810.03993"
          - "https://arxiv.org/pdf/2003.05155"
      - key: m6_decision
        title: "Запись решения"
        description: "Идём дальше / возвращаемся / останавливаемся, с обоснованием."
        type: artifact
        submission: file
        required: true
        owner_role: pm
        alt_roles: ["ml_engineer"]
        fallback:
          title: "Запись решения по шаблону"
          instruction: "Тимлид заполняет шаблон записи решения."
          template: tpl_decision_record
        review_checklist: true
        review_items:
          - "Решение (идти дальше / вернуться / стоп) записано?"
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf"
          - "https://arxiv.org/pdf/2003.05155"
      - key: m6_review
        title: "Ревью оценки"
        description: "Созвон 1 ч."
        type: ritual
        ritual_kind: call
        required: true
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["ritual_fields"]
        sources:
          - "https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf"
          - "https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf"
  - key: m7_serving
    title: "Сервинг, API и интеграция"
    goal: "Обернуть модель в API с той же предобработкой, что при обучении, и подключить к интерфейсу."
    duration_days: 11
    exit_criteria: "Модель на сервинге даёт те же ответы на контрольной выборке; интеграционный тест проходит."
    steps:
      - key: m7_api_spec
        title: "Спецификация API"
        description: "Эндпоинты предсказания и проверки состояния: вход, выход, ошибки, ограничения."
        type: artifact
        submission: either
        required: true
        owner_role: backend
        alt_roles: ["ml_engineer", "system_analyst"]
        fallback:
          title: "Мини-спецификация по шаблону"
          instruction: "Заполнить шаблон: эндпоинт, вход, выход, коды ошибок."
          template: tpl_ml_api_spec
        review_checklist: true
        review_items:
          - "Вход вне схемы отклоняется?"
        auto_checks: ["file_ok", "sha_dedup", "link_https"]
        sources:
          - "https://developers.google.com/machine-learning/guides/rules-of-ml"
          - "https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf"
      - key: m7_inference
        title: "Код инференса с общей предобработкой"
        description: "Ссылка на код сервиса; предобработка общая с обучением."
        type: artifact
        submission: link
        required: true
        owner_role: ml_engineer
        alt_roles: ["backend"]
        fallback:
          title: "Минимальный API-сервис в одном контейнере"
          instruction: "Собрать минимальный сервис в одном контейнере по шаблону."
          template: tpl_ml_api_spec
        review_checklist: true
        review_items:
          - "Предобработка одна и та же при обучении и сервинге?"
        auto_checks: ["link_https", "pr_cross_review:3"]
        sources:
          - "https://developers.google.com/machine-learning/guides/rules-of-ml"
          - "https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf"
      - key: m7_parity
        title: "Тест «сервинг равен обучению»"
        description: "Контрольная выборка: ответы сервиса совпадают с результатами обучения; интеграционный тест."
        type: artifact
        submission: either
        required: true
        owner_role: qa
        alt_roles: ["ml_engineer", "backend"]
        fallback:
          title: "Ручной тест на контрольной выборке"
          instruction: "Проверить вручную по чек-листу ML Test Score (ручной тест даёт 0,5 балла, автоматический 1)."
          template: tpl_ml_test_score_checklist
          url: "https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf"
        review_checklist: true
        review_items:
          - "На контрольной выборке сервинг выдаёт тот же результат, что обучение?"
          - "Интеграционный тест проходит?"
        auto_checks: ["file_ok", "sha_dedup", "link_https"]
        sources:
          - "https://developers.google.com/machine-learning/guides/rules-of-ml"
          - "https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf"
      - key: m7_ci
        title: "CI на GitHub Actions"
        description: "Ссылка на workflow: тесты и проверка сборки образа."
        type: artifact
        submission: link
        required: true
        owner_role: devops
        alt_roles: ["backend"]
        fallback:
          title: "Готовый шаблон CI GitHub Actions"
          instruction: "Взять шаблон CI платформы под Python-проект."
          template: tpl_ci_github_actions
          url: "https://docs.github.com/en/actions/writing-workflows/using-starter-workflows"
        review_checklist: false
        auto_checks: ["link_https", "ci_workflow"]
        sources:
          - "https://docs.github.com/en/actions/writing-workflows/using-starter-workflows"
          - "https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf"
      - key: m7_latency
        title: "Замеры задержки и ресурсов"
        description: "Задержка и потребление памяти на типичной нагрузке."
        type: artifact
        submission: file
        required: true
        owner_role: backend
        alt_roles: ["devops", "ml_engineer"]
        fallback:
          title: "Замер по инструкции шаблона"
          instruction: "Выполнить 100 запросов по инструкции шаблона и записать задержку и память."
          template: tpl_ml_api_spec
        review_checklist: true
        review_items:
          - "Задержка и ресурсы измерены?"
        auto_checks: ["file_ok", "sha_dedup"]
        sources:
          - "https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf"
          - "https://developers.google.com/machine-learning/guides/rules-of-ml"
      - key: m7_ui
        title: "Интерфейс или демо-страница"
        description: "Ссылка на страницу, где можно получить предсказание."
        type: artifact
        submission: link
        required: true
        owner_role: frontend
        alt_roles: ["designer"]
        fallback:
          title: "Готовый UI-кит и простая демо-страница"
          instruction: "Собрать страницу из готового UI-кита (Bootstrap или shadcn/ui)."
          template: tpl_ui_kit_guide
          url: "https://getbootstrap.com/docs/5.3/getting-started/introduction/"
        review_checklist: false
        auto_checks: ["link_https"]
        sources:
          - "https://developers.google.com/machine-learning/guides/rules-of-ml"
          - "https://getbootstrap.com/docs/5.3/getting-started/introduction/"
          - "https://ui.shadcn.com/docs"
      - key: m7_api_review
        title: "Ревью API командой"
        description: "Созвон 1 ч."
        type: ritual
        ritual_kind: call
        required: true
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["ritual_fields"]
        sources:
          - "https://developers.google.com/machine-learning/guides/rules-of-ml"
          - "https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf"
      - key: m7_retro
        title: "Review и ретро спринта"
        description: "Созвон 1-1,5 ч."
        type: ritual
        ritual_kind: retro
        required: true
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["ritual_fields"]
        sources:
          - "https://arxiv.org/pdf/2003.05155"
  - key: m8_release
    title: "Деплой, мониторинг, релиз и ретро"
    goal: "Выкатить сервис с запасным вариантом и мониторингом, подвести итоги, сдать ссылки на релиз и репозиторий."
    duration_days: 10
    exit_criteria: "Запасной вариант работает; мониторинг включён; отчёт готов; ссылка на работающий релиз и на репозиторий проверены платформой."
    steps:
      - key: m8_deploy
        title: "План деплоя и отката"
        description: "Как выкладывается версия, как откатывается на предыдущую или эвристику; автоматическая проверка на отложенных данных перед выкладкой."
        type: artifact
        submission: file
        required: true
        owner_role: devops
        alt_roles: ["backend", "ml_engineer"]
        fallback:
          title: "План деплоя уровня MLOps 0"
          instruction: "Заполнить шаблон плана деплоя (ручной, но воспроизводимый запуск)."
          template: tpl_mlops0_deploy
          url: "https://docs.cloud.google.com/architecture/mlops-continuous-delivery-and-automation-pipelines-in-machine-learning"
        review_checklist: true
        review_items:
          - "Автоматическая проверка на отложенных данных перед выкладкой?"
          - "Есть откат на предыдущую версию или эвристику?"
          - "Выкатка поэтапная или для узкой группы?"
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf"
          - "https://arxiv.org/pdf/2003.05155"
          - "https://docs.cloud.google.com/architecture/mlops-continuous-delivery-and-automation-pipelines-in-machine-learning"
          - "https://developers.google.com/machine-learning/guides/rules-of-ml"
      - key: m8_monitoring
        title: "План мониторинга и логирование"
        description: "Логирование статистики входов и распределения предсказаний; условие переобучения; владелец тихих сбоев."
        type: artifact
        submission: file
        required: true
        owner_role: devops
        alt_roles: ["backend", "ml_engineer"]
        fallback:
          title: "Лог входов и предсказаний и один алерт"
          instruction: "Логировать входы и предсказания и подключить один алерт доступности по шаблону."
          template: tpl_mlops0_deploy
        review_checklist: true
        review_items:
          - "Логируются статистика входов и распределение предсказаний?"
          - "Назначен владелец на «тихие» сбои, описано условие переобучения?"
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://arxiv.org/pdf/2003.05155"
          - "https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf"
          - "https://developers.google.com/machine-learning/guides/rules-of-ml"
      - key: m8_fallback
        title: "Запасной вариант в работе"
        description: "Предыдущая версия или эвристика из заметки об осуществимости; ссылка и описание переключения."
        type: artifact
        submission: either
        required: true
        owner_role: ml_engineer
        alt_roles: ["backend"]
        fallback:
          title: "Эвристика из заметки об осуществимости"
          instruction: "Использовать эвристику из шага «Заметка об осуществимости» как запасной ответ."
          template: tpl_mlops0_deploy
        review_checklist: false
        auto_checks: ["file_ok", "sha_dedup", "link_https"]
        sources:
          - "https://arxiv.org/pdf/2003.05155"
          - "https://developers.google.com/machine-learning/guides/rules-of-ml"
      - key: m8_user_guide
        title: "Руководство пользователя и отказ от ответственности"
        description: "Как пользоваться, что модель не умеет, ответственность."
        type: artifact
        submission: file
        required: true
        owner_role: product_analyst
        alt_roles: ["pm", "ba"]
        fallback:
          title: "Руководство по шаблону"
          instruction: "Заполнить шаблон руководства пользователя."
          template: tpl_user_guide_ml
        review_checklist: true
        review_items:
          - "Есть руководство пользователя и отказ от ответственности?"
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://arxiv.org/pdf/1810.03993"
          - "https://arxiv.org/pdf/2003.05155"
      - key: m8_test_score
        title: "Самопроверка ML Test Score"
        description: "Заполненный чек-лист ML Test Score с оценкой."
        type: artifact
        submission: file
        required: true
        owner_role: qa
        alt_roles: ["ml_engineer"]
        fallback:
          title: "Чек-лист ML Test Score как ручная самопроверка"
          instruction: "Пройти чек-лист вручную и записать баллы."
          template: tpl_ml_test_score_checklist
          url: "https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf"
        review_checklist: false
        auto_checks: ["file_ok", "sha_dedup"]
        sources:
          - "https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf"
      - key: m8_exit
        title: "Exit Report"
        description: "Итоговый отчёт: что сделано, результаты, ограничения, что дальше."
        type: artifact
        submission: file
        required: true
        owner_role: pm
        alt_roles: ["product_analyst"]
        fallback:
          title: "Exit Report по шаблону"
          instruction: "Заполнить шаблон Exit Report."
          template: tpl_exit_report
          url: "https://raw.githubusercontent.com/Azure/Azure-TDSP-ProjectTemplate/master/Docs/Project/Exit%20Report.md"
        review_checklist: true
        review_items:
          - "Ретроспектива и Exit Report написаны?"
        auto_checks: ["file_ok", "sha_dedup", "md_headings"]
        sources:
          - "https://raw.githubusercontent.com/Azure/Azure-TDSP-ProjectTemplate/master/Docs/Project/Exit%20Report.md"
          - "https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf"
      - key: m8_gonogo
        title: "Go/no-go встреча"
        description: "Созвон 30-60 мин: проход по плану деплоя и чек-листу."
        type: ritual
        ritual_kind: call
        required: true
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["ritual_fields"]
        sources:
          - "https://www.kde.cs.uni-kassel.de/wp-content/uploads/lehre/ws2012-13/kdd/files/CRISPWP-0800.pdf"
          - "https://research.google.com/pubs/archive/aad9f93b86b7addfea4c419b9100c6cdd26cacea.pdf"
      - key: m8_retro
        title: "Ретроспектива"
        description: "Созвон 1-1,5 ч."
        type: ritual
        ritual_kind: retro
        required: true
        owner_role: pm
        alt_roles: []
        fallback:
          title: "Ретро по шаблону из трёх вопросов"
          instruction: "Любой участник ведёт ретро по шаблону."
          template: tpl_retro
        review_checklist: false
        auto_checks: ["ritual_fields"]
        sources:
          - "https://arxiv.org/pdf/2003.05155"
      - key: m8_final_links
        title: "Ссылка на работающий релиз и репозиторий"
        description: "Публичный URL работающего ML-сервиса (демо или API, см. определение релиза) и репозиторий GitHub. Обязательны для завершения проекта."
        type: artifact
        submission: link
        required: true
        owner_role: any
        fallback: null
        review_checklist: false
        auto_checks: ["link_https", "release_alive_ml", "repo_final"]
        sources:
          - "https://arxiv.org/pdf/2003.05155"
          - "https://docs.cloud.google.com/architecture/mlops-continuous-delivery-and-automation-pipelines-in-machine-learning"
```

## 5. Шаблоны платформы

Шаблоны хранятся на платформе как документы (Markdown) с версией и подставляются в запасные шаги и в обычные шаги, где они упрощают работу. Здесь перечислены ключи, назначение и заголовки разделов. Полные тексты пишутся в фазе сборки среза «Маршрут проекта».

### 5.1. Перечень

| Ключ | Шаблон | Используется в шагах | Заголовки разделов |
|---|---|---|---|
| `tpl_charter` | Устав команды (веб-сервис) | w1_charter | Цель проекта; Участники и роли, владелец продукта; Правила общения и ритм встреч; Definition of Done v0; Appetite (в неделях); No-gos; Как принимаем решения и что делаем при просрочке |
| `tpl_charter_ml` | Charter ML-проекта | m1_charter, m1_no_ml | Бизнес-фон; Бизнес-метрика, текущее значение, способ измерения; ML-метрика и минимально приемлемый уровень; Вариант без ML (эвристика) и её оценка; Данные: что нужно и правило остановки; План и сроки; Архитектура на одном слайде; Риски и ограничения |
| `tpl_prfaq` | PR/FAQ-lite | w1_prfaq | Заголовок и подзаголовок; Резюме (абзац); Проблема; Решение; Цитата пользователя; FAQ: 5-10 вопросов (клиентские и внутренние) |
| `tpl_problem_statement` | Problem statement | w1_problem | История конкретного человека; Как решают проблему сейчас; Альтернативы и чем мы лучше; Допущения (самое рискованное отмечено); Как проверим допущения |
| `tpl_interview_kit` | Набор для интервью | w2_plan, w2_interviews, w2_snapshots | Цель и критерии отбора респондентов; Список вопросов о прошлом поведении; Роли пары (интервьюер, писарь); Snapshot интервью: кто, что рассказал, потребности, цитаты, возможности |
| `tpl_decision_record` | Запись решения | w2_decision, m2_enough, m6_decision | Вопрос; Факты; Варианты; Решение: продолжаем, меняем, стоп; Обоснование и риски |
| `tpl_pitch` | Pitch | w3_pitch | Problem; Appetite; Solution (must и «~»); Rabbit holes; No-gos |
| `tpl_user_story_kit` | Набор для user stories | w3_stories | Шаблон «Как..., я хочу..., чтобы...»; Критерии приёмки (Дано, Когда, Тогда); Проверка по INVEST; Карта историй по пути пользователя |
| `tpl_ui_kit_guide` | Инструкция по готовому UI-киту | w4_prototype, w6_frontend, m7_ui | Выбор кита (Bootstrap или shadcn/ui); Базовые компоненты и страницы; Правила: без кастомного дизайна в первой итерации; Список экранов проекта |
| `tpl_usability_test` | Скрипт и протокол теста прототипа | w4_test_script, w4_test_report | Цель теста и респонденты; Сценарные задачи; Что наблюдаем; Результаты по респондентам; Топ-3 проблемы: исправлено или отложено с причиной |
| `tpl_design_doc` | Мини design doc | w5_designdoc | Контекст и объём; Цели и не-цели; Решение; Альтернативы и trade-offs; Безопасность, приватность, наблюдаемость |
| `tpl_adr` | ADR | w5_adr | Контекст; Варианты; Решение; Последствия |
| `tpl_api_contract` | Таблица API-контракта | w5_api, w6_backend | Эндпоинт: метод и путь; Запрос; Ответ; Коды ошибок; Схема данных |
| `tpl_kanban_board` | Доска Kanban | w6_board | Колонки (К работе, В работе, Ревью, Готово); WIP-лимит; Правила перехода между колонками; Возраст задачи и порог обсуждения |
| `tpl_ci_github_actions` | Шаблон CI GitHub Actions | w6_ci, m7_ci | Запуск на push и pull request; Установка зависимостей; Линтер и тесты; Сборка; Правило: красный CI блокирует слияние (настройка защиты ветки) |
| `tpl_responsive_checklist` | Чек-лист адаптивной вёрстки и PWA | w6_mobile | Ширины экрана; Касания и размеры элементов; Манифест и офлайн-режим PWA; Проверка на реальном телефоне |
| `tpl_manual_test_checklist` | Чек-лист ручного тестирования | w7_regression, w7_smoke | Список must-историй с шагами проверки; Ожидаемый и фактический результат; Найденные баги (ссылки); Smoke-набор: 5-7 проверок главного сценария; Кто и когда проходил |
| `tpl_release_checklist` | Release checklist | w7_release_checklist, w7_deploy, w7_rollback, w7_monitoring | Окружения staging и prod, повторяемый деплой; Хостинг: список вариантов с оговорками и доступностью из РФ/СНГ; Безопасность: аутентификация, HTTPS; Резервная копия и проверка восстановления; План отката; Мониторинг и алерт «сервис недоступен»; Поэтапная выкатка; Отказ внешних зависимостей |
| `tpl_retro` | Ретроспектива | w8_retro, w8_retro_doc, m8_retro | Что получилось; Что не получилось; Что меняем (не более 3 действий: владелец, срок); Проверка действий прошлой ретро |
| `tpl_portfolio` | Описание проекта для портфолио | w8_portfolio | Проблема и пользователи; Решение и скриншоты; Моя роль и вклад; Стек; Результаты и уроки; Ссылки на релиз и репозиторий |
| `tpl_risk_register` | Реестр рисков и ограничений | m1_risks | Риск, вероятность, влияние; Правило остановки при нехватке данных; Юридические ограничения и персональные данные; Владелец и мера |
| `tpl_data_report` | Отчёт о данных и версиях | m2_collection, m2_version | Источник и лицензия; Способ получения, объём; Ограничения использования; Версия набора: хеш или тег |
| `tpl_datasheet` | Datasheet-lite | m2_datasheet | Зачем собраны данные; Состав; Как собраны и размечены; Допустимое и недопустимое использование |
| `tpl_labeling_guide` | Инструкция разметки | m2_guide | Определения классов; Примеры и контрпримеры; Спорные случаи; Проверка выборки двумя людьми |
| `tpl_dq_checklist` | Чек-лист и отчёт о качестве данных | m3_quality, m3_schema | Схема: типы и диапазоны; Пропуски и дубликаты; Баланс классов; Решения по очистке с обоснованием |
| `tpl_test_design` | Дизайн теста | m4_design, m4_baseline | Схема разбиения (время, группы); Метрики; Проверка дубликатов и утечки; Baseline и его значение |
| `tpl_experiment_log` | Журнал экспериментов | m5_log, m5_code, m5_selected | Таблица запусков: версия данных, параметры, seed, окружение, метрика; Среднее и разброс по seed; Итоговое сравнение с baseline; Команда воспроизведения |
| `tpl_eval_report` | Отчёт об оценке | m6_eval | Метрики на тесте; Метрики по срезам; Сравнение с минимальным уровнем; Выводы |
| `tpl_error_analysis` | Чек-лист разбора ошибок | m6_errors | Выборка топ-ошибок; Тип причины; Что исправимо; Что записать в ограничения |
| `tpl_model_card` | Model card | m6_model_card | Назначение; Неподдерживаемые применения; Данные; Метрики; Ограничения и риски |
| `tpl_ml_api_spec` | Мини-спецификация ML-API | m7_api_spec, m7_inference, m7_latency | Эндпоинт предсказания: вход, выход, ошибки; Проверка состояния; Инструкция запуска в одном контейнере; Замер задержки: 100 запросов, задержка и память |
| `tpl_ml_test_score_checklist` | Чек-лист ML Test Score | m7_parity, m8_test_score | Тесты данных; Тесты модели; Тесты инфраструктуры; Мониторинг; Баллы (0,5 за ручной, 1 за автоматический) |
| `tpl_mlops0_deploy` | План деплоя, отката и мониторинга (MLOps 0) | m8_deploy, m8_monitoring, m8_fallback | Шаги ручного воспроизводимого деплоя; Проверка на отложенных данных перед выкладкой; Откат и запасной вариант; Логи входов и предсказаний, алерт доступности; Условие переобучения и владелец тихих сбоев |
| `tpl_user_guide_ml` | Руководство пользователя ML | m8_user_guide | Как пользоваться; Чего модель не умеет; Отказ от ответственности |
| `tpl_exit_report` | Exit Report | m8_exit | Цели и результаты; Метрики; Ограничения; Что дальше |

### 5.2. Внешние шаблоны и хостинг

Внешние ссылки, на которые опираются шаблоны (все из `methodologies.md`): GitHub starter workflows для CI (https://docs.github.com/en/actions/writing-workflows/using-starter-workflows), шаблон pull request (https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/creating-a-pull-request-template-for-your-repository), Charter и Exit Report из TDSP (https://raw.githubusercontent.com/Azure/Azure-TDSP-ProjectTemplate/master/Docs/Project/Charter.md , https://raw.githubusercontent.com/Azure/Azure-TDSP-ProjectTemplate/master/Docs/Project/Exit%20Report.md), Model Cards (https://arxiv.org/pdf/1810.03993), Datasheets (https://arxiv.org/pdf/1803.09010).

Варианты хостинга для раздела «Хостинг» шаблона `tpl_release_checklist` **[решение автора]**. Платформа ничего не навязывает и проверяет только ответ ссылки. Доступность из РФ/СНГ во всех пунктах **[не проверено]**; список нужно проверить до публикации шаблона.

| Вариант | Оговорки (источник) |
|---|---|
| Собственный VPS или облако в РФ/СНГ (провайдер по выбору команды; платформа сама размещена на VPS в РФ, `docs/decisions.md`, п. 3) | Платный или пробный период; источника нет |
| Render Free (https://render.com/docs/free) | Засыпает через 15 минут, Postgres удаляется через 30 дней |
| Vercel Hobby (https://vercel.com/docs/plans/hobby) | Только для некоммерческого использования |
| Fly.io (https://docs.fly.io/about/pricing) | Бесплатного тарифа нет |

Запасной вариант демо на go/no-go и итоговом демо: локальный запуск или запись экрана (`methodologies.md`, 3.1). Он не заменяет ссылку на работающий релиз в последнем этапе.

## 6. Шаги для вычитки

Шаги и решения, в которых автор не уверен. «Причина» говорит, чего не хватает.

### 6.1. Сроки

| Шаг или этап | Причина |
|---|---|
| Все сроки этапов обоих сценариев | Оценки `methodologies.md`; источников по срокам для учебных команд нет |
| ML: этап «Сбор и разметка данных» 21 день, итого 13 недель | **[решение автора]**: источник даёт 2 недели (до 4 при реальной разметке); взято 3 для разумного запаса. Проверить, не удлинять ли до 16 недель для разметки вручную |
| Веб `w7_release` (7 шагов) и ML `m8_release` (9 шагов) | Источник даёт по неделе; шаги перегружали этап. Решение оркестратора: оба этапа по 10 дней; сокращены предыдущие этапы (веб `w6_build` 28 до 25 дней: второй спринт 11 дней; ML `m7_serving` 14 до 11 дней), суммы остались 84 и 91 день. Нужна вычитка: не ужат ли теперь второй спринт и сервинг |
| Веб `w4_prototype` 7 дней, `w3_shaping` 7 дней | Design Sprint и pitch растянуты до недели без опоры на данные о реальных командах |
| Веб `w6_s1_review`: срез объёма «в конце недели 8» | Из `methodologies.md`, раздел 4; привязан к концу спринта 1 этапа 6 (неделя 8 при последовательном прохождении) |

### 6.2. Критерии перехода и пункты чек-листов без первоисточника

| Шаг | Причина |
|---|---|
| Критерии перехода всех этапов | Формальные gate'ы в источниках не заданы (`methodologies.md`, «Не проверено»); критерии это оценка |
| `w1_charter` пункт про DoD v0 | Scrum Guide описывает DoD, но «v0» на старте это оценка |
| `w2_snapshots` («минимум 5 интервью») и проверка `min_files:5` | Число 5 это оценка (5-8 интервью), проверка добавлена автором |
| `w6_ci` пункт «красный CI блокирует слияние» | Первоисточника по CI нет (`methodologies.md`, этап 7) |
| `w7_release_checklist` и пункты `w7_*` | Адаптировано из SRE launch checklist, формулировки оценка |
| `m4_design` пункт про утечку целевой переменной | Прямого чек-листа в источниках нет (`methodologies.md`, ML этап 4) |
| Чек-листы ревью вообще | Пункты распределены по шагам автором; нужна вычитка человеком с опытом ревью (`docs/backlog.md`) |
| ML-ритуалы (`m4_review`, `m5_weekly`, `m5_code_review` и др.) | Предложение автора исследования, не из источников (`methodologies.md`, примечания к ML-таблице) |

### 6.3. Спорные запасные варианты

| Шаг | Причина |
|---|---|
| `w7_monitoring` | Внешний бесплатный сервис проверки доступности предложен без источника и без проверки доступности из РФ/СНГ |
| `w7_deploy` (хостинг) | Список вариантов в 5.2 непроверен; нужен вариант, гарантированно доступный из РФ/СНГ |
| `w7_regression`, `w7_smoke` | Ручной чек-лист вместо QA: источники по тест-чартерам, ISTQB, OWASP не проверены |
| `w6_frontend`, `w6_backend` | «Срезы одним человеком, ревью у второго» без первоисточника; порог `pr_cross_review:5` придуман |
| `w6_mobile` | Решено оркестратором: шаг необязателен (роль mobile необязательна, веб-сервис не требует мобильного клиента); запасной вариант «адаптивный веб или PWA» остаётся как совет, без обязательности |
| `w5_api` | OpenAPI это наш выбор без официального источника; запасной вариант это таблица эндпоинтов |
| `w5_adr` | Нет отдельного источника по ADR, указан Ubl (design docs) |
| `w1_charter`, `w1_prfaq`, `w8_retro` | «Ведущий любой участник» и ротация роли не подтверждены источником |
| `m2_collection` | Hugging Face Datasets как источник готовых данных: доступность из РФ/СНГ не проверена; Kaggle не проверен |
| `m5_log` | AutoML и модели Hugging Face как простой вариант не проверены |
| `m6_errors`, `m7_parity`, `m8_test_score` | Роль QA в ML опирается на ML Test Score (0,5 балла за ручной тест), прочие основания косвенные |
| `m7_latency` | Число «100 запросов» придумано автором |
| `m8_deploy` | Страница MLOps levels получена через суммаризатор, точные цитаты не проверены |

### 6.4. Решения автора

1. Поле `alt_roles` (второй владелец), потому что `methodologies.md` называет на этапе несколько ролей. Без него запасной шаг включался бы, даже если в команде есть подходящая соседняя роль.
2. Определение релиза ML (раздел 4.1): только работающий публичный адрес (демо-страница либо API с `/docs` или `/health`, ответ HTTP 200). Вариант «GitHub Releases без публичного адреса» убран по решению оркестратора как нарушающий требование «ссылка на работающий релиз».
3. Проверки `min_files`, `md_headings`, `pr_cross_review`, `ci_workflow` и их роль «только сигнал».
4. Двукратная проверка релиза: первый раз при сдаче шага, второй после 24 ч (требует, чтобы последний этап длился не меньше суток; ограничение 24 ч на этап из `components.md` это обеспечивает).
5. Необязательные шаги: `w6_pr_template`, `w6_mobile` (решение оркестратора), `m5_weekly`. Все остальные обязательны.
6. Отнесение ритуалов к видам: дизайн-ревью, pitch-ревью и go/no-go это `call`, ревью PR это `code_review`.
7. Ритуал «Мини-спринт дизайна» отнесён к `brainstorm`.

## 7. Проверено при написании

- У каждого шага обоих сценариев есть минимум один URL-источник, и каждый такой URL присутствует в `docs/research/methodologies.md`. Проверено скриптом.
- Каждый шаг с `owner_role` не `any` имеет `fallback` с ключом шаблона из раздела 5.1. Проверено скриптом.
- Сумма сроков: веб 84 дня (12 недель), ML 91 день (13 недель). Проверено скриптом.
- Последний этап каждого сценария содержит обязательный шаг со ссылкой на релиз и репозиторий и проверками `release_alive_*` и `repo_final`.
- Не проверено: открытие URL, соответствие каждого пункта чек-листа первоисточнику (пункты взяты из `methodologies.md`, а не из первоисточников), доступность хостингов и сервисов из РФ/СНГ.
