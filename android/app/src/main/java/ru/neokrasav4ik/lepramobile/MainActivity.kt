package ru.neokrasav4ik.lepramobile

import android.app.DownloadManager
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Environment
import android.os.Message
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.URLUtil
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

class MainActivity : AppCompatActivity() {

    companion object {
        const val HOME = "https://leprosorium.ru/"

        /* Тона взяты из сетки скрипта. Значения ЭКРАННЫЕ: ночной прообраз
           под фильтр инверсии живёт в скрипте, а здесь нужен тот цвет,
           который человек видит. */
        const val PAGE_DAY = 0xFFFDFCFA.toInt()
        const val PAGE_NIGHT = 0xFF111010.toInt()

        /* Правила, по которым скрипт попадает на страницу. Домен лепры и
           только он: в чужие окна (реклама, вставки с других сайтов) наш
           код не заходит вовсе. */
        val ORIGINS = setOf("https://leprosorium.ru", "https://*.leprosorium.ru")

        /* Чужие ошибки в журнале. Тот же приём, что на стенде: без маски
           наши тонут в чужих. CORS на картинках — это скрипт пробует снять
           пиксели гертруды через canvas, и в браузере ровно то же самое.
           Отсеянное не пропадает молча: счётчик виден в отчёте. */
        val FOREIGN = listOf(
            Regex("blocked by CORS policy", RegexOption.IGNORE_CASE),
            Regex("Access to image at", RegexOption.IGNORE_CASE),
            Regex("Failed to load resource", RegexOption.IGNORE_CASE),
            Regex("net::ERR_", RegexOption.IGNORE_CASE),
            Regex("attribute d: Expected", RegexOption.IGNORE_CASE),
            Regex("<path>: Expected", RegexOption.IGNORE_CASE),
            Regex("was preloaded using link preload", RegexOption.IGNORE_CASE),
            Regex("Third-party cookie", RegexOption.IGNORE_CASE),
            Regex("advertronic|mc\\.yandex|favicon", RegexOption.IGNORE_CASE),
        )
    }

    private lateinit var root: FrameLayout
    private lateinit var swipe: SwipeRefreshLayout
    private lateinit var web: WebView
    private lateinit var fullscreen: FrameLayout

    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null
    private var filePath: ValueCallback<Array<Uri>>? = null
    private var pullBlocked = false
    private var dark = false
    private var lastFailed: String? = null
    private var headersSeen = false
    private var foreignErrors = 0
    private val chrome = Chrome()

