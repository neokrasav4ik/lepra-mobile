package ru.neokrasav4ik.lepramobile

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Typeface
import android.os.Bundle
import android.view.Gravity
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
   жив ли вход, и при этом отчёт можно спокойно переслать. */
class DiagActivity : AppCompatActivity() {

    override fun onCreate(saved: Bundle?) {
        super.onCreate(saved)

        val pad = (16 * resources.displayMetrics.density).toInt()
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
        }

        val text = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 12f
            setTextIsSelectable(true)
            text = body()
        }

        val copy = Button(this).apply {
            text = getString(R.string.diag_copy)
            setOnClickListener {
                val cb = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                cb.setPrimaryClip(ClipData.newPlainText("lepra-diag", body()))
                Toast.makeText(this@DiagActivity, "Скопировано", Toast.LENGTH_SHORT).show()
            }
        }

        val revert = Button(this).apply {
            text = getString(R.string.diag_bundled)
            setOnClickListener {
                ScriptStore.revertToBundled(this@DiagActivity)
                Toast.makeText(
                    this@DiagActivity,
                    "Встроенная копия. Закройте и откройте приложение.",
                    Toast.LENGTH_LONG
                ).show()
            }
        }

        val update = Button(this).apply {
            text = "Проверить обновление скрипта"
            setOnClickListener {
                ScriptStore.maybeUpdate(this@DiagActivity, force = true) { said ->
                    runOnUiThread {
                        Toast.makeText(this@DiagActivity, said, Toast.LENGTH_LONG).show()
                        text2.text = body()
                    }
                }
            }
        }

        text2 = text
        col.addView(text, lp())
        col.addView(copy, lp())
        col.addView(update, lp())
        col.addView(revert, lp())

        val scroll = ScrollView(this).apply {
            addView(col, ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        setContentView(scroll)
    }

    private lateinit var text2: TextView

    private fun lp() = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
    ).apply { gravity = Gravity.START }

    private fun body(): String {
        val sb = StringBuilder()
        sb.append(Diag.report())
        sb.append("\nКУКИ ЛЕПРЫ (только имена)\n")
        val c = CookieManager.getInstance().getCookie(MainActivity.HOME)
        if (c.isNullOrBlank()) sb.append("  ни одной — значит входа нет\n")
        else {
            val names = c.split(';').mapNotNull { it.substringBefore('=').trim().ifBlank { null } }
            sb.append("  ").append(names.sorted().joinToString(", ")).append('\n')
            sb.append("  всего ").append(names.size).append('\n')
        }
        return sb.toString()
    }
}
