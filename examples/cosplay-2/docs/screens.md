# Как реализовать экран и какие компоненты нужны

## Порядок реализации экрана в Cosplay 2

Это руководство предлагает порядок добавления нового экрана по существующим образцам.
Новый экран ниже — пример, а не уже реализованная возможность приложения.

1. Выберите feature-модуль: интерфейс фестивалей находится в `feature/festival`,
   обновлений — в `feature/update`. Общий Compose-код пишется в `src/commonMain/kotlin`.
2. Определите входные данные экрана и callbacks пользовательских действий.
   Например, `FestivalDetailScreen` принимает `state: UiState<FestivalDetail>`,
   `client: HttpClient` и `onBack: () -> Unit`. Данные экрана и загрузка разделены:
   composable отображает переданное состояние, Route вызывает репозиторий.
3. Создайте composable `@Composable fun ...Screen(...)` и обработайте загрузку,
   ошибку, успех и пустой результат. `UiState` сейчас объявлен в `feature/festival`:
   `Loading`, `Success<T>(data)` и `Error(message)`. Это не общий тип из `core/model`.
4. Добавьте Route в `composeApp/.../App.kt`. По существующему образцу данные
   загружаются через `produceState`, затем передаются экрану. Задайте ключ загрузки
   по входному параметру: у деталей это `festival.id`, у списка — `selectedYear`.
5. Для отдельного перехода добавьте вариант в закрытый `AppRoute` и ветку `when`
   внутри `AnimatedContent`. Передавайте переходы callbacks, как `onFestivalSelected`.
   Проверьте поведение `SystemBackHandler`: сейчас возврат ведёт на список фестивалей.
6. Зависимости создавайте в `CosplayApp` и передавайте вниз. В текущем проекте
   нет обязательного ViewModel/DI/navigation framework для добавления экрана.
   HttpClient создаётся через `remember`, закрывается в `DisposableEffect`.
7. Проверьте Android и Desktop, состояния загрузки/ошибки/пустых данных и возврат.
   Команды компиляции приведены в [development.md](development.md).

## Компоненты экрана списка фестивалей

Образец — `feature/festival/src/commonMain/kotlin/ru/flobsterable/cosplay2/feature/festival/FestivalListScreen.kt`.
`FestivalsScreen` использует `Scaffold` и `LazyColumn`. Поиск представлен
`OutlinedTextField`, выбор года и категории — `FilterChip`, месяца — `MonthDropdown`.
Результаты показываются через `FestivalCard`. Состояния отображают `LoadingBlock`,
`ErrorBlock` и `EmptyBlock`; дополнительный верхний блок передаётся через `topContent`.
Запрос, категория и месяц хранятся через `rememberSaveable`; год приходит снаружи.
Фильтры работают над загруженным каталогом. Смена года запускает загрузку в Route.

## Компоненты экрана деталей фестиваля

Образец — `feature/festival/src/commonMain/kotlin/ru/flobsterable/cosplay2/feature/festival/FestivalDetailScreen.kt`.
`FestivalDetailScreen` разбирает `UiState<FestivalDetail>`. Для успешного результата
используется `LazyColumn`, блок метаданных `MetaCard` и раскрываемый текст
`ExpandableSectionCard`. Кнопка возврата вызывает `onBack`; интерфейс использует
цвета и типографику `MaterialTheme`. Сам экран не вызывает `getFestivalDetail`:
это делает `FestivalDetailRoute` в `App.kt`.

## Переиспользование компонентов

В `FestivalComponents.kt` есть `InfoSectionCard`, `MetaLine`, `FilterChip`,
`MonthDropdown`, `TypeChip`, `LoadingBlock`, `ErrorBlock`, `EmptyBlock`, а также
компоненты карточек фестиваля. Многие объявлены `internal`: их можно использовать
внутри `feature/festival`, но нельзя напрямую импортировать в другой feature-модуль.
Для нового модуля сначала решите, нужен ли публичный API или выделение общего UI;
общего модуля дизайн-системы сейчас нет. `MonthDropdown` привязан к `MonthFilter`,
а карточки — к моделям фестивалей; это не универсальные виджеты для любых данных.

## Минимальный шаблон нового экрана

Пример для файла внутри `feature/festival` в пакете `ru.flobsterable.cosplay2.feature.festival`.
Это шаблон UI, а не готовый маршрут: источник `state` и переход нужно подключить в `App.kt`.

```kotlin
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable

@Composable
fun ExampleScreen(state: UiState<String>, onBack: () -> Unit) {
    Column {
        TextButton(onClick = onBack) { Text("Назад") }
        when (state) {
            UiState.Loading -> LoadingBlock()
            is UiState.Error -> ErrorBlock(state.message)
            is UiState.Success -> {
                if (state.data.isBlank()) EmptyBlock() else Text(state.data)
            }
        }
    }
}
```

Модели и поля описаны в [data-model.md](data-model.md), загрузка и переходы —
в [feature-flows.md](feature-flows.md), зависимости модулей — в [architecture.md](architecture.md).