    private val fileChooser = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { res ->
        /* Ответить обязательно — хоть пустотой. Если проглотить обратный
           вызов, поле выбора файла на странице умирает НАВСЕГДА: второй раз
           WebView его уже не покажет, и выглядеть это будет как «не
           прикладываются картинки», без единой ошибки в журнале. */
        val cb = filePath
        filePath = null
        cb?.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(res.resultCode, res.data))
    }

    override fun onCreate(saved: Bundle?) {
        super.onCreate(saved)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_main)

        root = findViewById(R.id.root)
        swipe = findViewById(R.id.swipe)
        web = findViewById(R.id.web)
        fullscreen = findViewById(R.id.fullscreen)

        dark = darkFromCookie()
        paint()

        /* Системные вставки. С Андроида 15 приложение рисуется под строкой
           состояния и панелью навигации, отказаться нельзя. Отступы кладём
           на слой с перетягом, а не на корень: корень остаётся залитым тоном
           страницы и виден в самих полосах. */
        ViewCompat.setOnApplyWindowInsetsListener(swipe) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            insets
        }

        setupWeb()
        setupSwipe()
        setupBack()

        if (!injectScript()) return

        web.loadUrl(startUrl())
        ScriptStore.maybeUpdate(this)
        AppUpdate.check(this, force = false) { _, found ->
            if (found != null) runOnUiThread { offerUpdate(found) }
        }
    }

    /* Предложение обновиться. Спрашиваем, а не качаем молча: человек может
       сидеть на мобильном интернете, а APK весит мегабайты. */
    private fun offerUpdate(f: AppUpdate.Found) {
        if (isFinishing || isDestroyed) return
        androidx.appcompat.app.AlertDialog.Builder(this)
            .setTitle("Есть версия ${f.version}")
            .setMessage("Сейчас стоит ${BuildConfig.VERSION_NAME}. Скачать?\n\n" +
                        "После загрузки нажмите на уведомление — Андроид поставит " +
                        "её поверх нынешней.")
            .setPositiveButton("Скачать") { _, _ ->
                AppUpdate.download(this, f)
                toast("Качаю ${f.name}")
            }
            .setNegativeButton("Потом", null)
            .show()
    }

    private fun startUrl(): String {
        val data = intent?.data
        return if (data != null && ours(data)) data.toString() else HOME
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val d = intent.data ?: return
        if (ours(d)) web.loadUrl(d.toString())
    }

    // ------------------------------------------------------------------
    // WebView
    // ------------------------------------------------------------------

    private fun setupWeb() {
        val s = web.settings
        s.javaScriptEnabled = true

        /* Без domStorage не работает НИЧЕГО из наших настроек: скрипт держит
           в localStorage и настройки, и тему, и память о голосах. По
           умолчанию оно выключено, ломается молча, а выглядит как «скрипт
           сломался». */
        s.domStorageEnabled = true

        /* Без useWideViewPort WebView не читает метатег viewport, который
           скрипт ставит первым делом, — и мобильная вёрстка не включается
           вовсе. */
        s.useWideViewPort = true
        s.loadWithOverviewMode = true

        s.setSupportZoom(true)
        s.builtInZoomControls = true
        s.displayZoomControls = false
        s.setSupportMultipleWindows(true)
        s.javaScriptCanOpenWindowsAutomatically = true
        s.mediaPlaybackRequiresUserGesture = false
        s.mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE

        /* WebView по умолчанию домножает кегль на системную настройку
           размера шрифта. У человека с крупным системным шрифтом вёрстка
           расползлась бы, а причина осталась бы незаметной. Кегль тела у нас
           и так ползунок в попапе — пусть управление будет одно. */
        s.textZoom = 100

        web.setBackgroundColor(pageTone())
        WebView.setWebContentsDebuggingEnabled(true)

        val cm = CookieManager.getInstance()
        cm.setAcceptCookie(true)
        cm.setAcceptThirdPartyCookies(web, true)

        /* Своё затемнение WebView обязано быть выключено. Наша тёмная тема —
           filter: invert(1) hue-rotate(180deg) на html, и ночные тона
           записаны ПРООБРАЗОМ под этот фильтр. Если WebView начнёт затемнять
           сам, две работы наложатся, и выйдет не темнее, а мусор. */
        if (WebViewFeature.isFeatureSupported(WebViewFeature.ALGORITHMIC_DARKENING)) {
            WebSettingsCompat.setAlgorithmicDarkeningAllowed(s, false)
            Diag.fact("своё затемнение WebView", "выключено")
        } else {
            Diag.fact("своё затемнение WebView", "нет такой возможности в этом WebView")
        }

        hushRequestedWith(s)

        web.addJavascriptInterface(Bridge(), "LepraHost")
        web.webViewClient = Client()
        web.webChromeClient = chrome

        web.setDownloadListener { url, agent, disposition, mime, _ ->
            download(url, agent, disposition, mime)
        }

        /* Долгий тап по картинке.

           В браузере это делает сам браузер: длинное нажатие даёт меню
           «сохранить изображение». У WebView такого меню нет вовсе — он
           отдаёт голое окно, и всё, что в браузере «просто есть», в
           приложении надо писать руками. Отсюда жалоба «долгий тап на
           картинку не работает»: работать было нечему.

           hitTestResult отвечает, что именно под пальцем. Нас занимают два
           случая: картинка и картинка внутри ссылки. Всё прочее (текст,
           ссылка, поле ввода) отдаём странице — там своё поведение, и
           перебивать его нельзя: на длинном нажатии по тексту стоит
           выделение. */
        web.setOnLongClickListener {
            val hit = web.hitTestResult
            val url = hit.extra
            val isImage = hit.type == WebView.HitTestResult.IMAGE_TYPE ||
                          hit.type == WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE
            if (isImage && !url.isNullOrBlank()) {
                imageMenu(url)
                true
            } else {
                false
            }
        }

        val pkg = WebViewCompat.getCurrentWebViewPackage(this)
        Diag.fact("движок", if (pkg == null) "не определён"
                  else "${pkg.packageName} ${pkg.versionName}")
        Diag.fact("впрыск до разбора",
            if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) "есть"
            else "НЕТ — нужен свежий Android System WebView")
    }

    /* ------------------------------------------------------------------
       X-Requested-With.

       WebView добавляет ко всем запросам заголовок X-Requested-With с именем
       нашего пакета. Лепра по наличию этого заголовка отличает свои
       ajax-запросы от обычной навигации — то есть в худшем случае вместо
       страницы придёт кусок JSON.

       Убрать его в Chromium собирались и передумали: работы свернули в
       сентябре 2025, замены не нашлось. Значит гасим сами.

       Зовём ОТРАЖЕНИЕМ, а не напрямую, по одной причине: за годы у этой
       возможности было два разных имени (setRequestedWithHeaderMode и
       setRequestedWithHeaderOriginAllowList), и какое живёт в нашей версии
       библиотеки — я отсюда проверить не могу. Прямой вызов угаданного имени
       сломал бы СБОРКУ, отражение же в худшем случае честно скажет в отчёте,
       что не вышло, и приложение соберётся и запустится.
    ------------------------------------------------------------------ */
    private fun hushRequestedWith(s: WebSettings) {
        val cls = runCatching { Class.forName("androidx.webkit.WebSettingsCompat") }.getOrNull()
        if (cls == null) {
            Diag.fact("X-Requested-With", "androidx.webkit не найден")
            return
        }

        /* Спрашиваем сам движок, знает ли он про эту возможность. Имя
           признака берём строкой, а не постоянной: постоянной может не
           оказаться в нашей версии библиотеки, и тогда не собралось бы. */
        val known = runCatching {
            WebViewFeature.isFeatureSupported("REQUESTED_WITH_HEADER_ALLOW_LIST")
        }.fold({ if (it) "да" else "нет" }, { "спросить не вышло (" + it.javaClass.simpleName + ")" })

        val notes = StringBuilder("движок знает про список источников: ").append(known)

        /* Разбор по случаям — в этом весь смысл переделки. Прежняя редакция
           писала одно «погасить не вышло» и на «метода нет в библиотеке», и
           на «метод есть, но вызов отказал». Это разные беды с разным
           лечением: первая чинится поднятием версии библиотеки, вторая не
           чинится вовсе. Подпись, которая их путает, хуже отсутствующей. */
        fun tryOne(name: String, argType: Class<*>, arg: Any): Boolean {
            val m = runCatching { cls.getMethod(name, WebSettings::class.java, argType) }.getOrNull()
            if (m == null) {
                notes.append(" | ").append(name).append(": метода в библиотеке нет")
                return false
            }
            val r = runCatching { m.invoke(null, s, arg) }
            if (r.isSuccess) return true
            val e = r.exceptionOrNull()
            val why = (e?.cause ?: e)?.let { it.javaClass.simpleName + ": " + (it.message ?: "") }
            notes.append(" | ").append(name).append(": вызов отказал — ").append(why)
            return false
        }

        if (tryOne("setRequestedWithHeaderOriginAllowList", java.util.Set::class.java, emptySet<String>())) {
            Diag.fact("X-Requested-With", "погашен списком источников | " + notes)
            return
        }
        /* 0 — REQUESTED_WITH_HEADER_MODE_NO_HEADER у прежнего API. */
        if (tryOne("setRequestedWithHeaderMode", Int::class.javaPrimitiveType!!, 0)) {
            Diag.fact("X-Requested-With", "погашен режимом «без заголовка» | " + notes)
            return
        }
        Diag.fact("X-Requested-With", "погасить не вышло | " + notes)
    }

    // ------------------------------------------------------------------
    // Впрыск скрипта
    // ------------------------------------------------------------------

    private fun injectScript(): Boolean {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            showPlain(
                "Старый WebView",
                "Обновите «Android System WebView» из Play Маркета — без свежей " +
                "версии страницу не переоформить."
            )
            return false
        }

        val loaded = ScriptStore.load(this)
        /* Байты и знаки — разные числа, и путать их дорого: подпись
           «байт» при длине строки заставила однажды искать несуществующую
           вторую копию скрипта. Для кириллицы разница — треть файла. */
        val bytes = loaded.text.toByteArray(Charsets.UTF_8).size
        Diag.fact("скрипт", "${loaded.version}, ${loaded.source}, " +
            "$bytes байт (${loaded.text.length} знаков)")

        /* Порядок важен: сперва оправа объявляет о себе, потом идёт скрипт.
           Наоборот было бы поздно — скрипт читает window.lmHost при старте. */
        runCatching {
            WebViewCompat.addDocumentStartJavaScript(web, preamble(), ORIGINS)
            WebViewCompat.addDocumentStartJavaScript(web, loaded.text, ORIGINS)
            Diag.log("скрипт зарегистрирован на ${ORIGINS.joinToString(", ")}")
        }.onFailure {
            Diag.fact("впрыск", "ОШИБКА: ${it.message}")
            showPlain("Скрипт не встал", it.message ?: "неизвестно почему")
            return false
        }
        return true
    }

    /* Преамбула. Делает три вещи и ни одной лишней:

       1. Объявляет среду. Приложение — третья среда после Safari и Firefox,
          и всё, что должно вести себя в нём иначе, ветвится ВНУТРИ скрипта
          по window.lmHost. Форка скрипта нет и не будет.
       2. Сообщает оправе о теме, чтобы полосы под часами и над кнопками
          красились вместе со страницей, а не отставали.
       3. Говорит, можно ли сейчас тянуть страницу вниз для обновления.
          Нативный перетяг ничего не знает про окна с собственной прокруткой
          (попап настроек, окно пыни, голосовалка, список поиска) — а внутри
          них жест обязан прокручивать список, а не перезагружать лепру. */
    private fun preamble(): String = """
        (function () {
          var H = window.LepraHost;
          try {
            window.lmHost = { app: 'android', version: ${BuildConfig.VERSION_CODE},
                              back: 'native', pull: 'native' };
          } catch (e) {}
          if (!H || window.top !== window) return;

          function tell() {
            try { H.themeIs(document.documentElement.classList.contains('lm-dark')); }
            catch (e) {}
          }
          function start() {
            tell();
            try {
              new MutationObserver(tell).observe(document.documentElement,
                { attributes: true, attributeFilter: ['class'] });
            } catch (e) {}
            if (location.hash === '#appdiag') { try { H.openDiag(); } catch (e) {} }
          }
          if (document.documentElement) start();
          else document.addEventListener('DOMContentLoaded', start);

          function blocked(node) {
            for (var n = node; n && n.nodeType === 1 && n !== document.body; n = n.parentNode) {
              var cs;
              try { cs = getComputedStyle(n); } catch (e) { return false; }
              if (cs.position === 'fixed') return true;
              var ob = cs.overscrollBehaviorY || cs.overscrollBehavior;
              if (ob === 'contain' || ob === 'none') return true;
              var oy = cs.overflowY;
              if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight + 1)
                return true;
            }
            return false;
          }
          document.addEventListener('touchstart', function (e) {
            try { H.setPullBlocked(blocked(e.target)); } catch (err) {}
          }, true);
        })();
    """.trimIndent()

    // ------------------------------------------------------------------
    // Перетяг вниз
    // ------------------------------------------------------------------

    private fun setupSwipe() {
        swipe.setColorSchemeColors(0xFFC93825.toInt())
        swipe.setOnRefreshListener { web.reload() }
        /* Тянуть можно, только когда страница вверху И палец начался не на
           окне с собственной прокруткой. Первое проверяет оправа, второе —
           преамбула, потому что из Kotlin о разметке страницы ничего не
           видно. */
        swipe.setOnChildScrollUpCallback { _, _ -> web.scrollY > 0 || pullBlocked }
    }

    // ------------------------------------------------------------------
    // «Назад»
    // ------------------------------------------------------------------

    private fun setupBack() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    customView != null -> chrome.onHideCustomView()
                    web.canGoBack() -> web.goBack()
                    else -> finish()
                }
            }
        })
    }

    // ------------------------------------------------------------------
    // Тема и тона
    // ------------------------------------------------------------------

    private fun pageTone() = if (dark) PAGE_NIGHT else PAGE_DAY

    private fun darkFromCookie(): Boolean {
        /* Скрипт зеркалит общие настройки в куку на .leprosorium.ru —
           хранилище у поддоменов раздельное. Нам это на руку: тон полос
           известен ДО первой отрисовки, без единой строчки JS. */
        val c = CookieManager.getInstance().getCookie(HOME) ?: return false
        return Regex("""(^|;\s*)lm-dark=1""").containsMatchIn(c)
    }

    private fun paint() {
        root.setBackgroundColor(pageTone())
        if (::web.isInitialized) web.setBackgroundColor(pageTone())
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
    }

    private fun applyTheme(darkNow: Boolean) {
        if (darkNow == dark) return
        dark = darkNow
        paint()
        Diag.log("тема: " + if (dark) "ночь" else "день")
    }

    // ------------------------------------------------------------------
    // Свои страницы (ошибка сети, отказ)
    // ------------------------------------------------------------------

    private fun showPlain(head: String, body: String) {
        val bg = if (dark) "#111010" else "#fdfcfa"
        val ink = if (dark) "#eae7e2" else "#191714"
        val html = """
            <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
            <body style="margin:0;padding:24px;background:$bg;color:$ink;
                         font:16px/1.4 Verdana,sans-serif">
              <h1 style="font-size:20px;margin:0 0 12px">$head</h1>
              <p style="margin:0 0 20px;color:${if (dark) "#969189" else "#6f6a62"}">$body</p>
              <button onclick="LepraHost.retry()"
                      style="font:16px Verdana,sans-serif;color:$ink;background:transparent;
                             border:1px solid ${if (dark) "#59544c" else "#b0aaa0"};
                             border-radius:5px;padding:10px 16px">Ещё раз</button>
            </body>
        """.trimIndent()
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
    }

    // ------------------------------------------------------------------
    // Ссылки и скачивание
    // ------------------------------------------------------------------

    private fun ours(u: Uri): Boolean {
        val h = u.host ?: return false
        val s = u.scheme ?: return false
        if (s != "https" && s != "http") return false
        return h == "leprosorium.ru" || h.endsWith(".leprosorium.ru")
    }

    private fun outside(u: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: ActivityNotFoundException) {
            toast("Нечем открыть: $u")
        }
    }

    private fun download(url: String, agent: String?, disposition: String?, mime: String?) {
        /* blob: сюда не приходит — такие ссылки WebView отдаёт странице, а не
           нам. Пока это не мешает: лепра отдаёт картинки обычными адресами. */
        try {
            val name = URLUtil.guessFileName(url, disposition, mime)
            val req = DownloadManager.Request(Uri.parse(url))
                .addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                .addRequestHeader("User-Agent", agent ?: "")
                .setMimeType(mime)
                .setTitle(name)
                .setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name)
            (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
            toast("Качаю $name")
        } catch (e: Throwable) {
            Diag.log("скачивание не вышло: ${e.message}")
            toast("Не вышло скачать: ${e.message}")
        }
    }

    private fun toast(t: String) = Toast.makeText(this, t, Toast.LENGTH_SHORT).show()

    private fun imageMenu(url: String) {
        /* data: и blob: через DownloadManager не качаются — он умеет только
           сетевые адреса. Врать кнопкой, которая ничего не делает, нельзя,
           поэтому такие адреса просто не предлагаем сохранять. */
        val saveable = url.startsWith("http://") || url.startsWith("https://")
        val items = if (saveable)
            arrayOf("Сохранить картинку", "Открыть в браузере", "Скопировать ссылку")
        else
            arrayOf("Скопировать ссылку")

        androidx.appcompat.app.AlertDialog.Builder(this)
            .setItems(items) { _, which ->
                when (items[which]) {
                    "Сохранить картинку" -> download(url, web.settings.userAgentString, null, null)
                    "Открыть в браузере" -> outside(Uri.parse(url))
                    "Скопировать ссылку" -> {
                        val cb = getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
                        cb.setPrimaryClip(android.content.ClipData.newPlainText("lepra", url))
                        toast("Ссылка скопирована")
                    }
                }
            }
            .show()
    }

    private fun openDiagScreen() {
        startActivity(Intent(this, DiagActivity::class.java))
    }

    // ------------------------------------------------------------------

    private inner class Client : WebViewClient() {

        override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
            val u = req.url
            if (u.fragment == "appdiag") {
                openDiagScreen()
                return true
            }
            if (ours(u)) return false
            outside(u)
            return true
        }

        /* Единственное место, где видно ЗАГОЛОВКИ нашего запроса. Пишем их
           для главного запроса страницы один раз за загрузку: по ним и
           проверяется, ушёл ли X-Requested-With. Ничего не подменяем —
           возвращаем null, запрос идёт своим ходом. */
        override fun shouldInterceptRequest(
            view: WebView, req: WebResourceRequest
        ): WebResourceResponse? {
            if (req.isForMainFrame && !headersSeen) {
                headersSeen = true
                val h = req.requestHeaders
                val xrw = h["X-Requested-With"] ?: h["x-requested-with"]
                Diag.fact("заголовок X-Requested-With",
                    if (xrw == null) "не виден в запросе" else "ЕСТЬ: $xrw")
                Diag.log("главный запрос: ${req.url}")
            }
            return null
        }

        override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
            headersSeen = false
        }

        /* Колесико гасим ЗДЕСЬ, а не в onPageFinished.

           onPageFinished приходит, когда догружено всё до последней
           картинки и последнего куска видео, а лепра тянет предзагрузкой
           десятки мегабайт роликов — отсюда жалоба «обновилось быстро, а
           колесико крутится ещё несколько секунд». Оно и крутилось честно:
           страница-то была готова, а загрузка нет.

           onPageCommitVisible приходит в момент, когда новая страница
           впервые нарисована на экране. Это ровно то мгновение, которое
           человек и называет «обновилось». */
        override fun onPageCommitVisible(view: WebView, url: String) {
            swipe.isRefreshing = false
        }

        override fun onPageFinished(view: WebView, url: String) {
            swipe.isRefreshing = false
            applyTheme(darkFromCookie())
            /* Проверка «а встал ли скрипт» — не догадкой, а вопросом к
               странице. Ответ ложится в отчёт: с телефона это единственный
               способ отличить «скрипт не сработал» от «страница другая». */
            view.evaluateJavascript(
                "(function(){try{return (typeof window.lmHost)+'/'+" +
                "(document.getElementById('lepra-mobile-css')?'css есть':'css нет')+'/'+" +
                "(window.lmPynRan||0);}catch(e){return 'ошибка: '+e;}})()"
            ) { r -> Diag.fact("на странице", r?.trim('"') ?: "нет ответа") }
        }

        override fun onReceivedError(view: WebView, req: WebResourceRequest, err: WebResourceError) {
            if (!req.isForMainFrame) return
            lastFailed = req.url.toString()
            Diag.log("сеть: ${err.errorCode} на ${req.url}")
            swipe.isRefreshing = false
            showPlain("Лепра не отвечает", "Проверьте сеть. Адрес: ${req.url}")
        }
    }

    private inner class Chrome : WebChromeClient() {

        override fun onShowFileChooser(
            view: WebView,
            callback: ValueCallback<Array<Uri>>,
            params: FileChooserParams
        ): Boolean {
            filePath?.onReceiveValue(null)
            filePath = callback
            return try {
                fileChooser.launch(params.createIntent())
                true
            } catch (e: Throwable) {
                filePath = null
                callback.onReceiveValue(null)
                toast("Нечем выбрать файл")
                false
            }
        }

        override fun onCreateWindow(
            view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message
        ): Boolean {
            /* target="_blank" и window.open. Своя ссылка «Link» под видео —
               ровно этот случай. Настоящего второго окна не заводим: узнаём
               адрес и решаем, внутрь его или наружу. */
            val temp = WebView(this@MainActivity)
            temp.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(v: WebView, req: WebResourceRequest): Boolean {
                    if (ours(req.url)) web.loadUrl(req.url.toString()) else outside(req.url)
                    v.destroy()
                    return true
                }
            }
            (resultMsg.obj as WebView.WebViewTransport).webView = temp
            resultMsg.sendToTarget()
            return true
        }

        override fun onShowCustomView(view: View, callback: CustomViewCallback) {
            if (customView != null) { callback.onCustomViewHidden(); return }
            customView = view
            customCallback = callback
            fullscreen.addView(view, FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            fullscreen.visibility = View.VISIBLE
            swipe.visibility = View.GONE
            WindowInsetsControllerCompat(window, window.decorView).hide(
                WindowInsetsCompat.Type.systemBars())
        }

        override fun onHideCustomView() {
            val v = customView ?: return
            fullscreen.removeView(v)
            fullscreen.visibility = View.GONE
            swipe.visibility = View.VISIBLE
            customView = null
            customCallback?.onCustomViewHidden()
            customCallback = null
            WindowInsetsControllerCompat(window, window.decorView).show(
                WindowInsetsCompat.Type.systemBars())
        }

        override fun onConsoleMessage(m: ConsoleMessage): Boolean {
            if (m.messageLevel() != ConsoleMessage.MessageLevel.ERROR) return true
            val t = m.message() ?: ""
            if (FOREIGN.any { it.containsMatchIn(t) }) {
                foreignErrors++
                Diag.fact("чужих ошибок отсеяно", foreignErrors.toString())
                return true
            }
            Diag.log("js: $t (${m.sourceId()}:${m.lineNumber()})")
            return true
        }
    }

    private inner class Bridge {
        @JavascriptInterface fun setPullBlocked(b: Boolean) { pullBlocked = b }
        @JavascriptInterface fun themeIs(d: Boolean) { runOnUiThread { applyTheme(d) } }
        @JavascriptInterface fun openDiag() { runOnUiThread { openDiagScreen() } }
        @JavascriptInterface fun retry() {
            runOnUiThread { web.loadUrl(lastFailed ?: HOME) }
        }
    }

    // ------------------------------------------------------------------

    override fun onResume() {
        super.onResume()
        web.onResume()
    }

    override fun onPause() {
        super.onPause()
        web.onPause()
        /* Запись кук на диск отложена, и убитое системой приложение теряет
           свежие. Это самая частая причина жалобы «всё время разлогинивает». */
        CookieManager.getInstance().flush()
    }

    override fun onDestroy() {
        filePath?.onReceiveValue(null)
        filePath = null
        super.onDestroy()
    }
}
