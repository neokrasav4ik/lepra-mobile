package ru.neokrasav4ik.lepramobile

import android.app.DownloadManager
import android.content.Context
import android.net.Uri
import android.os.Environment
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

/* Обновление САМОГО приложения.

   Скрипт обновляется сам (ScriptStore), а APK до сих пор надо было качать
   руками со страницы выпусков. Пока компьютер под рукой это мелочь, а без
   него — единственный путь к новой версии, и человек про него забудет.

   Устройство простое до неприличия и намеренно:

     — спрашиваем у GitHub последний выпуск нашего же репозитория;
     — сравниваем номер с тем, что сейчас стоит;
     — если новее, предлагаем скачать; качает системная качалка, и она же
       показывает уведомление.

   Ставит человек сам, нажатием на уведомление. Мы могли бы запускать
   установщик своими руками, но это требует особого разрешения
   («устанавливать неизвестные приложения»), от которого приложение
   выглядит куда наглее, чем оно есть. Одно лишнее нажатие того не стоит.

   Куда ходим: только api.github.com за описанием выпуска и по адресу
   самого файла из ответа, и только если он лежит на github. Проверка
   адреса не паранойя: описание выпуска — это чужой текст, и вести по
   ссылке из него куда попало нельзя. */
object AppUpdate {

    private const val REPO = "neokrasav4ik/lepra-mobile"
    private const val API = "https://api.github.com/repos/$REPO/releases/latest"
    private const val PREFS = "lepra"
    private const val K_LAST = "app_update_last_check"
    private const val DAY_MS = 24L * 60 * 60 * 1000

    class Found(val version: String, val url: String, val name: String)

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

    private fun trusted(url: String): Boolean =
        url.startsWith("https://github.com/") ||
        url.startsWith("https://objects.githubusercontent.com/") ||
        url.startsWith("https://release-assets.githubusercontent.com/")

    /** done(что сказать человеку, найденное или null) — зовётся не в главном потоке. */
    fun check(ctx: Context, force: Boolean, done: (String, Found?) -> Unit) {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (!force && System.currentTimeMillis() - p.getLong(K_LAST, 0) < DAY_MS) {
            done("проверялось меньше суток назад", null)
            return
        }
        thread(name = "app-update") {
            val r = runCatching { ask(ctx) }
            p.edit().putLong(K_LAST, System.currentTimeMillis()).apply()
            val said: String
            var found: Found? = null
            if (r.isFailure) {
                said = "сеть: " + (r.exceptionOrNull()?.javaClass?.simpleName ?: "ошибка")
            } else {
                found = r.getOrNull()
                said = if (found == null) "у нас последняя (${BuildConfig.VERSION_NAME})"
                       else "есть ${found.version}, у нас ${BuildConfig.VERSION_NAME}"
            }
            Diag.fact("обновление приложения", said)
            done(said, found)
        }
    }

    private fun ask(ctx: Context): Found? {
        val conn = (URL(API).openConnection() as HttpURLConnection).apply {
            connectTimeout = 15_000
            readTimeout = 20_000
            setRequestProperty("Accept", "application/vnd.github+json")
        }
        if (conn.responseCode != 200) {
            conn.disconnect()
            throw IllegalStateException("ответ " + conn.responseCode)
        }
        val body = conn.inputStream.use { it.readBytes() }.toString(Charsets.UTF_8)
        conn.disconnect()

        val o = JSONObject(body)
        /* Метка выпуска у нас вида app-v0.1.2-7: номер приложения между v и
           последним дефисом, дальше номер сборки. */
        val tag = o.optString("tag_name", "")
        val ver = Regex("""v([0-9]+(?:\.[0-9]+)*)""").find(tag)?.groupValues?.get(1)
            ?: return null
        if (!newer(ver, BuildConfig.VERSION_NAME)) return null

        val assets = o.optJSONArray("assets") ?: return null
        for (i in 0 until assets.length()) {
            val a = assets.optJSONObject(i) ?: continue
            val name = a.optString("name", "")
            val url = a.optString("browser_download_url", "")
            if (!name.endsWith(".apk") || name.contains("-debug")) continue
            if (!trusted(url)) {
                Diag.log("выпуск: адрес не с гитхаба, пропущен — $url")
                continue
            }
            return Found(ver, url, name)
        }
        return null
    }

    fun download(ctx: Context, f: Found) {
        if (!trusted(f.url)) return
        val req = DownloadManager.Request(Uri.parse(f.url))
            .setTitle(f.name)
            .setDescription("Leprosorium ${f.version}")
            .setMimeType("application/vnd.android.package-archive")
            .setNotificationVisibility(
                DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, f.name)
        (ctx.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
        Diag.log("качаем ${f.name}")
    }
}
