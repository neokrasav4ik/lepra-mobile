package ru.neokrasav4ik.lepramobile

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Typeface
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.CookieManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity

/* Экран отчёта.

   Открывается долгим нажатием по значку приложения («Диагностика») или
   решёткой #appdiag в адресе.

   Зачем он есть: chrome://inspect требует компьютера, а компьютер будет не
   всегда. Без этого экрана единственным способом узнать причину поломки
   осталось бы гадание, а правило проекта — сначала цифры.

   Значений кук здесь нет намеренно: печатаются только ИМЕНА. По ним видно,
   жив ли вход, и при этом отчёт можно спокойно переслать.

   Отдельно про устройство этого файла. Первая его редакция не собралась, и
   поучительно почему: местная переменная называлась text, а подписи кнопкам
   ставились внутри apply как text = "...". Котлин в таком месте видит не
   свойство кнопки, а внешнюю переменную — она val и она TextView. Ошибка
   выглядела дико («ожидался TextView, а дали строку»), хотя причина —
   заслонённое имя.

   Отсюда здесь ни одного apply с присваиванием подписи: кнопки собирает
   отдельная функция, где заслонять нечего. */
class DiagActivity : AppCompatActivity() {

    private lateinit var report: TextView

    override fun onCreate(saved: Bundle?) {
        super.onCreate(saved)

        val pad = (16 * resources.displayMetrics.density).toInt()

        report = TextView(this)
        report.typeface = Typeface.MONOSPACE
        report.textSize = 12f
        report.setTextIsSelectable(true)
        report.text = collect()

        val column = LinearLayout(this)
        column.orientation = LinearLayout.VERTICAL
        column.setPadding(pad, pad, pad, pad)

        column.addView(report, wide())
        column.addView(button(getString(R.string.diag_copy)) { copyOut() }, wide())
        column.addView(button("Проверить обновление скрипта") { askUpdate() }, wide())
        column.addView(button("Проверить обновление приложения") { askAppUpdate() }, wide())
        column.addView(button(getString(R.string.diag_bundled)) { toBundled() }, wide())

        val scroll = ScrollView(this)
        scroll.addView(
            column,
            ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
        )
        setContentView(scroll)
    }

    private fun wide() = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT,
        ViewGroup.LayoutParams.WRAP_CONTENT
    )

    private fun button(label: String, onTap: () -> Unit): Button {
        val b = Button(this)
        b.text = label
        b.setOnClickListener { onTap() }
        return b
    }

    private fun say(what: String) = Toast.makeText(this, what, Toast.LENGTH_LONG).show()

    private fun copyOut() {
        val clip = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clip.setPrimaryClip(ClipData.newPlainText("lepra-diag", collect()))
        say("Скопировано")
    }

    private fun askUpdate() {
        ScriptStore.maybeUpdate(this, force = true) { said ->
            runOnUiThread {
                say(said)
                report.text = collect()
            }
        }
    }

    private fun askAppUpdate() {
        AppUpdate.check(this, force = true) { said, found ->
            runOnUiThread {
                report.text = collect()
                if (found == null) {
                    say(said)
                } else {
                    androidx.appcompat.app.AlertDialog.Builder(this)
                        .setTitle("Есть версия " + found.version)
                        .setMessage(said + ". Скачать? После загрузки нажмите на " +
                                    "уведомление — Андроид поставит её поверх нынешней.")
                        .setPositiveButton("Скачать") { _, _ ->
                            AppUpdate.download(this, found)
                            say("Качаю " + found.name)
                        }
                        .setNegativeButton("Потом", null)
                        .show()
                }
            }
        }
    }

    private fun toBundled() {
        ScriptStore.revertToBundled(this)
        say("Встроенная копия. Закройте и откройте приложение.")
    }

    private fun collect(): String {
        val sb = StringBuilder()
        sb.append(Diag.report())
        sb.append("\nКУКИ ЛЕПРЫ (только имена)\n")
        val c = CookieManager.getInstance().getCookie(MainActivity.HOME)
        if (c.isNullOrBlank()) {
            sb.append("  ни одной — значит входа нет\n")
        } else {
            val names = c.split(';').mapNotNull { it.substringBefore('=').trim().ifBlank { null } }
            sb.append("  ").append(names.sorted().joinToString(", ")).append('\n')
            sb.append("  всего ").append(names.size).append('\n')
        }
        return sb.toString()
    }
}
