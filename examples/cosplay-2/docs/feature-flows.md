# Сценарии приложения

## Загрузка каталога фестивалей

В composeApp/.../App.kt FestivalsRoute вызывает getFestivalCatalog(requestedYear).
Для пункта «Актуальные» requestedYear равен текущему календарному году; для выбранного года — ему самому.
Состояние загрузки представлено UiState.Loading, Success или Error.

CosplayRepositoryImpl выполняет запросы в следующем порядке:

1. Формирует wid — строку из 16 случайных шестнадцатеричных символов.
2. Получает JSON-LD схемы из страницы https://cosplay2.ru/archive/{year}.
3. Выполняет POST /api/events/filter_list с wid и active_year.
4. Получает типы событий через GET /api/events/get_types.
5. Преобразует DTO в FestivalSummary и обогащает изображение данными JSON-LD.
6. Обновляет festivalCache по нормализованному URL и возвращает FestivalCatalog.

App.kt сортирует успешный список по startTime перед передачей FestivalsScreen.
Пустой результат после фильтрации показывает EmptyBlock; ошибка состояния — ErrorBlock.

## Поиск и фильтрация списка

Фильтрация находится в feature/festival/.../FestivalListScreen.kt и выполняется на клиенте:

- «Актуальные» (ACTUAL_FILTER_YEAR=-1) оставляют только FestivalStatus.Future.
- Тип события проверяется через TypeFilter.matches(eventTypeId).
- Месяц проверяется через MonthFilter.matches(startTime).
- Текстовый запрос ищется в объединённых title, city и description без учёта регистра.

Пустая поисковая строка не ограничивает результаты. Введённый запрос обрезается по краям.
Изменение типа, месяца или текста не вызывает отдельный запрос API: фильтруется загруженный каталог.
Выбор другого года меняет selectedYear в App.kt и запускает загрузку каталога.
При смене года selectedMonth сбрасывается в All через rememberSaveable(selectedYear).

## Открытие деталей фестиваля

При нажатии карточки AppRoute меняется на FestivalDetails(festival).
FestivalDetailRoute вызывает repository.getFestivalDetail(festival).
Репозиторий берёт FestivalSummary из festivalCache по URL, либо использует переданный объект.

По первым четырём символам startTime определяется год для JSON-LD архива.
Если год не удалось распознать, схемы запрашиваются на корневой странице cosplay2.ru.
Дополнительно загружается {festival.url}/get_pages/home.
Описание, даты, место и изображение берутся из схемы при её наличии, иначе из карточки.
Пустой текст страницы заменяется резервным текстом: описание, город/страна и период проведения.
Ссылки действий берутся из HTML-страницы. Результат отображает FestivalDetailScreen.

## Навигация и состояние

AppRoute — закрытый тип с Festivals, FestivalDetails и Update.
Переходы отображаются через AnimatedContent. SystemBackHandler возвращает на список.
App.kt хранит lastSuccessfulCatalog, чтобы сохранить контекст последнего успешного каталога
при загрузке другого года; экран при этом показывает LoadingBlock.
HttpClient создаётся через remember и закрывается в DisposableEffect.

## Проверка и установка обновлений

GitHubUpdateRepository запрашивает последний релиз Flobsterable/cosplay-2.
Из assets выбирается APK, исключая unsigned; приоритет получают release-файлы,
затем файлы с MIME application/vnd.android.package-archive.
Баннер показывается при наличии pendingUpdate или более новой версии относительно AppVersion.versionName.

Android AppUpdateLauncher скачивает APK и вызывает системный установщик.
Пользователь подтверждает установку и при необходимости разрешает установку из этого источника.
Desktop открывает asset/страницу релиза через браузер. Это не обновление через Play Store.
