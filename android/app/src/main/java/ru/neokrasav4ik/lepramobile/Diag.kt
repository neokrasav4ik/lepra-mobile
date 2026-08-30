package ru.neokrasav4ik.lepramobile

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/* Отчёт приложения.

   Заведён не для красоты. Компьютер с chrome://inspect будет доступен
   недолго, а дальше единственный способ узнать, ЧТО происходит внутри, —
   прочитать это с экрана телефона и прислать текстом.

   Правило из записки по скрипту здесь в силе целиком:

     — сначала цифры, потом гипотеза;
     — печатать не только значение, но и его ИСТОЧНИК («заголовок снят с
       главного запроса», а не «заголовка нет»);
     — подписи обязаны быть честными: «не проверялось» и «нет» — разные
       слова, и путать их дороже, чем не печатать вовсе.

   Значений кук здесь нет и не будет: внутри чужая сессия. Имена — да,
   по ним видно, жив ли вход; содержимое — никогда. */
object Diag {

    private val lines = ArrayDeque<String>()
    private const val KEEP = 60

    /* Однократные сведения: заполняются при запуске и живут до перезапуска. */
    val facts = LinkedHashMap<String, String>()

    @Synchronized
    fun fact(name: String, value: String) {
        facts[name] = value
    }

    @Synchronized
    fun log(line: String) {
        val t = SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
        lines.addLast("$t  $line")
        while (lines.size > KEEP) lines.removeFirst()
    }

    @Synchronized
    fun report(): String {
        val sb = StringBuilder()
        sb.append("СВЕДЕНИЯ\n")
        val w = facts.keys.maxOfOrNull { it.length } ?: 0
        facts.forEach { (k, v) -> sb.append("  ").append(k.padEnd(w)).append("  ").append(v).append('\n') }
        sb.append("\nЖУРНАЛ (последние ").append(lines.size).append(")\n")
        if (lines.isEmpty()) sb.append("  пусто\n")
        else lines.forEach { sb.append("  ").append(it).append('\n') }
        return sb.toString()
    }
}
