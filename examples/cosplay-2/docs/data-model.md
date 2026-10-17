# Модели данных

Общие модели объявлены в core/model/src/commonMain/kotlin/ru/flobsterable/cosplay2/model/Models.kt.
DTO описывают сериализуемые ответы внешних API. Модели приложения используются UI и репозиториями.
Постоянной SQL-базы данных фестивалей нет; festivalCache хранит данные в памяти экземпляра репозитория.

## Ответы API фестивалей

FestivalListResponse содержит events: List<FestivalSummaryDto>.
FestivalSummaryDto описывает одну запись внешнего списка:

| Поле Kotlin | JSON | Тип и назначение |
| --- | --- | --- |
| id | id | Long, идентификатор события |
| eventTypeId | event_type_id | Int, ссылка на тип события |
| startTime / endTime | start_time / end_time | String, начало и окончание |
| title | title | String, название |
| description | description | String, описание; по умолчанию пустая строка |
| city / country | city / country | String, место; по умолчанию пустые строки |
| href | href | String, URL страницы фестиваля |
| time | time | String, готовая подпись даты |
| timestatus | timestatus | String, исходный статус |

EventTypeDto содержит id, title и titleOne (JSON title_one).
Репозиторий формирует справочник id → titleOne; при пустом titleOne использует title.

## Каталог и карточка фестиваля

FestivalSummary содержит id, title, description, city, country, eventTypeId,
startTime, endTime, displayTime, status, url и nullable imageUrl.
Репозиторий декодирует HTML-сущности в текстовых полях.

FestivalStatus имеет Future и Past. fromRaw считает строку future (без учёта регистра)
будущим событием, остальные значения — прошедшим. Статус не вычисляется по текущему времени.

FestivalCatalog объединяет festivals: List<FestivalSummary>, eventTypes: Map<Int, String>,
year: Int и isFallback: Boolean. isFallback=true означает демонстрационный список после ошибки
загрузки основного API, а не сохранённую копию последнего успешного сетевого ответа.

## Детали и HTML-данные

FestivalDetail содержит summary, description, pageContent, pageLinks, venueCity,
venueCountryCode, startDate, endDate и imageUrl.
FestivalActionLink содержит title и url.

FestivalSchema из data/festival/.../CosplayApi.kt хранит извлечённые JSON-LD поля:
imageUrl, description, startDate, endDate, venueCity и venueCountryCode.
FestivalHomePageData содержит читаемый content страницы и список links.
При ошибке загрузки страницы используются пустой FestivalHomePageData и резервный текст из модели.

## Обновления приложения

GitHubReleaseDto сопоставляет tag_name, name, body, html_url и assets.
GitHubReleaseAssetDto содержит name, browser_download_url и content_type.
GitHubUpdateRepository преобразует релиз в AppUpdateInfo: versionTag, versionName,
notes, releaseUrl и nullable apkUrl. Префикс v удаляется из versionName.

AppUpdateInstallState описывает состояние установки:
Idle, Downloading (версия, nullable progress, downloadedBytes, nullable totalBytes),
Downloaded, RequiresInstallPermission и Failed (nullable версия, message).
Это состояние установщика, отдельное от UiState загрузки экрана.

compareAppVersions удаляет префикс v, разбивает версии по точке, дефису и подчёркиванию,
сравнивает распознанные целые числа и считает отсутствующие части нулевыми.
Это простое числовое сравнение, а не полная реализация SemVer prerelease-правил.
