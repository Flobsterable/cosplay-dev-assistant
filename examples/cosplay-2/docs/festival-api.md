# API фестивалей и модели данных

Источник контрактов: `data/festival/src/commonMain/kotlin/ru/flobsterable/cosplay2/data/festival/CosplayApi.kt`.
DTO и модели: `core/model/src/commonMain/kotlin/ru/flobsterable/cosplay2/model/Models.kt`.
Это описание реализации клиента, а не полная официальная спецификация внешнего API.

## Загрузка списка фестивалей

`CosplayApiImpl.fetchFestivalList(year, wid)` отправляет:

```http
POST https://cosplay2.ru/api/events/filter_list
Content-Type: application/json
```

```json
{"wid":"идентификатор запроса","active_year":2026}
```

Год передаётся аргументом; 2026 — пример. Репозиторий формирует wid через generateWid().
Ответ декодируется в FestivalListResponse с полем events: List<FestivalSummaryDto>.

FestivalSummaryDto содержит id, event_type_id, start_time, end_time, title,
description, city, country, href, time и timestatus.
Поля event_type_id/start_time/end_time сопоставлены с Kotlin-свойствами через SerialName.
У description, city и country есть пустые значения по умолчанию.

## Типы событий

`fetchEventTypes()` выполняет `GET https://cosplay2.ru/api/events/get_types`.
Ответ — список EventTypeDto: id, title, title_one (свойство titleOne).
Тип фестиваля связывается с этим справочником через eventTypeId.

## Дополнительные данные страницы

`fetchSchemas(sourceUrl)` загружает HTML и разбирает script-блоки application/ld+json.
Из объектов с @type=Event и url извлекаются описание, изображение, даты и место проведения.
Результат — Map<String, FestivalSchema> с нормализованным URL в качестве ключа.
Для корневой страницы https://cosplay2.ru/ используется rootSchemaCache.

Каталог запрашивает JSON-LD страницы `https://cosplay2.ru/archive/{year}`.
`fetchFestivalHomePage(baseUrl)` запрашивает `{baseUrl}/get_pages/home`, после чего
HTML-парсер извлекает читаемый текст и ссылки действий.

## Модели приложения

- FestivalSummary — данные карточки: идентификатор, заголовок, описание, город,
  страна, тип, даты, отображаемое время, статус, URL и необязательное изображение.
- FestivalCatalog — festivals, eventTypes, year, isFallback.
- FestivalDetail — summary, description, pageContent, pageLinks, место, даты и изображение.
- FestivalActionLink — title и url.
- FestivalStatus.fromRaw возвращает Future только для строки future; иначе Past.

Репозиторий декодирует HTML-сущности и обогащает результаты списка JSON-LD данными.
При ошибке загрузки списка `getFestivalCatalog` возвращает fallback-каталог с isFallback=true.
Ошибка JSON-LD не прерывает загрузку основного списка; при ошибке или пустом справочнике
типов репозиторий подставляет fallbackEventTypes, сохраняя сетевой список фестивалей.

## API обновлений приложения

`data/update/.../GitHubReleaseApi.kt` запрашивает:
`GET https://api.github.com/repos/{owner}/{repo}/releases/latest`.
Клиент отправляет Accept: application/vnd.github+json и User-Agent: cosplay2-app-updater.

GitHubUpdateRepository выбирает APK asset, исключая файлы с unsigned в имени,
и формирует AppUpdateInfo. Версия получается из tagName без префикса v.
Сравнение версий и уведомление об обновлении выполняются отдельно от этого запроса.
