# Сжатие кода выключено (см. build.gradle.kts). Файл оставлен, чтобы при
# включении было куда писать: ScriptStore зовёт androidx.webkit ОТРАЖЕНИЕМ,
# по имени метода, и без правила сохранения этот вызов молча перестал бы
# находить метод.
-keep class androidx.webkit.WebSettingsCompat { *; }
