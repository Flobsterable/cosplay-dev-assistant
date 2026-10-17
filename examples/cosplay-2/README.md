# Cosplay 2

Compose Multiplatform приложение для просмотра фестивалей с [cosplay2.ru](https://cosplay2.ru/), с акцентом на аккуратный UI, модульную архитектуру и GitHub-based обновления.

[![GitHub Repo](https://img.shields.io/badge/GitHub-cosplay--2-181717?logo=github)](https://github.com/Flobsterable/cosplay-2)
[![Latest Release](https://img.shields.io/github/v/release/Flobsterable/cosplay-2?display_name=tag&logo=github)](https://github.com/Flobsterable/cosplay-2/releases/latest)
[![Release Workflow](https://img.shields.io/github/actions/workflow/status/Flobsterable/cosplay-2/release.yml?branch=main&label=release&logo=githubactions)](https://github.com/Flobsterable/cosplay-2/actions/workflows/release.yml)
[![Kotlin](https://img.shields.io/badge/Kotlin-2.0.21-7F52FF?logo=kotlin&logoColor=white)](https://kotlinlang.org/)
[![Compose Multiplatform](https://img.shields.io/badge/Compose_Multiplatform-1.7.3-4285F4)](https://www.jetbrains.com/lp/compose-multiplatform/)

**Быстрые ссылки**

- [Документация проекта](docs/README.md): архитектура, API, модели, сценарии, сборка и диагностика.

- [Открыть репозиторий](https://github.com/Flobsterable/cosplay-2)
- [Последний релиз](https://github.com/Flobsterable/cosplay-2/releases/latest)
- [GitHub Actions](https://github.com/Flobsterable/cosplay-2/actions)
- [Все релизы](https://github.com/Flobsterable/cosplay-2/releases)

## Что умеет

- загружает фестивали через `POST /api/events/filter_list`
- получает типы событий через `GET /api/events/get_types`
- открывает экран фестиваля с расширенным описанием
- парсит страницу фестиваля `.../get_pages/home`, чтобы достраивать контент и ссылки
- поддерживает фильтрацию по типу, году и месяцу
- проверяет наличие новой версии через GitHub Releases

## Платформы

- Android
- Desktop JVM

## Технологии

- Kotlin Multiplatform
- Compose Multiplatform
- Material 3
- Ktor Client
- kotlinx.serialization
- kotlinx.datetime

## Архитектура

Проект разбит на модули, чтобы UI, сеть и платформенные интеграции не жили в одном месте.

- `:composeApp` — app shell, navigation, composition root, Android/Desktop targets
- `:core:model` — общие модели и DTO
- `:core:network` — настройка Ktor `HttpClient`
- `:core:platform` — platform-specific интеграции: back handler, image loading, updater launcher, app version
- `:data:festival` — API и repository для `cosplay2.ru`
- `:data:update` — API и repository для GitHub Releases
- `:feature:festival` — список и экран фестиваля
- `:feature:update` — UI для уведомления об обновлении

## Структура данных

Приложение получает фестивали из API `cosplay2.ru`, а затем дополнительно обогащает детали:

- JSON список фестивалей
- JSON список типов событий
- JSON-LD/schema data со страниц архива
- HTML содержимое `get_pages/home` у конкретного фестиваля

За счёт этого detail screen может показывать не только базовые поля из списка, но и живой текст, ссылки и дополнительный контент страницы события.

## Локальный запуск

### Desktop

```bash
./gradlew :composeApp:run
```

### Android debug

```bash
./gradlew :composeApp:installDebug
```

### Полезные команды

```bash
./gradlew :composeApp:compileKotlinDesktop
./gradlew :composeApp:compileDebugKotlinAndroid
./gradlew :composeApp:assembleRelease
```

## Версионирование

Версия хранится в [gradle.properties](gradle.properties):

- `APP_VERSION_NAME`
- `APP_VERSION_CODE`

Git tag для релиза должен совпадать с `APP_VERSION_NAME`:

- `APP_VERSION_NAME=1.0.2`
- tag: `v1.0.2`

## Релизы через GitHub

Workflow релиза лежит в [.github/workflows/release.yml](.github/workflows/release.yml).

Что делает workflow:

- запускается на push тега вида `v*`
- проверяет совпадение тега с `APP_VERSION_NAME`
- собирает Android release APK
- публикует GitHub Release
- прикладывает APK и `sha256` checksum

## Как выпустить новую версию

1. Обновить `APP_VERSION_NAME` и `APP_VERSION_CODE` в [gradle.properties](gradle.properties)
2. Закоммитить изменения
3. Запушить ветку
4. Создать тег:

```bash
git tag v1.0.2
git push origin v1.0.2
```

После этого GitHub Actions создаст релиз автоматически.

## Обновление приложения

Приложение использует GitHub Releases как источник обновлений.

- на Android баннер обновления скачивает APK и открывает системную установку
- на Desktop баннер открывает release asset или страницу релиза в браузере

Это не Play Store in-app update, поэтому установка на Android всё равно подтверждается пользователем через системный installer.

## Статус проекта

Это не production backend-client, а UI/UX-ориентированный KMP прототип с реальными данными, модульной структурой и релизным пайплайном через GitHub.

## Репозиторий

- GitHub: [Flobsterable/cosplay-2](https://github.com/Flobsterable/cosplay-2)
