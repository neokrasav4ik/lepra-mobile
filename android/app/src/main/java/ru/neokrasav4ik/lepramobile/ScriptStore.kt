package ru.neokrasav4ik.lepramobile

import android.content.Context
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/* Откуда приложение берёт lepra-mobile.user.js.

   Замысел (раздел 4.3 записки): APK пересобирается редко, а скрипт живёт
   своей жизнью и правится по нескольку раз за сессию. Значит:

     1. Встроенная копия в assets — работает сразу и без сети, ею приложение
        стартует в первый раз. Кладётся туда сборкой из корня репозитория,
        руками её никто не трогает.
     2. Раз в сутки скачивается @updateURL из заголовка скрипта, сверяется
        @version, и если сеть дала новее — копия ложится во внутреннюю память.
     3. Дальше грузится скачанная, пока она новее встроенной.

   Три предосторожности, каждая из которых отвечает на «а что, если»:

     — Скачанное проверяется на то, что это ВООБЩЕ скрипт: начинается с
       // ==UserScript==, содержит @version, размер в разумных пределах.
       Иначе первая же страница ошибки GitHub легла бы в память вместо
       скрипта, и приложение показало бы десктопную лепру под лупой.
     — Прежняя копия сохраняется, и есть кнопка «вернуться к встроенной».
       Скрипт, который не запускается, изнутри не починить.
     — Обновление применяется при СЛЕДУЮЩЕМ запуске, а не на лету. Замена
       на лету означала бы перезагрузку страницы под пальцем — с потерей
       места и набранного текста. Выигрыш нулевой, цена заметная. */
object ScriptStore {

    private const val PREFS = "lepra"
    private const val K_LAST_CHECK = "script_last_check"
    private const val K_PREFER_BUNDLED = "script_prefer_bundled"
    private const val ASSET = "lepra-mobile.user.js"

    private const val DAY_MS = 24L * 60 * 60 * 1000
    private const val MIN_BYTES = 100_000
    private const val MAX_BYTES = 8_000_000

    class Loaded(val text: String, val source: String, val version: String)

    private fun dir(ctx: Context) = File(ctx.filesDir, "script").apply { mkdirs() }
    private fun current(ctx: Context) = File(dir(ctx), "current.js")
    private fun previous(ctx: Context) = File(dir(ctx), "previous.js")
    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun versionOf(text: String): String =
        Regex("""@version\s+([0-9][0-9.]*)""").find(text.take(4000))?.groupValues?.get(1) ?: "?"

    /* Сравнение вида 2.0.4 против 2.0.10 — по числам, а не по строкам.
       Строковое сравнение сказало бы, что 2.0.4 новее 2.0.10, и обновление
       молча перестало бы приходить. */
    private fun newer(a: String, b: String): Boolean {
        val x = a.split('.').map { it.toIntOrNull() ?: -1 }
        val y = b.split('.').map { it.toIntOrNull() ?: -1 }
        for (i in 0 until maxOf(x.size, y.size)) {
            val p = x.getOrElse(i) { 0 }
            val q = y.getOrElse(i) { 0 }
            if (p != q) return p > q
        }
        return false
    }

    private fun looksLikeScript(text: String): String? {
        if (text.length < MIN_BYTES) return "слишком мал: ${text.length} байт"
        if (text.length > MAX_BYTES) return "слишком велик: ${text.length} байт"
        if (!text.trimStart().startsWith("// ==UserScript==")) return "не начинается с заголовка юзерскрипта"
        if (versionOf(text) == "?") return "в заголовке нет @version"
        return null
    }

    private fun bundled(ctx: Context): String =
        ctx.assets.open(ASSET).use { it.readBytes().toString(Charsets.UTF_8) }

    fun load(ctx: Context): Loaded {
        val emb = bundled(ctx)
        val embV = versionOf(emb)
        if (prefs(ctx).getBoolean(K_PREFER_BUNDLED, false))
            return Loaded(emb, "встроенная (выбрано вручную)", embV)

        val f = current(ctx)
        if (f.exists()) {
            val txt = runCatching { f.readText(Charsets.UTF_8) }.getOrNull()
            val bad = txt?.let { looksLikeScript(it) }
            if (txt != null && bad == null) {
                val v = versionOf(txt)
                if (newer(v, embV)) return Loaded(txt, "скачанная", v)
                return Loaded(emb, "встроенная (скачанная $v не новее)", embV)
            }
            Diag.log("скачанная копия негодна (${bad ?: "не читается"}), беру встроенную")
        }
        return Loaded(emb, "встроенная", embV)
    }

    fun revertToBundled(ctx: Context) {
        prefs(ctx).edit().putBoolean(K_PREFER_BUNDLED, true).apply()
        Diag.log("выбрана встроенная копия скрипта")
    }

    fun useDownloadedAgain(ctx: Context) {
        prefs(ctx).edit().putBoolean(K_PREFER_BUNDLED, false).apply()
    }

    /* Адрес обновления берётся ИЗ САМОГО СКРИПТА. Так он остаётся в одном
       месте: поменяется репозиторий — поменяется и здесь, без правки APK. */
    private fun updateUrl(text: String): String? =
        Regex("""@(?:updateURL|downloadURL)\s+(\S+)""").find(text.take(4000))?.groupValues?.get(1)

    fun maybeUpdate(ctx: Context, force: Boolean = false, done: ((String) -> Unit)? = null) {
        val p = prefs(ctx)
        val last = p.getLong(K_LAST_CHECK, 0)
        if (!force && System.currentTimeMillis() - last < DAY_MS) {
            done?.invoke("проверялось меньше суток назад")
            return
        }
        thread(name = "script-update") {
            val said = runCatching { fetchAndStore(ctx) }.getOrElse { "сеть: ${it.javaClass.simpleName}" }
            p.edit().putLong(K_LAST_CHECK, System.currentTimeMillis()).apply()
            Diag.fact("обновление скрипта", said)
            Diag.log("обновление скрипта: $said")
            done?.invoke(said)
        }
    }

    private fun fetchAndStore(ctx: Context): String {
        val now = load(ctx)
        val url = updateUrl(now.text) ?: return "в заголовке нет @updateURL"

        val conn = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 30_000
            requestMethod = "GET"
            setRequestProperty("Accept", "text/plain, */*")
        }
        val code = conn.responseCode
        if (code != 200) {
            conn.disconnect()
            return "ответ $code"
        }
        val text = conn.inputStream.use { it.readBytes() }.toString(Charsets.UTF_8)
        conn.disconnect()

        val bad = looksLikeScript(text)
        if (bad != null) return "скачанное отвергнуто ($bad)"

        val v = versionOf(text)
        if (!newer(v, now.version)) return "сеть даёт $v, у нас ${now.version} — оставляем"

        if (current(ctx).exists()) current(ctx).copyTo(previous(ctx), overwrite = true)
        current(ctx).writeText(text, Charsets.UTF_8)
        useDownloadedAgain(ctx)
        return "скачана $v (применится при следующем запуске)"
    }
}
