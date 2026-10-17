# Разработка, сборка и релизы

## Запуск приложения

Используйте Gradle Wrapper из корня репозитория. Для Android необходим Android SDK.
Release workflow использует JDK 17; локальную Java и SDK нужно настроить для Gradle.

```bash
./gradlew :composeApp:run
./gradlew :composeApp:installDebug
```

Первая команда запускает Desktop JVM приложение, вторая устанавливает Android debug-сборку.
В Windows используйте `gradlew.bat` вместо `./gradlew`.

## Проверка сборки

```bash
./gradlew :composeApp:compileKotlinDesktop
./gradlew :composeApp:compileDebugKotlinAndroid
./gradlew :composeApp:assembleRelease
```


## Версия приложения

`gradle.properties` содержит APP_VERSION_NAME и APP_VERSION_CODE.
Перед релизом обновите оба значения и сохраните изменения коммитом.
Тег релиза должен совпадать с APP_VERSION_NAME с префиксом v.
Например, для APP_VERSION_NAME=1.0.2 тег — v1.0.2.

## Публикация релиза через GitHub Actions

`.github/workflows/release.yml` запускается на push тега v*.
Workflow проверяет соответствие тега версии, собирает подписанный Android release APK,
публикует GitHub Release, прикладывает APK и SHA-256 checksum.

Для подписания требуются секреты репозитория:
ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD.
Не добавляйте их значения в исходники или документацию.

После обновления версии и проверки сборки:

```bash
git push origin <ветка>
git tag v1.0.2
git push origin v1.0.2
```

Замените версию на фактическую. Push тега запускает публикацию релиза.

## Получение обновлений пользователем

Приложение проверяет GitHub Releases репозитория Flobsterable/cosplay-2.
Android скачивает APK и запускает системную установку, которую подтверждает пользователь.
Desktop открывает asset или страницу релиза в браузере.

## Актуализация документации

После изменений Kotlin, Gradle или release.yml обновляйте описание затронутых
моделей, сценариев, API и команд сборки. Карта документов находится в docs/README.md.
