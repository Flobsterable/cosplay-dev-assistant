# Агент предоставляет LLM проектам

GitHub Actions выполняет анализ в **cosplay-dev-assistant**, а не в приложении.
Ключи Gemini, основной модели, настройки маршрутизации и кеш ответов принадлежат
репозиторию агента. Приложение отправляет только метаданные задачи через
`workflow_dispatch`. Общий reusable workflow не решает эту задачу: он работает
в контексте вызывающего репозитория и сам по себе не получает секреты агента.

## Секреты и права

В Settings → Secrets and variables → Actions **cosplay-dev-assistant**:

| Secret | Назначение |
| --- | --- |
| `GEMINI_API_KEY` | Ключ Gemini для небольших запросов |
| `LLM_API_KEY` | Ключ основной модели для больших запросов |
| `PROJECT_GITHUB_TOKEN` | Fine-grained GitHub PAT к cosplay-2: Contents read/write, Pull requests read/write, Issues read/write |

`PROJECT_GITHUB_TOKEN` должен принадлежать отдельной учётной записи сервиса либо
владельцу проекта. Комментарии и Issues публикуются от её имени. Обычный
`GITHUB_TOKEN` репозитория агента не предоставляет запись в другом репозитории.
PAT не обходит защиту ветки. Доступ к Workflows для этого токена не требуется.

Модели, URL, бюджеты, пороги Gemini задаются Variables репозитория **агента**,
как описано в [economy.md](economy.md). `AGENT_PROJECTS` — список разрешённых
репозиториев через запятую; по умолчанию только `Flobsterable/cosplay-2`.
Входящая задача не может переопределить модели, ключи, runtime или список доступа.

В **cosplay-2** нужен только `AGENT_DISPATCH_TOKEN`: отдельный fine-grained PAT
к **cosplay-dev-assistant** с Actions write для запуска agent.yml через
GitHub REST API. Токен отправки не должен иметь Contents write: он не меняет код агента. Это GitHub-доступ к постановке задач, а не ключ LLM.
Ни `GEMINI_API_KEY`, ни `LLM_API_KEY` в приложении больше не используются.

## Подключение

1. Слейте workflow `.github/workflows/agent.yml` и доверенные скрипты в default
   branch агента. GitHub не обрабатывает workflow dispatch, если workflow ещё
   не находится в default branch.
2. Сохраните секреты у агента и токен отправки у приложения.
3. Скопируйте отправителей из `examples/workflows/` в приложение.
4. Откройте PR либо отправьте изменение кода в develop/main.

В приложении успешный job означает **доставку задачи**, а не завершение анализа.
Исполнение, ошибки моделей, расход, кеш и артефакты видны в **cosplay-dev-assistant →
Actions → Agent service**. Для docs-sync ошибка/отмена создаёт задачу восстановления
в приложении со ссылкой на центральный запуск и исходными SHA. Успех закрывает
только задачу того же диапазона. Сбой самой отправки виден в Actions приложения.

## Контракт запроса

Ревью: workflow `agent.yml`, ref `main`, inputs:

```json
{"type":"review","repository":"Flobsterable/cosplay-2","pr":"123","branch":"develop","base":"<40 hex SHA>","head":"<40 hex SHA>"}
```

Документация: тот же workflow, inputs:

```json
{"type":"docs-sync","repository":"Flobsterable/cosplay-2","branch":"develop","base":"<before SHA>","head":"<merged SHA>"}
```

До платного вызова проверяются allowlist, структура, фактический PR и ветка через
GitHub API, существование Git-объектов. Draft, закрытый или устаревший PR пропускается;
fork PR запрещён. Для docs-sync разрешены develop/main; base должен быть предком
source head, а source head — предком актуальной целевой ветки. Старые диапазоны
можно восстановить после новых мерджей, поэтому requested head не заменяется текущим.
Исходники приложения читаются как данные; его scripts, npm и Gradle не запускаются.

Ревью публикует только замечания к строкам, без общего отчёта и пустого review.
Повторные запуски обновляют только комментарии той же учётной записи и того же SHA.
Docs-sync использует доверенный скрипт из репозитория агента, проверяет каждый
документ и сохраняет только README/docs. На конфликте push сохраняет patch и
останавливается без повторного платного конвейера и без force push.

## Ручное восстановление

В **агенте** Actions → Agent service → Run workflow, default branch:
`type=docs-sync`, `repository`, `branch`, `base`, `head` из recovery issue.
Либо повторите отправку в Actions приложения → Update project documentation.
Для review укажите `type=review` и `pr` с актуальными base/head/branch.
Re-run старого запуска использует старый workflow; Run workflow запускает текущую
версию default branch. Маркер `Docs-Sync-Source` предотвращает повторную генерацию
уже опубликованного диапазона. Модельные ошибки не вызывают скрытый fallback.

Сервис сериализует задачи одной ветки (для ревью — одного PR) через concurrency
с queue: max. До 100 ожидающих запусков сохраняются, новые события не отменяют
предыдущие pending-задачи. Две генерации документации одного проекта/ветки не
конкурируют за push. Обычный push пользователя во время генерации по-прежнему
может привести к сохранению patch и явному восстановлению.
Семантика очереди: [GitHub Docs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
