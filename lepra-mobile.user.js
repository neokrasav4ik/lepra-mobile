// ==UserScript==
// @name         Lepra Mobile
// @namespace    lepra.mobile
// @version      0.9.98
// @description  Мобильная адаптация leprosorium.ru для iOS Safari
// @author       neokrasav4ik
// @homepageURL  https://github.com/neokrasav4ik/lepra-mobile
// @supportURL   https://github.com/neokrasav4ik/lepra-mobile/issues
// @updateURL    https://raw.githubusercontent.com/neokrasav4ik/lepra-mobile/main/lepra-mobile.user.js
// @downloadURL  https://raw.githubusercontent.com/neokrasav4ik/lepra-mobile/main/lepra-mobile.user.js
// @license      MIT
// @match        *://leprosorium.ru/*
// @match        *://*.leprosorium.ru/*
// @run-at       document-start
// @inject-into  auto
// @grant        none
// ==/UserScript==

/*
 * Что делает скрипт
 * -----------------
 * Лепрозорий свёрстан под фиксированную ширину с левой колонкой в 245px,
 * правой в 270-340px и без метатега viewport. На телефоне Safari рисует
 * страницу в виртуальном окне 980px и ужимает её — отсюда микрошрифт.
 *
 * Скрипт добавляет viewport, разбирает десктопную раскладку на одну колонку
 * и чинит элементы, которые были прибиты к координатам несуществующих колонок.
 * Плюс несколько своих удобств: навигация по комментариям, просмотрщик
 * картинок, тёмная тема.
 *
 * Чего скрипт НЕ делает
 * ---------------------
 * Не собирает и не передаёт никаких данных. Не обращается к сторонним
 * серверам. Не трогает куки, пароли и содержимое форм. Единственные сетевые
 * запросы — подгрузка превью видео с тех же адресов, откуда их берёт сама
 * лепра. Всё остальное — работа с DOM открытой страницы.
 */

(function () {
  'use strict';

  /* Внутри скрытого окна, которым грузится лента уведомлений (см. раздел
     4.2), скрипт не нужен: там ничего не показывают человеку, а второй
     проход по всей странице — это лишняя работа и лишние наблюдатели. */
  if (window.name === 'lm-pyn-frame') return;

  var VERSION = '0.9.98';

  /* ============================================================
     НАСТРОЙКИ
     ============================================================ */

  var CFG = {
    /* Ширина экрана, до которой работает адаптация. На широких экранах
       десктопная вёрстка лепры уместна сама по себе.
       Сравнивается с шириной ФИЗИЧЕСКОГО экрана, а не окна: скрипт стартует
       до применения viewport, когда Safari считает окно шириной 980, а при
       уменьшенном масштабе страницы — и вовсе за тысячу. */
    maxWidth: 1024,

    /* Видео.
       videoPreload: 'none'     — ничего не качать до нажатия плей
                     'metadata' — только заголовок файла (пара килобайт),
                                  зато известны пропорции и блок не прыгает
       videoPoster:  'frame' — коротко проиграть без звука и встать на паузу;
                               единственный способ, дающий первый кадр на iOS
                     'seek'  — только перемотка, легче, но кадра обычно нет
                     'none'  — не добывать кадр, будет пустой прямоугольник */
    videoPreload: 'metadata',
    videoPoster: 'frame',

    /* За сколько пикселей до экрана готовить медиа и сколько роликов
       обрабатывать одновременно. Оба числа влияют на трафик и на нагрев:
       подготовка десятков видео разом занимает главный поток. */
    lookAhead: 1200,
    maxParallelVideos: 2,
    posterFallbackDelay: 250,

    /* Тап по картинке. 'off' — ничего не делать: файлы у лепры
       полноразмерные, и деталь проще посмотреть щипком.
       'zoom' — узкие картинки разворачивать на всю ширину по тапу.
       В обоих случаях лепровский обработчик глушится: он подменяет узел
       и выбрасывает страницу наверх. */
    imageTap: 'off',

    /* НАСТРОЙКА: на сколько пикселей укоротить поле поиска на главной.
       Там оно делит нижнюю строку шапки с выбором режимов, и лишняя
       длина ни к чему. На инбоксе и в «моих вещах» поле не трогается:
       строка там своя, укорачивать нечего. 0 — не укорачивать. */
    searchTrim: 10,

    /* НАСТРОЙКА: нижний предел ширины поля поиска в сжатой шапке страниц
       с вкладками («мои вещи», инбокс, избранное). Там поле делит строку
       со ссылками и отдаёт им место первым, но уже поля в сантиметр
       вводить нечего. Больше число — поле длиннее, ссылкам теснее. */
    tabsSearchMin: 74,

    /* НАСТРОЙКА: поля страницы по краям экрана — та самая узкая рамка,
       из-за которой текст не упирается в кромку. Число одно на весь
       скрипт: им же отмеряется, насколько растянуть кастомный фон
       подлепры, чтобы он доходил до краёв, а текст остался на месте. */
    pageEdge: 12,

    /* НАСТРОЙКА: высота полосы фона профиля между навигационной штукой и
       телом. По бокам и снизу фон занимает дежурные поля страницы
       (pageEdge) — те самые, что на подлепрах отданы кастомному фону.
       Ноль оставит только боковые полосы. У профилей без своей картинки
       обрамления нет в любом случае. */
    profileArt: 24,

    /* НАСТРОЙКА: кегль выпадающего списка режимов просмотра в шапке
       («NORMAL (0)», «NIGHTMARE (все)»). У лепры он 13 пикселей набором
       Verdana, а соседи по шапке — ссылки в 13 и счётчики в 12 набором
       Arial. При равных числах Verdana выглядит крупнее: очко буквы у неё
       0.545 кегля против 0.519 у Arial, и знаки шире. Двенадцать ставят
       список между ссылками и счётчиками, одиннадцать — вровень со
       счётчиками. Заодно короче становится сам список: ширину ему задаёт
       самый длинный вариант, а он делит строку с полем поиска. */
    thresholdFont: 12,

    /* НАСТРОЙКА: кегль девиза подлепры («Филиал дурдома…») и нижний
       предел, до которого его можно ужимать. Девиз стоит по центру и
       никогда не переносится, поэтому длинный подгоняется по ширине
       экрана: сначала берётся subsiteTitle, и если строка не влезла —
       кегль уменьшается шагом в полпункта, но не ниже subsiteTitleMin.
       Ниже одиннадцати надпись перестаёт читаться, и остаток честнее
       обрезать многоточием, чем делать вид, что он виден. */
    subsiteTitle: 19,
    subsiteTitleMin: 11,

    /* НАСТРОЙКА: ширина окна подтверждения покупки («окно Чарли») в
       процентах от ширины экрана. Окно стоит по центру, а картинка с
       доской и тунцом растянута ровно по нему — поэтому число управляет
       и размером картинки тоже, а полей по краям не возникает.
       100 — во всю ширину экрана. */
    charleyArt: 90,

    /* НАСТРОЙКА: блок «что это такое» на странице званий (/fraud/ranks/).
       Четыре абзаца объяснения аукциона стоят ПЕРЕД таблицей и на телефоне
       занимают целый экран: до первого звания приходится листать.
       Сворачиваем его в строку с уголком. true — раскрывать сразу,
       false — держать свёрнутым. Дальше состояние помнится по нажатию,
       настройка задаёт только первое посещение. */
    ranksAbout: false,

    /* НАСТРОЙКА: страница нового поста.
       newPostBody — высота поля ввода в пикселях. У лепры она прописана
       прямо в разметке (200) и рассчитана на десктоп, где справа от поля
       стоит колонка опций и пустоты не остаётся. На телефоне опции ушли
       вниз, и поле — единственное, ради чего страницу открыли.
       newPostCats — в сколько колонок раскладывать список категорий.
       Две — предел для 393 пикселей: подпись вроде «Книги / Дизайн»
       в половину ширины уже переносится, но читается. Одна — если у
       подлепры длинные названия и переносится каждая вторая. */
    newPostBody: 240,
    newPostCats: 2,

    /* НАСТРОЙКА: свёрнутая строка навигационной штуки.
       navRow — её высота в пикселях. Двадцать девять — то, что было до
       появления герба: подпись в 13 пунктов с межстрочным 1.3 плюс по
       шесть на отбивки. Число ведущее: отбивки считаются от него, и
       гнездо герба растёт внутрь строки, а не раздвигает её.
       navIcon — сторона гнезда под герб. Двадцать один влезает в строку
       без её роста (остаётся по четыре на отбивки). Больше — строка
       начнёт расти; при navIcon от 30 отбивки кончаются совсем. */
    navRow: 29,
    navIcon: 21,

    /* НАСТРОЙКА: прыгалки — навигация по комментариям справа по центру.
       Вид взят у лепры: треугольники и маска, нарисованные в её же
       координатах (сетка 40×40), поэтому jumpSize меняет и размер
       значка, и площадь нажатия разом.
       jumpSize — сторона значка. У лепры 40, отступ справа 10, значки
       стоят вплотную друг к другу.
       jumpRight — отступ от правого края экрана.
       jumpGap — просвет между значками. У лепры нуля; на телефоне
       пара пикселей уменьшает промахи, не сдвигая столбик заметно.
       jumpColor, jumpEye — заливка значков и глаз маски, ровно как
       у лепры. Светло-серый на десктопе лежит в пустом поле справа,
       а на телефоне попадает на текст: если плохо видно, темнее.
       jumpHalo — белый ореол под значком. У лепры его нет и не нужно:
       там под значками пусто. Тут они висят над текстом поста, и без
       ореола светло-серый контур теряется в строчках. false вернёт
       чистый исходный вид. */
    jumpSize: 40,
    jumpRight: 10,
    jumpGap: 2,
    jumpColor: 'rgb(210,211,212)',
    jumpEye: 'rgb(236,34,39)',
    jumpHalo: true,

    /* НАСТРОЙКА: гертруда в развёрнутой штуке.
       gertruda — её обычная ширина в пикселях.
       gertrudaGrow — насколько процентов ей позволено вырасти, если
       столбик ссылок слева оказался выше картинки. Растёт она по высоте
       столбика, но не больше этого предела: дальше начнёт наползать на
       гвоздик, стоящий между ними. */
    gertruda: 118,
    gertrudaGrow: 10,

    /* НАСТРОЙКА: пынь. В десктопе по нажатию на колокольчик всплывает
       окошко со списком, а на страницу уведомлений ведёт ссылка в его
       низу. На телефоне окошко не открывалось, и тап уходил прямо на
       страницу. pynPopup: true возвращает окошко — своё, но с лепровским
       содержимым; false оставляет прежний переход по ссылке.
       pynHeight — высота окошка в процентах экрана.
       pynFresh — сколько секунд считать загруженный список свежим:
       повторное открытие в эти секунды рисуется сразу, без загрузки.
       pynWait — сколько секунд ждать, пока лента соберётся в скрытом
       окне; дальше окно закрывается и человеку пишут, что не вышло.
       pynShade — насколько процентов затемнить страницу под окном.
       Лепра своё окно ничем не затемняет, но оно у неё маленькое и висит
       под колокольчиком; наше во всю ширину, и без подложки по краям
       торчит страница. Ноль уберёт затемнение совсем — закрывать тапом
       мимо окна это не мешает. */
    pynPopup: true,
    pynHeight: 78,
    pynFresh: 60,
    pynWait: 12,
    pynShade: 60,

    /* НАСТРОЙКА: красить панели Safari — адресную строку сверху и полосу
       кнопок снизу — в цвет страницы. Сам Safari угадывает этот цвет по
       содержимому у верхней и нижней кромок экрана и пересчитывает его
       редко: любое затемнение поверх страницы (подложка окна покупки
       перекрывает обе кромки) оставляет панели чёрными и после закрытия
       окна, до следующей прокрутки. Явный цвет снимает угадывание.
       false — не вмешиваться в оформление браузера. */
    themeColor: true,

    /* Потолок на разовый обход DOM. Лепра тратит около 150 элементов
       на комментарий, поэтому тред на тысячу комментариев — это 150 тысяч
       узлов. Обходить их целиком незачем: вёрстка внутри комментариев
       однотипна и уже покрыта правилами CSS. */
    scanBudget: 6000,

    /* Отладочная панель: три тапа по левому верхнему углу или #lmdebug
       в адресе. Перед раздачей скрипта другим людям можно выключить. */
    debug: true
  };


  /* ============================================================
     VIEWPORT — самое первое действие
     Ставится до любых проверок: если ниже что-то упадёт, страница
     всё равно останется читаемой, а не десктопной.
     ============================================================ */

  function setViewport() {
    try {
      var head = document.head || document.documentElement;
      var m = document.querySelector('meta[name="viewport"]');
      if (!m) {
        m = document.createElement('meta');
        m.name = 'viewport';
        head.appendChild(m);
      }
      m.content = 'width=device-width, initial-scale=1, viewport-fit=cover';
    } catch (e) {}
  }

  setViewport();
  document.addEventListener('DOMContentLoaded', setViewport);

  /* Ширину экрана берём после viewport и с запасными источниками:
     до установки метатега Safari отдаёт виртуальные 980px. */
  function screenWidth() {
    var candidates = [
      window.screen && window.screen.width,
      document.documentElement && document.documentElement.clientWidth,
      window.innerWidth
    ].filter(function (x) { return typeof x === 'number' && x > 0; });
    return candidates.length ? Math.min.apply(Math, candidates) : 400;
  }

  /* На широком экране адаптация не нужна. */
  if (screenWidth() > CFG.maxWidth) return;

  /* ============================================================
     СЛУЖЕБНОЕ
     ============================================================ */

  var LOG = [];

  function note(msg) {
    if (!CFG.debug) return;
    LOG.push(msg);
    if (LOG.length > 25) LOG.shift();
  }

  /* Обёртка вокруг проходов: одна упавшая функция не должна останавливать
     остальные, а сообщение об ошибке попадает в отчёт вместо тишины. */
  function guard(where, fn) {
    return function () {
      try {
        return fn.apply(this, arguments);
      } catch (e) {
        note('ОШИБКА в ' + where + ': ' + ((e && e.message) || e));
      }
    };
  }

  function sliceOf(nodes) { return Array.prototype.slice.call(nodes); }

  /* ------------------------------------------------------------
     ПЕРЕХВАТ ЗАПРОСОВ (только для отчёта)
     Хронология ресурсов показывает адрес, но не показывает ни метода,
     ни заголовков. Для пыни этого не хватило: по адресу из хронологии
     сервер отвечает 404 даже на заведомо рабочий /api/replacements/,
     значит лепра зовёт его как-то иначе. Подмена XMLHttpRequest и fetch
     это покажет — если скрипт живёт в том же окружении, что и лепра.
     Если ничего не перехватится, а хронология запросы показывает, —
     значит окружения разные, и это тоже ответ.
     Ставится до скриптов лепры: скрипт работает с document-start.
     ------------------------------------------------------------ */

  var NET = [];

  function netLog(line) {
    if (NET.length > 60) return;
    NET.push(line);
  }

  function headerList(h) {
    var out = [];
    try {
      if (!h) return out;
      if (typeof h.forEach === 'function')
        h.forEach(function (v, k) { out.push(k + ': ' + v); });
      else
        Object.keys(h).forEach(function (k) { out.push(k + ': ' + h[k]); });
    } catch (e) {}
    return out;
  }

  function watchNet() {
    if (!CFG.debug) return;

    try {
      var X = window.XMLHttpRequest;
      if (X && X.prototype && !X.prototype.lmHooked) {
        X.prototype.lmHooked = true;
        var open = X.prototype.open,
            send = X.prototype.send,
            setH = X.prototype.setRequestHeader;

        X.prototype.open = function (m, u) {
          this.lmM = m; this.lmU = u; this.lmH = [];
          return open.apply(this, arguments);
        };
        X.prototype.setRequestHeader = function (k, v) {
          if (this.lmH) this.lmH.push(k + ': ' + v);
          return setH.apply(this, arguments);
        };
        X.prototype.send = function () {
          var self = this;
          self.addEventListener('load', function () {
            netLog('XHR ' + self.lmM + ' ' + String(self.lmU).slice(0, 100) +
                   '  → ' + self.status +
                   (self.lmH && self.lmH.length ? '\n     ' + self.lmH.join('\n     ') : ''));
          });
          return send.apply(this, arguments);
        };
      }
    } catch (e) {}

    try {
      var f = window.fetch;
      if (f && !f.lmHooked) {
        var wrapped = function (input, init) {
          var u = (typeof input === 'string') ? input : (input && input.url);
          var m = (init && init.method) ||
                  (typeof input !== 'string' && input && input.method) || 'GET';
          var h = headerList((init && init.headers) ||
                             (typeof input !== 'string' && input && input.headers));
          return f.apply(this, arguments).then(function (r) {
            netLog('fetch ' + m + ' ' + String(u).slice(0, 100) + '  → ' + r.status +
                   (h.length ? '\n     ' + h.join('\n     ') : ''));
            return r;
          });
        };
        wrapped.lmHooked = true;
        window.fetch = wrapped;
      }
    } catch (e) {}
  }

  watchNet();

  /* Метки «уже обработано» держим в WeakSet, а не в data-атрибутах:
     атрибут на каждом из десятков тысяч элементов — это лишняя память
     и лишняя работа для браузера. WeakSet не мешает сборке мусора. */
  /* если WeakSet почему-то недоступен, подменяем его совместимой заглушкой */
  var Marks = (typeof WeakSet === 'function') ? WeakSet : function () {
    this._k = '_lm' + Math.random().toString(36).slice(2);
    this.has = function (el) { return !!el[this._k]; };
    this.add = function (el) { el[this._k] = true; };
  };

  var seen = {
    scan:    new Marks(),   /* обойдено проверкой переполнения */
    unfloat: new Marks(),   /* проверено на обтекание */
    media:   new Marks(),   /* размеры медиа выставлены */
    obs:     new Marks(),   /* отдано наблюдателю видимости */
    poked:   new Marks(),   /* плеер разбужен */
    footer:  new Marks(),   /* подпись поста сокращена */
    toggle:  new Marks(),   /* кнопка сворачивания перенесена */
    userRow: new Marks()    /* пункт списка граждан размечен */
  };

  /* Обход в глубину с отсечением поддеревьев. querySelectorAll возвращает
     плоский список и пропустить целую ветку не даёт, а TreeWalker даёт:
     внутренности комментариев обходить не нужно, их сотни тысяч. */
  function walk(from, skipSubtree, visit, budget) {
    /* фильтр передаём функцией, а не объектом с acceptNode:
       объектную форму принимают не все версии Safari */
    var w = document.createTreeWalker(from, 1 /* SHOW_ELEMENT */, function (el) {
      return skipSubtree(el) ? 2 /* FILTER_REJECT */ : 1 /* FILTER_ACCEPT */;
    });
    var n = 0;
    while (w.nextNode() && n < budget) { visit(w.currentNode); n++; }
    return n;
  }

  /* Внутрь комментариев и постов не заходим: там однотипная разметка,
     уже покрытая правилами, зато именно она даёт основную массу узлов. */
  function isBulk(el) {
    return el.classList &&
      (el.classList.contains('comment') || el.classList.contains('post'));
  }

  function root() {
    return document.getElementById('js-nonfooter') || document.body;
  }

  /* Из-за overflow-x на body прокрутку может вести не окно, а сам body.
     Поэтому читаем максимум из кандидатов, а пишем во все: подействует
     только настоящий. */
  function scrollTopNow() {
    return Math.max(
      window.pageYOffset || 0,
      (document.scrollingElement && document.scrollingElement.scrollTop) || 0,
      document.documentElement.scrollTop || 0,
      (document.body && document.body.scrollTop) || 0
    );
  }

  function scrollTopSet(y) {
    try { window.scrollTo(0, y); } catch (e) {}
    if (document.scrollingElement) document.scrollingElement.scrollTop = y;
    document.documentElement.scrollTop = y;
    if (document.body) document.body.scrollTop = y;
  }

  function docHeight() {
    return Math.max(
      document.documentElement.scrollHeight || 0,
      document.documentElement.offsetHeight || 0,
      (document.body && document.body.scrollHeight) || 0,
      (document.body && document.body.offsetHeight) || 0
    );
  }

  /* ============================================================
     2. СТИЛИ
     ============================================================ */

  /* Лесенка комментариев: у лепры шаг 28px, для телефона это слишком много.
     Шаг 13px, потолок на шестом уровне — дальше текста не остаётся. */
  function indentRules() {
    var out = [], i;
    for (i = 1; i <= 30; i++)
      out.push('#js-comments .comment.indent_' + i +
               ' { padding-left: ' + Math.min(i * 13, 78) + 'px !important; }');
    return out.join('\n');
  }

  /* Герб «Блогов Империи» (empire_blogs.png) — файл 65×58, но рисунок в
     нём занимает только 39×38, начиная с точки (12, 10): шесть седьмых
     площади — прозрачные поля под вырез в фоновой подложке десктопной
     колонки. Оттого вписанный целиком герб и выходил втрое мельче
     гнезда: при гнезде в 24 на сам рисунок приходилось четырнадцать.
     Поэтому картинку не вписываем, а увеличиваем и обрезаем полями
     обёртки — в гнезде оказывается ровно рисунок.
     Числа — замер файла, а не подбор на глаз; если лепра его заменит,
     поля разъедутся, и мерить надо будет заново. */
  var CREST = { w: 65, h: 58, x: 12, y: 10, aw: 39, ah: 38 };
  /* Множитель считаем по ширине рисунка: гнездо квадратное, а рисунок
     почти квадратный, и по высоте он занимает 38/39 гнезда — оставшийся
     пиксель делим пополам сверху и снизу, чтобы стоял по центру. */
  var CREST_CSS = {
    w: (CREST.w / CREST.aw * 100).toFixed(2),
    x: (-CREST.x / CREST.aw * 100).toFixed(2),
    y: ((-CREST.y + (CREST.aw - CREST.ah) / 2) / CREST.aw * 100).toFixed(2)
  };

  /* Отбивка свёрнутой строки: столько, чтобы гнездо герба уместилось в
     заданную высоту строки. Семнадцать — высота самой подписи (13
     пунктов при межстрочном 1.3): пока гнездо ниже неё, высоту держит
     подпись, и отбивки считаются от неё. */
  var NAV_PAD = Math.max(0,
    Math.round((CFG.navRow - Math.max(CFG.navIcon, 17)) / 2));

  var css = `
/* ============ КАРКАС ============ */
/* overflow-x держим только на body: на html он отдаёт прокрутку body,
   и тогда window.pageYOffset всегда ноль, а documentElement.scrollHeight
   равен высоте экрана. На этом когда-то сломалась навигация. */
html {
  max-width: 100vw !important;
  scroll-behavior: auto !important;
  overscroll-behavior-y: contain !important; }
body {
  max-width: 100vw !important; overflow-x: hidden !important;
  scroll-behavior: auto !important;
  overscroll-behavior-y: contain !important;
  position: relative !important;
  -webkit-text-size-adjust: 100% !important; }

/* Поля по краям вешаем на .l-wrapper: он есть на всех страницах лепры,
   в отличие от .l-i-content_main, которого нет в профиле и подсайтах. */
.l-wrapper, #js-nonfooter {
  min-width: 0 !important; max-width: 100vw !important;
  padding-left: ${CFG.pageEdge}px !important;
  padding-right: ${CFG.pageEdge}px !important;
  box-sizing: border-box !important; }

/* Кастомное оформление подлепры лежит на .l-content: своя заливка и своя
   картинка. Поля страницы заданы выше, на .l-wrapper, то есть на два
   уровня выше по дереву — и по краям экрана оставалась белая рамка вокруг
   цветного содержимого. На белых подлепрах её не видно, на цветных она
   читается как ошибка вёрстки.
   Растягиваем .l-content на всю ширину отрицательными полями и возвращаем
   те же пиксели внутренним отступом: текст стоит ровно там же, где стоял,
   а фон доходит до кромки. Признак — класс l-custom_domain на body, лепра
   ставит его подлепрам со своим оформлением; на основном домене там
   l-base_domain, и правило не срабатывает. */
body.l-custom_domain .l-content {
  margin-left: -${CFG.pageEdge}px !important;
  margin-right: -${CFG.pageEdge}px !important;
  padding-left: ${CFG.pageEdge}px !important;
  padding-right: ${CFG.pageEdge}px !important; }

.l-i-wrapper      { padding-bottom: 20px !important; }
.l-content        { min-height: 0 !important; }
.l-content_aside  { display: none !important; }
.l-content_main   { margin-left: 0 !important; float: none !important;
                    width: auto !important; }
.l-i-content_main { margin-left: 0 !important; padding: 0 !important; }
.l-footer         { min-width: 0 !important; position: static !important;
                    height: auto !important; background: none !important; }

/* ============ ШАПКА ============ */
/* Порядок в строке: приветствие (гибкое) - переключатель темы - логотипы,
   затем навигация во всю ширину, затем две колонки со счётчиками и фильтром. */
.l-header {
  margin: 0 0 8px 0 !important; padding: 8px 0 12px !important;
  min-height: 0 !important;
  flex-wrap: wrap !important; align-items: flex-start !important;
  /* у лепры здесь space-between — он растаскивал приветствие,
     переключатель темы и логотипы по краям строки */
  justify-content: flex-start !important;
  border-bottom: 1px solid rgb(214, 212, 212) !important; }

/* выравнивание задаём явно: приветствие с логаутом всегда слева */
.l-header_tagline, .l-i-header_tagline, .b-header_tagline,
.l-header_tagline a { text-align: left !important; }
.l-header_tagline {
  order: 1 !important;
  /* база 0: длинная фраза не выталкивает логотип на новую строку,
     а растягивается по остатку ширины */
  flex: 1 1 0 !important; min-width: 0 !important;
  padding: 0 !important; margin: 2px 0 6px !important; }

#lm-theme {
  order: 2 !important; flex: 0 0 auto !important;
  align-self: flex-start !important;
  width: 34px !important; height: 34px !important;
  margin: 2px 8px 0 0 !important; padding: 0 !important;
  font-size: 17px !important; line-height: 32px !important;
  text-align: center !important; cursor: pointer !important;
  background: transparent !important;
  border: 1px solid rgb(214, 212, 212) !important;
  border-radius: 17px !important; }

.b-logo {
  order: 2 !important; flex: 0 0 auto !important;
  display: inline-block !important; position: static !important;
  align-self: flex-start !important;
  width: auto !important; text-align: left !important;
  margin: 0 0 0 10px !important; }
.b-logo img {
  display: inline-block !important;
  position: relative !important; top: -1px !important;
  width: auto !important; height: auto !important;
  max-height: 40px !important; max-width: 40px !important; }

/* Маска лепры на подсайте: переносится в шапку скриптом и встаёт рядом
   с логотипом подсайта, размером поменьше. */
.l-header .b-logo_subsite {
  order: 2 !important; flex: 0 0 auto !important;
  align-self: flex-start !important;
  position: static !important; float: none !important; width: auto !important;
  margin: 3px 0 0 16px !important; }
.l-header .b-logo_subsite img {
  position: relative !important; top: -1px !important;
  max-height: 32px !important; max-width: 32px !important;
  opacity: .85 !important; }

/* Строка ссылок: всегда в одну линию и по центру, на любом масштабе. */
.l-header_nav { order: 3 !important; flex: 0 0 100% !important;
                width: auto !important; padding: 0 !important;
                margin: 0 !important; line-height: 1.5 !important; }
.b-header_nav {
  display: flex !important; flex-wrap: nowrap !important;
  align-items: center !important; justify-content: center !important;
  gap: 0 8px !important; white-space: nowrap !important;
  font-size: 13px !important; line-height: 1.5 !important; }
.b-header_nav_link { flex: 0 0 auto !important; }
/* медали в навигации были absolute и ложились поверх соседнего текста */
.b-header_nav_link img { display: none !important; }
.b-header_nav_notifications { margin: 0 !important; padding: 0 !important; }
.b-header_nav_fraud { margin: 0 !important; }

/* Переключатель вида: три иконки были absolute от точки left:50%
   и ложились на выпадающий список. */
.b-posts_threshold {
  float: none !important; width: auto !important;
  min-width: 0 !important; min-height: 0 !important;
  flex: 1 1 160px !important; margin: 4px 0 !important; }
.b-index_navigation_holder {
  float: none !important; width: auto !important;
  padding: 6px !important; margin: 18px 0 6px !important;
  display: flex !important; flex-wrap: wrap !important;
  align-items: center !important; gap: 16px !important; }
.b-index_slider, .b-index_slider .b-slider_scale_icons {
  position: static !important; left: auto !important; top: auto !important;
  width: auto !important; height: auto !important;
  display: flex !important; align-items: center !important;
  justify-content: flex-end !important;
  gap: 18px !important; flex: 0 0 auto !important; }
.b-slider_scale_icon {
  position: relative !important; left: auto !important; top: auto !important;
  width: 26px !important; height: 26px !important;
  margin: 4px !important; flex: 0 0 auto !important; }
.b-index_view_about { display: none !important; }

/* Ниже — четыре самостоятельные строки. Все эти блоки скрипт переносит
   прямо в .l-header: в исходной разметке они лежат в разных обёртках,
   а флекс умеет строить строки только из соседей по одному родителю. */
.l-header > .b-header_nav_new_post {
  order: 4 !important; flex: 0 0 100% !important;
  box-sizing: border-box !important; min-width: 0 !important;
  /* «Лепрозорий ждёт новый пост!» длиннее подсайтного «Все ждут…» и при
     увеличении масштаба разрывалось на две строки, поднимая шапку. */
  white-space: nowrap !important;
  overflow: hidden !important; text-overflow: ellipsis !important;
  text-align: center !important; line-height: 1.4 !important;
  margin: 2px 0 4px !important; }

.l-header > .b-header_counters {
  order: 5 !important;
  /* Основа в 40%, а не auto. С auto строка «счётчики + переключатель
     вида» держалась на том, что 193 пикселя надписи и 146 переключателя
     случайно умещались в 369: при увеличении масштаба окно в CSS-пикселях
     сужается, сумма перестаёт влезать, и переключатель уезжает отдельной
     строкой, а за ним рассыпается всё остальное. Доля от ширины сужается
     вместе с окном, поэтому пара остаётся парой: 40% плюс постоянные 146
     переключателя укладываются в строку вплоть до 243 CSS-пикселей.
     Растяжение оставлено: свободное место забирает надпись, а не пустота,
     и переключатель по-прежнему стоит у правого края. */
  flex: 1 1 40% !important; box-sizing: border-box !important;
  text-align: left !important; line-height: 1.5 !important;
  height: auto !important;
  /* Строка «N сайтов и M человек» набрана шрифтом в пикселях, а ширина
     колонки зависит от масштаба страницы: при увеличении окно в CSS-пикселях
     сужается, надпись перестаёт помещаться и переносится второй строкой —
     шапка от этого становится выше. Запрещаем перенос: строка остаётся
     одной при любом масштабе, а если места совсем нет, хвост срезается
     многоточием, и высота шапки всё равно не меняется. */
  white-space: nowrap !important;
  min-width: 0 !important;
  overflow: hidden !important; text-overflow: ellipsis !important;
  font-size: 12px !important;
  /* НАСТРОЙКА: первое число — насколько опустить эту надпись.
     Больше — ниже, меньше (можно отрицательное) — выше.
     Соседние блоки не двигаются: отступ только у неё. */
  margin: 8px 0 0 0 !important; }
/* внутри две ссылки — они тоже не должны рваться по своим пробелам */
.l-header > .b-header_counters a { white-space: nowrap !important; }

.l-header > .b-index_slider {
  /* Ширина здесь постоянная и не зависит от экрана: три значка по 26 с
     полями по 4 и два зазора по 18 — ровно 138, плюс поле справа. Дать
     ему сжиматься нельзя, значки от этого налезли бы друг на друга,
     поэтому 0 0 auto, а тянется соседняя надпись. */
  order: 6 !important; flex: 0 0 auto !important;
  box-sizing: border-box !important; min-width: 0 !important;
  display: flex !important; justify-content: flex-end !important;
  align-items: center !important; gap: 18px !important;
  margin: 0 !important;
  /* НАСТРОЙКА: на сколько сдвинуть переключатель влево. Он выровнен по
     правому краю, поэтому сдвиг задаётся отступом справа. Нужен, чтобы
     его середина совпала с серединой блока порога строкой ниже: у
     значков переключателя есть собственные поля, из-за которых он
     заканчивается не там же, где блок под ним. */
  padding-right: 8px !important; }

/* Основа 0, а не 50%: соседом в этой строке стоит надпись со счётчиками,
   которой перенос запрещён. Поле поиска берёт то, что осталось, и
   отдаёт место первым — иначе при увеличении масштаба места не хватало
   обоим сразу и надпись срезало многоточием почём зря. */
.l-header > .b-header_search {
  order: 7 !important; flex: 1 1 0% !important; min-width: 0 !important;
  margin: 4px 0 0 !important; }

/* На главной в шапке есть ещё и переключатель вида. С основой 0 поиск
   переставал требовать себе места, все три блока умещались в одну
   строку, и поле поиска, у которого снизу ограничение в 90 пикселей,
   вылезало влево поверх значков переключателя. Возвращаем половину
   строки: счётчики с переключателем встают строкой выше, а поиск делит
   нижнюю с выбором режимов — как и было. Признак — сам переключатель:
   скрипт переносит блоки в шапку в известном порядке, поэтому он
   всегда стоит в разметке раньше поиска. */
.l-header > .b-index_slider ~ .b-header_search {
  flex: 1 1 49% !important; box-sizing: border-box !important; }

/* Порядок в строке: лупа, затем поле, всё прижато к правому краю.
   Правила заданы одним блоком по id формы, а не по .l-header: во-первых,
   нужны и там, где шапка не перебрана скриптом; во-вторых, два набора
   правил на один элемент уже однажды дали зависимость от порядка. */
#js-header_search_form {
  display: flex !important; align-items: center !important;
  justify-content: flex-end !important; gap: 4px !important; }
/* Обёртка поля мерилась на 22 пикселя шире самого поля при нулевых
   отступах и без псевдоэлементов — откуда берётся её ширина, по цифрам
   так и не сошлось. display:contents убирает её коробку целиком:
   поле становится прямым флекс-элементом формы, и мерить больше нечего. */
#js-header_search_form .b-header_search_input_holder {
  display: contents !important; }
#js-header_search_form .b-header_search_input_holder::before,
#js-header_search_form .b-header_search_input_holder::after {
  content: none !important; display: none !important; }
/* Нижний предел, ниже которого поле сжиматься не должно: строкой выше
   ему разрешено уступать место счётчикам, а поле шириной в сантиметр
   бесполезно. */
#js-header_search_form .i-form_text_input {
  order: 2 !important; flex: 0 1 auto !important;
  min-width: 90px !important; margin: 0 !important; }
#js-header_search_form input[type="submit"] { display: none !important; }
#js-header_search_form .b-icon_button_search {
  order: 1 !important; flex: 0 0 auto !important;
  position: static !important; inset: auto !important; margin: 0 !important; }

/* На главной поиск делит нижнюю строку с выбором режимов, и лупа слева
   от поля упирается в них. Там меняем порядок на обратный: поле, затем
   лупа у самого края. Признак тот же, что и для ширины строкой выше, —
   наличие переключателя вида. Селекторы длиннее базовых нарочно: они
   должны перевешивать их и по весу, и по месту в файле, иначе результат
   зависел бы от того, как браузер разрешает спор. */
.l-header > .b-index_slider ~ .b-header_search
  #js-header_search_form .i-form_text_input { order: 1 !important; }
.l-header > .b-index_slider ~ .b-header_search
  #js-header_search_form .b-icon_button_search { order: 2 !important; }
/* и прижимаем связку к левому краю. Форма по умолчанию выровнена вправо,
   поэтому укорочение поля съедало пиксели слева и оставляло отступ от
   края экрана. Теперь поле с лупой стоят у левого края — на том же
   расстоянии, что и блок режимов от правого. */
.l-header > .b-index_slider ~ .b-header_search #js-header_search_form {
  justify-content: flex-start !important; }

.l-header > .b-posts_threshold {
  order: 8 !important; flex: 1 1 50% !important;
  box-sizing: border-box !important;
  display: flex !important; justify-content: flex-end !important;
  align-items: center !important;
  margin: 4px 0 0 !important; padding: 0 !important;
  text-align: right !important; }

/* ---- Шапка подсайта: четыре блока в две строки ----
   На главной нижние строки делят со счётчиками переключатель вида
   (главная / подлепры / микс). На подсайте его нет, и три оставшихся
   блока разъезжались: приглашение написать пост занимало целую строку
   в одиночку, а счётчики, поиск и порог кое-как делили следующую.
   Собираем в две ровные строки: счётчики с приглашением, поиск с порогом.

   Признак подсайта берём из разметки, а не классом от скрипта: шапка
   там лежит внутри .l-header_subsite, и этого хватает. Селекторы в три
   класса перевешивают базовые в два и стоят ниже по файлу — спор
   решается одинаково и по весу, и по порядку.

   Основы в сумме дают 99% строки. Это и есть цементирование: остатка в
   один процент не хватит следующему блоку никогда, поэтому перенос
   происходит в одном и том же месте при любом масштабе, а не «пока
   помещается». Проценты флекс-основы считаются от содержимого, поля
   прибавляются сверху — поэтому у блоков с полями обязателен
   box-sizing: border-box. Без него пара 55+45 плюс поле в 8 пикселей
   давала 377 при строке в 369, и приглашение уезжало вниз. */
.l-header_subsite .l-header > .b-header_counters {
  order: 4 !important; flex: 1 1 54% !important;
  box-sizing: border-box !important; }
.l-header_subsite .l-header > .b-header_nav_new_post {
  order: 5 !important; flex: 1 1 45% !important;
  box-sizing: border-box !important; min-width: 0 !important;
  text-align: right !important; font-size: 12px !important;
  line-height: 1.5 !important; white-space: nowrap !important;
  overflow: hidden !important; text-overflow: ellipsis !important;
  /* тот же отступ сверху, что у счётчиков рядом, — иначе строки текста
     в паре стоят на разной высоте */
  margin: 8px 0 0 !important; padding: 0 0 0 8px !important; }
.l-header_subsite .l-header > .b-header_search {
  order: 6 !important; flex: 1 1 46% !important;
  box-sizing: border-box !important;
  /* у лепры блок сдвинут на пиксель влево — под приветствием и ссылками
     это видно как ступенька у левого края */
  position: static !important; left: auto !important; }
.l-header_subsite .l-header > .b-posts_threshold {
  order: 7 !important; flex: 1 1 53% !important;
  box-sizing: border-box !important; }

/* Поле выбора порога само по себе шире отведённой ему половины строки:
   ширину ему задаёт самый длинный вариант («NIGHTMARE (все)»), а не
   выбранный. Блок выровнен по правому краю, поэтому лишнее вылезало
   ВЛЕВО и накрывало лупу поиска — по отчёту лупа стояла на 190-210,
   а поле начиналось с 202. Ограничиваем поле шириной блока: длинные
   варианты в свёрнутом виде срежутся, в раскрытом списке они целые.
   Правило общее, не только для подсайта: на главной поле стоит в такой
   же паре и упирается в тот же предел, просто там пока помещалось. */
.l-header > .b-posts_threshold select {
  max-width: 100% !important; box-sizing: border-box !important;
  /* кегль — из CFG.thresholdFont, см. настройки */
  font-size: ${CFG.thresholdFont}px !important; }

/* Поиск переехал в левую половину строки, а форма у лепры выровнена
   вправо — поле уезжало к середине экрана, слева оставалась дыра.
   Ставим поле первым, лупу за ним и прижимаем связку к левому краю:
   ровно так же, как на главной, где поиск делит строку с режимами. */
.l-header_subsite .l-header > .b-header_search #js-header_search_form {
  justify-content: flex-start !important; }
.l-header_subsite .l-header > .b-header_search
  #js-header_search_form .i-form_text_input { order: 1 !important; }
.l-header_subsite .l-header > .b-header_search
  #js-header_search_form .b-icon_button_search { order: 2 !important; }

/* Опустевшие обёртки. Важно: у них нет order, а значит он равен нулю —
   такой блок встаёт в строке ПЕРЕД приветствием (order:1) и сдвигает его
   вправо на свою ширину. Именно поэтому приветствие казалось центрированным. */
.l-header_aside, .b-header_aside { order: 9 !important; }
.l-header_aside:empty, .b-header_aside:empty,
.b-index_navigation_holder:empty { display: none !important; }

/* ---- Сжатая шапка на страницах с панелью вкладок ----
   «Мои вещи», инбокс, избранное, настройки, социализм, приложения несут
   под шапкой собственную панель вкладок, где уже есть и «мои вещи», и
   «избранное», и инбокс. Сверху они дублируются, а высота на телефоне
   дороже полноты. Здесь шапка сжимается до двух строк: приветствие с
   логаутом, затем «Мои вещи N», инбокс, колокольчик и поиск.

   Признак страницы ставит скрипт классом lm-tabs на <html>. Из CSS его
   не вывести: панель вкладок лежит в разметке ПОСЛЕ шапки, а обратного
   соседа выбрать нечем. */
html.lm-tabs .b-header_counters,
html.lm-tabs .b-header_nav_new_post,
html.lm-tabs .b-header_nav_fraud,
html.lm-tabs .b-header_nav a[href*="/my/favourites"] {
  display: none !important; }

/* Поиск скрипт переносит в конец строки ссылок — тем же флекс-элементом,
   что и сами ссылки. Именно внутрь .b-header_nav, а не в .l-header:
   строка ссылок занимает всю ширину, и сосед по .l-header встал бы
   отдельной строкой, то есть ровно тем, от чего мы уходим.
   Штатные position/left у блока поиска сдвигали его на пиксель влево —
   внутри флекса это лишнее. */
html.lm-tabs .b-header_nav .b-header_search {
  flex: 1 1 auto !important; min-width: 0 !important;
  position: static !important; left: auto !important;
  margin: 0 0 0 4px !important; padding: 0 !important; }
/* Ширина поля задана лепрой в процентах от обёртки (86%), а обёртка у нас
   display:contents, то есть коробки не имеет. Переводим на флекс: поле
   занимает остаток строки и сжимается до предела из настроек. */
html.lm-tabs #js-header_search_form .i-form_text_input {
  width: auto !important; flex: 1 1 auto !important;
  min-width: ${CFG.tabsSearchMin}px !important; }

/* ============ ЛЕНТА И ПОСТЫ ============ */
/* Белая полоса справа получалась из двух вложенных width:98%,
   плюс у поста было 270px внутреннего отступа под правую колонку. */
.b-posts_holder { width: 100% !important; padding-top: 0 !important; }
.post {
  float: none !important; width: auto !important;
  padding-right: 0 !important;
  margin-left: 0 !important; margin-right: 0 !important; }
.post .dt { padding-right: 0 !important; }
.dd {
  position: relative !important;
  padding: 0 0 0 88px !important;   /* место для голосовалки слева */
  /* Высота строки задана ниже, в правиле подписей поста: строки там
     переносятся часто, и 1.4 не хватало — соседние наезжали друг на
     друга. Держим её в одном месте, а не в двух. */
  font-size: 13px !important; }

/* Подпись — флекс-строка: промежутки задавались пробелами в разметке
   и полями у ссылок, отсюда рыхлость и перенос крестика на третью строку. */
.dd .ddi {
  display: flex !important; flex-wrap: wrap !important;
  align-items: center !important; gap: 2px 6px !important; }
.dd .b-post_controls {
  display: inline-flex !important; align-items: center !important;
  gap: 8px !important; white-space: nowrap !important; margin: 0 !important; }
/* Все значки подписи скрипт складывает в один контейнер .lm-icons.
   Раньше они лежали в двух разных обёртках лепры с разными метриками,
   и выровнять их правилами не удавалось: крестик всё время проваливался
   ниже. Соседи по одному флекс-боксу разъехаться не могут. */
.dd .lm-icons {
  display: inline-flex !important; align-items: center !important;
  gap: 10px !important; height: 16px !important;
  vertical-align: middle !important; }
.dd .lm-icons > span:not(.hidden):not(.b-post_interest_info),
.dd .lm-icons a:not(.hidden):not(.b-post_interest_info) {
  display: inline-flex !important;
  align-items: center !important; justify-content: center !important;
  align-self: center !important;
  /* У лепры .b-icon_button задан position:relative, и отдельным значкам
     приписаны сдвиги top. Внутри флекс-бокса это и разбрасывало их по
     вертикали: «?» уходил на 4px вверх, крестик на 7px вниз. */
  position: static !important; inset: auto !important;
  top: auto !important; bottom: auto !important;
  transform: none !important;
  height: 16px !important; line-height: 16px !important;
  font-size: 14px !important;
  margin: 0 !important; padding: 0 !important;
  text-decoration: none !important; }
.dd .lm-icons a i, .dd .lm-icons a b {
  position: static !important; top: auto !important;
  height: 16px !important; line-height: 16px !important;
  vertical-align: middle !important; }
/* неактивные значки лепра прячет классом — не мешаем */
.dd .lm-icons a.hidden { display: none !important; }
/* Справочная ссылка «?»: в ленте лепра её показывает, на телефоне она
   только занимает место. Скрытие вынесено и в исключение основного
   правила выше — иначе оно перебивало это по весу селектора. */
.b-post_interest_info,
.dd .lm-icons .b-post_interest_info { display: none !important; }
.dd .lm-icons svg {
  display: block !important; width: 14px !important; height: 14px !important; }
/* Пустые обёртки под фоновые спрайты лепры рисовали мелкие чёрточки по
   краям значков. Но в такой же <span class="b-svg-icon"> завёрнут svg
   галочки — поэтому скрываем только ПУСТЫЕ, по содержимому, а не по тегу. */
.dd .lm-icons a em:empty, .dd .lm-icons a span:empty { display: none !important; }

.dd .post_icon { margin: 0 !important; }
/* .c_show_user — декоративная точка лепры, на телефоне рисуется
   случайным глифом и сбивает высоту строки */
.dd .c_show_user { display: none !important; }
.b-paginator { padding: 20px 10px 40px !important; }
.b-post_tags {
  float: none !important; width: auto !important;
  padding-right: 0 !important; margin: 0 0 10px !important; }
.b-post_tags_form .i-form_text_input { width: 60% !important; }

.post .p_body, .comment .c_body {
  font-size: 17px !important; line-height: 1.45 !important;
  word-wrap: break-word !important; overflow-wrap: break-word !important; }
.post img, .comment img, .p_body img, .c_body img {
  max-width: 100% !important; width: auto !important; height: auto !important; }
.post iframe, .comment iframe, .b-video, .video_holder {
  max-width: 100% !important; }
pre, code { white-space: pre-wrap !important; word-break: break-word !important; }

/* у увеличенной картинки лепра прописывает width:3000px */
.c_body img.js-image_in_comments_original,
.p_body img.js-image_in_comments_original,
img.js-image_in_comments_original {
  width: auto !important; max-width: 100% !important; height: auto !important; }

/* Форма быстрого поста с кнопкой YARRR: скрыта, для создания поста
   есть отдельная кнопка в шапке. Чтобы вернуть — удалите эту строку. */
.b-new_post_miniform, .b-new_post_miniform_footer { display: none !important; }

/* ============ КОММЕНТАРИИ ============ */
.post_comments_page, #js-comments { padding: 0 !important; }
/* .b-post_comments у лепры имеет width:90% — десятая часть ширины уходила
   впустую, и комментарии не доходили до правого края. Панель навигации
   к этому отношения не имеет: она фиксированная и места не занимает. */
.b-post_comments, #js-comments_holder {
  width: 100% !important; max-width: 100% !important;
  box-sizing: border-box !important; }
.post_comments_page .post {
  margin-right: 0 !important; width: auto !important;
  padding-right: 0 !important; float: none !important; }
#js-comments .comment { padding-bottom: 10px !important; }
${indentRules()}

/* Подпись в одну флекс-строку. div.ddi — блок, из-за него голосование
   уезжало на отдельную строку; display:contents убирает его собственный
   бокс, и ссылки попадают в общий ряд с кнопками. */
.comment .c_footer {
  display: flex !important; flex-wrap: wrap !important;
  align-items: center !important; gap: 0 5px !important;
  line-height: 1.3 !important; font-size: 13px !important; }

.comment .ddi { font-size: 13px !important; }
/* :not(.b-button) — чтобы не перекрывать логику показа стрелок
   сворачивания: они управляются отдельными правилами ниже */
/* .ddi исключён: он должен остаться display:contents, иначе становится
   единственным блочным ребёнком флекса и всё содержимое подписи
   выстраивается обычным потоком в столбик. */
.comment .c_footer a:not(.b-button), .comment .ddi a:not(.b-button),
.comment .c_footer > *:not(.b-comment_thread_collapse):not(.ddi),
.comment .ddi > *:not(.b-comment_thread_collapse) {
  display: inline-block !important;
  padding: 1px 0 !important; margin: 0 !important; }

/* Сворачивание веток: у лепры это две кнопки, показывается одна из двух
   по классу состояния — стрелка вверх у развёрнутой ветки, вниз у свёрнутой.
   Лишней была только подпись «Показать комментарий такого-то и N ответов»:
   она есть лишь у кнопки разворота и занимала целую строку. */
.b-comment_thread_collapse {
  display: inline-block !important; position: static !important;
  /* просвет до значка странички задаёт gap самой строки, свой отступ
     складывался с ним и давал девять пикселей вместо пяти */
  margin: 0 !important; padding: 0 !important;
  height: auto !important; overflow: visible !important; }
.b-comment_thread_collapse .b-button_caption { display: none !important; }
/* display у кнопок НЕ трогаем: лепра сама показывает одну из двух
   по классу состояния, а принудительный inline-block выводил обе */
.b-comment_thread_collapse .b-button {
  padding: 0 !important; margin: 0 !important; vertical-align: middle !important; }
.b-comment_thread_collapse .b-button_icon { margin: 0 !important; }
/* перенесённая в подпись кнопка встаёт первой в строке */
.c_footer .b-comment_thread_collapse { order: -1 !important; }

/* Частное правило объявлено ПОСЛЕ общего: во флекс-строке inline-block
   превращается в block, и кнопка занимала целую строку. */
.comment .c_footer .b-comment_thread_collapse {
  display: inline-flex !important; align-items: center !important;
  height: 18px !important; }
.comment .c_footer .b-comment_thread_collapse .b-button,
.comment .c_footer .b-comment_thread_collapse .b-button_icon,
.comment .c_footer .b-comment_thread_collapse .b-svg-icon {
  display: inline-flex !important; align-items: center !important;
  height: 18px !important; position: static !important; }
.comment .c_footer .b-comment_thread_collapse svg {
  width: 16px !important; height: 16px !important; display: block !important; }
.comment .c_footer .b-comment_thread_collapse em { display: none !important; }



/* Кнопки управления постом: у лепры height:13px с обрезкой, а подпись
   поднята на 7px вверх. Класс общий, используется не только свёрнутыми
   ветками, поэтому правило нужно и при скрытом сворачивании. */
/* :not(.b-comment_thread_collapse) — у кнопки сворачивания веток тот же
   класс, а display:block заставлял её занимать целую строку в подписи. */
.b-post_my_post_controls_button:not(.b-comment_thread_collapse) {
  display: block !important; height: auto !important;
  overflow: visible !important; vertical-align: baseline !important; }
.b-comment_thread_collapse {
  height: auto !important; overflow: visible !important; }
.b-post_my_post_controls_button .b-button,
.b-post_my_post_controls_button .b-button_caption {
  position: static !important; top: auto !important;
  margin-left: 0 !important; }
.b-post_my_post_controls_button .b-button {
  display: inline-block !important; padding: 4px 0 !important; }
.b-post_my_post_controls_button .b-button_caption {
  white-space: normal !important; }

/* Обёртка .ddi растворяется: её содержимое становится прямыми элементами
   флекс-строки подписи. Объявлено после правил выше — иначе они его
   перебивали, и подпись рассыпалась в столбик. */
.comment .c_footer .ddi { display: contents !important; }

/* Показ одной из двух стрелок задаём сами и объявляем ПОСЛЕ всех правил
   для ссылок в подписи: так результат не зависит ни от специфичности,
   ни от порядка — оба фактора работают в одну сторону. */
#js-comments .comment .b-button__collapse { display: none !important; }
#js-comments .comment .b-comment_thread__collapse .b-button__collapse {
  display: inline-block !important; }
#js-comments .comment .b-button__expand { display: inline-block !important; }
#js-comments .comment .b-comment_thread__collapse .b-button__expand {
  display: none !important; }

/* Значки в подписи комментария: «поделиться», крестик и точка. У каждого
   свои метрики и position:relative от лепры, из-за чего крестик уходил
   с общей горизонтали. Приводим к одной высоте и гасим смещения. */
#js-comments .c_footer .c_show_user,
#js-comments .c_footer .b-button_share,
#js-comments .c_footer .b-icon_button_close,
#js-comments .c_footer .b-controls_button {
  display: inline-flex !important;
  align-items: center !important; justify-content: center !important;
  align-self: center !important;
  position: static !important; inset: auto !important;
  top: auto !important; bottom: auto !important;
  height: 18px !important; line-height: 18px !important;
  font-size: 14px !important;
  margin: 0 !important; padding: 0 !important; }
#js-comments .c_footer .b-button_icon,
#js-comments .c_footer .b-svg-icon {
  display: inline-flex !important; align-items: center !important;
  position: static !important; height: 18px !important; }
#js-comments .c_footer .b-button_share svg {
  display: block !important; width: 14px !important; height: 14px !important; }
/* обёртки значка «поделиться» сдвигали его вверх на пару пикселей */
#js-comments .c_footer .b-button_share .b-button_icon,
#js-comments .c_footer .b-button_share .b-svg-icon {
  position: static !important; top: auto !important;
  vertical-align: middle !important;
  height: 18px !important; line-height: 18px !important; }
#js-comments .c_footer em:empty { display: none !important; }

/* кнопка обновления комментариев уезжала за левый край */
.b-comments_controls {
  padding-left: 0 !important; margin-left: 0 !important;
  display: flex !important; flex-wrap: wrap !important;
  gap: 2px 6px !important; font-size: 14px !important; }
.b-comments_controls a { display: inline-block !important;
                         padding: 6px 4px !important; }
.b-comments_controls > a.b-svg-icon,
.b-comments_controls a[data-key="refresh"] {
  position: static !important; float: none !important;
  margin: 0 !important; flex: 0 0 auto !important;
  width: 24px !important; height: 24px !important; }

/* ============ ГОЛОСОВАНИЕ ============ */
/* Блок жил в левой колонке (left:-38px) и был скрыт до наведения мышью.
   Возвращаем в поток, делаем всегда видимым, кнопки — под палец. */
#js-comments .comment .vote,
#js-comments .comment .vote.c_vote,
.post .vote, .vote {
  position: static !important; inset: auto !important;
  display: inline-flex !important; align-items: center !important;
  width: auto !important; height: auto !important;
  vertical-align: middle !important; white-space: nowrap !important; }
.post .vote { margin: 0 !important; }

/* Голосование поста — в зарезервированное слева место.
   Правило стоит НИЖЕ общего .post .vote и имеет большую специфичность:
   при равной побеждало бы то, что ниже, и блок оставался в потоке. */
.post .dd .vote, .dd .vote, div.dd > div.vote {
  position: absolute !important; inset: auto auto auto 0 !important;
  top: 0 !important; left: 0 !important;
  margin: 0 !important; width: auto !important; }
/* голосование прижато к правому краю подписи: во всей ветке кнопки
   выстраиваются в одну вертикаль вместо «то тут, то там» */
.comment .c_footer .vote { margin: 0 0 0 auto !important; }

#js-comments .comment .c_vote .vote_button,
#js-comments .comment .c_vote .vote_result,
.c_vote .vote_button_plus, .c_vote .vote_button_minus,
.vote_button, .vote_result {
  position: static !important; inset: auto !important;
  visibility: visible !important; float: none !important;
  display: inline-block !important;
  width: auto !important; min-width: 34px !important;
  height: 28px !important; line-height: 26px !important;
  box-sizing: border-box !important;
  padding: 0 !important; margin: 0 2px !important;
  font-size: 13px !important; color: rgb(102,102,102) !important;
  text-align: center !important;
  background: rgb(244,244,242) !important;
  border: 1px solid rgb(220,220,216) !important;
  border-radius: 5px !important; }
/* Счётчик перечислен и выше, в общем блоке кнопок: там задаются размеры
   и типографика, здесь снимаются рамка с фоном. Это наслоение, а не
   дубликат — свести в одно правило можно только продублировав десяток
   свойств. */
/* порядок в строке: минус, счётчик, плюс — в разметке плюс идёт первым */
.vote_button_minus { order: 1 !important; }
.vote_button_plus  { order: 3 !important; }
#js-comments .comment .c_vote .vote_result,
.c_vote .vote_result, .vote_result {
  order: 2 !important;
  background: none !important; border: 0 !important;
  font-weight: 600 !important; min-width: 30px !important; }

/* в комментариях кнопки чуть мельче, иначе строка переносится */
.comment .vote_button, .comment .vote_result {
  height: 24px !important; line-height: 22px !important;
  min-width: 28px !important; margin: 0 1px !important;
  font-size: 12px !important; }
.comment .vote_result { min-width: 24px !important; }
/* общее правило отступов для ссылок раздувало кнопки */
.comment .c_footer a.vote_button, .comment .ddi a.vote_button {
  padding: 0 !important; }

/* Кнопки голосования под постом компактнее общих. Объявлено последним
   в разделе: так правило выигрывает и по весу селектора, и по порядку. */
.dd .vote .vote_button, .post .dd .vote .vote_button {
  min-width: 24px !important; height: 24px !important;
  line-height: 22px !important; font-size: 13px !important;
  margin: 0 1px !important; }
.dd .vote .vote_result, .post .dd .vote .vote_result {
  min-width: 22px !important; font-size: 13px !important;
  margin: 0 1px !important; }

/* Уже отданный голос лепра метит классом на самой кнопке: vote_voted у
   постов и комментариев, active у кармы. Метка серверная — в шаблоне под
   неё оставлено место, видно по хвостовому пробелу в разметке невыбранных
   кнопок: class="vote_button vote_button_plus ". То есть после перезагрузки
   состояние приходит с сервера, терять его нам нечего.
   Терялось оно у нас: собственная подсветка лепры — фоновая картинка
   vote_button_hover.gif и цвет rgb(102,102,102) — затёрта общим правилом
   кнопок выше, где background, border и color заданы через !important.
   Возвращаем состояние своим оформлением: заливка вместо контура. Заливка,
   а не цвет, потому что тёмная тема сделана инверсией всей страницы —
   цветная подсветка под ней уехала бы в чужой тон, а пара «контур/заливка»
   читается одинаково в обеих темах.
   Веса селекторов подобраны под конкурентов поимённо: общее правило кнопок
   в комментариях идёт с идентификатором (#js-comments .comment .c_vote
   .vote_button), поэтому одного класса .vote_voted для победы мало. Блок
   стоит последним в разделе — выигрывает и по весу, и по порядку.
   Обратите внимание: правило цепляется только к vote_voted, но не к :hover.
   У лепры они в одном правиле, а на iOS hover после тапа залипает — иначе
   соседняя кнопка выглядела бы нажатой. */
#js-comments .comment .c_vote .vote_button.vote_voted,
.c_vote .vote_button.vote_voted,
.post .dd .vote .vote_button.vote_voted,
.dd .vote .vote_button.vote_voted,
a.vote_button.vote_voted,
.b-karma_button.active {
  background: rgb(102,102,102) !important;
  border: 1px solid rgb(102,102,102) !important;
  color: rgb(255,255,255) !important;
  font-weight: 700 !important; }

/* ============ МЕДИА ============ */
.js-media_player, .b-media_player, .b-media_player_preview {
  width: auto !important; max-width: 100% !important;
  height: auto !important; aspect-ratio: auto !important; }
.js-media_player video, .js-media_player audio,
.comment video, .p_body video {
  width: 100% !important; height: auto !important;
  max-height: 80vh !important; aspect-ratio: auto !important; }
.js-media_player video, .js-media_player iframe, .js-media_player embed,
.js-media_player object, .js-media_player > div { max-width: 100% !important; }
.b-media_player_preview_pic_holder img {
  max-width: 100% !important; height: auto !important; }

/* ============ ФОРМЫ ============ */
form table, form tbody, form tr, form td, form th {
  display: block !important; width: auto !important;
  max-width: 100% !important; box-sizing: border-box !important; }
input[type="text"], input[type="password"], input[type="email"],
textarea, select {
  /* 16px обязателен: при меньшем Safari зумит страницу на фокусе */
  font-size: 16px !important; max-width: 100% !important;
  box-sizing: border-box !important; }
input[type="radio"], input[type="checkbox"] {
  transform: scale(1.2); margin-right: 6px; }

/* ============ СТРАНИЦА НОВОГО ПОСТА ============ */
/* Разметка формы — самая старая на лепре: одна таблица во всю страницу,
   внутри неё ещё четыре, ширины колонок процентами, раскраска атрибутами
   bgcolor. Общее правило «form table → block» её разбирает, но в блоки
   превращается и то, что должно стоять рядом: квадратик отдельной
   строкой, подпись к нему — следующей. Отсюда и размашистость.
   Поэтому таблицы не чиним, а разбираем в свою колонку — см. fixNewPost.
   Здесь только вид собранного. */
.lm-np { display: block !important; padding-top: 4px !important; }

/* Панель кнопок оформления — это ячейка таблицы, поэтому display задаём
   явно, поверх общего правила. Десять подписей в 13 пунктов занимают
   около 364 пикселей: в 393 они укладываются в строку впритык, при
   увеличенном масштабе страницы переносятся во вторую. Перенос и есть
   запасной вариант — обрезать в такой панели нечего. */
.lm-np #js-new_post_body_wysiwyg {
  display: flex !important; flex-wrap: wrap !important;
  align-items: center !important; gap: 6px 4px !important;
  padding: 0 0 6px !important; white-space: normal !important; }
.lm-np .b-textarea_editor_button {
  margin: 0 !important; padding: 3px 0 !important; font-size: 13px !important; }

/* Высота поля прописана у лепры в разметке — перебиваем своей.
   Кегль 16 обязателен: ниже Safari наезжает увеличением при касании. */
.lm-np #js-new_post_body {
  width: 100% !important; height: ${CFG.newPostBody}px !important;
  font-size: 16px !important; box-sizing: border-box !important;
  margin: 0 !important; }

/* Два списка под полем ввода. Кнопки стоят в одну строку, раскрытый
   список ложится под ними во всю ширину: в половину экрана подписи
   категорий не помещаются, а рвать их пополам ради симметрии незачем.
   Порядок в разметке — обе кнопки, потом обе группы, поэтому строка
   получается сама, без order. */
.lm-np_lists {
  display: flex !important; flex-wrap: wrap !important;
  gap: 6px !important; margin: 14px 0 0 !important; }
.lm-np_toggle {
  flex: 1 1 calc(50% - 3px) !important; min-width: 0 !important;
  box-sizing: border-box !important; display: block !important;
  text-align: left !important; margin: 0 !important;
  padding: 7px 24px 7px 9px !important; position: relative !important;
  font-family: inherit !important; color: inherit !important;
  background: rgba(0, 0, 0, 0.05) !important;
  border: 1px solid rgba(0, 0, 0, 0.15) !important;
  border-radius: 4px !important;
  -webkit-appearance: none !important; appearance: none !important; }
/* Если список остался один — занимает строку целиком, чтобы рядом
   не висела пустая половина. */
.lm-np_toggle:only-of-type { flex: 1 1 100% !important; }
/* Уголок — переключением содержимого, а не поворотом: у правого края
   узкой кнопки повёрнутый глиф заметно прыгает. */
.lm-np_toggle::after {
  content: '▾'; position: absolute !important; right: 8px !important;
  top: 50% !important; margin-top: -0.6em !important;
  font-size: 12px !important; opacity: 0.6 !important; }
.lm-np_toggle.lm-open::after { content: '▴'; }
.lm-np_toggle_t {
  display: block !important; font-size: 13px !important;
  font-weight: bold !important; line-height: 1.25 !important; }
/* Что в списке выбрано. Строка одна: длинное название категории
   обрезаем — тут это не поломка, полное видно в самом списке. */
.lm-np_toggle_v {
  display: block !important; font-size: 11px !important;
  line-height: 1.35 !important; opacity: 0.65 !important;
  white-space: nowrap !important; overflow: hidden !important;
  text-overflow: ellipsis !important; }
/* Группа пунктов: закрыта по умолчанию, открывается классом. */
.lm-np_group {
  display: none !important; flex-wrap: wrap !important;
  flex: 1 1 100% !important; gap: 3px !important;
  margin: 2px 0 4px !important; }
.lm-np_group.lm-open { display: flex !important; }
/* Квадратик с подписью — один пункт: порознь подпись отрывалась от
   своего квадратика на переносе. Подложка вместо lepr'овского bgcolor:
   его ячейки при разборе таблицы всё равно исчезают. */
.lm-np_opt {
  display: flex !important; align-items: flex-start !important;
  gap: 7px !important; padding: 6px 7px !important;
  box-sizing: border-box !important; min-width: 0 !important;
  background: rgba(0, 0, 0, 0.045) !important; border-radius: 3px !important; }
.lm-np_opt input { margin: 0 !important; flex: 0 0 auto !important; }
.lm-np_opt label {
  font-size: 13px !important; line-height: 1.35 !important;
  display: block !important; min-width: 0 !important; }
.lm-np_opt img { vertical-align: middle !important; }
/* Специальные опции — по одной в строку: подписи там фразами.
   Категории — в колонки, число берётся из CFG.newPostCats. */
.lm-np_flags .lm-np_opt { flex: 1 1 100% !important; }
.lm-np_cats .lm-np_opt {
  flex: 1 1 ${Math.max(0, 100 / CFG.newPostCats - 3).toFixed(1)}% !important; }

/* Строка отправки. Отбивка сверху вместо лепровского <hr>: он жил
   внутри таблицы и при разборе уходит вместе с ней. */
.lm-np_send {
  display: flex !important; align-items: center !important;
  gap: 12px !important; margin: 16px 0 0 !important;
  padding: 12px 0 4px !important;
  border-top: 1px solid rgba(0, 0, 0, 0.12) !important; }
/* Кнопка отправки у лепры — картинка 54×20. Пальцем в неё попасть можно,
   но с запасом: поля добавляют площади нажатия, не трогая саму картинку. */
.lm-np_send #js-new_post_submit {
  flex: 0 0 auto !important; padding: 9px 14px !important;
  border-radius: 4px !important; background: rgba(0, 0, 0, 0.06) !important; }

/* Загрузчик картинки. У лепры и кнопка «прикреплю», и панель выбора
   файла позиционированы абсолютно внутри контейнера, у которого своей
   высоты нет вовсе: на десктопе они просто лежат в пустом поле слева от
   кнопки отправки. В строке из двух элементов такой контейнер
   схлопывается в ноль, и надпись наезжает на то, что окажется под ней.
   Ставим обоих в поток. */
.lm-np_send #js-new_post_file {
  flex: 1 1 auto !important; width: auto !important; height: auto !important;
  min-width: 0 !important; margin: 0 !important; text-align: left !important; }
.lm-newpost .b-file_uploader_button,
.lm-newpost .b-file_uploader {
  position: static !important; margin: 0 !important; padding: 0 !important;
  font-size: 13px !important; }
.lm-newpost .b-file_uploader_browse_button {
  float: none !important; margin: 0 !important;
  padding: 0 10px 0 0 !important; }
/* «или перетащить сюда» на телефоне бессмысленно, но узел не прячем:
   похоже, лепра пишет в него имя выбранного файла, а скриптов её в
   сохранённой странице нет и проверить нечем. Пока просто убираем
   абсолютные координаты и нижний предел ширины в 200 пикселей. */
.lm-newpost .b-file_uploader_drag {
  position: static !important; display: inline !important;
  min-width: 0 !important; max-width: 100% !important;
  padding: 0 !important; font-size: 11px !important; }
.lm-newpost .b-new_post_delete_file { font-size: 11px !important; }
/* Табличка «Интернет включён» под формой — украшение, но 150 пикселей
   у правого края смотрятся обрезком. Ставим по центру. */
.lm-newpost #js-new_post_form + div[align="right"] { text-align: center !important; }



/* ============ СТРАНИЦА ПОИСКА ============ */
.b-search_form {
  white-space: normal !important; text-align: left !important;
  padding-top: 10px !important; }
.b-search_form .i-form_text_input {
  width: 100% !important; box-sizing: border-box !important; }
.b-search_form .b-icon_button_search { left: 0 !important;
                                       margin-left: 4px !important; }
.b-search_threshold {
  margin-right: 0 !important; padding-left: 0 !important;
  min-height: 0 !important; }
.b-search_threshold form { padding-left: 0 !important; }
.b-search_threshold form .i-form_text_input { width: 100% !important; }
.b-search_threshold form .b-search_threshold_settings .i-form_text_input {
  width: 100px !important; }
.b-search_form_submit {
  padding-top: 12px !important; line-height: 1.6 !important;
  display: flex !important; flex-wrap: wrap !important;
  align-items: center !important; gap: 8px !important; }
.b-search_form_container { margin-top: 12px !important;
                           padding-top: 14px !important; }
.b-subscriptions_search_form {
  width: auto !important; float: none !important;
  margin-bottom: 16px !important; }

/* переключатель режима был absolute и ложился на чекбоксы */
#js-search_settings_mode_toggle {
  position: static !important; inset: auto !important;
  float: none !important; display: inline-block !important;
  margin: 4px 0 10px !important; white-space: nowrap !important; }

.b-search_threshold_settings,
.b-search_threshold_settings .b-i-search_threshold_settings {
  display: flex !important; flex-wrap: wrap !important;
  align-items: center !important; gap: 8px 16px !important;
  line-height: 1.7 !important;
  margin-left: 0 !important; padding-left: 0 !important; }
.b-search_threshold_settings > *,
.b-search_threshold_settings .b-i-search_threshold_settings > *,
.b-search_threshold_settings span {
  position: static !important; inset: auto !important; float: none !important; }
.b-search_threshold_settings a,
.b-search_threshold_settings label {
  position: static !important; inset: auto !important; float: none !important;
  display: inline-flex !important; align-items: center !important;
  gap: 6px !important; white-space: nowrap !important; }
/* служебные поля статикой делать нельзя — они всплывут в поток */
.b-search_threshold_settings .pos_hidden,
.b-search_threshold_settings select.hidden,
.b-search_threshold_settings .hidden { display: none !important; }
.b-search_threshold_settings input[type="checkbox"],
.b-search_threshold_settings input[type="radio"] {
  position: static !important; margin: 0 !important; flex: 0 0 auto !important; }

/* ============ МОИ ВЕЩИ ============ */
/* Разделитель под подшапкой — парный к тому, что под шапкой страницы */
.b-my_posts_feed_controls {
  padding-bottom: 10px !important; margin-bottom: 12px !important;
  border-bottom: 1px solid rgb(214, 212, 212) !important; }
/* Строка с вводной фразой остаётся обычным текстом: поле выбора стоит
   внутри предложения, и флекс бы его оттуда вырвал — фраза встала бы
   блоком слева, поле отдельно справа. */
.b-my_posts_feed_controls p {
  line-height: 1.7 !important; margin: 0 0 6px !important; }
.b-my_posts_feed_controls select { vertical-align: middle !important; }

/* Строка из одних полей — флекс, и это не украшательство. В разметке
   лепры пробелы лежат не только МЕЖДУ пунктами, но и внутри них: перед
   чекбоксом и после каждого поля выбора. Инлайновый пробел рисуется
   шириной около четырёх пикселей, и к заданному интервалу их набегало
   два — по одному с каждой стороны стыка. У флекс-элементов пробельные
   узлы между ними не рисуются вовсе, а начальные и конечные пробелы
   внутри каждого элемента браузер срезает сам. Тогда интервал задан
   ровно в одном месте — в gap.
   Свободное место раздаётся между пунктами, а не копится справа — иначе
   поля жмутся к левому краю, а правая треть строки пустует.
   Перенос разрешён, но нужен редко: ширину полям скрипт задаёт по
   ВЫБРАННОМУ пункту списка (см. fitSelects), а не по самому длинному,
   и в обычном положении строка помещается целиком. Если же выбраны
   самые длинные варианты сразу в двух списках, пункт уезжает на вторую
   строку — это некрасиво ровно один раз, тогда как подрезанный текст
   в поле выглядит поломкой всегда. */
.b-my_posts_feed_controls p.lm-filters_row {
  display: flex !important; flex-wrap: wrap !important;
  align-items: center !important; gap: 4px 5px !important;
  justify-content: space-between !important; }
/* Подпись и её поле не разрывать: «За» вставало строкой выше своего
   поля, как только пункту не хватало ширины. */
.b-my_posts_feed_controls p.lm-filters_row > .b-my_posts_feed_controls_item {
  min-width: 0 !important; white-space: nowrap !important; }
.b-my_posts_feed_controls p.lm-filters_row >
  .b-my_posts_feed_controls_item:last-child {
  flex: 0 0 auto !important; }
.b-my_posts_feed_controls p.lm-filters_row select {
  max-width: 100% !important; }
/* В «моих вещах» поле сортировки лежит в строке само по себе, без
   обёртки лепры, то есть само является пунктом строки. Форменным
   элементам браузер задаёт нижний предел ширины по содержимому — снимаем,
   иначе строка не сожмётся вовсе. Сжатие здесь — запас на крайний
   случай: ширину полю скрипт уже подобрал по выбранному значению. */
.b-my_posts_feed_controls p.lm-filters_row > select {
  flex: 0 1 auto !important; min-width: 0 !important; }
/* Собственные отступы пунктов и полей снимаем целиком: у лепры они
   рассчитаны на широкую строку и складывались с нашими. */
.b-my_posts_feed_controls_item {
  margin: 0 !important; padding: 0 !important; }
.b-my_posts_feed_controls_item > select,
.b-my_posts_feed_controls_item > label,
.b-my_posts_feed_controls_item > input {
  margin: 0 !important; }
/* у чекбокса «только новое» лепра держит margin-left: 14px прямо
   в атрибуте style — снимаем, иначе к интервалу прибавляются её */
.b-my_posts_feed_controls_item input[type="checkbox"] {
  margin-left: 0 !important; }
/* чекбокс с подписью скрипт сводит сюда, чтобы подпись не отрывалась
   от квадратика при переносе */
.b-my_posts_feed_controls .lm-unread_row {
  display: flex !important; align-items: center !important;
  gap: 6px !important; margin-top: 4px !important; }
/* внутри строки из одних полей он идёт наравне с ними: свой отступ
   сверху ему там не нужен, а сжиматься ему нечем */
.b-my_posts_feed_controls p.lm-filters_row > .lm-unread_row {
  margin-top: 0 !important; flex: 0 0 auto !important; }
.b-my_posts_feed_controls .lm-unread_row input {
  margin: 0 !important; flex: 0 0 auto !important; }
.b-my_posts_feed_controls .lm-unread_row label {
  flex: 1 1 auto !important; }
/* На «избранном» чекбокс с подписью держит собственный узел лепры
   .b-check_item, и своей обёртки мы там не строим. Интервал между ними
   был начальным пробелом внутри подписи — после сокращения текста он
   пропал. Задаём его здесь, в одном месте, а собственные поля квадратика
   снимаем, чтобы величина интервала не складывалась из двух источников. */
.b-my_posts_feed_controls p.lm-filters_row .b-check_item {
  display: inline-flex !important; align-items: center !important;
  gap: 5px !important; white-space: nowrap !important; }
.b-my_posts_feed_controls p.lm-filters_row .b-check_item input,
.b-my_posts_feed_controls p.lm-filters_row .b-check_item label {
  margin: 0 !important; }

/* ============ ИНБОКС ============ */
/* «Написать инбокс» у лепры стоит в потоке слева, под панелью фильтров, и
   на широком экране этого хватает. На телефоне строка из значка и подписи
   теряется у самого края — единственное действие страницы выглядит как
   служебная сноска. Ставим её отдельной строкой по центру.
   Флекс, а не text-align: сама ссылка блочная, и центровать надо её,
   а не текст внутри. */
.b-inbox_write_link {
  position: static !important; float: none !important; clear: both !important;
  width: auto !important; margin: 4px 0 8px !important;
  display: flex !important; justify-content: center !important; }
.b-inbox_write_link > a {
  position: static !important; float: none !important;
  display: inline-flex !important; align-items: center !important;
  gap: 6px !important; }
/* значок внутри — такой же b-svg-icon, как в подписях: у лепры он
   позиционирован относительно и сдвинут по вертикали, внутри флекса
   это уводит его от подписи на пару пикселей */
.b-inbox_write_link .b-svg-icon {
  position: static !important; inset: auto !important;
  top: auto !important; margin: 0 !important;
  display: inline-flex !important; align-items: center !important;
  flex: 0 0 auto !important; }
.b-inbox_write_link .b-svg-icon svg { display: block !important; }
.b-inbox_write { width: 100% !important; box-sizing: border-box !important; }

/* ============ ПРОФИЛЬ ============ */
/* Блок пользователя был жёстко 1200px с минимумом 800px, плюс шесть
   абсолютно позиционированных вставок поверх друг друга.
   Боковые отступы снимаем вместе с ширинами: под аватар и колонку фона
   лепра держит поля в несколько десятков пикселей с каждой стороны, и на
   телефоне содержимое профиля оказывалось ужатым в середину экрана,
   заметно уже шапки и подвала. Поля страницы уже заданы на .l-wrapper. */
.b-user_block, .b-i-user_block,
.b-user_data, .b-i-user_data,
.b-user_data h2, .b-i-user_data h2,
.l-content_wrapper, .b-content_section,
.b-profile_left_col, .b-profile_right_col {
  width: auto !important; min-width: 0 !important; max-width: 100% !important;
  box-sizing: border-box !important; float: none !important;
  margin-left: 0 !important; margin-right: 0 !important;
  padding-left: 0 !important; padding-right: 0 !important; }
.b-user_data, .b-i-user_data, .b-info_block { display: block !important; }
/* h2 у лепры: display:flex, padding-right:195px под голосовалку кармы,
   white-space:nowrap и кегль 36px. Отступ снимаем, перенос разрешаем,
   кегль убавляем — имя в 36px занимало на телефоне почти всю ширину.
   Флекс оставляем: в эту же строку проход moveKarmaToName переносит
   голосовалку, а заметка с базой 100% уходит на строку ниже. */
.b-user_data h2, .b-i-user_data h2 {
  display: flex !important; flex-wrap: wrap !important;
  align-items: center !important; gap: 8px !important;
  margin-top: 0 !important;
  font-size: 24px !important; white-space: normal !important;
  line-height: 1.2 !important; }
.b-user_name-link {
  flex: 0 1 auto !important; min-width: 0 !important;
  word-break: break-word !important; }
.b-profile_left_col, .b-profile_right_col { line-height: 1.6 !important; }
/* карточка пользователя: 285px под аватар и поля под колонку контактов */
.b-userpic_wrapper, .b-userpic { width: auto !important; max-width: 100% !important; }
.b-userpic_image { max-width: 100% !important; height: auto !important; }
/* Подпись к картинке, приглашение и «редактировать» шли левым столбиком
   с полями по 16-30px под десктопную колонку в 330px. В одну колонку
   уместнее по центру и вплотную. */
.b-profile_left_col { text-align: center !important; }
.b-userpic_title { margin-bottom: 2px !important; }
.b-userpic_title_add { padding: 2px !important; }
.b-user_friends, .b-user_contacts {
  padding-right: 0 !important; margin-bottom: 4px !important;
  text-align: center !important; }
.b-user_parent { margin-bottom: 4px !important; }
.b-user_edit_info { margin-bottom: 6px !important; text-align: center !important; }
/* Серая полоса между шапкой и карточкой профиля — это фон .l-i-wrapper
   (#e1e1e1), видимый в зазоре под шапкой. Зазор мой: .l-header оставляет
   снизу 8px. На ленте это воздух между шапкой и первым постом, на профиле
   белая карточка начинается сразу, и полоска бросается в глаза. */
body.l-profile .l-header { margin-bottom: 1px !important; }

/* «#93307, с нами с …» — у лепры под этой строкой 30px пустоты: на широком
   экране в этот зазор попадает голосовалка кармы, прибитая абсолютно
   справа. В одну колонку голосовалка встаёт своей строкой, и зазор
   остаётся просто дырой в треть экрана. */
.b-user_data_registered { margin-bottom: 6px !important; }
/* содержимое профиля ниже вкладок: у лепры 38px сверху и 44px снизу
   плюс блоки с полями по 30-40px — на телефоне это экран пустоты */
.l-content_wrapper { padding-top: 14px !important; padding-bottom: 20px !important; }
.b-info_block, .b-user_citizen { margin-bottom: 16px !important; }
.b-user_stat { padding-bottom: 8px !important; margin-bottom: 8px !important; }
.b-userpic { margin-bottom: 6px !important; }
.b-profile_right_col { padding-bottom: 0 !important; }
.b-menu__profile .b-menu_list { float: none !important; margin-right: 0 !important; }

/* Фон профиля. Держит его .b-user_block — обёртка вокруг всего профиля,
   от карточки до вкладок и содержимого. У лепры на нём: padding-top 46px
   под полосу фона, серая заливка rgb(204,204,204) на случай, когда
   картинки нет, размер cover и attachment: fixed — на десктопе картинка
   стоит на месте, а карточка в 80% ширины едет по ней.
   На телефоне карточка занимает всю ширину, и 46 пикселей сверху были
   просто серой полосой, поэтому раньше фон гасился целиком. Теперь он
   остаётся тонким обрамлением: полоса сверху и поля по краям.

   Картинку лепра ставит ИНЛАЙНОВЫМ стилем, поэтому background-image
   здесь не трогаем ни в каком виде: правило с !important перебило бы
   инлайновый стиль, и вернуть картинку из CSS было бы уже нечем — адрес
   лежит только в разметке. Гасим только заливку.

   Размер — по ширине, а не cover: элемент высотой в несколько экранов,
   и cover растянул бы картинку до неузнаваемой мути ради нижнего края.
   При 100% ширины видна верхушка картинки в натуральных пропорциях, а
   ниже она повторяется — фоны профилей это обычно узор, а не портрет.
   Attachment: fixed снимаем — на iOS он ненадёжен, а смысла в нём нет:
   карточка по фону больше не ездит. */
.b-user_block {
  padding: 0 !important;
  background-color: transparent !important;
  background-attachment: scroll !important;
  background-size: 100% auto !important;
  background-position: center top !important;
  background-repeat: repeat-y !important;
  min-height: 0 !important; height: auto !important; }
/* Класс ставит markProfileArt, увидев инлайновую картинку: без неё
   обрамление было бы пустой полосой в цвет страницы.
   Устройство то же, что у кастомного фона подлепры: растягиваем блок на
   ширину экрана отрицательными полями и возвращаем те же пиксели
   внутренним отступом. Картинка занимает дежурные белые поля страницы, а
   тело профиля остаётся ровно той же ширины, что и без обрамления.
   max-width снимаем отдельно: общее правило выше держит на этом блоке
   100%, то есть ширину БЕЗ полей, и растянуться до кромок он бы не смог —
   вылез бы влево на двенадцать пикселей и не достал справа. */
.b-user_block.lm-art {
  max-width: none !important;
  margin-left: -${CFG.pageEdge}px !important;
  margin-right: -${CFG.pageEdge}px !important;
  padding: ${CFG.profileArt}px ${CFG.pageEdge}px
           ${CFG.pageEdge}px !important; }
.b-user_data { padding-top: 14px !important; padding-bottom: 20px !important; }

.b-user_note_container {
  position: static !important; display: block !important;
  flex: 1 1 100% !important; width: auto !important;
  max-width: 100% !important; margin: 2px 0 0 !important;
  padding-left: 0 !important; }
.b-user_note, #js-usernote {
  position: static !important; display: block !important;
  width: auto !important; max-width: none !important; min-width: 0 !important;
  white-space: normal !important; padding: 2px 0 !important;
  box-sizing: border-box !important; }

/* карма: обёртка плавала вправо с отрицательными полями по всем сторонам,
   значение и кнопки висели абсолютно друг на друге */
.b-user_votes_wrapper {
  position: static !important; float: none !important;
  width: auto !important; height: auto !important; margin: 4px 0 6px !important; }
.b-user_karma {
  position: relative !important; height: auto !important;
  display: inline-flex !important; align-items: center !important;
  gap: 6px !important; }
.b-user_karma .b-karma_value {
  position: static !important; width: auto !important;
  height: auto !important; margin: 0 !important; }
.b-user_karma .b-karma_controls {
  position: static !important; width: auto !important;
  height: auto !important; margin: 0 !important;
  display: inline-flex !important; gap: 4px !important; }
.b-user_karma .b-karma_button {
  position: static !important; width: 22px !important; height: 22px !important;
  line-height: 20px !important; font-size: 13px !important; }
/* Ошибка прежних версий: нижний блок кнопок я счёл дубликатом верхнего и
   скрыл. На деле сверху два минуса, снизу два плюса — на телефоне карму
   можно было только убавить. Показываем обе группы одной строкой:
   [− −] значение [+ +], порядок в разметке уже такой. */
.b-user_karma .b-karma_controls__bot { display: inline-flex !important; }
/* Голосовалка, перенесённая в строку с именем: прижата к правому краю.
   Правило стоит НИЖЕ общего .b-user_votes_wrapper и специфичнее его —
   побеждает и по весу селектора, и по порядку объявления.
   Кегль задаём явно: внутри h2 голосовалка наследовала его 24px, отчего
   «41» и знаки выглядели как заголовок. */
.b-i-user_data h2 .b-user_votes_wrapper {
  flex: 0 0 auto !important; margin: 0 0 0 auto !important;
  font-size: 13px !important; line-height: 1.2 !important; }
.b-i-user_data h2 .b-karma_value,
.b-i-user_data h2 .b-karma_value_inner {
  font-size: 13px !important; line-height: 20px !important;
  height: 22px !important; min-width: 30px !important; }
/* Имя ужимается с многоточием, а не переносит голосовалку на строку ниже:
   при масштабе 110% и выше пара «имя + карма» перестаёт помещаться. */
.b-i-user_data h2 .b-user_name-link {
  flex: 0 1 auto !important; min-width: 0 !important;
  overflow: hidden !important; text-overflow: ellipsis !important;
  white-space: nowrap !important; word-break: normal !important;
  font-size: 22px !important; }

/* Окно со списком проголосовавших (тап по счётчику кармы, а на постах и
   комментариях — по числу голосов). У лепры оно шириной 410px и прибито
   к середине голосовалки со сдвигом вправо:
   .b-votes_popup { position:absolute; right:50%; margin-right:-192px }
   Расчёт десктопный — там голосовалка стоит в середине широкой карточки.
   На телефоне она прижата к правому краю строки с именем, и окно вылезало
   за экран дважды: собственной шириной (410 при CSS-ширине экрана 393)
   и сдвигом на 192px. Ширину ограничиваем экраном прямо здесь, чтобы окно
   не мигало широким до первого замера; горизонтальный сдвиг доводит
   проход fitVotesPopup — из CSS его не вычислить, он зависит от того,
   где именно на строке оказалась голосовалка. */
.b-votes_popup {
  width: 410px !important; max-width: calc(100vw - 12px) !important;
  box-sizing: border-box !important; }
/* Поля внутри окна — 30px слева и 40px справа — оставлены под стрелки
   листания (сами стрелки шириной 21px). На узком окне это седьмая часть
   ширины под пустоту, а список имён и так в две колонки. */
.b-votes_popup .b_users_table_holder {
  padding-left: 24px !important; padding-right: 26px !important; }
.b-votes_popup .b_users_table-list { max-width: none !important; }

/* Пенсне — родная кнопка разворота панели заметок. У лепры это картинка
   75×75, прибитая абсолютно слева от жёлтого поля (left:0, top:-5px).
   Слева от поля на телефоне места нет, поэтому ставим её в поток первой
   в строке и уменьшаем до 30px. */
.b-user_public_notes_logo {
  display: block !important; position: static !important;
  width: 30px !important; height: 30px !important; top: auto !important;
  flex: 0 0 auto !important; margin: 0 !important;
  background-size: contain !important;
  background-position: center center !important; }

/* «Показать авторов» у лепры — не текст, а полоса-картинка 158×34 со
   сдвигом margin-left:133px под ширину десктопной колонки. Оставляем
   подпись, картинку и сдвиг убираем. */
.b-user_public_notes__opened .b-user_public_notes_authors {
  display: inline-flex !important; align-items: center !important;
  position: static !important; overflow: visible !important;
  width: auto !important; height: auto !important;
  margin: 0 !important; padding: 0 !important;
  background: none !important; line-height: 1.3 !important;
  font-size: 12px !important; flex: 0 0 auto !important; }
/* Чекбокс «публиковать заметки» и переключатель «по рейтингу / по дате» —
   одной строкой, прижаты вправо. У лепры оба прибиты абсолютно
   (top:31px right:160px и top:30px right:0) к ширине, которой на телефоне нет. */
.b-user_public_notes {
  display: flex !important; flex-wrap: wrap !important;
  align-items: center !important; gap: 6px 10px !important;
  width: auto !important; margin: 8px 0 !important; padding-left: 0 !important; }
.b-user_public_notes_switcher {
  margin-left: auto !important; }
.b-user_public_notes_switcher, .b-user_public_notes_sorting {
  position: static !important; float: none !important;
  width: auto !important; flex: 0 0 auto !important;
  display: inline-flex !important; align-items: center !important;
  gap: 6px !important; margin-top: 0 !important; margin-bottom: 0 !important;
  padding: 0 !important; }
.b-user_public_notes_switcher label,
.b-user_public_notes_sorting_button { margin: 0 !important; }

.b-user_public_notes_list, .b-user_public_notes_list ul {
  width: auto !important; margin-left: 0 !important; padding-left: 0 !important; }
/* список заметок — со своей строки на всю ширину, иначе он встаёт
   четвёртым элементом той же строки и жмётся в узкую колонку */
.b-user_public_notes_list {
  flex: 1 1 100% !important; margin-top: 8px !important; }
/* Строка «пенсне + жёлтое поле», которую собирает groupNotesRow.
   Пенсне держим у верхнего края: в развёрнутом виде поле высотой
   в несколько экранов, и кнопка по центру уехала бы из виду. */
.lm-notes-row {
  display: flex !important; align-items: flex-start !important;
  gap: 8px !important; flex: 1 1 100% !important; width: 100% !important; }
.lm-notes-row .b-user_public_notes_list {
  flex: 1 1 auto !important; min-width: 0 !important; margin-top: 0 !important; }
/* Пенсне у верхнего края строки, но со сдвигом: свёрнутое поле высотой 48,
   кнопка 30 — половина разницы и есть 9px. В развёрнутом виде поле высотой
   в несколько экранов, и центровать по нему нельзя: кнопка уехала бы
   из виду, поэтому сдвиг фиксированный, а не align-items: center. */
.lm-notes-row .b-user_public_notes_logo { margin-top: 9px !important; }

/* Кнопка продления гражданства — по центру колонки. display:table даёт
   ширину по содержимому, и поля auto её центруют; у inline-элемента
   auto-поля не работают. */
.b-user_citizen_extend {
  display: table !important; margin: 8px auto 0 !important; }
/* Пара «публиковать заметки» + сортировка: прижата вправо, при нехватке
   места переносится целиком, а не по одному элементу. */
.lm-notes-controls {
  display: flex !important; align-items: center !important;
  gap: 10px !important; flex: 0 0 auto !important;
  margin-left: auto !important; }
.lm-notes-controls .b-user_public_notes_switcher { margin-left: 0 !important; }

/* В свёрнутом виде остаются пенсне и последняя заметка: у лепры кнопка
   авторов и переключатели относятся к раскрытой панели, а сложенные в
   одну строку над одной заметкой они выглядели набором ярлыков без повода. */
.b-user_public_notes:not(.b-user_public_notes__opened) .b-user_public_notes_authors,
.b-user_public_notes:not(.b-user_public_notes__opened) .b-user_public_notes_switcher,
.b-user_public_notes:not(.b-user_public_notes__opened) .b-user_public_notes_sorting,
.b-user_public_notes:not(.b-user_public_notes__opened) .lm-notes-controls,
.b-user_public_notes:not(.b-user_public_notes__opened) .vote {
  display: none !important; }
/* поля внутри жёлтого поля: 60px по бокам и 100px справа у текста
   оставлены под стрелки листания и голосовалку, на телефоне это половина
   ширины экрана под пустоту */
.b-user_public_notes_list ul { padding: 8px 10px !important; }
.b-user_public_notes_list li { padding-bottom: 0 !important; }
.b-user_public_notes_list_note_body { padding-right: 0 !important; }
/* В развёрнутой панели заметки идут списком — им нужен зазор между собой */
.b-user_public_notes__opened .b-user_public_notes_list li {
  padding-bottom: 10px !important; }
.b-user_public_notes_list_note { margin-left: 0 !important; }
.b-user_public_notes_list_previous { display: none !important; }

.b-profile_search .i-form_text_input,
#js-profile_search_input,
.i-form_text_input_profile_search,
.i-form_text_input_profile_search_domains {
  width: 100% !important; max-width: 100% !important;
  box-sizing: border-box !important; }
.b-profile_search_controls { position: static !important; }

/* вкладка смены фона позиционировалась с right:-32px, то есть заведомо
   за краем родителя — на телефоне до неё не дотянуться */
.b-user_backgrounds, .b-user_backgrounds_toggle { display: none !important; }

/* ============ АРХИВ ============ */
/* Лента архива имела 330px отступа справа под правую колонку: на телефоне
   постам оставалось меньше двухсот пикселей, отсюда крошечные превью
   и наезжающие друг на друга подписи. */
.b-posts_archive { padding-right: 0 !important; }
.b-archive_heading {
  padding: 10px 0 16px !important; font-size: 1.3em !important; }
.b-archive_navigation {
  width: auto !important; box-sizing: border-box !important;
  padding: 6px !important; }
.b-archive_bottom_navigation {
  margin: 20px 0 !important; padding: 20px 0 !important; }
.b-archive_previous_day_bottom { padding: 6px 10px !important; }
/* календарь архива */
.b-archive_calendar, .b-archive_calendar table {
  width: 100% !important; max-width: 100% !important;
  box-sizing: border-box !important; }

/* подписи постов: строки переносятся часто, тесная высота строки
   заставляла соседние строки наезжать друг на друга */
.dd { line-height: 1.6 !important; }
.dd .b-note { line-height: 1.4 !important; }

/* ============ ВКЛАДКИ (мои вещи, профиль, настройки) ============ */
/* Свёрстаны CSS-таблицей: ячейки таблицы не переносятся в принципе,
   строка обязана уместиться целиком. Переводим на флекс. */
/* верхний отступ блока: вместе с полем шапки давал пустую полосу
   под разделителем */
.b-menu { margin-top: 0 !important; padding-top: 0 !important; }
.b-menu_list {
  display: block !important; width: auto !important;
  height: auto !important; margin-bottom: 8px !important; }
.b-menu_list_row {
  display: flex !important; flex-wrap: wrap !important; gap: 6px !important; }
.b-menu_list_link, span.b-menu_list_link {
  display: inline-block !important; flex: 0 0 auto !important;
  padding: 7px 12px !important; margin: 0 !important; }
.b-menu_list_text { height: auto !important; line-height: 1.4 !important; }
.b-menu_list_link_content { float: none !important; margin-right: 0 !important; }
.b-menu_list_link__last { width: auto !important; }

/* Активная вкладка отличается от соседних фоном rgb(241,240,241) против
   белого — полтора процента яркости. На бумаге это разница, на телефоне
   при боковом свете её нет вовсе. Затемняем фон и рамку настолько, чтобы
   вкладка читалась сразу, но не выглядела нажатой кнопкой.
   Нижнюю границу оставляем цветом самой вкладки, как у лепры: так она
   «открывается» в содержимое, а не обводится со всех сторон.
   Профиль и панель-кнопки не трогаем: там своё оформление активной
   вкладки — залитая серым с белым текстом и рамка без заливки. */
.b-menu:not(.b-menu__profile):not(.b-menu__buttons) .b-menu_list_link_active,
.b-menu:not(.b-menu__profile):not(.b-menu__buttons) .b-menu_list_link_active:hover {
  background-color: rgb(223, 221, 223) !important;
  border-color: rgb(184, 182, 184) rgb(184, 182, 184)
                rgb(223, 221, 223) !important;
  color: rgb(40, 40, 40) !important; }

/* Четыре вкладки профиля с общими полями по 12px не помещались в 369px и
   переносились. При масштабе страницы 110% ширина падает до ~333, поэтому
   считаем с запасом: кегль 11, поля 5, зазор 3 — вся четвёрка около 280. */
.b-menu__profile .b-menu_list_row { gap: 3px !important; }
.b-menu__profile .b-menu_list_link {
  padding: 6px 5px !important; font-size: 11px !important;
  white-space: nowrap !important; flex: 0 1 auto !important; }
.b-menu__profile .b-menu_list_link i { font-size: 10px !important; }

/* ============ МАГАЗИН (/fraud/) ============ */
/* ---- Строка ссылок под навигационной штукой ----
   Шесть пунктов набраны Verdana в 12.8 с полями по 12 — это 642 пикселя
   с зазорами при доступных 369, и они ложились в ТРИ строки, причём
   третью занимал один знак вопроса: вторая недобирала восьми пикселей
   (377 против 369). Мерить эту строку по Arial нельзя — Verdana идёт по
   0.545 кегля против 0.519, и при равных числах она заметно шире.

   Ужимаем кегль, поля и зазор, а самый длинный пункт сокращаем в
   shortenTabs. Тогда 488 вместо 642, и две строки держатся не только при
   100%, но и при масштабе страницы 125%, когда доступных остаётся 316. */
.b-menu_fraud .b-menu_list_row { gap: 4px !important; }
.b-menu_fraud .b-menu_list_link, .b-menu_fraud span.b-menu_list_link {
  padding: 6px 9px !important; font-size: 12px !important;
  line-height: 1.15 !important; white-space: nowrap !important; }
/* Знак вопроса свои поля держит на вложенной ссылке — иначе они
   складывались бы с полями пункта и он выходил бы вдвое шире прочих. */
.b-menu_fraud .b-menu_list_link__last { padding: 0 !important; }
.b-menu_fraud .b-menu_list_link_content {
  padding: 6px 9px !important; border-radius: 3px !important; }
/* Тунец остаётся, но вписывается в строку. У лепры он 28×40 при кнопке
   в 29 — то есть выше её, и торчал вверх на дюжину пикселей, наезжая на
   строку над собой. Пропорции сохраняем: 28×24/40 = 17. */
.b-menu_fraud .b-charlie_item { padding-left: 20px !important; }
.b-menu_fraud .b-charlie_item i {
  width: 17px !important; height: 24px !important;
  background-size: 17px 24px !important;
  margin-top: -12px !important; }

/* ---- Общее для всех страниц магазина ----
   Кегль полей ввода. У лепры они идут по 12–14, а всё, что ниже 16,
   Safari на iOS встречает наездом камеры при касании: страница
   прыгает масштабом, и вернуть его обратно нечем. Ставим 16 всему
   разделу разом — по одному правилу на страницу их набиралось шесть,
   и каждая новая форма приносила бы седьмое. */
html.lm-fraud input[type="text"], html.lm-fraud input[type="password"],
html.lm-fraud input[type="email"], html.lm-fraud input[type="tel"],
html.lm-fraud input[type="number"], html.lm-fraud textarea,
html.lm-fraud select { font-size: 16px !important; }
/* Поля с шириной в пикселях под десктопную колонку — их на страницах
   магазина россыпь (500, 450, 130). Ширину отдаём содержимому, но с
   рамками в расчёте: иначе поле во всю карточку вылезает на их толщину. */
html.lm-fraud input[type="text"], html.lm-fraud input[type="password"],
html.lm-fraud textarea {
  max-width: 100% !important; box-sizing: border-box !important; }

/* Подменю разделов («Пополнение счета | Переводы | История операций»,
   «Приветствия | Смена никнейма | Будка…»): отступ слева в 20 пикселей
   рассчитан на логотип магазина, стоящий выше и левее. Справа его нет,
   и на телефоне строка стояла несимметрично. */
.b-fraud_sub_navigation {
  padding: 12px 0 0 !important; font-size: 12px !important;
  line-height: 1.7 !important; }

/* Обёртки содержимого: 96% ширины оставляли полосу справа и ничего не
   давали взамен, отступ слева в 18 и верхний в 43 — тот же логотип.
   Правило держим на классе страницы: .b-tabs_content лепра использует и
   в профиле, и в настройках, а их я не проверял. */
html.lm-fraud .b-tabs_content, html.lm-fraud .b-inner_container {
  width: auto !important; padding-left: 0 !important;
  padding-right: 0 !important; padding-top: 0 !important; }

/* Ширина документа 882 при экране 393 бралась не из содержимого, а из двух
   нижних пределов: min-width 770 у витрины и min-width 870 у отдела с
   мерчем. Всё остальное в отчёте — следствие: колонки, отступы, кегли и
   ширины полей считаются от этой ширины, поэтому чинить их по одному
   бессмысленно, пока стоят пределы. */
.b-fraud_showcase {
  min-width: 0 !important; margin: 0 0 16px !important;
  padding: 0 !important; }
.b-fraud_market { min-width: 0 !important; padding-left: 0 !important; }
.b-fraud_quick_block {
  padding: 0 0 0 4px !important; margin: 0 0 24px !important; }

/* Три колонки товаров — в одну. Порог unfloatWide сюда не дотягивается:
   треть от 369 — это 123 пикселя, меньше 40% экрана. */
.b-fraud_showcase_col { float: none !important; width: auto !important; }
/* Карточки и их обёртка залиты одним и тем же серым, и в столбик они
   слипаются в сплошное полотно. На десктопе их разделяли колонки. */
.b-fraud_showcase_col .b-fraud_showcase_product {
  border-bottom: 1px solid rgb(224, 224, 224) !important; }

/* Отбивка заголовка сверху в 44 пикселя и сдвиг витрины вправо на 41
   были рассчитаны на логотип магазина, который лежит выше и левее. */
.b-fraud_showcase_caption {
  font-size: 15px !important; line-height: 1.35 !important;
  margin: 0 0 10px !important; padding: 10px 0 0 !important; }
.b-fraud_logo { margin: 10px 0 12px !important; max-width: 100% !important; }

/* Карточка гражданства: тунец нарисован фоном размером 227×332 и отодвигал
   текст на 275 пикселей — на экране 393 под сам текст оставалось меньше
   сотни. Картинку уменьшаем втрое, отступ вместе с ней. */
.b-fraud_showcase_pro {
  padding-left: 100px !important; padding-right: 12px !important;
  background-size: 84px auto !important;
  background-position: 8px 12px !important; }

.b-fraud_showcase_product { font-size: 13px !important; }
.b-fraud_showcase_product h1 {
  font-size: 18px !important; line-height: 1.25 !important;
  padding-top: 10px !important; }
.b-fraud_showcase_product h2 { font-size: 16px !important; }
.b-i-fraud_showcase_product,
.b-i-fraud_showcase_product_description { padding: 10px 12px !important; }

/* Формы покупки: кегль полей 18 и ширины в пикселях заданы под карточку
   в треть от 770. Ширину отдаём содержимому, но с рамками в расчёте —
   иначе поле шириной во всю карточку вылезает на толщину рамки. */
.b-fraud_showcase .i-form_text_input,
.b-fraud_showcase .i-form_textarea {
  max-width: 100% !important; box-sizing: border-box !important; }
.b-fraud_showcase_product_form .b-hidden_content {
  padding: 14px 12px 12px !important; }
.b-fraud_showcase_product_form_price { font-size: 18px !important; }
.b-fraud_showcase_pro_new_sublepro_form .b-hidden_content {
  width: auto !important; padding: 14px 0 16px !important; }
.b-fraud_showcase_pro_new_sublepro_form .i-form_text_input {
  width: 150px !important; }
.b-fraud_showcase_pro_new_sublepro_form label {
  margin-right: 6px !important; }
.b-fraud_showcase_pro_new_sublepro_link i { font-size: 15px !important; }
.b-fraud_showcase .b-pro_acc_prolongation_friend_form { padding-left: 0 !important; }
/* поля наружу по 20 пикселей с каждой стороны — под широкую карточку */
.b-fraud_showcase_ranks_rebuy { margin: 0 !important; }

/* ============ ЗВАНИЯ (/fraud/ranks/) ============ */
/* Отступ слева в 20 пикселей рассчитан на логотип магазина, который лежит
   выше и левее содержимого. Справа его нет, поэтому на телефоне текст
   стоит несимметрично: слева 32 пикселя от края, справа 12. */
.b-fraud_text { padding: 14px 0 0 !important; }

/* ---- Строка «у вас нет должности» и галочка ----
   Оба куска — inline, и на десктопе стоят в одну строку. На телефоне
   галочка «не хочу званий от других» переносится и её подпись отрывается
   от квадратика. Ставим отдельной строкой. */
.b-ranks_current { margin-bottom: 12px !important; font-size: 13px !important; }
.b-block_external_ranks { display: block !important; margin: 6px 0 0 !important; }

/* ---- Форма «Добавить должность» ----
   Заголовок набран кеглем 30: одна надпись «Добавить должность:» — это
   296 пикселей при доступных 369, и поле в 25% ширины (92) уже не влезало
   в ту же строку. Дальше в той же строке шли поле ника фиксированной
   ширины 130, «за», поле цены 50, «ЛВ» и кнопка — всё это ломалось
   вперемешку. Кегль сбавляем, а поле должности пускаем отдельной
   строкой блоком: тогда предложение читается «Добавить должность: /
   <поле> / <ник> за <N> ЛВ» и переносы получаются по смыслу, а не по
   тому, где кончилось место.
   Шестнадцать у полей обязательны: ниже Safari на iOS наезжает
   увеличением при касании. */
.b-ranks_add_form { margin-bottom: 18px !important; }
.b-ranks_add_form h1 {
  font-size: 15px !important; line-height: 2 !important;
  margin: 0 0 4px !important; }
.b-ranks_add_form .b-ranks_input_rank {
  display: block !important; width: 100% !important;
  box-sizing: border-box !important;
  font-size: 16px !important; text-align: left !important;
  margin: 3px 0 6px !important; }
.b-ranks_add_form .b-ranks_input_username {
  width: 45% !important; max-width: 170px !important;
  box-sizing: border-box !important; font-size: 16px !important; }
.b-ranks_add_form .b-ranks_input_value {
  width: 62px !important; box-sizing: border-box !important;
  font-size: 16px !important; }
/* кнопка — картинка 54×20, у лепры она сидит на базовой линии текста */
.b-ranks_add_form .b-ranks_input_yarrr {
  margin-left: 8px !important; vertical-align: middle !important; }

/* ---- Блок объяснения: строка с уголком ----
   Уголок — переключением содержимого, а не поворотом: у правого края
   повёрнутый глиф заметно прыгает. */
.lm-ranks_about {
  display: block !important; width: 100% !important;
  box-sizing: border-box !important; text-align: left !important;
  position: relative !important; margin: 0 !important;
  padding: 9px 28px 9px 12px !important;
  font-family: inherit !important; font-size: 13px !important;
  color: inherit !important;
  background: rgb(236, 237, 239) !important;
  border: 0 !important; border-radius: 4px !important;
  -webkit-appearance: none !important; appearance: none !important; }
.lm-ranks_about:not(.lm-open) { margin-bottom: 14px !important; }
.lm-ranks_about.lm-open { border-radius: 4px 4px 0 0 !important; }
.lm-ranks_about::after {
  content: '▾'; position: absolute !important; right: 10px !important;
  top: 50% !important; margin-top: -0.6em !important;
  font-size: 12px !important; opacity: 0.6 !important; }
.lm-ranks_about.lm-open::after { content: '▴'; }
.lm-ranks_about:not(.lm-open) + .b-ranks_about { display: none !important; }
.b-ranks_about {
  padding: 2px 12px 4px !important; margin: 0 0 14px !important;
  border-radius: 0 0 4px 4px !important;
  font-size: 13px !important; line-height: 1.45 !important; }
.b-ranks_about h3 {
  font-size: 16px !important; line-height: 1.25 !important;
  margin: 0 0 6px !important; }
.b-ranks_about p { margin: 0 0 8px !important; }

/* ---- Таблица званий ----
   Четыре колонки с полями по 15 с каждой стороны требуют 595 пикселей при
   доступных 369: должность 146, ник 146, история 222, цена 81. Ячейки
   таблицы не переносятся целиком, поэтому браузер жмёт каждую по буквам —
   отсюда и «криво». Разворачиваем строку в две:

       должность                              2025 ЛВ
       ник   с 1 Марта 2021 перекупалась 2 раза

   Перелом строки делаем пустым флекс-элементом на 100% ширины: он занимает
   целую строку и уносит всё, что после него, вниз. Порядок задаём
   свойством order, а не перестановкой узлов, — разметку лепра
   перерисовывает своим скриптом при сортировке и по кнопке «Ещё». */
.b-ranks_table { display: block !important; width: auto !important; }
.b-ranks_table tbody { display: block !important; }
.b-ranks_table tr {
  display: flex !important; flex-wrap: wrap !important;
  align-items: baseline !important; gap: 2px 8px !important; }
.b-ranks_table_stat::after {
  content: '' !important; flex: 0 0 100% !important;
  height: 0 !important; order: 2 !important; }

/* Рамку и поля переносим с ячеек на строку: у ячеек они умножались на
   четыре и съедали 120 пикселей из 369.
   Селектор с tbody взят не для красоты: у лепры есть правило
   .b-ranks_table .b-ranks_table_stat_my td весом в два класса — своё
   звание она подчёркивает красным. Ровно по весу спор решался бы
   порядком объявления, а jsdom и браузер считают его по-разному, поэтому
   берём заведомо больший вес. */
.b-ranks_table tbody .b-ranks_table_stat td {
  display: block !important; border: 0 !important; padding: 0 !important;
  width: auto !important; }
.b-ranks_table tbody .b-ranks_table_stat {
  padding: 9px 0 8px !important;
  border-bottom: 1px solid rgb(224, 224, 224) !important; }
.b-ranks_table tbody .b-ranks_table_stat_my {
  border-bottom-color: rgb(255, 0, 0) !important; }

.b-ranks_table tbody .b-ranks_table_rank {
  order: 1 !important; flex: 1 1 auto !important; min-width: 0 !important;
  font-size: 15px !important; line-height: 1.25 !important; }
/* Цена — то, ради чего сюда приходят: по ней и перекупают. Держим её
   в конце первой строки и не даём сжиматься. */
.b-ranks_table tbody .b-ranks_table_price {
  order: 1 !important; flex: 0 0 auto !important;
  font-size: 15px !important; font-weight: bold !important;
  line-height: 1.25 !important; text-align: right !important; }
.b-ranks_table tbody .b-ranks_table_username {
  order: 3 !important; flex: 0 0 auto !important; font-size: 13px !important; }
.b-ranks_table tbody .b-ranks_table_history {
  order: 4 !important; flex: 1 1 auto !important; min-width: 0 !important;
  font-size: 11px !important; line-height: 1.3 !important;
  opacity: 0.6 !important; }

/* Заголовки колонок — это переключатели сортировки (по ним есть
   обработчик у лепры, а подчёркиванием она их и помечает). Строкой
   таблицы им быть больше незачем, но кнопками остаться надо. */
.b-ranks_table tbody th {
  display: block !important; border: 0 !important;
  padding: 5px 8px !important; border-radius: 4px !important;
  background: none !important; }
.b-ranks_table tbody th.b-active {
  background-color: rgb(224, 226, 230) !important; }
.b-ranks_table tbody th span { font-size: 12px !important; }
.b-ranks_table tbody th.b-active span { text-decoration: none !important; }

/* Поле, в которое превращается цена при перекупке. Кегль у лепры 14 —
   ниже порога, за которым Safari наезжает увеличением на касание.
   Высота 34 с таким же межстрочным раздвигала строку вдвое. */
.b-ranks_table .js-ranks_new_price_holder_table {
  height: auto !important; line-height: 1.25 !important; }
.b-ranks_table .js-ranks_new_price_holder input {
  font-size: 16px !important; width: 66px !important;
  box-sizing: border-box !important; }

/* «Ещё» — плавающая кнопка шириной по содержимому. Плавание снимаем
   (под ним пустая строка от .clear), кнопку растягиваем: она одна внизу
   длинного списка, и промахиваться по ней незачем. */
.b-ranks_table_more {
  float: none !important; display: block !important;
  height: auto !important; text-align: center !important;
  margin: 12px 0 0 !important; padding: 11px 14px !important;
  border-radius: 4px !important; }
.b-ranks_cols { margin-bottom: 20px !important; }

/* ============ ОПЕРАЦИИ С ЛВ (/fraud/refuel/) ============ */
/* Снизу у контейнера 170 пикселей пустоты — почти пол-экрана ни подо что.
   На десктопе она уравновешивала высокую правую колонку, в одну колонку
   это просто дыра перед подвалом. */
.b-refuel_container { padding: 16px 0 24px !important; }
/* Две колонки 62/38 — в одну. Правая под порог unfloatWide не попадает:
   38% от 369 — это 140 пикселей, меньше 40% экрана. */
.b-refuel_container .b-left_col, .b-refuel_container .b-right_col {
  float: none !important; width: auto !important;
  padding: 0 !important; }
.b-refuel_container .b-right_col { margin-top: 20px !important; }

.b-fraud_refuel { font-size: 15px !important; }
.b-fraud_refuel form { margin-bottom: 16px !important; }
.b-fraud_refuel .i-form_text_input { width: 90px !important; }
.b-fraud_refuel_fz54_contact .i-form_text_input { width: 100% !important; }
.b-fraud_refuel_fz54_contact { font-size: 12px !important; }
/* Кнопки оплаты: два блока по 150 в inline-block. Логотипы 127×27 и
   128×24 в них влезают, а вот сдвиг самой кнопки на -5 пикселей влево
   ставил её мимо центра своего блока — это заметно, когда блоки стоят
   парой. */
.b-fraud_refuel_pay_button .b-button {
  margin-left: 0 !important; padding: 8px 14px !important; }

/* Курс — шутка, набранная 53 пикселями с запретом переноса: «1 ЛВ = 1
   РУБ» это 300 пикселей текста плюс 74 полей, то есть 374 при доступных
   369, и плашка вылезала за экран. Ужимаем ровно настолько, чтобы она
   осталась крупной и при масштабе 125%: 216 текста плюс 40 полей. */
.b-refuel_rate {
  font-size: 38px !important; padding: 18px 20px !important;
  text-align: center !important; margin: 8px 0 10px !important; }
.b-refuel_rate em { font-size: 26px !important; }
.b-refuel_rate_desc { font-size: 12px !important; line-height: 1.45 !important; }

/* ============ ПРОФ. АККАУНТ (/fraud/professional/) ============ */
/* Заголовок в 29 пикселей с отбивкой сверху в 48 и дата в 24 — на
   десктопе это шапка страницы во всю ширину, на телефоне «Вы —
   гражданин Лепрозория.» занимало две строки, а дата под ним — три. */
.b-fraud_members h2 {
  font-size: 21px !important; line-height: 1.25 !important;
  padding-top: 16px !important; margin-bottom: 10px !important; }
.b-payed_duration {
  font-size: 16px !important; line-height: 1.35 !important;
  margin-bottom: 18px !important; }

/* Блок продления был жёстко 600 пикселей — переполнение на 231 при
   доступных 369, и оно тянуло за собой ширину всего документа. */
.b-pro_acc_prolongation { width: auto !important; font-size: 13px !important; }
/* Отступ слева держит красную руку: она 32x34 и прибита абсолютно к
   левому краю. Отбивка снизу в 34 между двумя абзацами — десктопный
   воздух. */
.b-pro_acc_prolongation_text {
  padding-left: 38px !important; margin-bottom: 16px !important;
  line-height: 1.4 !important; }
.b-fraud_members .b-pro_acc_prolongation_friend_form {
  padding-left: 38px !important; }
.fraud_members_payed_text { font-size: 13px !important; line-height: 1.5 !important; }

/* Вопросы-ответы. Заголовок «У меня есть вопросы!» — 24 пикселя с полем
   снизу в 43, и это при том, что сам список свёрнут: до нажатия на
   странице стоял пустой отступ в полсотни пикселей. */
.b-fraud_members_questions {
  margin-top: 24px !important; padding-bottom: 20px !important; }
.b-fraud_members_questions h3 {
  font-size: 17px !important; line-height: 1.3 !important;
  padding: 16px 0 18px !important; }
.b-members_questions h4 { margin-top: 16px !important; line-height: 1.3 !important; }
.b-members_questions p { padding-bottom: 14px !important; line-height: 1.5 !important; }
/* Образец меню с Чарли — картинка 271x78 обтеканием справа. Рядом с ней
   на текст оставалось меньше сотни пикселей. */
.b-charley_in_menu_sample {
  float: none !important; display: block !important;
  max-width: 100% !important; height: auto !important;
  margin: 0 0 12px !important; }

/* ============ ЗАМЕНЫ (/fraud/replacements/) ============ */
/* 85% ширины без центрирования: справа оставалась полоса в 55 пикселей,
   а полезной ширины внутри полей по 20 выходило 274 из 369. */
.b-fraud_replace { width: auto !important; padding: 16px 0 !important; }
/* Заголовок в 28 пикселей — «Замена слов и фраз в Лепрозории на 1 день!»
   это 641 пиксель текста, то есть три строки. Красный кружок с ценой
   лежит ВНУТРИ заголовка строчным блоком 120x120 и на десктопе стоит
   справа от него; в узкой колонке он попадает в поток текста, поэтому
   уменьшаем его вместе с кеглем и уводим отдельной строкой. */
.b-fraud_replace_caption {
  font-size: 20px !important; line-height: 1.3 !important;
  margin-bottom: 14px !important; }
.b-fraud_replace_price {
  display: block !important; width: 84px !important; height: 84px !important;
  line-height: 84px !important; font-size: 19px !important;
  margin: 10px 0 0 !important; }

/* Форма замены: два поля по 28% — это по 77 пикселей, куда не помещается
   даже подсказка «другое». Подписи и поля ставим столбиком во всю
   ширину. */
.b-fraud_replace_form { padding: 16px 14px !important; }
.b-fraud_replace_form_label {
  display: block !important; margin: 0 0 3px !important;
  font-size: 13px !important; }
.b-fraud_replace_form_input {
  display: block !important; width: 100% !important;
  box-sizing: border-box !important; margin-bottom: 12px !important; }
.b-fraud_replace_form_submit { margin-top: 4px !important; }
.b-fraud_replace_description {
  margin-bottom: 20px !important; font-size: 13px !important;
  line-height: 1.5 !important; }

/* Проверялка замен: поле ввода и окно вывода по 35% строчными блоками,
   то есть на десктопе рядом. В 369 пикселях рядом им не встать.
   Раскрытие ведёт лепра через max-height — механику не трогаем. */
.b-fraud_replace_checker_form { margin-bottom: 20px !important; }
.b-fraud_replace_checker_form_input {
  display: block !important; width: 100% !important;
  box-sizing: border-box !important; height: 110px !important;
  margin-bottom: 8px !important; }
.b-fraud_replace_checker_form_output {
  display: block !important; width: 100% !important;
  box-sizing: border-box !important; }
.b-fraud_replace_checker_toggle { font-size: 16px !important; }

/* ============ ОСНОВНЫЕ ВЕЩИ (/fraud/greetings/) ============ */
/* Форма приветствий — две колонки 60/39 с разделительной чертой между
   ними. У гражданина без денег на счету лепра не выводит ни одной из
   них, но левая остаётся в разметке пустой, а нижний предел высоты у
   неё 186 пикселей плюс отбивка сверху 25 — полэкрана пустоты сразу под
   подписью «сначала пополните счет».
   Отступ между колонками задаём полем, а не отбивкой: пустая колонка с
   одним лишь полем схлопывается сама, отбивка осталась бы видна. */
.b-fraud_greetings { padding: 8px 0 16px !important; }
.b-fraud_greetings .b-settings_left_col,
.b-fraud_greetings .b-settings_right_col {
  float: none !important; width: auto !important; max-width: none !important;
  min-height: 0 !important; margin: 0 !important;
  padding: 0 !important; border: 0 !important; }
.b-fraud_greetings .b-settings_right_col { padding-top: 16px !important; }
.b-fraud_greetings .b-form_field { margin-bottom: 14px !important; }

/* ---- Окно подтверждения покупки («окно Чарли») ----
   Открывается на любой покупке: продление гражданства, звания, никнейм.
   Держатель прибит к верху экрана и высотой в один пиксель, а само окно
   выходит из него наружу и задано шириной 666 — то есть в полтора экрана.
   Крестик закрытия у него absolute от правого края окна, поэтому уезжал
   за экран вместе с ним, а закрыть окно больше нечем: подложка тапы
   не принимает, и остаётся только «назад».

   Держатель при этом ровно 393 в ширину, поэтому общая подгонка слоёв
   его не трогала — она смотрит на рамку, а виновато содержимое. */
#charley_holder .charley {
  /* Ширину окна задаём настройкой, а картинку кладём ровно по окну.
     Раньше окно было во весь экран, а картинка занимала долю его ширины,
     и справа оставалась полоса заливки шириной в эту разницу — она и
     выглядела торчащей подложкой. Теперь лишнего места нет вовсе. */
  width: ${CFG.charleyArt}% !important; max-width: 100% !important;
  /* auto по бокам — окно снова по центру. У лепры здесь margin: -200px
     auto 0, и обнулять боковые поля было незачем: вправо окно уезжало
     не из-за них, а из-за ширины в 666 пикселей. */
  margin-left: auto !important; margin-right: auto !important;
  min-height: 0 !important;
  /* Доска с тунцом и КРЕСТИК ЗАКРЫТИЯ — всё одна картинка 660×318.
     Отдельного значка у крестика нет: .close — просто прозрачный
     квадрат 51×51 поверх нарисованного. Поэтому масштабировать можно
     только по ширине: cover обрезал картинку сбоку, и крестик, который
     нарисован у правого края, пропадал — тап работал, а видно не было.
     Если окно выше картинки, низ добирается цветом самой доски: он
     замерен по ней и одинаков в середине и у края, шва не будет. */
  background-size: 100% auto !important;
  background-color: rgb(44, 44, 44) !important; }

/* Отступ слева был 200 пикселей — ровно под тунца в натуральную величину.
   На картинке тунец нарисован до 148-го пикселя из 660, то есть занимает
   22% ширины; картинка растянута по ширине окна, значит те же 22% окна
   при любом экране. Отсюда 24%: те же 22 плюс небольшой зазор до текста.
   Справа оставляем место крестику — его квадрат 51 пиксель. */
#charley_holder .charley_inner {
  padding: 14px 56px 12px 24% !important; }
#charley_holder .text {
  font-size: 14px !important; line-height: 1.35 !important;
  margin-bottom: 10px !important; }
#charley_holder .yes, #charley_holder .no { font-size: 15px !important; }
#charley_holder .password_holder {
  font-size: 12px !important; margin: 6px 0 !important; }
/* Кегль поля был 8 пикселей. Ниже 16 Safari на iOS наезжает камерой на
   поле при касании, поэтому именно 16, а не «покрупнее». */
#charley_holder .password_holder input {
  font-size: 16px !important; width: 110px !important;
  padding: 2px 4px !important; }
#charley_holder .close { right: 2px !important; top: 2px !important; }

/* ============ ЧАРЛИ (вкладка с тунцом) ============ */
/* Страница собрана из трёх плавающих колонок под ширину около 900 пикселей:
   тунец 184px слева, текст с отступом ровно в эти 184, ниже «важная
   информация» в половину строки и колонка подлепрозориев в 39%. На
   телефоне из этого выходит текст в двести пикселей шириной, пустая
   колонка справа и дата, вылезающая за экран. */

/* 96% оставляли полосу справа и ничего не давали взамен */
.b-inner_container { width: auto !important; }
.b-pro_account_container { padding-bottom: 8px !important; }

/* Тунец остаётся слева обтекаемым блоком, но вдвое уже: 184 пикселя из
   393 — это половина экрана под картинку с подписью. Отступ слева у
   текста снимаем совсем. Тогда текст идёт справа от тунца, а закончив
   его высоту — продолжается под ним во всю ширину, вместо того чтобы
   стоять узкой колонкой до самого низа. Нижние поля по 80 пикселей
   выравнивали колонки между собой и здесь дают только пустоту. */
.b-pro_acc_charlie {
  width: 116px !important; margin: 0 12px 6px 0 !important; }
.b-pro_acc_charlie img { max-width: 100% !important; height: auto !important; }
.b-pro_acc_charlie p { width: auto !important; line-height: 1.35 !important; }
.b-pro_acc_text {
  margin: 0 !important; padding: 0 !important;
  font-size: 13px !important; line-height: 1.5 !important; }

/* «Крупно и красным» — шутка, набранная 48 пикселями. Дата в них выходит
   за экран (412 пикселей при окне 393) и разгоняет ширину всего документа
   до 441. Кегль сбавляем, но перепад между строкой и датой оставляем:
   без него от шутки ничего не остаётся. */
.b-pro_acc_info {
  float: none !important; width: auto !important;
  padding: 10px 0 8px !important; }
.b-pro_acc_info p { margin: 0 0 6px !important; line-height: 1.4 !important; }
.b-pro_acc_info .b-pro_acc_expire {
  font-size: 15px !important; line-height: 1.3 !important;
  padding-top: 4px !important; }
.b-pro_acc_info .b-pro_acc_expire .b-valid_till { font-size: 15px !important; }
.b-pro_acc_info .b-pro_acc_expire em { font-size: 22px !important; }

/* Колонка подлепрозориев: 39% ширины, у гражданина без своих подлепр
   пустая — тогда это просто плавающий пустой блок, сдвигающий соседей.
   Порог unfloatWide до неё не дотягивается: 138 пикселей меньше 40%
   экрана, поэтому снимаем обтекание правилом.
   Отступ сверху задаём полем, а не отбивкой: у гражданина без своих
   подлепр блок пуст, и пустой блок с одним лишь полем схлопывается сам
   в ноль высоты, тогда как отбивка осталась бы видимой полосой.
   Проверка :empty здесь не годится: внутри блока лежит перевод строки. */
.b-pro_acc_subs {
  float: none !important; width: auto !important;
  padding-top: 0 !important; margin-top: 8px !important; }

/* Строка ссылок под вкладками — обычный текст с разделителями */
.b-my_posts_feed_controls_navigation {
  font-size: 12px !important; line-height: 1.6 !important; }

/* ============ ПОДСАЙТЫ ============ */
.l-header_subsite { padding-left: 0 !important; }
.l-content_aside_subsite { display: none !important; }
/* Девиз подсайта. Тридцать пикселей десктопа на телефоне давали три
   строки — при том, что это подпись, а не заголовок страницы.
   Стоит по центру и никогда не переносится: девиз — единая фраза, и
   разорванный на две-три строки он читается как обрывок ленты, а не как
   подпись подлепры. Уместить его в строку одним CSS нельзя, кегль
   подбирает fitSubsiteHeader по замеру; здесь только начальное значение.
   overflow: hidden — страховка на случай, если подгонка не отработала
   (кегль ещё не подобран, замер дал ноль, проход упал): без неё nowrap
   растягивает страницу вбок и ломает всю ленту, а не одну надпись. */
.b-subsite_header {
  /* Три пикселя снизу — не отбивка, а место под тень: overflow: hidden
     режет её вместе с содержимым, и без поля у надписи снизу тень
     обрывалась. Отбивку на те же три уменьшили, общая высота прежняя. */
  padding: 4px 0 3px 0 !important; margin: 0 0 1px 0 !important;
  font-size: ${CFG.subsiteTitle}px !important; line-height: 1.2 !important;
  text-align: center !important;
  white-space: nowrap !important;
  overflow: hidden !important; text-overflow: ellipsis !important;
  /* заголовок часто лежит поверх фотографии */
  text-shadow: 0 1px 2px rgba(255,255,255,.9) !important; }
.b-subsite_header a { padding: 0 !important; margin-left: 0 !important; }
/* дубликат логотипа: тот, что в шапке, лепра рисует своими средствами */
.b-subsite_logo { display: none !important; }
.l-content__subsite .b-archive_heading { padding-right: 0 !important; }
.b-new_sublepra { width: auto !important; padding: 12px 0 !important; }

/* правая колонка в 330px оставляла ленте около сорока пикселей.
   Полосы сверху и снизу: свёрнутое пенсне — это одна строка между девизом
   и лентой, и без верхней черты она читалась началом ленты, а не отдельным
   блоком. Отбивка сверху в три пикселя — чтобы черта не липла к девизу;
   вместе с самой чертой подпись пенсне опускается на четыре пикселя. */
.b-subdomain_aside_right {
  float: none !important; width: auto !important;
  margin: 3px 0 10px !important; padding-bottom: 0 !important;
  border-top: 1px solid rgb(226, 224, 222) !important;
  border-bottom: 1px solid rgb(226, 224, 222) !important; }
/* Распорки под снятые обтекания: своей высоты у них нет, но каждая
   рвёт схлопывание полей соседей и добавляет строку пустоты.
   Селектор нарочно не прямой: собранное пенсне переносит содержимое
   колонки на уровень ниже, в .lm-pince_body, и «>» перестал бы попадать. */
.b-subdomain_aside_right .clear { display: none !important; }
.b-subdomain_aside_subscribe {
  height: auto !important; overflow: visible !important;
  margin-bottom: 0 !important; }
.b-subdomain_aside_subscribe .b-subscribe_button {
  float: none !important; width: auto !important; margin: 0 0 2px !important; }
.b-subdomain_aside_subscribe_additional {
  float: none !important; width: auto !important; margin-top: 2px !important; }
.b-subdomain_aside_subscribe_expand {
  position: static !important; left: auto !important; top: auto !important;
  transform: none !important; display: inline-block !important;
  margin-left: 6px !important; }
.b-subdomain_settings_button { right: 4px !important; top: 4px !important; }
.b-subdomain_aside_right .b-domain_popup_controls {
  margin-bottom: 2px !important; }

/* Описание подлепры — свободный текст, набранный правлением вручную.
   У лепры это правая колонка: float, 286px ширины и 30px поля справа.
   Обтекание здесь снимаем правилом, а не эвристикой unfloatWide: в
   свёрнутом пенсне блок скрыт, ширина у него нулевая, и проверка
   «шире 40% экрана» не сработает — а пометку «просмотрено» проход
   уже поставит, и после разворота никто сюда не вернётся. */
.b-domain_description {
  float: none !important; width: auto !important;
  padding: 0 !important; margin: 0 !important;
  border-bottom: 0 !important;
  font-size: 13px !important; line-height: 1.45 !important; }
/* Абзацы там разделены парами <br>. На десктопной колонке это выглядит
   списком, на телефоне — двойным межстрочным на весь блок. Вторую
   строку убираем: одинарного разрыва хватает. */
.b-domain_description br + br { display: none !important; }

/* ---- Простое пенсне ----
   Свод правил и ссылок подлепры, сложенный в одну строку. Название —
   по волшебному пенсне в профиле: там таким же нажатием разворачивается
   лента заметок. */
.lm-pince {
  display: flex !important; align-items: center !important; gap: 7px !important;
  width: 100% !important; box-sizing: border-box !important;
  margin: 0 !important; padding: 5px 0 !important;
  background: none !important; border: 0 !important;
  -webkit-appearance: none !important; appearance: none !important;
  /* Шорткат font: inherit здесь стоял и съедал заданный ниже кегль:
     он сбрасывает font-size последним значением из наследования. */
  font-family: inherit !important; font-weight: normal !important;
  font-size: 13px !important; line-height: 1.3 !important;
  color: inherit !important;
  text-align: left !important; cursor: pointer !important;
  -webkit-user-select: none !important; user-select: none !important;
  -webkit-tap-highlight-color: transparent !important; }
/* Стёкла и шеврон одной ширины — как в навигационной штуке. Подпись
   растягивается на остаток строки и центруется в нём; поскольку по краям
   от неё отведено поровну (30 + отбивка с каждой стороны), середина
   остатка и есть середина строки. Прежде подпись стояла сразу за
   стёклами, а шеврон уходил вправо полем auto. Ширина 30 — по стеклу:
   svg нарисован как раз в 30 пикселей. */
.lm-pince_glass, .lm-pince_arrow { flex: 0 0 30px !important; }
.lm-pince_glass { display: block !important; }
.lm-pince_label {
  flex: 1 1 auto !important; min-width: 0 !important;
  text-align: center !important; }
/* Шеврон у правого края строки. */
.lm-pince_arrow {
  margin-left: 0 !important; text-align: right !important;
  font-size: 10px !important;
  color: rgb(130, 130, 130) !important; }
/* Развёрнутое состояние — сменой знака, а не поворотом. Поворот идёт
   вокруг середины коробки шеврона, а сам знак прижат к её правому краю:
   на 30 пикселях ширины он перепрыгивал бы к левому, и шеврон при
   каждом развороте гулял по строке. Знак пишем содержимым псевдоэлемента,
   поэтому в разметке span пустой. */
.lm-pince_arrow::before { content: '▾' !important; }
.lm-pince__open .lm-pince_arrow::before { content: '▴' !important; }
.lm-pince_body { padding: 2px 0 8px !important; }

/* Левая колонка подсайта — управляющий, правление, блоги империи.
   Общим правилом выше она скрыта: на десктопе это столбец в 245px с
   фоновой картинкой bg_left.png, а поля в 45-65 пикселей у пунктов
   отбиты под нарисованные на ней завитки. Текст в ней ровно тот же
   «о подлепре», поэтому в теле пенсне она разворачивается — без
   картинки, без полей и без трёх декоративных подложек поверх.
   Правило заведомо весомее скрывающего (два класса против одного) и
   стоит ниже по файлу: иначе jsdom и браузер решили бы спор по-разному. */
.lm-pince_body .l-content_aside_subsite {
  display: block !important; float: none !important;
  width: auto !important; min-height: 0 !important;
  background: none !important;
  margin: 6px 0 0 !important; padding: 6px 0 0 !important;
  border-top: 1px solid rgb(238, 236, 234) !important; }
.lm-pince_body .b-aside_item {
  padding: 0 !important; margin: 0 0 5px !important;
  min-height: 0 !important; }
.lm-pince_body .b-aside_president a,
.lm-pince_body .b-aside_president b { font-size: 14px !important; }
.lm-pince_body .b-aside_president p {
  margin: 0 !important; font-size: 11px !important; }
.lm-pince_body .b-aside_government a,
.lm-pince_body .b-aside_imperial_blogs strong,
.lm-pince_body .b-aside_imperial_blogs a { font-size: 13px !important; }
.lm-pince_body .b-aside_imperial_blogs strong {
  padding-left: 0 !important; margin-bottom: 2px !important; }
.lm-pince_body .b-aside_imperial_blogs ul { margin: 0 !important; }
.lm-pince_body .b-aside_imperial_blogs li {
  padding-left: 0 !important; margin-bottom: 0 !important; }
/* подложки — вырезанные куски той самой фоновой картинки колонки */
.lm-pince_body .b-aside_president_bg,
.lm-pince_body .b-aside_imperial_blogs_bg { display: none !important; }
.b-subdomain_aside_right:not(.lm-pince__open) .lm-pince_body {
  display: none !important; }

/* ============ КНОПКА ПОДПИСКИ ============ */
/* Кнопка устроена так: значок лежит абсолютно в начале строки, а подпись
   к нему («подписаться» / «отписаться») раскрывается с нулевой ширины
   по наведению мыши. На телефоне наведения нет, поэтому от кнопки
   оставался один серый значок в двадцать пикселей: у неподписанного
   плюс, у подписанного шеврон вниз, который читается как «раскрыть
   список», а не как состояние. Понять, подписан ли ты, было нельзя,
   а тап сразу выполнял действие.
   Разворачиваем подпись насовсем — ровно то, что на десктопе показывает
   наведение, включая замену шеврона на минус у подписанного. Значок при
   этом должен встать в поток: раскрытая подпись растёт вправо и абсолютным
   блоком легла бы поверх числа подписчиков. */
.b-subscribe_button {
  display: inline-flex !important; align-items: center !important; }
.b-subscribe_button_icon {
  position: static !important; top: auto !important; left: auto !important;
  display: inline-flex !important; align-items: center !important;
  height: 24px !important; padding: 0 5px !important;
  flex: 0 0 auto !important; }
.b-subscribe_button_hover_text::after,
.js-subscribed .b-subscribe_button_hover_text::after {
  max-width: 100px !important; padding-left: 5px !important;
  padding-right: 0 !important; }
.js-subscribed .b-subscribe_button_icon span[data-name="subscribed"] {
  display: none !important; }
.js-subscribed .b-subscribe_button_icon span[data-name="unsubscribe"] {
  display: inline-block !important; }
/* число подписчиков отступало на 32 пикселя от левого края — обходило
   значок, которого там больше нет */
.b-subscribe_button_text {
  position: static !important; left: auto !important;
  line-height: 1.3 !important; padding-left: 7px !important; }

/* ============ СПИСОК ПОДСАЙТОВ (underground) ============ */
/* Тело пункта занимало 50% ширины, описание плавало на 45%, счётчики
   стояли абсолютно на 40, 52 и 64 процентах — всё складывалось в кашу. */
.b-list_item { padding-bottom: 8px !important; }
.b-list_item_body { width: auto !important;
                    padding: 12px 0 12px 78px !important; }
.b-list_item_logo { top: 12px !important; left: 2px !important; }
/* Описание и дополнительные настройки лепра сворачивает через max-height: 0,
   но отбивки вокруг них при этом остаются видимыми — 26 пикселей воздуха
   на пункт, а пунктов на странице четыре десятка. Поля даём только
   раскрытому пункту. */
.b-list_item_blog_description {
  float: none !important; width: auto !important; margin: 0 !important; }
.b-list_item_blog_controls_additional { margin: 0 !important; }
.b-list_item__opened .b-list_item_blog_description {
  margin: 6px 0 2px !important;
  font-size: 13px !important; line-height: 1.4 !important; }
.b-list_item__opened .b-list_item_blog_controls_additional {
  margin-top: 8px !important; }
.b-list_item_blog_stats {
  position: static !important; width: auto !important;
  display: flex !important; flex-wrap: wrap !important;
  gap: 4px 14px !important; margin: 4px 0 6px !important; }
.b-list_item_blog_stats_posts,
.b-list_item_blog_stats_comments,
.b-list_item_blog_stats_subscribers {
  position: static !important; left: auto !important; top: auto !important;
  width: auto !important; text-align: left !important; }
.b-list_item_blog_toggle_expand { right: 4px !important; top: 12px !important; }
.b-list_item_user_karma {
  position: static !important; width: auto !important;
  text-align: left !important; }
.b-list_item_blog_controls label { display: inline !important;
                                   margin-left: 4px !important; }
.b-list_item_blog_controls p { margin: 0 0 8px !important; }
.b-list_item__user { margin-right: 0 !important; }
.b-subscriptions_random { display: none !important; }

/* Плотная раскладка самого списка подлепр. Правила ниже намеренно
   привязаны к .b-blogs_list: те же классы .b-list_item носят список
   граждан и подлепры в профиле, у них своя разметка и своя ширина. */
.b-blogs_list .b-list_item {
  display: flex !important; flex-direction: column !important;
  padding: 0 0 6px !important; margin-bottom: 6px !important;
  border-bottom: 1px solid rgb(226, 224, 222) !important; }
/* Описание лежит в разметке ПЕРЕД телом: на десктопе оно уплывало вправо
   и логотипу не мешало, а без обтекания встало бы первой строкой пункта —
   поверх логотипа, который позиционирован абсолютно. Меняем порядок. */
.b-blogs_list .b-list_item_body {
  order: 1 !important; padding: 7px 0 0 54px !important; }
.b-blogs_list .b-list_item_blog_description { order: 2 !important; }
/* распорка под обтекание; во флекс-колонке она встала бы первым элементом */
.b-blogs_list .b-list_item > .clear { display: none !important; }
.b-blogs_list .b-list_item_logo {
  width: 44px !important; height: 44px !important;
  top: 7px !important; left: 0 !important; }
/* Адрес, название и создатель занимали три строки из четырёх. Адрес и
   название читаются как одна строка, разделителя у лепры нет — ставим сами. */
.b-blogs_list .b-list_item_body_text { line-height: 1.3 !important; }
.b-blogs_list .b-list_item h5 { display: inline !important;
                                margin: 0 !important; }
.b-blogs_list .b-list_item_blog_prefix { font-size: 13px !important; }
.b-blogs_list .b-list_item_blog_prefix::after {
  content: ' · ' !important; color: rgb(160, 160, 160) !important; }
.b-blogs_list .b-list_item_blog_creator {
  display: block !important; margin: 1px 0 0 !important;
  font-size: 12px !important; }
.b-blogs_list .b-list_item_blog_controls { margin-top: 3px !important; }
/* Ссылкой подписки у лепры служит вся строка целиком, вместе с числом
   подписчиков: оно выглядит подписью, а работает кнопкой, и промах по
   пункту списка молча менял подписку. Оставляем нажимаемым только сам
   значок с подписью; тап по числу уходит пункту и раскрывает описание.
   Событие с значка всплывает до ссылки, обработчик лепры не задет. */
.b-blogs_list .b-subscribe_button { pointer-events: none !important; }
.b-blogs_list .b-subscribe_button_icon { pointer-events: auto !important; }

/* Строка режимов, сортировки и поиска. Поле поиска в 300 пикселей плавало
   вправо с отбивкой в 40, списки несли поля по 10 — три уровня, ни один
   не совпадал с краем пунктов списка. */
.b-underground_nav { margin: 6px 0 8px !important; padding: 0 !important; }
.b-underground_nav ul { margin: 0 !important; padding: 0 !important; }
.b-underground_nav_mode li { padding: 3px 7px !important;
                             margin: 0 4px 0 0 !important;
                             font-size: 14px !important; }
.b-underground_nav_sort { display: block !important;
                          margin: 7px 0 0 !important; }
.b-underground_nav_sort li { margin-right: 14px !important; }
.b-menu_underground_search { float: none !important;
                             display: block !important;
                             margin: 8px 0 0 !important; }
.b-menu_underground_search form {
  width: auto !important; margin: 0 !important;
  display: flex !important; align-items: center !important; }
.b-menu_underground_search .i-form_text_input {
  width: auto !important; flex: 1 1 auto !important; }
.l-subscription_list .b-load_more_posts_button {
  margin-bottom: 16px !important; }

/* Врезка с подлепрой дня отсчитывалась от левой колонки в 245 пикселей:
   на телефоне это отжимало её к правому краю в вертикальную полоску.
   Отбивка снизу в 60 — расчёт на пустое поле рядом с колонкой. */
.l-content_aside_subscriptions_top { margin: 0 0 12px !important; }
.l-content_aside_subscriptions_top .b-subscriptions_aside_block p {
  font-size: 13px !important; line-height: 1.35 !important;
  margin-top: 6px !important; }

/* ============ СПИСОК ГРАЖДАН (/users/) ============ */
/* Пункт списка раскидан по десктопной сетке: тело на 40% ширины, карма
   абсолютно на правых десяти процентах, а между ними — блок описания,
   плавающий вправо на 50% ширины с отбивкой ещё в 10% и нижним пределом
   высоты в 100 пикселей. Описание почти всегда пустое (лепра отдаёт его
   классом __empty и подгружает по нажатию), поэтому на телефоне каждый
   гражданин занимал сто с лишним пикселей, из которых больше половины —
   пустое место. Хуже того, unfloatWide видел плавающую колонку шире 40%
   экрана и честно снимал ей обтекание — пустой блок разворачивался уже
   во всю ширину. Здесь float снят правилом, поэтому проход его пропустит:
   он выходит на первом же элементе с float: none.

   Собираем пункт в три строки: логин с кармой, имя с городом, счётчики. */
.b-users_list_users .b-list_item {
  position: relative !important;
  display: flex !important; flex-wrap: wrap !important;
  padding: 6px 16px 7px 50px !important; margin: 0 !important;
  border-bottom: 1px solid rgb(226, 224, 222) !important;
  border-radius: 0 !important; box-shadow: none !important; }
.b-users_list_users .b-list_item_logo {
  width: 40px !important; height: 40px !important;
  top: 8px !important; left: 0 !important;
  border-radius: 3px !important; z-index: 2 !important; }
/* z-index у тела намеренно auto, а не число: с числом тело заводит свой
   слой, и поднятые ссылки внутри него уже не могут перекрыть подложку
   описания. С auto слоя нет — ссылки всплывают на уровень карточки,
   а всё остальное тело оказывается под подложкой, и тап по нему
   разворачивает карточку. */
.b-users_list_users .b-list_item_body {
  order: 1 !important; flex: 1 1 100% !important;
  position: relative !important; z-index: auto !important;
  width: auto !important; min-width: 0 !important;
  padding: 0 52px 0 0 !important; }
.b-users_list_users .b-list_item_body_text { line-height: 1.3 !important; }
.b-users_list_users .b-list_item > .clear { display: none !important; }

.b-users_list_users .b-list_item h5 { margin: 0 !important; }
.b-users_list_users .b-list_item h5 a.c_user { font-size: 16px !important; }
/* Имя и город лепра ставит блоками — две строки на четыре слова. Сводим
   в одну; разделитель вешает скрипт, и только когда имя не пустое. */
.b-users_list_users .b-list_item_user_name {
  display: inline !important; font-size: 12px !important;
  margin: 0 !important; }
.b-users_list_users .b-list_item_user_residence {
  display: inline !important; font-size: 12px !important;
  margin: 0 !important; }
.b-users_list_users .lm-after_name::before {
  content: ' · ' !important; color: rgb(160, 160, 160) !important; }
.b-users_list_users .b-list_item_user_docs { margin-top: 1px !important; }
.b-users_list_users .b-list_item_user_docs a { margin-right: 9px !important; }
/* Карма — единственное число в пункте, ей место у логина, а не отдельной
   строкой внизу, куда её отправляло общее правило для списка подлепр.
   Отсчитывается от тела пункта, под неё же в теле отведено поле справа. */
.b-users_list_users .b-list_item_user_karma {
  position: absolute !important; right: 0 !important; top: 1px !important;
  width: auto !important; text-align: right !important;
  font-size: 13px !important; color: rgb(90, 90, 90) !important; }

/* Раскрытое и свёрнутое-с-текстом описание идут обычным потоком под телом. */
.b-users_list_users .b-list_item_user_description {
  order: 2 !important; flex: 1 1 100% !important;
  float: none !important; width: auto !important; margin: 0 !important;
  min-height: 0 !important; padding: 2px 0 0 !important;
  font-size: 12px !important; line-height: 1.35 !important; }
.b-users_list_users .b-list_item_user_description_info {
  padding: 4px 0 2px !important; }
.b-users_list_users .b-list_item_user_description_info > * {
  margin-bottom: 8px !important; }
/* Свёрнутое описание — это не блок, а кнопка: нажатие на него подгружает
   подробности о гражданине. Растягиваем его подложкой на весь пункт,
   а ссылки поднимаем над ним, чтобы они остались нажимаемыми. Так тап
   мимо ссылки раскрывает карточку, и лишней высоты это не стоит.
   Класс lm-open ставит скрипт, когда лепра положила внутрь содержимое:
   на случай, если она раскроет блок, не сняв с него __empty.
   Правило стоит НИЖЕ общего и весит больше — иначе браузер и проверка
   в jsdom разошлись бы: первый считает по весу, вторая по порядку. */
.b-users_list_users .b-list_item_user_description__empty:not(.lm-open),
.b-users_list_users .b-list_item_user_description.lm-collapsed {
  position: absolute !important; top: 0 !important; right: 0 !important;
  bottom: 0 !important; left: 0 !important;
  float: none !important; width: auto !important; margin: 0 !important;
  min-height: 0 !important; padding: 0 !important; z-index: 1 !important; }
/* Обратно лепра карточку не сворачивает — обработчик у неё только на
   разворот. Сворачиваем своим классом: содержимое прячем, блок снова
   становится подложкой-кнопкой на всю карточку. */
.b-users_list_users .b-list_item_user_description.lm-collapsed > * {
  display: none !important; }
.b-users_list_users .b-list_item h5 a,
.b-users_list_users .b-list_item_user_name,
.b-users_list_users .b-list_item_user_docs a {
  position: relative !important; z-index: 2 !important; }
/* Указатель раскрытия у лепры — белый треугольник посреди пустого блока:
   на белом фоне его не видно, он проявляется наведением, которого на
   телефоне нет. Перекрашиваем и уводим к правому краю. */
.b-users_list_users .b-list_item .b-list_item_user_description__empty::after,
.b-users_list_users .b-list_item .b-list_item_user_description__folded::after {
  top: 50% !important; left: auto !important; right: 3px !important;
  margin: -3px 0 0 !important;
  border-width: 6px 5px 0 !important;
  border-color: rgb(178, 178, 178) transparent transparent !important; }
.b-users_list_users .b-list_item_user_description.lm-open:not(.lm-collapsed)::after {
  transform: rotate(180deg) !important; }

/* Шапка раздела: заголовок в 30 пунктов, два блока настроек, плавающих
   влево с отбивкой в 40, поле поиска фиксированной ширины в 300 и общий
   отступ слева в 12 пикселей — он не совпадал с краем пунктов списка,
   у которых своих полей нет. */
.b-users_list_caption {
  font-size: 20px !important; padding: 0 !important;
  margin: 6px 0 10px !important; }
.b-users_list_section {
  float: none !important; margin: 0 !important; }
.b-users_list_search { padding-left: 0 !important; margin-bottom: 8px !important; }
.b-users_list_search form {
  display: flex !important; align-items: center !important; }
/* 16 пунктов — нижний предел, при котором Safari на iOS не наезжает
   увеличением при касании поля. */
.b-users_list_search .i-form_text_input {
  width: auto !important; flex: 1 1 auto !important; min-width: 0 !important;
  font-size: 16px !important; }
/* Три строки настроек — «искать среди заметок» с двумя полями, «Был» с
   тремя чекбоксами и сортировка — сводятся каждая в одну линию. Ширину
   заранее не посчитать: она зависит от масштаба страницы, который скрипту
   не виден, и от выбранных пунктов в полях. Поэтому раскладку задаём
   флексом, а подгонку кегля делает fitUsersRows по факту замера.
   flex-wrap оставлен намеренно: это последняя ступень, до неё доходит
   только когда кегль упёрся в пол. Подрезанный текст выглядит поломкой
   всегда, перенос — один раз. */
.b-users_list_filters,
.b-users_list_filters + .b-users_list_flags,
.b-users_list_sorting {
  display: flex !important; flex-wrap: wrap !important;
  align-items: center !important;
  padding-left: 0 !important; font-size: 13px !important; }
.b-users_list_filters {
  gap: 6px 9px !important; padding-bottom: 8px !important; }
.b-users_list_filters + .b-users_list_flags {
  gap: 6px 8px !important; margin-bottom: 8px !important; }
.b-users_list_sorting {
  gap: 4px 6px !important; margin-bottom: 4px !important; }
/* Чекбокс «искать среди заметок» лежит у лепры в отдельном блоке над
   полями. Скрипт переносит блок внутрь строки, а сам блок убираем из
   раскладки: он нужен только чтобы держать узлы вместе и не терять
   обработчик лепры, а место в строке должны занимать его дети. */
.b-users_list_filters > .b-users_list_flags { display: contents !important; }
/* «мои заметки» лепра открывает галочкой «искать среди заметок» — пункт
   появляется уже после подгонки строки, поэтому ему сразу отводим свою
   линию, а не отбираем ширину у соседей. */
.b-users_list_filters .b-users_list_flags > span:not(.lm-chk) {
  flex: 1 1 100% !important; }
/* Квадратик с подписью — один пункт строки: порознь подпись отрывалась
   от чекбокса на переносе. */
.lm-chk {
  display: inline-flex !important; align-items: center !important;
  gap: 5px !important; white-space: nowrap !important;
  flex: 0 0 auto !important; }
.lm-chk input, .lm-chk label {
  margin: 0 !important; font-size: inherit !important; }
.lm-flag_prefix, .lm-sort_prefix {
  flex: 0 0 auto !important; white-space: nowrap !important; }
/* Форменным элементам браузер задаёт нижний предел ширины по содержимому —
   снимаем, иначе строка не сожмётся вовсе. Ширину полю подбирает
   fitSelect по выбранному пункту. */
.b-users_list_filters select {
  flex: 0 1 auto !important; min-width: 0 !important; max-width: 100% !important;
  margin: 0 !important; font-size: inherit !important; }
.b-users_list_sorting ul {
  display: flex !important; flex-wrap: wrap !important;
  align-items: center !important; gap: 4px !important;
  margin: 0 !important; padding: 0 !important; }
.b-users_list_sorting li {
  padding: 2px 5px !important; margin: 0 !important;
  font-size: inherit !important; white-space: nowrap !important; }
.b-users_list_users { margin-bottom: 8px !important; }
.b-load_more_posts_button__users {
  margin: 12px 0 16px !important; padding: 8px 0 10px 14px !important; }

/* ============ УВЕДОМЛЕНИЯ («Пынь») ============ */
/* Лента отсчитывалась от левой колонки (left:245px), резервировала 340px
   под боковую панель и требовала минимум 446px ширины. */
.b-notification-feed {
  left: 0 !important; right: 0 !important;
  width: auto !important; max-width: 100vw !important;
  box-sizing: border-box !important; }
.b-notification-feed_layout_popup {
  min-width: 0 !important; width: auto !important;
  max-width: 100vw !important; box-sizing: border-box !important; }
.b-notification-feed_inner,
.b-notification-feed_layout_popup .b-notification-feed_inner {
  margin: 0 !important; max-width: 100% !important; }
.b-notification-feed_content { margin-left: 0 !important; }
.b-notification-feed_sidebar, .b-notification-feed_fixed {
  position: static !important; width: auto !important;
  padding-left: 0 !important; }
.b-notification-feed__footer { width: auto !important; }
.b-notification-feed_layout_popup .b-notification-item {
  padding-left: 12px !important; padding-right: 10px !important; }
.b-notification { margin: 2px 8px !important; }
.b-notification-item_header, .b-notification-item_footer {
  margin-left: 0 !important; }

/* Страница уведомлений. Лента лежит последним потомком body и прибита
   абсолютно: top ей считает скрипт лепры от высоты своей шапки (вышло
   112 пикселей), а у нас шапка другая и выше — лента наезжала на неё.
   Ставим в поток; сам узел переносится в главную колонку скриптом,
   иначе статичный блок встал бы ниже подвала. */
.b-notification-feed_layout_page {
  position: static !important; top: auto !important;
  min-height: 0 !important; }
.b-notification-item {
  padding: 9px 10px 9px 38px !important; line-height: 18px !important; }
.b-notification-item_icon { margin-left: -30px !important; }
/* Внутри пункта было четыре отбивки по 5–10 пикселей: под шапкой со
   значком, под строкой «кто ответил», над подписью и под ней. На экране
   в 393 это давало полтора пункта на высоту одного. */
.b-notification-item_header { margin-bottom: 0 !important; }
.b-notification-item_message { margin-bottom: 4px !important; }
.b-notification-item_footer {
  margin-top: 4px !important; padding-bottom: 0 !important; }
.b-notification-item_mention_comment_text { word-break: break-word !important; }
/* Три раздела шли строкой по 30 пикселей высотой, с отбивками под
   десктопную колонку в 320. Ставим столбиком и обнуляем всю цепочку
   обёрток: у сайдбара своя отбивка (.b-right_sidebar margin-top),
   у секции своя, у списка своя — по отдельности каждая мелочь, вместе
   полпальца пустоты. */
.b-notification-feed_layout_page .b-notification-feed_sidebar,
.b-notification-feed_layout_page .b-notification-feed_fixed,
.b-notification-feed_layout_page .b-notification-settings {
  margin: 0 !important; padding: 0 !important; }
.b-notification-feed_layout_page .b-notification-settings_list {
  display: block !important; margin: 0 !important; padding: 0 !important; }
.b-notification-feed_layout_page .b-notification-settings_separator {
  display: none !important; }
.b-notification-feed_layout_page .b-notification-settings_category {
  line-height: 22px !important; height: auto !important;
  font-size: 13px !important; margin: 0 !important; padding: 0 !important; }
/* Ячейка внутри пункта была шириной во всю строку и высотой ровно в 40 —
   от этого счётчик уходил под название отдельной строкой. */
.b-notification-feed_layout_page .b-notification-settings_category_content {
  width: auto !important; height: auto !important;
  white-space: nowrap !important; }
.b-notification-feed_layout_page .b-notification-settings_category_icon {
  height: 20px !important; width: 20px !important;
  margin: 1px 4px 0 0 !important; }
.b-notification-feed_layout_page .b-notification-settings_category_icon svg {
  height: 20px !important; width: 20px !important; }
/* Отбивка в 36 пикселей и невидимая (opacity: 0, но display: block)
   ссылка «Показать отписки» давали пустую полосу почти в палец высотой. */
.b-notification-feed_layout_page .b-notification-unsubscriptions {
  display: flex !important; flex-wrap: wrap !important;
  align-items: center !important; gap: 2px 14px !important;
  font-size: 13px !important; line-height: 22px !important;
  margin: 0 !important;
  padding: 0 0 6px !important;
  border-bottom: 1px solid #ebebeb !important; }
.b-notification-unsubscriptions_link.hidden { display: none !important; }
.b-notification-mark_link, .b-notification-unsubscriptions_link {
  margin-bottom: 0 !important; }

/* ============ ПЫНЬ: своё окошко ============ */
/* У лепры по нажатию на колокольчик всплывает окно со списком, а внизу
   у него ссылка на страницу целиком. На телефоне оно не открывается, да
   и рассчитано на мышь: минимум 446 пикселей ширины, а прокрутка ленты
   включается только под наведением (:hover). Поэтому окно своё, а
   содержимое — леприно, загруженное со страницы уведомлений. */
html.lm-pyn_on .b-notification-feed_layout_popup { display: none !important; }
#lm-pyn {
  position: fixed !important; top: 0 !important; left: 0 !important;
  right: 0 !important; bottom: 0 !important;
  z-index: 2147483000 !important;
  display: flex !important; align-items: flex-start !important; }
/* Своё окно лепра ничем не затемняет — оно у неё маленькое и висит под
   колокольчиком. У нас во всю ширину экрана, и без подложки по краям
   торчала бы страница. Держим её еле заметной; CFG.pynShade: 0 уберёт
   совсем, тогда тап мимо окна всё равно закрывает. */
.lm-pyn_shade {
  position: absolute !important; top: 0 !important; left: 0 !important;
  right: 0 !important; bottom: 0 !important;
  background: rgba(0, 0, 0, ${CFG.pynShade / 100}) !important; }
/* Рамка и подвал — как у лепровского окна уведомлений:
   .b-notification-feed_layout_popup — рамка 1px rgb(215,215,215) без
   скруглений и без строки заголовка; .b-notification-feed__footer —
   полоса 42px цветом rgb(224,224,226), надписи 12px rgb(37,37,37)
   с отступом 20 по краям. */
.lm-pyn_box {
  position: relative !important; z-index: 1 !important;
  margin: 6px !important; width: 100% !important; box-sizing: border-box !important;
  max-height: ${CFG.pynHeight}vh !important;
  display: flex !important; flex-direction: column !important;
  overflow: hidden !important;
  background: #fff !important;
  border: 1px solid #d7d7d7 !important;
  box-shadow: 0 2px 10px rgba(0, 0, 0, .25) !important; }
.lm-pyn_body {
  flex: 1 1 auto !important; overflow-y: auto !important;
  -webkit-overflow-scrolling: touch !important;
  background: #fff !important; }
.lm-pyn_note {
  padding: 20px 12px !important; text-align: center !important;
  color: #777 !important; font: 13px/1.4 Arial, sans-serif !important; }
.lm-pyn_foot {
  flex: 0 0 auto !important; display: flex !important;
  align-items: center !important; justify-content: space-between !important;
  height: 42px !important; padding: 0 20px !important;
  box-sizing: border-box !important;
  background: #e0e0e2 !important; }
/* Кнопка закрытия — на месте лепровского «Отметить всё как прочитанное»
   (та без её скрипта не работает, а закрывать окно на телефоне чем-то
   надо: строки заголовка у лепры нет). */
.lm-pyn_foot a, .lm-pyn_close {
  font: 12px/42px Arial, sans-serif !important; color: #252525 !important;
  text-decoration: none !important;
  background: none !important; border: 0 !important; padding: 0 !important; }
#lm-pyn .b-notification-item { font-size: 13px !important; }
#lm-pyn .b-notification-item_footer { padding-bottom: 0 !important; }

/* ============ СКРЫТОЕ ============ */
.b-navthing_holder, .b-chat, .b-chat_open,
.b-footer_left_col, .b-footer_futurico, .b-gertruda,
.b-content_top_shadow, .b-tags, .b-cloud,
.b-subs_ads_on_index, .b-subs_ads_on_index__wrapper,
.b-subs_ads_overflow_holder, .b-subs_ads { display: none !important; }
/* Реклама подсайтов: у неё padding-right:329px, на телефоне это давало
   пустую колбасу в 800px высотой. Чтобы вернуть в сжатом виде, удалите
   .b-subs_ads* из списка выше и раскомментируйте это:
   .b-subs_ads_overflow_holder { padding-right: 0 !important; }
   .b-subs_ads_on_index { margin-right: 0 !important; } */

/* ============ СВОИ ЭЛЕМЕНТЫ ============ */
/* Навигация по комментариям. Родная (.b-comments_navigation) после первого
   нажатия перехватывала тапы по всей странице, поэтому скрыта. */
.b-comments_navigation, #js-comments_navigation { display: none !important; }

#lm-nav {
  position: fixed !important; right: ${CFG.jumpRight}px !important;
  top: 50% !important;
  transform: translateY(-50%) !important; z-index: 30 !important;
  display: flex !important; flex-direction: column !important;
  gap: ${CFG.jumpGap}px !important;
  /* коробка тапы не ловит — иначе перекрывала бы ссылки под собой */
  pointer-events: none !important; }
#lm-nav button, #lm-theme {
  /* при долгом удержании Safari предлагал выделить символ на кнопке */
  -webkit-user-select: none !important; user-select: none !important;
  -webkit-touch-callout: none !important;
  -webkit-tap-highlight-color: transparent !important;
  touch-action: manipulation !important; }
/* Кнопка — только площадь нажатия: ни фона, ни рамки, весь вид несёт
   значок внутри. -webkit-appearance снимаем явно, иначе Safari рисует
   свою серую капсулу поверх заданного background. */
#lm-nav button {
  pointer-events: auto !important;
  width: ${CFG.jumpSize}px !important; height: ${CFG.jumpSize}px !important;
  padding: 0 !important; margin: 0 !important;
  -webkit-appearance: none !important; appearance: none !important;
  background: none !important; border: 0 !important;
  border-radius: 0 !important; box-shadow: none !important;
  display: block !important; cursor: pointer !important;
  opacity: 1 !important; transition: opacity .3s !important; }
#lm-nav button svg {
  display: block !important;
  width: 100% !important; height: 100% !important; }
${CFG.jumpHalo ? `#lm-nav button svg {
  filter: drop-shadow(0 0 1px rgba(255,255,255,.95))
          drop-shadow(0 0 2px rgba(255,255,255,.8)) !important; }` : ''}
/* Нижняя стрелка — та же картинка, повёрнутая, как у лепры. Поворот
   здесь безопасен: значок квадратный и стоит в квадратной кнопке,
   прыгать при вращении нечему. */
#lm-nav .lm-nav_down svg { transform: rotate(180deg) !important; }
/* Неактивная кнопка — прозрачность лепры (0.3), не серый цвет:
   перекрашивать пришлось бы каждую фигуру отдельно. */
#lm-nav button.lm-off { opacity: .3 !important; cursor: default !important; }
#lm-nav button:active:not(.lm-off) { opacity: .55 !important; }
/* одиночная кнопка «наверх»: появляется, когда отлистан хотя бы экран */
#lm-nav.lm-nav__top { opacity: 0 !important; transition: opacity .2s !important; }
#lm-nav.lm-nav__top.lm-visible { opacity: 1 !important; }

/* Увеличение картинки прямо в посте. Раньше здесь был оверлей поверх
   страницы, но он блокировал прокрутку через overflow:hidden на body —
   на iOS это теряет позицию прокрутки и после закрытия выбрасывает
   наверх, а кнопка закрытия попадала в зону логотипа. */
img.lm-zoomed {
  width: 100% !important; max-width: 100% !important;
  height: auto !important; cursor: zoom-out !important; }

/* ---- Навигационная штука ----
   Серую черту под шапкой заменяет строка-переключатель: свёрнутая, она и
   есть разделитель, развёрнутая — отдаёт то, что на десктопе лежит в левой
   колонке главной. Устройство то же, что у простого пенсне подлепр, но
   подпись стоит по центру: этот блок не принадлежит ленте под ним, он
   разделяет шапку и ленту.
   Черту у шапки снимаем классом на html, а не безусловным правилом: если
   блок построить не вышло, разделитель останется прежним. */
html.lm-navthing_on .l-header {
  margin-bottom: 0 !important; border-bottom: 0 !important; }

#lm-navthing { margin: 0 0 10px !important; }
/* На профиле эта отбивка и есть та серая полоса под строкой: сквозь неё
   виден фон .l-i-wrapper, а он у лепры на профиле rgb(204,204,204). К
   картинке владельца полоса отношения не имеет — потому и оставалась
   серой на профилях со своим фоном. Убираем: под строкой начинается
   обрамление профиля, а на профилях без картинки — сразу карточка. */
body.l-profile #lm-navthing { margin-bottom: 0 !important; }
.lm-navthing_row {
  display: flex !important; align-items: center !important; gap: 6px !important;
  width: 100% !important; box-sizing: border-box !important;
  margin: 0 !important; padding: ${NAV_PAD}px 8px !important;
  background: rgb(232, 230, 228) !important;
  border: 0 !important; border-radius: 0 !important;
  -webkit-appearance: none !important; appearance: none !important;
  /* Шорткат font: inherit сбрасывает кегль последним значением из
     наследования — свойства перечисляем по одному, как у пенсне. */
  font-family: inherit !important; font-weight: normal !important;
  font-size: 13px !important; line-height: 1.3 !important;
  color: rgb(70, 70, 70) !important; text-align: center !important;
  cursor: pointer !important;
  -webkit-user-select: none !important; user-select: none !important;
  -webkit-tap-highlight-color: transparent !important; }
/* Пиктограмма и шеврон одной ширины: иначе подпись между ними встаёт
   сдвинутой на разницу их размеров, а не по середине строки.
   Значок — герб «Блогов Империи», тот самый, что внутри стоял слева от
   заголовка. Гнездо работает окошком: картинка внутри увеличена так,
   чтобы её рисунок (39 из 65 пикселей ширины файла) занял гнездо
   целиком, а прозрачные поля ушли под обрезку. Проценты считаются от
   стороны гнезда, поэтому размер меняется одной настройкой navIcon.
   max-width: none обязателен — общее правило для картинок в теле
   страницы иначе прижмёт герб к ста процентам, и увеличение пропадёт.
   Если герба нет ни на странице, ни в памяти, гнездо остаётся пустым:
   место под него нужно всё равно, иначе подпись съедет вправо. */
.lm-navthing_icon, .lm-navthing_arrow {
  flex: 0 0 ${CFG.navIcon}px !important; }
.lm-navthing_icon {
  display: block !important; position: relative !important;
  width: ${CFG.navIcon}px !important; height: ${CFG.navIcon}px !important;
  overflow: hidden !important; line-height: 0 !important; }
.lm-navthing_icon img {
  display: block !important; position: absolute !important;
  left: ${CREST_CSS.x}% !important; top: ${CREST_CSS.y}% !important;
  width: ${CREST_CSS.w}% !important; height: auto !important;
  max-width: none !important; max-height: none !important;
  margin: 0 !important; }
.lm-navthing_arrow {
  font-size: 10px !important; text-align: right !important;
  color: rgb(120, 120, 120) !important; }
.lm-navthing_label {
  flex: 1 1 auto !important; min-width: 0 !important;
  text-align: center !important; }
/* Развёрнутое состояние — сменой знака, а не поворотом. Поворот идёт
   вокруг середины коробки шеврона, а знак прижат к её правому краю: на
   двадцати пикселях ширины он перепрыгивал к левому, и шеврон при каждом
   развороте уезжал на полтора сантиметра. Знак пишем содержимым
   псевдоэлемента, поэтому в разметке span пустой — как у пенсне. */
.lm-navthing_arrow::before { content: '▾' !important; }
#lm-navthing.lm-navthing__open .lm-navthing_arrow::before {
  content: '▴' !important; }

.lm-navthing_body {
  display: none !important;
  padding: 10px 8px !important;
  background: rgb(245, 244, 243) !important;
  font-size: 13px !important; line-height: 1.5 !important; }
#lm-navthing.lm-navthing__open .lm-navthing_body { display: block !important; }

/* Ссылки слева, гертруда справа: картинка узкая и высокая, рядом с ней
   как раз остаётся колонка под пять коротких строк. Между ними —
   растяжимая пустая середина с гвоздиком: он должен стоять посередине
   промежутка, а не липнуть к картинке. Поэтому ссылкам роста не даём
   (flex-grow 0) — иначе они забирают весь свободный ход, и центрировать
   гвоздик становится не в чем.
   Нижний предел ширины середины — под сам гвоздик: на длинных названиях
   подлепр она сжимается до него, и гвоздик просто оказывается вплотную
   к гертруде вместо середины. Это лучше, чем резать названия. */
.lm-navthing_top {
  display: flex !important; align-items: flex-start !important;
  gap: 10px !important; }
.lm-navthing_links { flex: 0 1 auto !important; min-width: 0 !important; }
.lm-navthing_mid {
  flex: 1 1 auto !important; min-width: 22px !important;
  display: flex !important; align-items: flex-start !important;
  justify-content: center !important; }
/* Блоги Империи. У лепры отбивка слева 45 пикселей — под герб, прибитый
   абсолютно в левый верхний угол, плюс ещё по 20 у заголовка и пунктов
   списка: там оставлено место под крестик «отписаться». Двадцатки убираем
   вместе с крестиком (см. ниже), а отбивку под герб — вместе с гербом:
   он теперь стоит в свёрнутой строке слева от подписи «Навигационная
   штука», и держать его копию внутри незачем. Столбик ссылок встаёт
   вплотную к левому краю блока.
   Ширина 140 и черта снизу приходят от .b-aside_item — того же элемента. */
.lm-navthing_links .b-aside_imperial_blogs {
  width: auto !important; min-height: 0 !important;
  margin: 0 !important; padding: 0 !important;
  border-bottom: 0 !important; }
/* Герб внутри прячем, а не удаляем: узел леприн, и хотя он декоративный,
   выдёргивать чужие узлы из разметки ради косметики не стоит. */
.lm-navthing_links .b-aside_imperial_blogs_bg { display: none !important; }
.lm-navthing_links .b-aside_imperial_blogs strong {
  margin-bottom: 4px !important; padding-left: 0 !important;
  font-size: 14px !important; }
.lm-navthing_links .b-aside_imperial_blogs ul { margin: 0 !important; }
.lm-navthing_links .b-aside_imperial_blogs li {
  padding-left: 0 !important; margin-bottom: 3px !important; }
.lm-navthing_links .b-aside_imperial_blogs a { font-size: 13px !important; }
/* Крестик «отписаться» лепра показывает по .b-aside_imperial_blogs
   li:hover. Я считал, что на телефоне это правило мёртвое, — оказалось
   нет: Safari после тапа по ссылке оставляет на пункте состояние hover,
   крестик выезжает и висит до следующего тапа в стороне.
   Убираем совсем, а не отодвигаем: это действие разрушающее — подлепра
   уходит из списка — и держать его под тем самым пальцем, которым только
   что открывали ссылку, не стоит. К тому же в копии, восстановленной из
   памяти на внутренних страницах, крестика нет вовсе, и список вёл бы
   себя по-разному в зависимости от страницы.
   Селектор нарочно с :hover: правило лепры весит три класса и элемент,
   ровно столько же весило бы моё без него, и спор решался бы порядком
   объявления — то есть по-разному в браузере и в проверке. */
.lm-navthing_links .b-aside_imperial_blogs li:hover .b-close_btn,
.lm-navthing_links .b-aside_imperial_blogs .b-close_btn {
  display: none !important; }
.lm-navthing_pic {
  flex: 0 0 ${CFG.gertruda}px !important;
  max-width: ${CFG.gertruda}px !important; }
/* Гертруда скрыта общим правилом выше вместе с остальной левой колонкой.
   Правило заведомо весомее скрывающего (два класса против одного) и стоит
   ниже по файлу: иначе jsdom и браузер решили бы спор по-разному.
   min-height:291px и отбивка снизу в 29 у лепры отмерены под десктопную
   колонку, где картинка стоит в вырезе фоновой подложки. */
.lm-navthing_pic .b-gertruda {
  display: block !important; position: static !important;
  min-height: 0 !important; margin: 0 !important;
  overflow: visible !important; }
.lm-navthing_pic img {
  display: block !important; width: 100% !important; height: auto !important;
  max-width: 100% !important; margin: 0 !important; }

/* Овощебаза. У лепры это блок в 213px, а подпись отбита слева на 64
   пикселя под завиток фоновой картинки колонки, которой здесь нет.
   Показываем только с непустым списком замен: пустая жёлтая плашка —
   это подпись к тому, чего нет. Класс ставится проверкой (syncVeg), а
   не безусловным правилом, потому что список приходит позже разметки. */
.lm-navthing_veg { display: none !important; margin-top: 10px !important; }
.lm-navthing_veg.lm-on { display: block !important; }
.lm-navthing_veg .b-aside_replacements {
  width: auto !important; margin: 0 !important; }
.lm-navthing_veg .b-aside_replacements_header {
  margin: 0 !important; font-size: 13px !important; }
.lm-navthing_veg .b-aside_replacements_list_items,
.lm-navthing_veg .b-aside_replacements_list_counter {
  margin-left: 0 !important; }
.lm-navthing_veg .b-aside_replacements_list_item { padding-left: 0 !important; }
.lm-navthing_veg .b-aside_replacements_list_item_rating {
  position: static !important; }

/* Гвоздик слева от герба. Кнопка своего фона не имеет: закреплено или нет,
   видно по самому значку — стоит прямо или наклонён и приглушён. Галка,
   стоявшая тут раньше, отнимала строку и звала взгляд синим пятном, а
   смотреть в этом блоке надо не на неё. */
.lm-navthing_pin {
  flex: 0 0 22px !important; align-self: flex-start !important;
  width: 22px !important; height: 22px !important;
  margin: 0 !important; padding: 0 !important;
  background: none !important; border: 0 !important;
  -webkit-appearance: none !important; appearance: none !important;
  color: rgb(90, 90, 90) !important;
  line-height: 0 !important; cursor: pointer !important;
  -webkit-tap-highlight-color: transparent !important;
  touch-action: manipulation !important; }
.lm-navthing_pin svg {
  display: block !important; margin: 3px auto 0 !important;
  transition: transform .15s !important; }
/* Откреплено: гвоздик вынут и лежит боком. */
.lm-navthing_pin:not(.lm-on) { opacity: .4 !important; }
.lm-navthing_pin:not(.lm-on) svg {
  transform: rotate(-40deg) !important; }

/* ============ ТЁМНАЯ ТЕМА ============ */
/* Инверсия с поворотом тона. Своей тёмной палитры у лепры нет, а ручная
   перекраска сотни классов рассыпалась бы на подсайтах с их стилями.
   Картинки и видео инвертируются обратно, чтобы остаться нормальными. */
html.lm-dark {
  filter: invert(1) hue-rotate(180deg) !important;
  background: #fff !important; }
html.lm-dark img, html.lm-dark video, html.lm-dark iframe,
html.lm-dark canvas, html.lm-dark embed, html.lm-dark object,
html.lm-dark .b-list_item_logo, html.lm-dark .b-userpic,
html.lm-dark [style*="background-image"] {
  filter: invert(1) hue-rotate(180deg) !important; }

/* ============ ОТЛАДОЧНАЯ ПАНЕЛЬ ============ */
#lm-debug {
  position: fixed !important; left: 0; right: 0; bottom: 0;
  max-height: 60vh; overflow: auto; z-index: 2147483647;
  padding: 8px; background: #101010; color: #6f6;
  font: 11px/1.35 monospace; white-space: pre-wrap;
  border-top: 3px solid #6f6; }
#lm-debug button { font: 13px monospace; padding: 8px 12px; margin: 0 6px 8px 0; }
`;

  function injectCss() {
    if (document.getElementById('lepra-mobile-css')) return;
    var s = document.createElement('style');
    s.id = 'lepra-mobile-css';
    s.textContent = css;
    (document.head || document.documentElement).appendChild(s);
  }

  injectCss();
  document.addEventListener('DOMContentLoaded', injectCss);

  /* ============================================================
     3. ПОЧИНКА ПЕРЕПОЛНЕНИЯ
     Отлавливает то, что не попало в правила по имени: чужие стили
     подсайтов, редкие страницы, будущие изменения вёрстки.
     ============================================================ */

  /* .plupload — невидимый слой загрузчика файлов: контейнер с opacity:0 и
     полем input внутри, у которого font-size 999px, чтобы палец попадал
     куда угодно. Он честно вылезает за экран и накладывается на область
     перетаскивания, но увидеть его нельзя, а в отчёте он занимал место
     настоящих поломок. */
  var SKIP = 'svg,path,polygon,em,i,.comment,.b-svg-icon,#lm-debug,#lm-debug *,' +
             '.plupload,.plupload *';

  function scanOverflow(rescanAll) {
    var W = document.documentElement.clientWidth, out = [];

    walk(root(), isBulk, function (el) {
      if (!rescanAll && seen.scan.has(el)) return;
      seen.scan.add(el);
      if (el.matches && el.matches(SKIP)) return;
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      if (r.left >= -2 && r.right <= W + 2) return;
      var cs = getComputedStyle(el);
      if (cs.position === 'fixed' || cs.visibility === 'hidden') return;
      out.push({ el: el, cs: cs, r: r });
    }, CFG.scanBudget);

    return out;
  }

  function fixOverflow() {
    var W = document.documentElement.clientWidth;
    scanOverflow(false).forEach(function (b) {
      var el = b.el, cs = b.cs;
      /* Окно голосов правит fitVotesPopup — по замеру и сдвигом. Общий
         починщик поставил бы ему max-width:100% от .b-user_karma, а это
         полсотни пикселей: окно сплющилось бы в столбик. В отчёт оно
         при этом попадает как обычно — регрессию видно будет. */
      if (el.closest && el.closest('.b-votes_popup')) return;
      el.style.setProperty('max-width', '100%', 'important');
      el.style.setProperty('box-sizing', 'border-box', 'important');
      if (parseFloat(cs.paddingRight) > 40)
        el.style.setProperty('padding-right', '8px', 'important');
      if (parseFloat(cs.paddingLeft) > 40)
        el.style.setProperty('padding-left', '8px', 'important');
      if (parseFloat(cs.marginLeft) < 0)
        el.style.setProperty('margin-left', '0', 'important');
      if (parseFloat(cs.marginRight) < 0)
        el.style.setProperty('margin-right', '0', 'important');
      if (cs.position === 'absolute' && b.r.left < -2)
        el.style.setProperty('left', '0', 'important');
      /* Элементы, которым ширину задал сам скрипт (поле поиска, поля
         выбора в панели фильтров), не трогаем: иначе этот проход
         возвращал бы им исходную длину. */
      if (b.r.width > W && !el.dataset.lmWidth)
        el.style.setProperty('width', 'auto', 'important');
    });
  }

  /* Широкие плавающие колонки. У подсайтов свои таблицы стилей со своими
     !important, поэтому правим инлайном — его из CSS не перебить. */
  var ASIDE_SEL = '.b-subdomain_aside_right, .b-subdomain_aside_subscribe, ' +
                  '.b-subdomain_aside_subscribe_additional, ' +
                  '.b-subscribe_button, .l-content_aside, .b-tags, ' +
                  /* внутри свёрнутого пенсне ширина нулевая, и мерить
                     описание бесполезно — снимаем обтекание безусловно */
                  '.b-domain_description';

  function unfloatWide() {
    var W = document.documentElement.clientWidth;
    /* Пока раскладки нет, ширина всех элементов нулевая, а ноль проходит
       проверку «меньше 40% экрана» ровно наоборот — сравнение с нулевым
       порогом истинно, и обтекание снималось со всего подряд, включая
       узкие блоки, которым оно нужно. Мерить до раскладки нечего. */
    if (!W) return;
    var host = root();

    var force = function (el) {
      el.style.setProperty('float', 'none', 'important');
      el.style.setProperty('width', 'auto', 'important');
      el.style.setProperty('max-width', '100%', 'important');
      el.style.setProperty('margin-left', '0', 'important');
      el.style.setProperty('margin-right', '0', 'important');
    };

    host.querySelectorAll(ASIDE_SEL).forEach(function (el) {
      if (seen.unfloat.has(el)) return;
      seen.unfloat.add(el);
      force(el);
    });

    /* Любая чужая колонка шире 40% экрана. Внутрь комментариев не заходим
       и каждый просмотренный элемент помечаем: иначе следующий проход
       заново считает стили всего документа. */
    walk(host, isBulk, function (el) {
      if (seen.unfloat.has(el)) return;
      if (!/^(DIV|ASIDE|SECTION|UL)$/.test(el.tagName)) return;
      seen.unfloat.add(el);
      var cs = getComputedStyle(el);
      if (cs.cssFloat === 'none') return;
      if (el.getBoundingClientRect().width < W * 0.4) return;
      force(el);
    }, CFG.scanBudget);
  }

  /* Заметка в профиле: inline-block с flex-grow внутри флекса получал
     нулевую ширину и переносился по одной букве. Кто именно режет ширину,
     из CSS не видно, поэтому правим инлайном по цепочке предков.
     Заодно снимаем боковые отступы: ширину они не задают, но сдвигают
     текст к середине экрана. */

  /* Пустую заметку лепра заполняет подсказкой «Место для заметок. Заметки
     могут быть видны всем гражданам.» — на телефоне это четыре строки ради
     одной мысли. Оставляем первое предложение.
     Полный текст возвращаем на место при первом же касании: лепра узнаёт
     подсказку по совпадению строки и очищает поле перед вводом. Не вернём —
     сокращённая фраза уедет в заметку как её содержимое. */
  var NOTE_HINT = 'Место для заметок';
  var NOTE_HINT_RE = /^Место для заметок\.\s*Заметки могут быть видны/i;

  function noteEl() { return document.querySelector('#js-usernote, .b-user_note'); }

  function noteText(el) {
    return (el.textContent || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function shortenNoteHint(el) {
    if (!el || !NOTE_HINT_RE.test(noteText(el))) return;   /* своя заметка — не трогаем */
    el.dataset.lmHint = el.textContent;                    /* исходная строка, до буквы */
    el.textContent = NOTE_HINT;
  }

  function restoreNoteHint(el) {
    if (!el || !el.dataset.lmHint) return;
    if (noteText(el) !== NOTE_HINT) return;                /* человек уже что-то ввёл */
    el.textContent = el.dataset.lmHint;
  }

  /* Возврат полного текста по касанию оставлял его на месте навсегда, если
     ввод так и не открылся: focusout не приходит, потому что фокуса не
     было. Через секунду проверяем, редактирует ли человек заметку, и если
     нет — сокращаем обратно. */
  function noteEditing(el) {
    if (!el) return false;
    if (el.classList.contains('active')) return true;
    if (el.querySelector('input, textarea')) return true;
    return !!(document.activeElement && el.contains(document.activeElement));
  }

  function maybeShortenNote() {
    var el = noteEl();
    if (el && !noteEditing(el)) shortenNoteHint(el);
  }

  var noteTimer = null;

  function scheduleNoteRecheck(ms) {
    clearTimeout(noteTimer);
    noteTimer = setTimeout(maybeShortenNote, ms || 900);
  }

  function fixUserNote() {
    var note_ = noteEl();
    if (!note_) return;

    shortenNoteHint(note_);

    if (!note_.dataset.lmNote) {
      note_.dataset.lmNote = '1';
      /* слушаем на погружении: обработчик лепры висит на самой заметке,
         и к моменту его вызова полный текст должен быть на месте */
      ['pointerdown', 'touchstart', 'mousedown', 'focusin'].forEach(function (ev) {
        document.addEventListener(ev, function (e) {
          var el = noteEl();
          if (el && e.target && (e.target === el || el.contains(e.target))) {
            restoreNoteHint(el);
            scheduleNoteRecheck(900);
          }
        }, true);
      });
      /* ушли из поля — лепра вернула подсказку целиком, сокращаем снова */
      document.addEventListener('focusout', function () {
        scheduleNoteRecheck(300);
      }, true);
    }

    var el = note_, steps = 0;
    while (el && steps < 6) {
      if (el === document.body ||
          el.classList.contains('l-i-wrapper') ||
          el.classList.contains('b-user_block')) break;
      /* h2 оставляем флексом: в нём имя и голосовалка стоят рядом,
         а display:block свёл бы их в две строки */
      if (el.tagName !== 'H2')
        el.style.setProperty('display', 'block', 'important');
      el.style.setProperty('position', 'static', 'important');
      el.style.setProperty('float', 'none', 'important');
      el.style.setProperty('width', 'auto', 'important');
      el.style.setProperty('max-width', 'none', 'important');
      el.style.setProperty('min-width', '0', 'important');
      el.style.setProperty('box-sizing', 'border-box', 'important');
      el.style.setProperty('margin-left', '0', 'important');
      el.style.setProperty('margin-right', '0', 'important');
      el.style.setProperty('padding-left', '0', 'important');
      el.style.setProperty('padding-right', '0', 'important');
      el = el.parentElement;
      steps++;
    }
  }

  /* Прохода, который искал серую полосу по признакам, здесь больше нет.
     Он был написан вслепую, пока не было таблицы стилей лепры, и находил
     не то: под определение «широкий узел без текста» попал сам аватар
     (285×285) и слой загрузчика поверх него — картинка пропадала со
     страницы. Причина полосы оказалась в одном правиле CSS
     (.b-user_block: padding-top 46px и серая заливка), и закрыта там же. */

  /* Голосовалка кармы у лепры прибита абсолютно к правому верхнему углу
     карточки (top:47px right:35px), под неё же в h2 оставлено 195px поля.
     В одну колонку она вставала отдельной строкой под датой регистрации.
     Переносим её в строку с именем — там она и стояла на десктопе. */
  function moveKarmaToName() {
    var h2 = document.querySelector('.b-i-user_data h2, .b-user_data h2');
    var karma = document.querySelector('.b-user_votes_wrapper');
    if (!h2 || !karma || karma.parentElement === h2) return;
    var name = h2.querySelector('.b-user_name-link');
    if (name && name.nextSibling) h2.insertBefore(karma, name.nextSibling);
    else h2.appendChild(karma);
  }

  /* Окно со списком проголосовавших.

     Лепра создаёт его по тапу и ставит абсолютно: right:50% от голосовалки
     плюс сдвиг вправо на 192px. На десктопе голосовалка в середине широкой
     карточки, и окно ложится под неё. На телефоне голосовалка прижата
     к правому краю строки с именем — окно уезжает за экран, документ
     становится шире окна, и страница перемасштабируется.

     Ширину ограничивает CSS, здесь остаётся горизонтальный сдвиг. Двигаем
     именно сдвигом (transform), а не координатами и полями, по двум
     причинам. Первая: лепра сама меряет окно, чтобы решить, показать его
     сверху или снизу (класс js-bottom), а transform не меняет ни
     offsetLeft, ни offsetWidth — её замеры остаются верными. Вторая:
     менять left/right пришлось бы наперегонки с её же расстановкой.

     Перед замером прошлый сдвиг снимаем: иначе на втором проходе мерилось
     бы уже сдвинутое окно и оно уползало бы дальше с каждым разом. */

  var POPUP_GAP = 6;          /* зазор от края экрана */
  var POPUP_ARROW_EDGE = 8;   /* насколько близко хвостик пускаем к углу */

  /* К чему окно относится. Для кармы берём сам счётчик: попадание хвостика
     в него виднее всего. Для голосовалок постов и комментариев — предок,
     от которого лепра его и позиционировала. */
  function popupAnchor(p) {
    if (p.classList.contains('b-votes_popup_karma'))
      return document.querySelector('.b-user_karma .b-karma_value') ||
             document.querySelector('.b-user_karma');
    return p.offsetParent || p.parentElement;
  }

  /* ============================================================
     СЛОИ ПОВЕРХ СТРАНИЦЫ
     ============================================================ */

  /* Модальные окна лепры — подтверждение пароля при покупке, диалоги
     подтверждения — размечает и позиционирует её собственный скрипт уже
     после нажатия: ширина и координаты приходят инлайном в пикселях,
     посчитанные от ширины документа. На телефоне документ шире экрана,
     и окно уезжает вправо вместе с кнопкой закрытия — а закрыть его
     больше нечем, потому что страница под ним обесточена.

     Разбирать конкретный класс нечем: скрипта лепры в сохранённой
     странице нет, а разметки до нажатия не существует. Поэтому правим
     не по имени, а по признаку — всплывший поверх страницы блок, что
     шире экрана или начинается за его краем. Это заодно закрывает все
     прочие окна лепры, до которых мы ещё не добрались. */

  function isOverlay(el) {
    var cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
    var z = parseInt(cs.zIndex, 10);
    return z >= 100;                       /* ниже сотни — не окна, а мелочь */
  }

  /* Слои ищем по всему документу, а не среди прямых потомков body.
     Первая попытка смотрела только их, и модальное окно не нашлось:
     лепра вставляет его в глубину разметки, а не рядом с ней. Обход
     идёт тем же walk с отсечением комментариев и постов — иначе на
     длинном треде это сотня тысяч замеров стиля. */
  function eachLayer(visit, budget) {
    if (!document.body) return;
    walk(document.body, isBulk, function (el) {
      if (/^lm-/.test(el.id || '')) return;
      if (!isOverlay(el)) return;
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      visit(el, r);
    }, budget || CFG.scanBudget);
  }

  function squeezeOverlay(el, W) {
    var r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    if (r.width <= W && r.left >= -1 && r.right <= W + 1) return false;

    el.style.setProperty('max-width', '100vw', 'important');
    el.style.setProperty('box-sizing', 'border-box', 'important');
    el.style.setProperty('left', '0', 'important');
    el.style.setProperty('margin-left', '0', 'important');
    el.style.setProperty('margin-right', '0', 'important');
    /* Ширину в пикселях лепра пишет инлайном — снимаем её же способом. */
    if (el.style.width) el.style.setProperty('width', 'auto', 'important');
    return true;
  }

  function fitOverlays() {
    var W = document.documentElement.clientWidth;
    if (!W) return;
    eachLayer(function (el) { squeezeOverlay(el, W); });
  }

  function fitVotesPopup() {
    var W = document.documentElement.clientWidth;

    sliceOf(document.querySelectorAll('.b-votes_popup')).forEach(function (p) {
      p.style.removeProperty('transform');
      /* .invisible — служебное состояние лепры: окно отнесено на -10000px,
         чтобы измерить его невидимым. Мерить его бессмысленно. */
      if (p.classList.contains('invisible')) return;

      var r = p.getBoundingClientRect();
      if (!r.width || !r.height) return;

      var dx = 0;
      if (r.right > W - POPUP_GAP) dx = (W - POPUP_GAP) - r.right;
      if (r.left + dx < POPUP_GAP) dx = POPUP_GAP - r.left;
      if (dx)
        p.style.setProperty('transform',
                            'translateX(' + Math.round(dx) + 'px)', 'important');

      /* Хвостик пузыря лепра ставит числом от правого края окна (121px для
         кармы, 24px для поста). После сдвига он показывал бы в пустоту,
         поэтому наводим его на голосовалку по замеру, а не по числу.
         Обоим хвостикам, верхнему и нижнему: какой из них показать,
         лепра решает классом js-bottom, и это её дело. */
      var a = popupAnchor(p);
      if (!a) return;
      var ar = a.getBoundingClientRect();
      if (!ar.width) return;

      var left = r.left + dx;
      sliceOf(p.querySelectorAll('.b-votes_popup_arrow')).forEach(function (t) {
        var tw = t.getBoundingClientRect().width || 28;
        var x = ar.left + ar.width / 2 - left - tw / 2;
        x = Math.max(POPUP_ARROW_EDGE,
                     Math.min(r.width - tw - POPUP_ARROW_EDGE, x));
        t.style.setProperty('left', Math.round(x) + 'px', 'important');
        t.style.setProperty('right', 'auto', 'important');
      });
    });
  }

  /* Когда мерить. Окно появляется по тапу, а список голосовавших приходит
     ответом сервера уже после — от одного замера толку мало. Отдельный
     наблюдатель за всем документом ради этого не нужен: тап и так проходит
     через document, и по нему заводим короткую серию проверок. Слушатель
     на перехвате, чтобы обработчик лепры не успел его отменить. */
  var popupWatched = false;

  function watchVotesPopup() {
    if (popupWatched || !document.body) return;
    popupWatched = true;
    var run = guard('fitVotesPopup', fitVotesPopup);
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      if (!t.closest('.b-karma_value, .vote, .b-votes_popup')) return;
      [0, 60, 200, 500, 1200].forEach(function (ms) { setTimeout(run, ms); });
    }, true);
  }

  /* «Гражданин Лепрозория до 3 Сентября 2027» — строка на две строки
     экрана, из которых половина уходит на слова, известные и без того.
     Оставляем «Гражданство до 03.09.27», полную дату кладём в подсказку.
     Узел даты забираем ДО того, как переписать заголовок: textContent
     сносит всех детей, и потом вставлять было бы уже нечего. */
  function compactCitizen() {
    var box = document.querySelector('.b-user_citizen');
    if (!box || box.dataset.lmCitizen) return;
    var h3 = box.querySelector('h3');
    if (!h3) return;
    box.dataset.lmCitizen = '1';

    var date = h3.querySelector('.js-date');
    if (!date) { h3.textContent = 'Гражданство'; return; }

    var full = (date.textContent || '').trim();
    var epoch = parseInt(date.getAttribute('data-epoch_date'), 10);
    if (epoch) {
      var d = new Date(epoch * 1000);
      if (!isNaN(d.getTime())) {
        date.title = full;
        date.textContent = pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) +
                           '.' + String(d.getFullYear()).slice(2);
      }
    }
    h3.textContent = 'Гражданство до ';
    h3.appendChild(date);
  }

  /* Пенсне и жёлтое поле должны стоять в одной строке, как на десктопе,
     а переключатели — выше. Одним флексом с переносом это не выражается:
     строки набираются жадно, и порядок узлов у лепры другой. Поэтому
     собираем пенсне и список в свою строку-обёртку.
     Обработчик разворота вешает скрипт лепры прямо на узел пенсне —
     перенос узла его сохраняет, слушатели переезжают вместе с элементом. */
  function groupNotesRow() {
    var box = document.querySelector('.b-user_public_notes');
    if (!box) return;
    var logo = box.querySelector('.b-user_public_notes_logo');
    var list = box.querySelector('.b-user_public_notes_list');
    if (!logo || !list) return;

    /* Чекбокс и сортировка — в общую обёртку. Порознь они набираются в
       строки жадно: «показать авторов» (128) и чекбокс (152) влезали в
       одну строку, а сортировке (138) места уже не оставалось, и она
       уходила третьей строкой к левому краю. Вместе они переносятся и
       прижимаются вправо одной парой. */
    var sw = box.querySelector('.b-user_public_notes_switcher');
    var sort = box.querySelector('.b-user_public_notes_sorting');
    if (sw && sort && !(sw.parentElement &&
        sw.parentElement.classList.contains('lm-notes-controls'))) {
      var ctl = document.createElement('div');
      ctl.className = 'lm-notes-controls';
      box.insertBefore(ctl, sw);
      ctl.appendChild(sw);
      ctl.appendChild(sort);
    }

    if (logo.parentElement && logo.parentElement.classList.contains('lm-notes-row')) return;

    var row = document.createElement('div');
    row.className = 'lm-notes-row';
    box.appendChild(row);
    row.appendChild(logo);
    row.appendChild(list);
  }

  /* ============================================================
     СПИСОК ГРАЖДАН (/users/)
     ============================================================ */

  /* Имя и город сведены в одну строку правилами, но разделитель между
     ними в CSS не выразить: поле имени у лепры может быть пустым, и
     ::before на городе дал бы строку, начинающуюся с точки. Ставим метку
     только там, где слева от неё действительно что-то есть.

     Заодно снимаем подложку-кнопку со свёрнутого описания, если лепра
     положила внутрь содержимое, не тронув класс __empty: раскрытый текст
     оказался бы в блоке нулевой высоты поверх карточки. Проверка идёт по
     элементам-потомкам — пустое описание у лепры содержит один перевод
     строки, и :empty на нём не срабатывает. */
  /* Квадратик и его подпись сводим в один узел: порознь они идут по
     строке двумя пунктами, и подпись отрывается от чекбокса на переносе.
     Между ними у лепры лежит перевод строки — его убираем, иначе он
     останется висеть лишним пробелом внутри пары. */
  function wrapCheckbox(inp) {
    if (!inp || !inp.id || !inp.parentNode) return null;
    if (inp.parentNode.classList.contains('lm-chk')) return inp.parentNode;
    var lab = inp.parentNode.querySelector('label[for="' + inp.id + '"]');
    if (!lab || lab.parentNode !== inp.parentNode) return null;

    var pair = document.createElement('span');
    pair.className = 'lm-chk';
    inp.parentNode.insertBefore(pair, inp);
    pair.appendChild(inp);
    var n = pair.nextSibling;
    while (n && n !== lab) {
      var next = n.nextSibling;
      if (n.nodeType === 3 && !n.nodeValue.trim()) n.parentNode.removeChild(n);
      n = next;
    }
    pair.appendChild(lab);
    return pair;
  }

  /* Общий кусок подписи выносим в начало строки: «был президентом, был
     министром, был пресс-секретарём» — три лишних слова на строку,
     в которую и без них едва помещаются три чекбокса. Полный текст
     остаётся в подсказке. */
  function stripPrefix(el, re) {
    var t = (el.textContent || '').replace(/\u00a0/g, ' ').trim();
    var m = t.match(re);
    if (!m) return false;
    if (!el.title) el.title = t;
    el.textContent = m[1];
    return true;
  }

  function fixUsersList() {
    var box = document.querySelector('.b-users_list_users');
    if (!box) return;

    sliceOf(box.querySelectorAll('.b-list_item_user_residence')).forEach(function (r) {
      if (seen.userRow.has(r)) return;
      seen.userRow.add(r);
      var body = r.parentNode;
      var name = body && body.querySelector('.b-list_item_user_name');
      var has = function (el) {
        return !!el && (el.textContent || '').replace(/\u00a0/g, ' ').trim() !== '';
      };
      if (has(name) && has(r)) r.classList.add('lm-after_name');
    });

    sliceOf(box.querySelectorAll('.b-list_item_user_description__empty'))
      .forEach(function (d) {
        if (d.children.length) d.classList.add('lm-open');
        else d.classList.remove('lm-open');
      });
  }

  /* Строка первая: «искать среди заметок» с полями пола и гражданства.
     Чекбокс лежит у лепры в своём блоке над полями — переносим блок
     целиком, вместе со скрытым пунктом «мои заметки» и обработчиком,
     который его открывает. Сам блок из раскладки убран правилом
     display: contents, поэтому в строку встают его дети. */
  function buildUsersRows() {
    var filters = document.querySelector('.b-users_list_filters');
    if (!filters) return;

    var notes = document.getElementById('js-users_search_user_notes');
    if (notes) {
      var flags = notes.closest('.b-users_list_flags');
      if (flags && flags.parentNode !== filters)
        filters.insertBefore(flags, filters.firstChild);
      wrapCheckbox(notes);
      wrapCheckbox(document.getElementById('js-users_search_my_notes'));
    }

    /* Строка вторая: «Был» и три чекбокса. Берём соседа строки полей —
       по классу его от перенесённого блока заметок не отличить. */
    var was = filters.nextElementSibling;
    if (was && was.classList.contains('b-users_list_flags') && !was.dataset.lmWas) {
      was.dataset.lmWas = '1';
      var pre = '';
      sliceOf(was.querySelectorAll('input[type="checkbox"]')).forEach(function (inp) {
        var pair = wrapCheckbox(inp);
        var lab = pair && pair.querySelector('label');
        if (!lab) return;
        var t = (lab.textContent || '').replace(/\u00a0/g, ' ').trim();
        if (stripPrefix(lab, /^(?:был)\s+(.+)$/i)) pre = 'Был';
      });
      if (pre) {
        var p = document.createElement('span');
        p.className = 'lm-flag_prefix';
        p.textContent = pre;
        was.insertBefore(p, was.firstChild);
      }
    }

    /* Строка третья: сортировка. Слово «Сортировать:» лежит голым
       текстовым узлом — заворачиваем, иначе оно не станет пунктом
       флекс-строки и мерить в подгонке будет нечего. */
    var sort = document.querySelector('.b-users_list_sorting');
    if (sort && !sort.dataset.lmSort) {
      sort.dataset.lmSort = '1';
      sliceOf(sort.childNodes).forEach(function (n) {
        if (n.nodeType === 3 && n.nodeValue.trim()) sort.removeChild(n);
      });
      var sp = document.createElement('span');
      sp.className = 'lm-sort_prefix';
      sp.title = 'Сортировать по';
      sp.textContent = 'Сортировать по';
      sort.insertBefore(sp, sort.firstChild);
    }
    if (sort) {
      sliceOf(sort.querySelectorAll('li a, li strong')).forEach(function (a) {
        if (a.dataset.lmSort) return;
        a.dataset.lmSort = '1';
        stripPrefix(a, /^по\s+(.+)$/i);
      });
    }
  }

  /* ---- Подгонка строк настроек в одну линию ----
     Считать заранее нечего: доступная ширина зависит от масштаба
     страницы, который скрипту не виден, а ширина полей — от выбранных
     пунктов. Меряем по факту и ужимаем ступенями, каждый раз начиная
     от исходного кегля: иначе на повороте экрана строка осталась бы
     мелкой, хотя места стало больше. */
  var ROW_UNITS = '.lm-chk, .lm-flag_prefix, .lm-sort_prefix, select, li';
  var ROW_STEPS = [1, 0.92, 0.85, 0.78];

  /* Пункты строки разной высоты, и по верхнему краю их не сравнить:
     при выравнивании по центру поле выбора выше подписи, а тапом
     это не отличить от переноса. Сравниваем середины. */
  function sameLine(list) {
    var mid = [], i, r;
    for (i = 0; i < list.length; i++) {
      r = list[i].getBoundingClientRect();
      if (!r.width || !r.height) continue;   /* скрытые пункты не в счёт */
      mid.push(r.top + r.height / 2);
    }
    if (mid.length < 2) return true;
    return Math.max.apply(null, mid) - Math.min.apply(null, mid) <= 4;
  }

  /* Последние ступени для строки сортировки. Одним кеглем её не спасти:
     «Сортировать по» занимает столько же, сколько два варианта вместе,
     а «комментариям» — самое длинное слово в ряду. Убираем по одному и
     только когда кегль уже дошёл до предпоследней ступени. Полный текст
     держим в data-атрибуте, а не в подсказке: в подсказке лежит исходная
     подпись лепры вместе с предлогом, и вернуть из неё нечего. */
  function sortStages() {
    var sort = document.querySelector('.b-users_list_sorting');
    if (!sort) return [];
    return [
      [sort.querySelector('.lm-sort_prefix'), 'по'],
      [sort.querySelector('li[data-sorting="comments_count"] a, ' +
                          'li[data-sorting="comments_count"] strong'), 'комментам']
    ];
  }

  function sortShorten(full) {
    var st = sortStages(), hit = false, i, el;
    for (i = 0; i < st.length; i++) {
      el = st[i][0];
      if (!el) continue;
      if (full) {
        if (el.dataset.lmFull && el.textContent !== el.dataset.lmFull) {
          el.textContent = el.dataset.lmFull;
          hit = true;
        }
        continue;
      }
      if (el.textContent === st[i][1]) continue;
      if (!el.dataset.lmFull) el.dataset.lmFull = el.textContent;
      el.textContent = st[i][1];
      return true;              /* по одной ступени за раз */
    }
    return hit;
  }

  function fitUsersRow(row, shorten) {
    if (!row) return;
    /* До загрузки шрифта ширины подписей другие, и мерить рано. */
    if (document.fonts && document.fonts.status !== 'loaded') return;

    var base = parseFloat(row.dataset.lmBase);
    if (!(base > 0)) {
      base = parseFloat(getComputedStyle(row).fontSize);
      if (!(base > 0)) return;
      row.dataset.lmBase = base;
    }
    if (shorten) shorten(true);

    for (var i = 0; i < ROW_STEPS.length; i++) {
      row.style.setProperty('font-size',
                            (base * ROW_STEPS[i]).toFixed(1) + 'px', 'important');
      fitSelects();
      if (sameLine(sliceOf(row.querySelectorAll(ROW_UNITS)))) return;
      /* Сокращение подписи — только с третьей ступени кегля: убавить
         кегль на восьмую долю заметно меньше, чем урезать слово.
         По одной подписи на ступень, самая безобидная первой. */
      if (i >= 2 && shorten && shorten(false) &&
          sameLine(sliceOf(row.querySelectorAll(ROW_UNITS)))) return;
    }
    /* Дальше ужимать нечем: перенос честнее нечитаемого кегля. */
  }

  function fitUsersRows() {
    var filters = document.querySelector('.b-users_list_filters');
    if (!filters) return;
    fitUsersRow(filters, null);
    var was = filters.nextElementSibling;
    if (was && was.classList.contains('b-users_list_flags')) fitUsersRow(was, null);
    fitUsersRow(document.querySelector('.b-users_list_sorting'), sortShorten);
  }

  /* ---- Сворачивание карточки ----
     У лепры обработчик только на разворот: раскрытая карточка обратно
     не закрывается ничем. Свой переключатель ведём своим классом.
     Слушаем в фазе перехвата и гасим событие там же: обработчик лепры
     висит на самом блоке описания, то есть в фазе всплытия сработал бы
     раньше нашего и развернул карточку тем же нажатием. */
  var cardTapBound = false;

  function watchUserCards() {
    if (cardTapBound || !document.querySelector('.b-users_list_users')) return;
    cardTapBound = true;
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var d = t.closest('.b-list_item_user_description');
      if (!d || !d.closest('.b-users_list_users')) return;
      if (t.closest('a')) return;
      /* Пока лепра не положила внутрь содержимое, сворачивать нечего —
         первое нажатие должно дойти до её обработчика. */
      if (!d.children.length) return;
      d.classList.toggle('lm-collapsed');
      e.stopPropagation();
      e.preventDefault();
    }, true);
  }


  /* ============================================================
     ПОДСАЙТЫ: ПРОСТОЕ ПЕНСНЕ
     ============================================================ */

  /* Правая колонка подлепры (.b-subdomain_aside_right) — кнопка подписки,
     настройки уведомлений, облако тегов и вольный текст правления со
     ссылками. На десктопе это столбец сбоку от ленты; развёрнутый в одну
     колонку, он у иных подлепр занимает два экрана до первого поста.
     Складываем его целиком под одну строку — «простое пенсне», по образцу
     волшебного пенсне в профиле.

     Порог постов сюда не попадает: relayoutHeader уносит его в шапку
     раньше, поэтому пенсне собирается ПОСЛЕ перестройки шапки. */

  var PINCE_KEY = 'lm-pince';

  /* Стёкла рисуем разметкой, а не картинкой: pincenez_logo.png лежит на
     основном домене, а подлепра — это отдельный поддомен, и за него
     пришлось бы ходить запросом. Заодно значок красится вместе с текстом
     и переворачивается тёмной темой сам, без исключения из инверсии. */
  var PINCE_SVG =
    '<svg class="lm-pince_glass" viewBox="0 0 46 20" width="30" height="13" ' +
    'aria-hidden="true" focusable="false">' +
    '<g fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round"><circle cx="12" cy="11" r="7"/>' +
    '<circle cx="32" cy="11" r="7"/><path d="M19 11h6"/>' +
    '<path d="M5 8C3 4 1 3 1 3"/><path d="M39 8c4-1 6 4 3 7"/></g></svg>';

  function pinceOpen() {
    try { return localStorage.getItem(PINCE_KEY) === '1'; } catch (e) { return false; }
  }

  function buildSubsitePince() {
    var aside = document.querySelector('.b-subdomain_aside_right');
    if (!aside || aside.dataset.lmPince) return;
    /* Пустая колонка встречается: у молодой подлепры нет ни описания,
       ни тегов, и тогда строка-переключатель нечего разворачивать. */
    if (!aside.textContent.replace(/\s/g, '')) return;
    aside.dataset.lmPince = '1';

    var body = document.createElement('div');
    body.className = 'lm-pince_body';
    while (aside.firstChild) body.appendChild(aside.firstChild);

    /* Левая колонка подсайта скрыта общим правилом — переносим её в
       конец тела: описание подлепры важнее её управляющего, а внизу
       текст колонки читается продолжением, а не врезкой. */
    var left = document.querySelector('.l-content_aside_subsite');
    if (left) body.appendChild(left);

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lm-pince';
    btn.innerHTML = PINCE_SVG +
      '<span class="lm-pince_label">Простое пенсне</span>' +
      /* знак шеврона — в CSS: он меняется по состоянию */
      '<span class="lm-pince_arrow"></span>';

    aside.appendChild(btn);
    aside.appendChild(body);

    var open = pinceOpen();
    aside.classList.toggle('lm-pince__open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      var on = !aside.classList.contains('lm-pince__open');
      aside.classList.toggle('lm-pince__open', on);
      btn.setAttribute('aria-expanded', on ? 'true' : 'false');
      try { localStorage.setItem(PINCE_KEY, on ? '1' : '0'); } catch (err) {}
    });
  }


  /* ---- Звания (/fraud/ranks/) ----
     Две вещи, которые одним CSS не делаются.

     Первая — блок объяснения аукциона: четыре абзаца перед таблицей,
     на телефоне это целый экран до первого звания. Сворачиваем его в
     строку с уголком; состояние помним, как у пенсне.

     Вторая — подсказка в поле новой должности. Поле уехало отдельной
     строкой, и подпись «Добавить должность:» осталась выше; без
     подсказки внутри непонятно, чем это поле отличается от соседнего
     поля ника. Заодно называем предел длины: он написан только в
     свёрнутом объяснении. */

  var ABOUT_KEY = 'lm-ranks-about';

  function aboutOpen() {
    try {
      var v = localStorage.getItem(ABOUT_KEY);
      if (v === '1') return true;
      if (v === '0') return false;
    } catch (e) {}
    return !!CFG.ranksAbout;
  }

  function fixRanks() {
    var about = document.querySelector('.b-ranks_about');
    if (about && !about.dataset.lmAbout) {
      about.dataset.lmAbout = '1';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lm-ranks_about';
      btn.textContent = 'Как это устроено';
      about.parentNode.insertBefore(btn, about);

      var open = aboutOpen();
      btn.classList.toggle('lm-open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');

      btn.addEventListener('click', function (e) {
        e.preventDefault();
        var on = !btn.classList.contains('lm-open');
        btn.classList.toggle('lm-open', on);
        btn.setAttribute('aria-expanded', on ? 'true' : 'false');
        try { localStorage.setItem(ABOUT_KEY, on ? '1' : '0'); } catch (err) {}
      });
    }

    var rank = document.querySelector('.b-ranks_input_rank');
    if (rank && !rank.getAttribute('placeholder'))
      rank.setAttribute('placeholder', 'должность, до 25 знаков');
  }


  /* ---- Обрамление профиля ----
     Картинку фона лепра ставит инлайновым стилем на .b-user_block.
     Читаем именно инлайновый стиль, а не вычисленный: в вычисленном
     лежала бы и лепровская заглушка, и отличить «своя картинка» от
     «ничего» стало бы нельзя. Класс снимаем, если картинки нет, —
     владелец мог убрать её, а страница обновиться без перезагрузки. */
  function markProfileArt() {
    var block = document.querySelector('.b-user_block');
    if (!block) return;
    var img = block.style.backgroundImage;
    block.classList.toggle('lm-art', !!img && img !== 'none');
  }


  /* ---- Девиз подлепры одной строкой ----
     Выключка по центру и запрет переноса стоят в CSS, но уместить фразу
     в строку правилами нельзя: длина у девизов любая — от «Йода» до
     «Филиал дурдома. Научная секция диодов.». Кегль подбираем замером.

     Считать надо каждый раз заново, от начального значения: у Den масштаб
     страницы меняется прямо на ходу, CSS-ширина гуляет от 462 до 340, и
     подгонка, наложенная на прежнюю, ушла бы вниз ступенями и обратно
     уже не поднялась. */
  var titleWidth = 0;   /* при какой ширине экрана считали в прошлый раз */

  function fitSubsiteHeader() {
    var h = document.querySelector('.b-subsite_header');
    if (!h) return;
    var a = h.querySelector('a') || h;

    /* Вокруг надписи в разметке лежат табуляция и перевод строки. На
       выключке по левому краю они не видны, а по центру входят в замер:
       строка считается шире, чем есть, и кегль выходит мельче нужного.
       Чистим один раз — дальше текст свой. */
    if (!h.dataset.lmTitle) {
      h.dataset.lmTitle = '1';
      var txt = (a.textContent || '').replace(/\s+/g, ' ').trim();
      if (txt) a.textContent = txt;
    }

    var W = h.clientWidth;
    /* Ноль означает «мерить нечем»: страница ещё не оформлена или блок
       скрыт. Сравнение с нулём прошло бы как «влезает» при любом кегле. */
    if (!W) return;

    var base = CFG.subsiteTitle, min = CFG.subsiteTitleMin, size = base;
    h.style.setProperty('font-size', base + 'px', 'important');
    var w = a.getBoundingClientRect().width;

    if (w > W) {
      /* Первое приближение — по пропорции: ширина строки растёт вместе с
         кеглем почти линейно. «Почти» — из-за округления глифов по
         пикселям, поэтому дальше несколько шагов по полпункта вниз. */
      size = Math.max(min, Math.floor(base * (W / w) * 2) / 2);
      h.style.setProperty('font-size', size + 'px', 'important');
      for (var i = 0; i < 8 && size > min &&
                      a.getBoundingClientRect().width > W; i++) {
        size = Math.max(min, size - 0.5);
        h.style.setProperty('font-size', size + 'px', 'important');
      }
    }

    titleWidth = document.documentElement.clientWidth;
  }


  /* ============================================================
     СТРАНИЦА «МОИ ВЕЩИ»
     ============================================================ */

  /* Панель фильтров — два абзаца сплошного инлайнового потока. На узком
     экране вводная фраза занимала две строки, а подпись чекбокса
     переносилась под сам чекбокс. Фразу сокращаем, чекбокс с подписью
     заворачиваем в отдельную флекс-строку: перенос подписи тогда идёт
     по её собственному краю, а не по краю колонки. */
  /* Подписи пунктов, вариантов сортировки и ссылок подпанели рассчитаны
     на десктопную строку шириной в семьсот пикселей. На телефоне под ту
     же строку остаётся треть экрана, и каждая лишняя буква — это перенос
     на вторую строку. Длинные варианты заменяем короткими, полный текст
     уходит в подсказку. Меняется только видимая надпись: value полей
     выбора лепра шлёт на сервер, его не трогаем нигде.

     Замена по точному совпадению, а не по вхождению: в панели фильтров
     лежит вводная фраза «моих вещей», и она должна остаться как есть.
     По той же причине безопасно проходить и по текстовым узлам:
     разделители « | » ни с чем не совпадут. */
  var SHORT = [
    /* инбокс */
    [/^по\s+последним\s+комментариям$/i, 'по комментариям'],
    /* мои вещи */
    [/^только\s+новые\s+посты\s+и\s+комментарии$/i, 'только новые'],
    /* избранное */
    [/^по\s+дате\s+поста$/i,          'по посту'],
    [/^по\s+дате\s+добавления$/i,     'по добавлению'],
    [/^публиковать\s+в\s+профайле$/i, 'в профайле'],
    /* чарли: строка ссылок под вкладками */
    [/^подлепрозорий$/i,   'подлепра'],
    [/^почтовый\s+ящик$/i, 'почтовый ящик'],
    [/^игнор-лист$/i,      'игнор-лист'],
    [/^скрытые\s+посты$/i, 'скрытое']
  ];

  function shortLabel(s) {
    var t = (s || '').replace(/\u00a0/g, ' ').trim();
    for (var i = 0; i < SHORT.length; i++)
      if (SHORT[i][0].test(t)) return SHORT[i][1];
    return null;
  }

  function shortenIn(box, sel) {
    if (!box) return;
    sliceOf(box.querySelectorAll(sel)).forEach(function (el) {
      /* Только конечные узлы. Если активный пункт окажется ссылкой внутри
         strong, под выборку попадут оба, внешний обработается первым — и
         замена текста снесла бы ссылку вместе с разметкой. */
      if (el.children && el.children.length) return;
      var t = (el.textContent || '').replace(/\u00a0/g, ' ').trim();
      var s = shortLabel(t);
      if (s === null) return;
      /* Подсказку вешаем только когда есть что подсказывать: часть замен
         меняет лишь регистр, и всплывающая копия той же надписи мешает. */
      if (!el.title && s.length < t.length) el.title = t;
      el.textContent = s;
    });
  }

  /* Строка ссылок под вкладками у Чарли: «Подлепрозорий | Почтовый ящик |
     Игнор-лист | Скрытые посты». Текущий раздел лепра выводит не ссылкой,
     а тегом strong с серой подложкой — поэтому обход только по ссылкам
     сокращал три пункта из четырёх, а на открытом разделе возвращалось
     полное название. Берём и то и другое, плюс голые текстовые узлы:
     разметка активного пункта у лепры непостоянна, а точное совпадение
     не даст задеть лишнее.

     Живёт отдельно от панели фильтров: на разделах Чарли обёртки
     .b-my_posts_feed_controls может не быть вовсе, и привязка к ней
     оставила бы страницу без сокращений. */
  function shortenSubNav() {
    sliceOf(document.querySelectorAll('.b-my_posts_feed_controls_navigation'))
      .forEach(function (nav) {
        shortenIn(nav, 'a, strong, b, em, span');
        /* Активный пункт лепра иногда выводит вообще без обёртки — голым
           текстом. Тогда название и следующий за ним разделитель лежат в
           одном текстовом узле, и целиком он ни с чем не совпадёт.
           Поэтому режем узел по вертикальной черте и примеряем замену к
           каждому куску, сохраняя окружающие пробелы: без них пункты
           слиплись бы с разделителями. */
        sliceOf(nav.childNodes).forEach(function (n) {
          if (n.nodeType !== 3) return;
          var hit = false;
          var out = n.nodeValue.split('|').map(function (p) {
            var s = shortLabel(p);
            if (s === null) return p;
            hit = true;
            return p.match(/^\s*/)[0] + s + p.match(/\s*$/)[0];
          });
          if (hit) n.nodeValue = out.join('|');
        });
      });
  }

  function fixMyThings() {
    var box = document.querySelector('.b-my_posts_feed_controls');
    if (!box || box.dataset.lmMyThings) return;
    box.dataset.lmMyThings = '1';

    /* «В ваших вещах — все, к чему вы имели отношение за последние
       [месяц]» — предложение длиной в строку, хотя вся его смысловая
       нагрузка в предлоге перед полем выбора. Полный текст уходит в
       подсказку узла-обёртки ниже. */
    var period = box.querySelector('#js-my_things_period');
    if (period) {
      var t = period.previousSibling;
      while (t && t.nodeType !== 3) t = t.previousSibling;
      if (t && /отношение/.test(t.nodeValue))
        t.nodeValue = 'За ';
    }

    /* Пункты панели фильтров: сама таблица замен и обход — общие,
       см. SHORT и shortenIn выше. */
    shortenIn(box, 'option, label');

    /* Подписи «Показывать» и «Сортировать» занимали больше места, чем сами
       поля, хотя выбранное значение («все», «по дате») и так читается без
       них. Убираем только текстовые узлы с точным совпадением: вводная
       фраза «моих вещей» лежит в этой же строке и должна остаться. */
    var w = document.createTreeWalker(box, NodeFilter.SHOW_TEXT, null, false);
    var caption = [], node;
    while ((node = w.nextNode())) {
      var tag = node.parentNode && node.parentNode.nodeName;
      if (tag === 'SELECT' || tag === 'OPTION') continue;
      if (/^(показывать|сортировать)$/i.test(
            node.nodeValue.replace(/\u00a0/g, ' ').trim()))
        caption.push(node);
    }
    caption.forEach(function (n) { n.parentNode.removeChild(n); });

    /* Пункты панели — инлайновые span'ы, между ними в разметке лежат
       переводы строк. Пробел между инлайновыми элементами рисуется, и к
       заданному отступу молча прибавлялось ещё четыре-пять пикселей.
       Убираем только чисто пробельные узлы, у которых с обеих сторон
       стоит пункт панели: вводная фраза «моих вещей» так не пострадает. */
    sliceOf(box.querySelectorAll('.b-my_posts_feed_controls_item'))
      .forEach(function (it) {
        var n = it.nextSibling;
        if (!n || n.nodeType !== 3 || n.nodeValue.trim()) return;
        var after = n.nextSibling;
        while (after && after.nodeType === 3 && !after.nodeValue.trim())
          after = after.nextSibling;
        if (after && after.nodeType === 1 &&
            after.classList.contains('b-my_posts_feed_controls_item'))
          n.parentNode.removeChild(n);
      });

    /* Отступ чекбокса лепра пишет прямо в атрибут style. Правило с
       !important его перебивает, но убрать источник надёжнее: тогда
       величина интервала видна в одном месте, а не спорит в двух. */
    sliceOf(box.querySelectorAll('input[type="checkbox"][style]'))
      .forEach(function (el) {
        el.style.removeProperty('margin-left');
        if (!el.getAttribute('style')) el.removeAttribute('style');
      });

    /* Чекбокс с подписью сводим в один узел: дальше он идёт по строке
       как единое целое и подпись не отрывается от квадратика.
       Только там, где они лежат прямо в абзаце («мои вещи»). На инбоксе
       их и так держит вместе собственный span лепры, и лишняя обёртка
       там только сдвинула бы их на свои отступы. */
    var chk = box.querySelector('p > input[type="checkbox"]');
    var lab = chk && chk.id && box.querySelector('label[for="' + chk.id + '"]');
    if (chk && lab && chk.parentNode === lab.parentNode) {
      var pair = document.createElement('span');
      pair.className = 'lm-unread_row';
      chk.parentNode.insertBefore(pair, chk);
      pair.appendChild(chk);
      /* между ними лежит &nbsp; — иначе останется висеть пустой строкой */
      var n = pair.nextSibling;
      while (n && n !== lab) {
        var next = n.nextSibling;
        if (n.nodeType === 3 && !n.nodeValue.trim()) n.parentNode.removeChild(n);
        n = next;
      }
      pair.appendChild(lab);
    }

    /* «Мои вещи»: панель разбита на два абзаца — предлог с периодом в
       первом, сортировка с чекбоксом во втором. После сокращения фразы
       обе строки заняты едва наполовину, поэтому сводим их в одну.
       Предлог с полем периода заворачиваем в общий узел: иначе при
       раздаче свободного места предлог уедет к левому краю, а его поле —
       к середине строки, и связь между ними потеряется. */
    if (period && period.parentNode && period.parentNode.nodeName === 'P') {
      var p1 = period.parentNode;
      var grp = document.createElement('span');
      grp.className = 'b-my_posts_feed_controls_item';
      grp.title = 'Всё, к чему вы имели отношение за выбранный срок';
      p1.insertBefore(grp, p1.firstChild);
      var n = grp.nextSibling, done = false;
      while (n && !done) {
        var next = n.nextSibling;
        done = (n === period);
        if (n.nodeType === 3 && !n.nodeValue.trim()) p1.removeChild(n);
        else grp.appendChild(n);
        n = next;
      }

      sliceOf(box.querySelectorAll('p')).forEach(function (p) {
        if (p === p1) return;
        sliceOf(p.childNodes).forEach(function (node) {
          if (node.nodeType === 3 && !node.nodeValue.trim()) return;
          p1.appendChild(node);
        });
        p.parentNode.removeChild(p);
      });
    }

    /* Строки панели бывают двух видов, и обращаться с ними надо
       по-разному. Строка из одних полей (обе на инбоксе, вторая в «моих
       вещах») держится в одну линию и растягивается по ширине. Строка с
       вводной фразой остаётся обычным текстом: поле выбора стоит внутри
       предложения, и превращать её во флекс нельзя — фраза оторвётся от
       поля и встанет отдельным блоком.
       Признак — есть ли среди прямых потомков непробельный текст. */
    sliceOf(box.querySelectorAll('p')).forEach(function (p) {
      var bare = sliceOf(p.childNodes).some(function (n) {
        return n.nodeType === 3 && n.nodeValue.trim();
      });
      var units = p.querySelectorAll(
        'select, .lm-unread_row, .b-my_posts_feed_controls_item').length;
      if (!bare && units > 1) p.classList.add('lm-filters_row');
    });
  }


  /* Подписи вкладок рассчитаны на широкую строку. На телефоне каждая лишняя
     буква — это перенос всего ряда, поэтому две самые длинные сокращаем.
     Число приглашений подставляет сервер, поэтому вытаскиваем его из текста
     и склоняем сами. */
  function pluralRu(n, one, few, many) {
    var a = Math.abs(n) % 100, b = a % 10;
    if (a > 10 && a < 20) return many;
    if (b > 1 && b < 5) return few;
    if (b === 1) return one;
    return many;
  }

  function shortenTabs() {
    document.querySelectorAll('.b-menu_list_link').forEach(function (a) {
      if (a.dataset.lmTab) return;
      var t = (a.textContent || '').replace(/\u00a0/g, ' ').trim();
      if (/приглашени/.test(t)) {
        var m = t.match(/\d+/);
        a.dataset.lmTab = '1';
        a.textContent = m
          ? m[0] + ' ' + pluralRu(+m[0], 'инвайт', 'инвайта', 'инвайтов')
          : 'нет инвайтов';
      } else if (/личная информация/.test(t)) {
        a.dataset.lmTab = '1';
        a.textContent = 'настройки';
      } else if (/профессиональн/i.test(t)) {
        /* Самый длинный пункт меню магазина: 24 знака Verdana плюс место
           под тунца — 219 пикселей из 369, и с ним строка ломалась
           натрое. Подпись лежит текстовым узлом рядом с пустым <i>, в
           котором фоном нарисован тунец, поэтому переписываем сам
           текстовый узел: замена textContent снесла бы <i> с картинкой. */
        var host = a.querySelector('.b-charlie_item') || a;
        var tn = sliceOf(host.childNodes).filter(function (n) {
          return n.nodeType === 3 && n.textContent.trim();
        })[0];
        if (tn) {
          a.dataset.lmTab = '1';
          if (!a.title) a.title = t;
          tn.textContent = 'Проф. аккаунт';
        }
      }
    });
  }


  /* Ширину поля выбора браузер берёт по САМОМУ ДЛИННОМУ пункту списка,
     а показывает выбранный. У сортировки список меряется по «по
     комментариям», а стоит обычно «по времени» — сорок лишних пикселей
     пустоты справа от значения, и так в каждом поле. На широкой строке
     это незаметно, на телефоне из-за этого не помещался чекбокс.
     Считаем ширину по выбранному пункту. Служебную часть поля (стрелка,
     собственные поля, рамка) не угадываем: меряем копию поля вне строки,
     где на неё не действует сжатие, и вычитаем из её ширины ширину
     самого длинного текста. Остаток и есть служебная часть — точно,
     без подгонки под конкретный браузер. */
  function textWidth(probe, s) {
    probe.textContent = s;
    return probe.getBoundingClientRect().width;
  }

  function fitSelect(sel) {
    if (!sel.options || sel.options.length < 2) return;
    var cs = getComputedStyle(sel);

    var probe = document.createElement('span');
    probe.style.cssText = 'position:absolute!important;left:-9999px!important;' +
                          'top:0!important;visibility:hidden!important;' +
                          'white-space:pre!important';
    probe.style.fontFamily = cs.fontFamily;
    probe.style.fontSize = cs.fontSize;
    probe.style.fontWeight = cs.fontWeight;
    probe.style.fontStyle = cs.fontStyle;
    probe.style.letterSpacing = cs.letterSpacing;
    document.body.appendChild(probe);

    var widest = 0, cur = 0;
    for (var i = 0; i < sel.options.length; i++) {
      var t = sel.options[i].textContent || '';
      var wt = textWidth(probe, t);
      if (wt > widest) widest = wt;
      if (i === sel.selectedIndex) cur = wt;
    }
    probe.parentNode.removeChild(probe);
    if (!widest) return;

    /* Служебная часть постоянна для поля — считаем её один раз. */
    var chrome = parseFloat(sel.dataset.lmChrome);
    if (!(chrome >= 0)) {
      var copy = sel.cloneNode(true);
      copy.removeAttribute('id');
      copy.style.cssText = 'position:absolute!important;left:-9999px!important;' +
                           'top:0!important;visibility:hidden!important;' +
                           'width:auto!important;max-width:none!important;' +
                           'min-width:0!important;flex:none!important';
      document.body.appendChild(copy);
      chrome = copy.getBoundingClientRect().width - widest;
      copy.parentNode.removeChild(copy);
      if (!(chrome >= 0)) return;
      sel.dataset.lmChrome = chrome;
    }

    sel.dataset.lmWidth = '1';
    sel.style.setProperty('width', Math.ceil(cur + chrome) + 'px', 'important');
  }

  /* Вызывается на каждом полном проходе: шрифт мог догрузиться и сместить
     замеры, а выбранное значение — смениться. Считать дёшево: полей два,
     обходов списка столько же. */
  function fitSelects() {
    sliceOf(document.querySelectorAll(
        '.lm-filters_row select, .b-users_list_filters select'))
      .forEach(function (sel) {
        fitSelect(sel);
        if (sel.dataset.lmFitBound) return;
        sel.dataset.lmFitBound = '1';
        sel.addEventListener('change', function () { fitSelect(sel); });
      });
  }

  /* Строка фильтров при масштабе страницы 110% и выше перестаёт помещаться
     и переносит чекбокс на вторую строку. Считать заранее нечего: ширина
     полей зависит от выбранных пунктов, а доступная — от масштаба, который
     скрипту не виден. Поэтому меряем по факту — по вертикальной отбивке
     между первым и последним пунктом — и ужимаем ступенями, пока не сойдётся.
     Ступень применяется только если она помогла: иначе панель мельчала бы
     впустую там, где не помещается ничто. */
  function rowWrapped(row) {
    var k = row.children;
    if (k.length < 2) return false;
    return k[k.length - 1].getBoundingClientRect().top -
           k[0].getBoundingClientRect().top > 4;
  }

  function fitFiltersRow() {
    var row = document.querySelector('.b-my_posts_feed_controls p.lm-filters_row');
    if (!row) return;
    /* До загрузки шрифта ширины подписей другие, и мерить рано: строка
       могла бы «не поместиться» на ровном месте, а укороченная подпись
       обратно уже не вернётся. */
    if (document.fonts && document.fonts.status !== 'loaded') return;
    if (!rowWrapped(row)) return;

    /* Ступень первая: подпись чекбокса. Полный текст уже лежит в подсказке,
       а фильтр в этой панели ровно один — «новые» ни с чем не спутать. */
    var lab = row.querySelector('.lm-unread_row label');
    if (lab && (lab.textContent || '').trim() !== 'новые') {
      lab.textContent = 'новые';
      if (!rowWrapped(row)) return;
    }

    /* Ступень вторая: кегль всей панели. Поля выбора после этого надо
       обмерить заново — их ширину скрипт задаёт в пикселях по выбранному
       пункту, и от прежнего кегля она осталась бы великовата. */
    var box = row.closest('.b-my_posts_feed_controls');
    if (box && box.dataset.lmSmall !== '1') {
      box.dataset.lmSmall = '1';
      box.style.setProperty('font-size', '92%', 'important');
      fitSelects();
      if (!rowWrapped(row)) return;
    }

    /* Дальше ужимать нечем: перенос честнее подрезанного текста. */
  }


  /* ============================================================
     ПОДПИСИ ПОСТОВ И ВЕТОК
     ============================================================ */

  /* Кнопку сворачивания переносим внутрь подписи: там она встаёт в общую
     флекс-строку и не занимает отдельную строку под каждым комментарием. */
  function compactThreadToggles() {
    document.querySelectorAll('.b-comment_thread_collapse').forEach(function (el) {
      if (seen.toggle.has(el)) return;
      seen.toggle.add(el);
      var box = el.parentElement;
      if (!box) return;
      var footer = box.querySelector('.c_footer');
      if (footer && footer !== el.parentElement) footer.insertBefore(el, footer.firstChild);
      else if (footer) footer.insertBefore(el, footer.firstChild);
    });
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  /* Дату лепра пишет словами. «сегодня»/«вчера» оставляем как есть — коротко
     и понятно, остальное переводим в dd.mm.yy в hh.mm. */
  function shortenDate(el) {
    var txt = (el.textContent || '').trim();
    if (!txt || /сегодня|вчера/i.test(txt)) return;
    var epoch = parseInt(el.getAttribute('data-epoch_date'), 10);
    if (!epoch) return;
    var d = new Date(epoch * 1000);
    if (isNaN(d.getTime())) return;
    el.title = txt;
    el.textContent = pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' +
                     String(d.getFullYear()).slice(2) +
                     ' в ' + pad2(d.getHours()) + '.' + pad2(d.getMinutes());
  }

  /* Подпись поста занимала две широких строки. Сокращаем: домен без
     хвоста .leprosorium.ru, дата числами, длинные ссылки — значками. */
  var FOOTER_ICONS = [
    ['b-post_my_post_controls_button_in_interest',    '\u2295'],  /* в мои вещи */
    ['b-post_my_post_controls_button_out_interest',   '\u2296'],  /* из моих вещей */
    ['b-post_my_post_controls_button_in_favourites',  '\u2606'],  /* в избранное */
    ['b-post_my_post_controls_button_out_favourites', '\u2605']   /* из избранного */
  ];

  /* «129 комментариев / 2 новых» -> «129 / 2 новых».
     Если новых нет — остаётся «129 комментариев».
     Если все новые, лепра пишет «777 новых комментариев» -> «777 комментариев». */
  function compactCommentCount(ddi) {
    var total = null, fresh = null;

    sliceOf(ddi.querySelectorAll('a')).forEach(function (a) {
      var t = (a.textContent || '').trim();
      if (/^\d+\s+нов/.test(t)) fresh = a;
      else if (/^\d+\s+комментари/.test(t)) total = a;
    });

    var num = function (el) {
      var m = (el.textContent || '').match(/\d+/);
      return m ? m[0] : null;
    };

    /* Жирным выделяем непрочитанное. Лепра делает это то классом
       b-all_new_comments_link, то обёрткой <strong>, а иногда не делает
       вовсе — поэтому проставляем сами, по смыслу. */
    var bold = function (el, on) {
      el.style.setProperty('font-weight', on ? '700' : '400', 'important');
    };

    if (total && fresh) {
      var n = num(total), f = num(fresh);
      if (!n || !f) return;
      total.title = (total.textContent || '').trim();
      total.textContent = n;
      fresh.textContent = f + ' новых';
      bold(total, false);        /* всего — обычным */
      bold(fresh, true);         /* новые — жирным */
      return;
    }

    /* только «N новых комментариев» — значит новые все */
    if (fresh && !total) {
      var k = num(fresh);
      if (!k) return;
      fresh.title = (fresh.textContent || '').trim();
      fresh.textContent = k + ' комментариев';
      bold(fresh, true);         /* все непрочитаны — жирным целиком */
      return;
    }

    /* только «N комментариев» — новых нет, выделять нечего */
    if (total && !fresh) bold(total, false);
  }

  /* Значки лежат в двух обёртках .b-post_controls с разными метриками.
     Собираем их в один свой контейнер: так они становятся соседями по
     флекс-боксу и выравниваются по центру гарантированно. */
  function groupFooterIcons(ddi) {
    /* Только span: у галочки «прочитано» тот же класс b-post_controls,
       но это самостоятельная ссылка. Разбирая её как обёртку, скрипт
       вынимал из неё svg и возвращал пустой остаток — отсюда смещение. */
    var boxes = sliceOf(ddi.querySelectorAll('span.b-post_controls'));

    /* Часть значков (галочка «прочитано» и подобные) лежит не в обёртке,
       а прямо в подписи отдельными элементами со своим svg. Их тоже
       забираем, иначе они остаются со своими метриками и уезжают. */
    var loose = sliceOf(ddi.children).filter(function (el) {
      if (el.classList.contains('lm-icons')) return false;
      if (el.classList.contains('b-post_pinned_icon')) return false;   /* метка «закреплён» */
      if (el.classList.contains('b-post_comments_links')) return false;
      if (el.classList.contains('js-date')) return false;
      if (el.classList.contains('c_user')) return false;
      if (!/^(A|SPAN)$/.test(el.tagName)) return false;
      if (!el.querySelector('svg')) return false;
      return !(el.textContent || '').trim();      /* только значки без текста */
    });

    if (!boxes.length && !loose.length) return;

    var holder = document.createElement('span');
    holder.className = 'lm-icons';

    boxes.forEach(function (box) {
      sliceOf(box.children).forEach(function (child) { holder.appendChild(child); });
      if (box.parentNode) box.parentNode.removeChild(box);
    });
    loose.forEach(function (el) { holder.appendChild(el); });

    ddi.appendChild(holder);
  }

  /* Даты в подписях комментариев — тот же краткий формат, что и у постов. */
  function compactCommentDates() {
    var host = document.getElementById('js-comments');
    if (!host) return;
    host.querySelectorAll('.c_footer .js-date').forEach(function (el) {
      if (seen.footer.has(el)) return;
      seen.footer.add(el);
      shortenDate(el);
    });
  }

  function compactPostFooters() {
    document.querySelectorAll('.dd .ddi').forEach(function (ddi) {
      if (seen.footer.has(ddi)) return;
      seen.footer.add(ddi);

      var domain = ddi.querySelector('a.b-post_domain');
      if (domain) {
        var full = (domain.textContent || '').trim();
        var short = full.split('.')[0];
        if (short && short !== full) {
          domain.title = full;
          domain.textContent = short;
        }
      }

      ddi.querySelectorAll('.js-date').forEach(shortenDate);

      FOOTER_ICONS.forEach(function (pair) {
        var a = ddi.querySelector('.' + pair[0]);
        if (!a) return;
        var text = (a.textContent || '').trim();
        if (text.length < 3) return;            /* уже значок */
        a.title = text;
        a.textContent = pair[1];
      });

      compactCommentCount(ddi);
      groupFooterIcons(ddi);

      /* косая черта между «в мои вещи» и «в избранное» теперь лишняя */
      ddi.querySelectorAll('.b-post_controls').forEach(function (box) {
        sliceOf(box.childNodes).forEach(function (n) {
          if (n.nodeType === 3 && n.nodeValue.trim() === '/') n.nodeValue = ' ';
        });
      });
    });
  }

  /* ============================================================
     4. ПЕРЕСТРОЙКА ШАПКИ
     ============================================================ */

  /* Страницы, под шапкой которых лепра рисует панель вкладок: «мои вещи»,
     инбокс, избранное, настройки, социализм, приложения, инвайты.
     Опознаём по Чарли — он стоит в этой панели предпоследней вкладкой и
     больше нигде не встречается. Запасной признак — адрес: панель приходит
     вместе с разметкой, но первый проход идёт до полной загрузки, и на
     медленной сети её может ещё не быть, а класс нужен сразу, иначе шапка
     мигнёт полной. */
  function isTabsPage() {
    if (document.querySelector('.b-menu .b-menu_list_link__charlie')) return true;
    return /(^|\.)leprosorium\.ru$/i.test(location.hostname) &&
           /^\/my(\/|$)/.test(location.pathname);
  }

  function markTabsPage() {
    if (isTabsPage()) document.documentElement.classList.add('lm-tabs');
  }

  /* Класс страниц магазина. Нужен для правил, которые касаются всего
     раздела разом (кегли полей ввода), а общего контейнера у магазина
     нет: у каждой страницы своя обёртка со своим именем. */
  function markFraudPage() {
    if (/(^|\.)leprosorium\.ru$/i.test(location.hostname) &&
        /^\/fraud(\/|$)/.test(location.pathname))
      document.documentElement.classList.add('lm-fraud');
  }

  function relayoutHeader() {
    var header = document.querySelector('.l-header');
    if (!header) return;

    /* На подсайте лепра подменяет картинку логотипа на оформление подсайта,
       но адрес оставляет свой — выходит картинка подсайта со ссылкой на
       leprosorium.ru. Выбираем по классу: id="js-logo" у лепры продублирован
       на обоих логотипах, полагаться на него нельзя. */
    var host = location.hostname;
    if (/\.leprosorium\.ru$/i.test(host)) {
      var own = document.querySelector('.l-header a.b-logo:not(.b-logo_subsite)');
      if (own && !own.dataset.lmHref) {
        own.dataset.lmHref = '1';
        own.setAttribute('href', location.protocol + '//' + host + '/');
        own.setAttribute('title', 'главная ' + host.split('.')[0]);
      }
    }

    /* Маска лепры на подсайте лежит снаружи шапки, прямым потомком
       .l-header_subsite, и потому рисуется строкой ниже слева. */
    var subLogo = document.querySelector('.b-logo_subsite');
    if (subLogo && !subLogo.dataset.lmMoved) {
      subLogo.dataset.lmMoved = '1';
      subLogo.setAttribute('href', 'https://leprosorium.ru/');
      subLogo.setAttribute('title', 'главная Лепрозория');
      header.appendChild(subLogo);
    }

    /* Каждая строка шапки — самостоятельный блок. В разметке лепры они
       лежат в разных обёртках, а флекс строит строку только из соседей
       по одному родителю, поэтому переносим их прямо в .l-header. */
    var tabsPage = document.documentElement.classList.contains('lm-tabs');

    ['.b-header_nav_new_post', '.b-header_counters',
     '.b-index_slider', '.b-header_search'].forEach(function (sel) {
      /* На страницах с вкладками поиск отдельной строкой не нужен — он
         уходит в конец строки ссылок шагом ниже. */
      if (tabsPage && sel === '.b-header_search') return;
      var el = document.querySelector(sel);
      if (el && !el.dataset.lmMoved && el.parentElement !== header) {
        el.dataset.lmMoved = '1';
        header.appendChild(el);
      }
    });

    /* Сжатая шапка: из строки ссылок ушли «Магазин», «Избранное» и
       приглашение написать пост, место освободилось — ставим туда поиск.
       Метку lmMoved выставляем той же, чтобы обход выше не утащил его
       обратно в .l-header на следующем проходе. */
    if (tabsPage) {
      var navBox = header.querySelector('.b-header_nav');
      var srch = document.querySelector('.b-header_search');
      if (navBox && srch && srch.parentElement !== navBox) {
        srch.dataset.lmMoved = '1';
        navBox.appendChild(srch);
      }
    }

    var th = document.querySelector('.b-posts_threshold');
    if (th && !th.dataset.lmMoved && !header.contains(th)) {
      th.dataset.lmMoved = '1';
      header.appendChild(th);
    }

    /* Длина поля поиска задана не разметкой, а атрибутом size, то есть
       числом знаков — в пикселях её из CSS не убавить, не зная шрифта.
       Поэтому меряем готовое поле и вычитаем настроенное число.
       Величина постоянная (зависит от шрифта, а не от ширины окна), так
       что снимаем её один раз и запоминаем, иначе каждый следующий
       проход укорачивал бы поле ещё на столько же. */
    var slider = header.querySelector('.b-index_slider');
    var inp = header.querySelector('#js-header_search_input');
    if (slider && inp && CFG.searchTrim > 0 && !inp.dataset.lmWidth) {
      var iw = inp.getBoundingClientRect().width;
      if (iw > CFG.searchTrim + 60) {
        inp.dataset.lmWidth = '1';
        inp.style.setProperty('width', (iw - CFG.searchTrim) + 'px', 'important');
      }
    }

    /* Опустевшую обёртку прячем — но только убедившись, что её содержимое       действительно переехало, иначе при неудачном переносе исчезли бы
       поиск и счётчик. У неё нет order, то есть он равен нулю, и в строке
       она вставала перед приветствием, сдвигая его вправо. */
    var aside = document.querySelector('.l-header_aside');
    if (aside && !aside.querySelector('.b-header_counters, .b-header_search'))
      aside.style.setProperty('display', 'none', 'important');
  }

  /* ============================================================
     4.1. НАВИГАЦИОННАЯ ШТУКА
     ============================================================ */

  /* Строка на месте серого разделителя под шапкой. Внутри — то, до чего
     на телефоне иначе не добраться: ссылки навигационной штуки лепры
     (сама она нарисована картинкой 642×377 с абсолютно размеченными
     поверх пустыми <a> — переносить её как есть некуда), гертруда и
     овощебаза из левой колонки главной.

     Строится ПОСЛЕ relayoutHeader: та переносит в шапку порог постов и
     счётчики, и вставлять блок за шапку имеет смысл, когда шапка собрана. */

  var NAV_KEY = 'lm-navthing';    /* закреплено ли (открывать сразу) */
  var GERT_KEY = 'lm-gertruda';   /* последняя увиденная гертруда */

  /* Значок свёрнутой строки — герб «Блогов Империи», тот же файл, что
     лепра кладёт внутрь блока. Нарисованного компаса тут больше нет:
     свой значок ни на что на странице не похож, а герб уже связан
     смыслом с содержимым — строка развернётся именно в него.
     Берём адрес, а не сам узел: узел леприн и прибит абсолютно в угол
     своего блока, а в памяти на внутренних страницах его вообще нет —
     остаётся только адрес из записи. */
  function crestSrc() {
    var img = document.querySelector('.b-aside_imperial_blogs_bg');
    var src = img && img.getAttribute('src');
    if (src && src.slice(0, 5) !== 'data:') return src;
    var saved = cachedBlogs();
    return (saved && saved.i) || '';
  }

  /* Гвоздик. Одно и то же начертание для обоих положений: откреплённый —
     тот же значок, наклонённый и приглушённый правилом. Две разные
     картинки пришлось бы держать согласованными по толщине линий. */
  var PIN_SVG =
    '<svg viewBox="0 0 24 24" width="15" height="15" ' +
    'aria-hidden="true" focusable="false">' +
    '<g fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M9 3h6"/><path d="M10 3v7l-3 3.5V15h10v-1.5L14 10V3"/>' +
    '<path d="M12 15v6"/></g></svg>';

  var BLOGS_KEY = 'lm-blogs';     /* последний увиденный список подлепр */
  var BLOGS_URL = 'https://leprosorium.ru/underground/';
  var VEG_KEY = 'lm-veg';         /* были ли у овощебазы замены */
  var VEG_URL = 'https://leprosorium.ru/fraud/replacements/';

  function vegWasOn() {
    try { return localStorage.getItem(VEG_KEY) === '1'; } catch (e) { return false; }
  }

  /* Овощебаза жива, только если в ней есть замены. Разметку лепра отдаёт
     всегда — и заголовок, и пустой список, — поэтому решает не наличие
     блока, а наличие пунктов.
     Прячем блок целиком классом, а не разбираем его: список у лепры
     наполняется её скриптом уже после разметки, и если он придёт позже,
     достаточно вернуть класс — восстанавливать удалённые узлы не надо.
     Состояние запоминаем: на внутренних страницах блока нет вовсе, и
     решать там нечем, кроме прошлого захода на главную. Записываем
     только когда блок настоящий — иначе внутренняя страница затирала бы
     память нулём просто потому, что овощебазы на ней не бывает. */
  function syncVeg() {
    var veg = document.querySelector('.lm-navthing_veg');
    if (!veg) return;
    var box = veg.querySelector('.b-aside_replacements');
    var on;
    if (box) {
      on = !!box.querySelector('.b-aside_replacements_list_item');
      try { localStorage.setItem(VEG_KEY, on ? '1' : '0'); } catch (e) {}
    } else {
      /* восстановленная по памяти ссылка — её кладём, только если в
         прошлый раз замены были; пусто здесь значит «не показывать» */
      on = !!veg.firstChild;
    }
    veg.classList.toggle('lm-on', on);
  }

  function navAlways() {
    try { return localStorage.getItem(NAV_KEY) === '1'; } catch (e) { return false; }
  }

  /* Гертруда лежит только в разметке главной, а блок нужен на всех
     страницах. Запоминаем последнюю увиденную картинку и на прочих
     страницах показываем её: она и так меняется от захода к заходу,
     так что вчерашняя — не ошибка, а просто предыдущая. */
  function rememberGertruda() {
    var img = document.querySelector('.b-gertruda img');
    var src = img && img.getAttribute('src');
    if (!src || src.slice(0, 5) === 'data:') return;
    try { localStorage.setItem(GERT_KEY, src); } catch (e) {}
  }

  function cachedGertruda() {
    try { return localStorage.getItem(GERT_KEY) || ''; } catch (e) { return ''; }
  }

  /* «Блоги Империи» — тоже только на главной (и в левой колонке подлепры).
     Запоминаем не разметку, а разобранные данные: заголовок, герб и пары
     «адрес — название». Собранная обратно из них копия заведомо не внесёт
     в страницу ничего, кроме текста и адресов, — в отличие от innerHTML,
     который вернул бы на страницу произвольную разметку из хранилища.

     Счётчик «0/524» и крестик «отписаться» в запись не идут намеренно:
     число непрочитанного к следующей странице уже неверно, а крестик без
     скрипта лепры — просто нерабочий значок. */
  function readBlogs(el) {
    var head = el.querySelector('strong a') || el.querySelector('a');
    if (!head) return null;
    var pic = el.querySelector('.b-aside_imperial_blogs_bg');
    var data = {
      t: (head.textContent || '').trim(),
      u: head.getAttribute('href') || BLOGS_URL,
      i: (pic && pic.getAttribute('src')) || '',
      l: []
    };
    sliceOf(el.querySelectorAll('li')).forEach(function (li) {
      var a = li.querySelector('a:not(.b-close_btn)');
      var u = a && a.getAttribute('href');
      if (!a || !u || u.charAt(u.length - 1) === '#') return;
      data.l.push({ t: (a.textContent || '').trim(), u: u });
    });
    return data;
  }

  function rememberBlogs(el) {
    var data = readBlogs(el);
    if (!data) return;
    try { localStorage.setItem(BLOGS_KEY, JSON.stringify(data)); } catch (e) {}
  }

  function cachedBlogs() {
    try {
      var raw = localStorage.getItem(BLOGS_KEY);
      var data = raw && JSON.parse(raw);
      return (data && data.t && data.l) ? data : null;
    } catch (e) { return null; }
  }

  /* Классы лепры оставляем: герб, кегли и отступы описаны ими, и правила
     выше правят обе копии — родную и восстановленную — одинаково.
     Идентификатор картинки не переносим: на главной он уже занят. */
  function makeBlogs(data) {
    var box = document.createElement('div');
    box.className = 'b-aside_item b-aside_imperial_blogs';
    if (data.i) {
      var pic = document.createElement('img');
      pic.className = 'b-aside_imperial_blogs_bg';
      pic.setAttribute('src', data.i);
      pic.setAttribute('alt', '');
      box.appendChild(pic);
    }
    var head = document.createElement('strong');
    var a = document.createElement('a');
    a.setAttribute('href', data.u);
    a.textContent = data.t;
    head.appendChild(a);
    box.appendChild(head);

    var ul = document.createElement('ul');
    data.l.forEach(function (item) {
      var li = document.createElement('li');
      var link = document.createElement('a');
      link.setAttribute('href', item.u);
      link.textContent = item.t;
      li.appendChild(link);
      ul.appendChild(li);
    });
    box.appendChild(ul);
    return box;
  }

  /* Гертруда подрастает под столбик ссылок. У человека с одной подлепрой
     столбик низкий, картинка рядом с ним и так велика; у человека с
     десятком — столбик уходит вниз, и картинка в 118 пикселей смотрится
     обрубком рядом с длинной колонкой.
     Считаем каждый раз ОТ ИСХОДНОЙ ширины, а не от текущей: иначе при
     каждом пересчёте картинка прибавляла бы к уже прибавленному, и за
     несколько поворотов экрана уехала бы через всю строку. Ровно та же
     ловушка была у кегля девиза подлепры.
     Предел — gertrudaGrow процентов: дальше картинка подходит вплотную
     к гвоздику, стоящему между нею и ссылками. */
  function fitGertruda() {
    var pic = document.querySelector('.lm-navthing_pic');
    var links = document.querySelector('.lm-navthing_links');
    if (!pic || !links || !pic.querySelector('img')) return;

    var base = CFG.gertruda;
    pic.style.flexBasis = base + 'px';
    pic.style.maxWidth = base + 'px';

    var high = links.getBoundingClientRect().height;
    var low = pic.getBoundingClientRect().height;
    /* Свёрнутый блок и любая проверка без раскладки дают нули. Ноль в
       делимом или делителе даст либо бесконечность, либо ложное «расти
       некуда» — выходим, оставив исходную ширину. */
    if (!high || !low) return;

    var k = high / low;
    if (k < 1) k = 1;
    var max = 1 + CFG.gertrudaGrow / 100;
    if (k > max) k = max;

    var w = Math.round(base * k);
    pic.style.flexBasis = w + 'px';
    pic.style.maxWidth = w + 'px';
  }

  function buildNavthing() {
    if (document.getElementById('lm-navthing')) return;
    var header = document.querySelector('.l-header');
    if (!header || !header.parentNode) return;

    rememberGertruda();

    var box = document.createElement('div');
    box.id = 'lm-navthing';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lm-navthing_row';

    var icon = document.createElement('span');
    icon.className = 'lm-navthing_icon';
    var crest = crestSrc();
    if (crest) {
      var crestImg = document.createElement('img');
      crestImg.setAttribute('src', crest);
      crestImg.setAttribute('alt', '');
      icon.appendChild(crestImg);
    }
    var label = document.createElement('span');
    label.className = 'lm-navthing_label';
    label.textContent = 'Навигационная штука';
    /* знак шеврона — в CSS: он меняется по состоянию */
    var arrow = document.createElement('span');
    arrow.className = 'lm-navthing_arrow';
    btn.appendChild(icon);
    btn.appendChild(label);
    btn.appendChild(arrow);

    var body = document.createElement('div');
    body.className = 'lm-navthing_body';

    var top = document.createElement('div');
    top.className = 'lm-navthing_top';

    /* Гвоздик — посередине между столбиком ссылок и гертрудой, в той же
       строке и по её верху. Своей ячейкой, а не отступами: промежуток
       зависит от длины названий подлепр, и любое постоянное число
       промахивалось бы мимо середины на каждой второй странице. */
    var pin = document.createElement('button');
    pin.type = 'button';
    pin.className = 'lm-navthing_pin';
    pin.innerHTML = PIN_SVG;
    var mid = document.createElement('div');
    mid.className = 'lm-navthing_mid';
    mid.appendChild(pin);

    var links = document.createElement('div');
    links.className = 'lm-navthing_links';
    var blogs = document.querySelector('.b-aside_imperial_blogs');
    if (blogs) {
      rememberBlogs(blogs);
      links.appendChild(blogs);
    } else {
      var saved = cachedBlogs();
      if (saved) links.appendChild(makeBlogs(saved));
      else {
        /* Ни разметки, ни записи — первый заход не с главной. Оставляем
           хотя бы вход в общий список, чтобы строка не разворачивалась
           в одну гертруду. */
        var only = document.createElement('a');
        only.setAttribute('href', BLOGS_URL);
        only.textContent = 'Блоги Империи';
        links.appendChild(only);
      }
    }
    top.appendChild(links);
    top.appendChild(mid);

    var pic = document.createElement('div');
    pic.className = 'lm-navthing_pic';
    var gert = document.querySelector('.b-gertruda');
    if (gert) {
      pic.appendChild(gert);
    } else {
      var cached = cachedGertruda();
      if (cached) {
        var wrap = document.createElement('a');
        wrap.setAttribute('href', 'https://leprosorium.ru/');
        var img = document.createElement('img');
        img.setAttribute('src', cached);
        img.setAttribute('alt', '');
        wrap.appendChild(img);
        pic.appendChild(wrap);
      }
    }
    /* Пустой флекс-элемент забрал бы свои 118 пикселей у колонки ссылок. */
    if (pic.firstChild) top.appendChild(pic);
    body.appendChild(top);

    var veg = document.createElement('div');
    veg.className = 'lm-navthing_veg';
    var vegBox = document.querySelector('.b-aside_replacements');
    if (vegBox) {
      /* Список замен лепра наполняет своим скриптом по id — перенос узла
         этому не мешает, getElementById найдёт его и на новом месте. */
      veg.appendChild(vegBox);
    } else if (vegWasOn()) {
      /* Блока на странице нет. Запасную ссылку кладём только если в
         прошлый раз замены были: иначе на внутренних страницах висела бы
         жёлтая плашка от овощебазы, которой человек не пользуется. */
      var vegLink = document.createElement('a');
      vegLink.className = 'b-aside_replacements_header';
      vegLink.setAttribute('href', VEG_URL);
      vegLink.textContent = 'Овощебаза';
      veg.appendChild(vegLink);
    }
    body.appendChild(veg);

    box.appendChild(btn);
    box.appendChild(body);
    header.parentNode.insertBefore(box, header.nextSibling);
    document.documentElement.classList.add('lm-navthing_on');

    /* Гвоздик — про состояние при загрузке страницы, а не про текущий вид:
       свернуть закреплённый блок пальцем можно, но на следующей странице
       он снова развернётся. Этим он отличается от пенсне, которое просто
       помнит последнее положение. */
    function showPin(on) {
      pin.classList.toggle('lm-on', on);
      pin.setAttribute('aria-pressed', on ? 'true' : 'false');
      pin.setAttribute('title', on ? 'закреплено' : 'откреплено');
    }

    var pinned = navAlways();
    showPin(pinned);
    box.classList.toggle('lm-navthing__open', pinned);
    btn.setAttribute('aria-expanded', pinned ? 'true' : 'false');

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      var on = !box.classList.contains('lm-navthing__open');
      box.classList.toggle('lm-navthing__open', on);
      btn.setAttribute('aria-expanded', on ? 'true' : 'false');
      /* Меряем только что развёрнутое: у свёрнутого блока раскладки нет
         и все прямоугольники нулевые. */
      if (on) guard('fitGertruda', fitGertruda)();
    });

    pin.addEventListener('click', function (e) {
      e.preventDefault();
      var on = !pin.classList.contains('lm-on');
      showPin(on);
      try { localStorage.setItem(NAV_KEY, on ? '1' : '0'); } catch (e2) {}
    });

    /* Наблюдатель — на сам блок овощебазы, а не на общий: тот повешен на
       ленту или тред и до навигационной штуки не достаёт, а список замен
       приходит как раз добавлением узлов внутрь блока. */
    guard('syncVeg', syncVeg)();
    guard('fitGertruda', fitGertruda)();
    if (veg.querySelector('.b-aside_replacements') && 'MutationObserver' in window)
      new MutationObserver(guard('syncVeg', syncVeg))
        .observe(veg, { childList: true, subtree: true });
  }

  /* ============================================================
     4.2. ПЫНЬ
     ============================================================ */

  /* В десктопе колокольчик открывает окно поверх страницы, а на саму
     страницу уведомлений ведёт ссылка в его низу. На телефоне тап уходил
     прямо на страницу — окно лепры не открывалось.

     Чинить лепровское нечем: скрипта, который его строит, в сохранённой
     странице нет, а по её CSS видно, что окно рассчитано на мышь —
     min-width: 446px и прокрутка ленты только под наведением
     (.b-notification-feed_inner:hover { overflow-y: scroll }). Поэтому
     окно своё, а содержимое берём готовое: грузим страницу уведомлений
     и переносим оттуда ленту.

     Что переносится, то и должно работать. Всё, что у лепры держится на
     её скрипте (отписки, «ответить», «развернуть», отметка о прочтении),
     на перенесённых узлах обработчиков не получит, поэтому вырезается:
     кнопка, которая ничего не делает, хуже отсутствующей.

     Откуда берётся лента. Первая попытка запрашивала /my/events/ и
     разбирала ответ — в нём ленты не оказалось вовсе: сервер отдаёт
     30 КБ каркаса, а список собирает уже скрипт лепры, вытягивая шаблоны
     из /static/views/notifications/ и данные из /api/my/notifications/.
     Пойти этим же путём не вышло: тот же адрес, теми же куками, тем же
     методом отвечает 404 — чем именно лепра его зовёт, установить пока
     не удалось. Поэтому лента собирается её же скриптом в скрытом окне
     на ту же страницу, а мы забираем готовые узлы. Дороже одного
     запроса, зато не зависит от разгадки API. */

  var PYN_PAGE = '/my/events/';
  var PYN_FRAME = 'lm-pyn-frame';   /* по нему скрипт узнаёт себя в окне */
  var pynData = null;       /* разобранный кусок ленты и набор значков */
  var pynAt = 0;            /* когда он загружен */
  var pynBusy = false;
  var pynFrame = null;

  function onEventsPage() {
    return /^\/my\/events(\/|$)/.test(location.pathname);
  }

  /* Куда уходить, если окно не сложилось. Ссылка у пыни абсолютная и
     ведёт на главный домен — её и берём, а не свой адрес. */
  function pynHref() {
    var a = document.querySelector('a.js-header_button_events');
    return (a && a.getAttribute('href')) ||
           'https://leprosorium.ru' + PYN_PAGE;
  }

  /* Подпись уведомления собрана из кусков, разделённых точками. Часть
     кусков уходит, и точки остаются висеть по краям и парами. */
  function dropStrayDots(f) {
    var dot = function (el) {
      return !!el && el.classList.contains('b-notification-item_footer-delimiter');
    };
    var prevDot = true;                 /* начало строки — ведущая точка лишняя */
    sliceOf(f.children).forEach(function (el) {
      if (dot(el) && prevDot) { el.remove(); return; }
      prevDot = dot(el);
    });
    var last = f.children[f.children.length - 1];
    if (dot(last)) last.remove();
  }

  function pynClean(box) {
    sliceOf(box.querySelectorAll(
      '.b-notification-item_parent_comment,' +   /* разворот родительского */
      '.b-notification-item_unsubscribe-menu,' + /* отписки */
      '.b-notification-item_mark-read,' +        /* отметка о прочтении */
      '.b-notification-item_answer-message,' +   /* «Отправлено» */
      '.b-notification-item_footer_answer,' +    /* «ответить» */
      '.b-roll_parent_comment,' +
      '.js-roll_action'                          /* «развернуть» / «свернуть» */
    )).forEach(function (el) { el.remove(); });

    /* Без «развернуть» обрезанный текст показывать незачем — оставляем
       полный, он лежит рядом под классом hidden. */
    sliceOf(box.querySelectorAll('.js-roll_snippet'))
      .forEach(function (el) { el.remove(); });
    sliceOf(box.querySelectorAll('.js-roll_full'))
      .forEach(function (el) { el.classList.remove('hidden'); });

    sliceOf(box.querySelectorAll('.b-notification-item_footer'))
      .forEach(dropStrayDots);

    /* Слово «комментарий» было ручкой разворота: у лепры .b-roll_down —
       это пунктирное подчёркивание и палец под курсором. Разворачивать
       больше нечего, а вид обещает нажатие. */
    sliceOf(box.querySelectorAll('.js-roll_parent_comment'))
      .forEach(function (el) {
        el.classList.remove('b-roll_down', 'js-roll_parent_comment');
      });

    /* Совпадение id с настоящими комментариями страницы сломало бы и
       якоря, и поиск по id в скрипте лепры: у уведомлений id родительских
       комментариев те же, что у комментариев в треде. Набор значков это
       не затрагивает — он лежит отдельным узлом и чистке не подлежит. */
    sliceOf(box.querySelectorAll('[id]'))
      .forEach(function (el) { el.removeAttribute('id'); });
  }

  function pynLoad(cb) {
    if (pynData && Date.now() - pynAt < CFG.pynFresh * 1000) return cb(pynData);
    if (pynBusy) return;
    pynBusy = true;

    var timer = null;
    var done = function (data, why) {
      pynBusy = false;
      if (timer) clearInterval(timer);
      if (pynFrame && pynFrame.parentNode) pynFrame.remove();
      pynFrame = null;
      cb(data, why);
    };

    var fr = document.createElement('iframe');
    pynFrame = fr;
    fr.setAttribute('name', PYN_FRAME);
    fr.setAttribute('aria-hidden', 'true');
    fr.setAttribute('src', location.protocol + '//' + location.host + PYN_PAGE);
    /* Не display: none и не размер в пиксель: скрипт лепры при сборке
       ленты меряет раскладку, и в схлопнутом окне мерить ему нечего.
       Поэтому окно нормального размера, просто унесено за край. */
    fr.style.cssText = 'position:fixed;left:-10000px;top:0;width:420px;' +
                       'height:900px;border:0;opacity:0;pointer-events:none;';
    document.body.appendChild(fr);

    var t0 = Date.now();

    var look = function () {
      var d = null;
      try { d = fr.contentDocument; } catch (e) {}
      var main = d && d.querySelector('#js-notification-feed-main');
      if (main && main.querySelector('.b-notification-item')) {
        /* Забираем немедленно и к себе: после удаления окна его документ
           пропадает, и узлы, оставленные там, станут непригодны. */
        var mine = document.importNode(main, true);
        pynClean(mine);
        var sp = d.querySelector('.b-notification-svg-font');
        pynData = { main: mine,
                    sprite: sp ? document.importNode(sp, true) : null };
        pynAt = Date.now();
        return done(pynData, null);
      }
      if (Date.now() - t0 > CFG.pynWait * 1000)
        done(null, d ? 'лента не собралась за ' + CFG.pynWait + ' с'
                     : 'страница уведомлений не открылась');
    };

    timer = setInterval(guard('pynLook', look), 200);
  }

  function pynClose() {
    var w = document.getElementById('lm-pyn');
    if (w) w.remove();
  }

  function pynFill(body, data) {
    if (!data) return false;

    /* Значки уведомлений нарисованы через <use xlink:href="#notification_…">,
       а сами svg лежат в отдельном наборе — на прочих страницах его нет,
       и без него в ленте были бы пустые места. */
    if (data.sprite && !document.querySelector('.b-notification-svg-font'))
      document.body.appendChild(document.importNode(data.sprite, true));

    body.textContent = '';
    var main = document.importNode(data.main, true);
    if (!main.querySelector('.b-notification-item')) {
      var empty = document.createElement('div');
      empty.className = 'lm-pyn_note';
      empty.textContent = 'Пока ничего';
      body.appendChild(empty);
      return true;
    }
    body.appendChild(main);
    return true;
  }

  function pynOpen() {
    if (document.getElementById('lm-pyn')) { pynClose(); return; }
    if (!document.body) return;

    var wrap = document.createElement('div');
    wrap.id = 'lm-pyn';

    var shade = document.createElement('div');
    shade.className = 'lm-pyn_shade';
    shade.addEventListener('click', pynClose);
    /* Страницу под окном не глушим через overflow: hidden на body — на
       iOS это теряет позицию прокрутки и выбрасывает наверх (см. историю
       просмотрщика картинок). Хватает того, что палец на подложке не
       тащит страницу. */
    shade.addEventListener('touchmove', function (e) { e.preventDefault(); },
                           { passive: false });

    var box = document.createElement('div');
    box.className = 'lm-pyn_box';

    var body = document.createElement('div');
    body.className = 'lm-pyn_body';
    var note = document.createElement('div');
    note.className = 'lm-pyn_note';
    note.textContent = 'Загружаю…';
    body.appendChild(note);

    /* Строки заголовка у лепровского окна уведомлений нет вовсе, поэтому
       и у нас её нет: закрытие ушло в подвал, слева, на место её
       «Отметить всё как прочитанное». */
    var foot = document.createElement('div');
    foot.className = 'lm-pyn_foot';
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'lm-pyn_close';
    close.textContent = 'Закрыть';
    close.addEventListener('click', pynClose);
    var all = document.createElement('a');
    all.setAttribute('href', pynHref());
    all.textContent = 'Все уведомления';
    foot.appendChild(close);
    foot.appendChild(all);

    box.appendChild(body);
    box.appendChild(foot);
    wrap.appendChild(shade);
    wrap.appendChild(box);
    document.body.appendChild(wrap);

    pynLoad(function (data, why) {
      if (!document.getElementById('lm-pyn')) return;   /* успели закрыть */
      if (pynFill(body, data)) return;
      /* Раньше отсюда шёл переход на страницу уведомлений: окно мигало
         и пропадало, а почему — оставалось неизвестным. Теперь причина
         остаётся на виду, а уйти на страницу можно ссылкой снизу. */
      body.textContent = '';
      var bad = document.createElement('div');
      bad.className = 'lm-pyn_note';
      bad.textContent = 'Список не загрузился: ' + (why || 'неизвестно');
      body.appendChild(bad);
    });
  }

  if (CFG.pynPopup) {
    document.documentElement.classList.add('lm-pyn_on');
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;
      var a = t.closest('a.js-header_button_events');
      if (!a) return;
      /* На самой странице уведомлений окно ни к чему: лента и так перед
         глазами, а ссылка ведёт на неё же. */
      if (onEventsPage()) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      guard('pynOpen', pynOpen)();
    }, true);
  }

  /* Страница уведомлений: лента лежит последним потомком body и прибита
     абсолютно, top ей считает скрипт лепры под свою шапку. Позиционирование
     снято в CSS, но статичный блок на месте последнего потомка body встал
     бы ниже подвала — поэтому переносим его в главную колонку. */
  function fixEventsPage() {
    var feed = document.getElementById('js-notification-feed');
    if (!feed) return;
    var main = document.querySelector('.l-i-content_main');
    if (main && feed.parentNode !== main) main.appendChild(feed);
    feed.style.removeProperty('top');
  }


  /* ---- Страница нового поста ----
     Форма собрана из пяти вложенных таблиц. Общее правило «form table →
     block» их разбирает, но заодно разрывает пары «квадратик — подпись»:
     они лежат в соседних ячейках, и каждая становится своей строкой.
     Чинить это правилами нельзя — пары надо держать вместе, а ячейки
     соседями не выбираются.

     Поэтому таблицы разбираем сами: узлы, за которые держится скрипт
     лепры (панель кнопок с её id, поле, загрузчик, кнопка отправки),
     переносим целиком, пары собираем в отдельные пункты, остаток
     выбрасываем. Порядок свой: панель — поле — два свёрнутых списка
     (категории и специальные опции) — отправка.

     Клонировать ничего нельзя: на узлах висят обработчики лепры,
     переживает их только перенос. */

  function newPostForm() {
    var f = document.querySelector('#js-new_post_form');
    if (!f) return null;
    /* Форма быстрого поста в ленте носит те же id, но она скрыта и
       разбирать её незачем. Как именно она обёрнута, по сохранённой
       странице не видно — поэтому отсекаем и по предку, и по потомку. */
    if (f.closest && f.closest('.b-new_post_miniform')) return null;
    if (f.querySelector('.b-new_post_miniform')) return null;
    return f.querySelector('#js-new_post_body') ? f : null;
  }

  /* Пара «квадратик — подпись». wrapCheckbox для этого не годится:
     там input и label лежат в одном родителе, здесь всегда в разных
     ячейках, и связывает их только атрибут for. */
  function npPair(f, inp) {
    var pair = document.createElement('span');
    pair.className = 'lm-np_opt';
    var lab = inp.id ? f.querySelector('label[for="' + inp.id + '"]') : null;
    pair.appendChild(inp);
    if (lab) pair.appendChild(lab);
    return pair;
  }

  /* Заголовки групп лепра размечает по-разному: «Cпециальные опции:» —
     жирным начертанием внутри ячейки (буква C в начале латинская, поэтому
     ищем со второй), «Выберите категорию …» — просто текстом ячейки.
     Ни класса, ни общего тега у них нет, так что ищем по тексту.
     Годится только самый глубокий подходящий узел: у всех ячеек-обёрток
     текст ровно тот же. */
  function npHeadText(f, re) {
    var all = f.querySelectorAll('b, td');
    for (var i = 0; i < all.length; i++) {
      if (!re.test(all[i].textContent || '')) continue;
      if (all[i].querySelector('b, td, table')) continue;
      return all[i];
    }
    return null;
  }

  /* Название списка берём у лепры, но чистим: пояснение в скобках
     («Посты без категории автоматически получают …») занимало на телефоне
     три строки ради того, что и так понятно, а двоеточие в подписи
     свёрнутого списка лишнее. Если разметка изменится и заголовок не
     найдётся — своё название. */
  function npTitle(head, def) {
    if (!head) return def;
    var small = head.querySelector('.small, i, span');
    if (small && small.parentNode) small.parentNode.removeChild(small);
    var t = (head.textContent || '').replace(/\s+/g, ' ')
              .replace(/\s*:\s*$/, '').trim();
    return t || def;
  }

  function npPairs(f, sel) {
    var list = f.querySelectorAll(sel), out = [];
    for (var i = 0; i < list.length; i++) out.push(npPair(f, list[i]));
    return out;
  }

  /* Список: кнопка с названием и сама группа пунктов. В разметку они
     кладутся врозь (сначала обе кнопки, потом обе группы), поэтому
     возвращаем пару, а расставляет уже fixNewPost.
     Кнопке обязателен type="button": без него она внутри формы работает
     кнопкой отправки, и первое же нажатие отправило бы пустой пост. */
  function npList(key, title, items) {
    if (!items.length) return null;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'lm-np_toggle lm-np_toggle-' + key;
    var t = document.createElement('span');
    t.className = 'lm-np_toggle_t';
    t.textContent = title;
    var v = document.createElement('span');
    v.className = 'lm-np_toggle_v';
    btn.appendChild(t);
    btn.appendChild(v);

    var g = document.createElement('div');
    g.className = 'lm-np_group lm-np_' + key;
    for (var i = 0; i < items.length; i++) g.appendChild(items[i]);

    btn.addEventListener('click', function () {
      btn.classList.toggle('lm-open', g.classList.toggle('lm-open'));
    });
    return { btn: btn, box: g };
  }

  /* Подпись под названием: что в списке выбрано. Без неё свёрнутый список
     прячет и сам выбор — категорию поставил, закрыл, и проверить нечем,
     кроме как открыть заново. */
  function npValue(lists, key, text) {
    var v = lists.querySelector('.lm-np_toggle-' + key + ' .lm-np_toggle_v');
    if (v) v.textContent = text;
  }

  function npStatus(lists) {
    var cats = lists.querySelector('.lm-np_cats');
    if (cats) {
      var on = cats.querySelector('input:checked');
      var lab = on && on.id && cats.querySelector('label[for="' + on.id + '"]');
      var name = lab ? (lab.textContent || '').replace(/\s+/g, ' ').trim() : '';
      npValue(lists, 'cats', on ? (name || 'выбрана') : 'без категории');
    }
    var flags = lists.querySelector('.lm-np_flags');
    if (flags) {
      var n = flags.querySelectorAll('input:checked').length;
      npValue(lists, 'flags', n ? 'выбрано: ' + n : 'ничего');
    }
  }

  function fixNewPost() {
    var f = newPostForm();
    if (!f) return;
    document.documentElement.classList.add('lm-newpost');
    if (f.querySelector('.lm-np')) return;      /* уже разобрано */

    var np = document.createElement('div');
    np.className = 'lm-np';

    var tools = f.querySelector('#js-new_post_body_wysiwyg');
    if (tools) {
      /* инлайновый white-space:nowrap держал панель в одну строку */
      tools.style.removeProperty('white-space');
      np.appendChild(tools);
    }
    var body = f.querySelector('#js-new_post_body');
    if (body) np.appendChild(body);

    /* Категории и опции — в два свёрнутых списка под полем. Развёрнутыми
       это два десятка строк между полем и кнопкой отправки: чтобы просто
       написать пост, приходилось прокручивать их все. */
    var lists = document.createElement('div');
    lists.className = 'lm-np_lists';
    var pack = [
      npList('cats', npTitle(npHeadText(f, /^\s*Выберите категорию/i),
                             'Выберите категорию'),
             npPairs(f, 'input[type="radio"]')),
      npList('flags', npTitle(npHeadText(f, /пециальные опции/i),
                              'Специальные опции'),
             npPairs(f, 'input[type="checkbox"]'))
    ];
    for (var p = 0; p < pack.length; p++) if (pack[p]) lists.appendChild(pack[p].btn);
    for (p = 0; p < pack.length; p++) if (pack[p]) lists.appendChild(pack[p].box);
    if (lists.firstChild) {
      np.appendChild(lists);
      lists.addEventListener('change', function () { npStatus(lists); });
      npStatus(lists);
    }

    var send = document.createElement('div');
    send.className = 'lm-np_send';
    var up = f.querySelector('#js-new_post_file');
    if (up) send.appendChild(up);
    var go = f.querySelector('#js-new_post_submit');
    if (go) send.appendChild(go);
    if (send.firstChild) np.appendChild(send);

    /* Всё, что осталось от таблиц, уходит вместе с ними. Но сначала
       спасаем поля, которых мы не знаем: в сохранённой странице форма
       обходится без служебных, а на живом сайте в ней может лежать что
       угодно, и без такого поля пост просто не отправится. Скрытые
       ничего не займут, видимые встанут внизу — заметно и починимо,
       в отличие от молча пропавшего значения. */
    var keep = document.createElement('div');
    keep.className = 'lm-np_keep';
    var rest = f.querySelectorAll('input, select, textarea, button');
    for (var i = 0; i < rest.length; i++) keep.appendChild(rest[i]);
    if (keep.firstChild) np.appendChild(keep);

    var old = sliceOf(f.childNodes);
    f.appendChild(np);
    for (var k = 0; k < old.length; k++) f.removeChild(old[k]);
  }

  /* ============================================================
     5. ТЁМНАЯ ТЕМА
     ============================================================ */

  function isDark() {
    return document.documentElement.classList.contains('lm-dark');
  }

  function themeColorValue() { return isDark() ? '#1a1a1a' : '#ffffff'; }

  /* Свой метатег ставим ПЕРВЫМ в head, а не последним. По правилам
     разметки браузер берёт первый подходящий theme-color, а не
     последний — своего у лепры сейчас нет, но появись он, наш в конце
     просто не подействовал бы. */
  function themeMeta() {
    var m = document.querySelector('meta[name="theme-color"][data-lm]');
    if (m) return m;
    var head = document.head || document.documentElement;
    if (!head) return null;
    m = document.createElement('meta');
    m.setAttribute('name', 'theme-color');
    m.setAttribute('data-lm', '1');
    head.insertBefore(m, head.firstChild);
    return m;
  }

  /* Цвет — фон страницы: белый обычно, тёмный при нашей тёмной теме.
     Она сделана инверсией всего документа, поэтому белый там становится
     почти чёрным, и панели должны быть под стать.

     nudge: Safari перерисовывает панели по изменению метатега, а не по
     содержимому страницы, и верхнюю строку обновляет заметно ленивее
     нижней. Поэтому там, где цвет должен смениться прямо сейчас, сперва
     ставим соседний оттенок и через кадр возвращаем нужный: разница в
     один шаг глазу не видна, а обновление вызывает. */
  function setThemeColor(nudge) {
    if (!CFG.themeColor) return;
    var m = themeMeta();
    if (!m) return;
    var want = themeColorValue();
    if (!nudge) { m.setAttribute('content', want); return; }
    m.setAttribute('content', isDark() ? '#1b1b1b' : '#fefefe');
    setTimeout(function () { m.setAttribute('content', want); }, 60);
  }

  /* Затемнение окна покупки перекрывает обе кромки экрана, и Safari
     красит панели по нему. После закрытия окна сам он их не пересчитает,
     поэтому ловим переход «было затемнение — не стало» и обновляем цвет
     принудительно. Следим за подложкой, а не за держателем: держатель
     высотой в один пиксель и виден всегда. */
  var darkOverlayOn = false;

  function syncThemeColor() {
    if (!CFG.themeColor) return;
    var box = document.getElementById('charley_holder');
    var b = box && box.querySelector('.black');
    var now = false;
    if (b) {
      var cs = getComputedStyle(b);
      now = cs.display !== 'none' && cs.visibility !== 'hidden' &&
            parseFloat(cs.opacity) > 0.05;
    }
    if (now === darkOverlayOn) return;
    darkOverlayOn = now;
    if (!now) setThemeColor(true);
  }

  function setDark(on) {
    document.documentElement.classList.toggle('lm-dark', on);
    try { localStorage.setItem('lm-dark', on ? '1' : '0'); } catch (e) {}
    var b = document.getElementById('lm-theme');
    if (b) b.textContent = on ? '\u2600' : '\u263E';
    setThemeColor(true);
  }

  /* применяем до отрисовки, иначе страница мигнёт белым */
  try {
    if (localStorage.getItem('lm-dark') === '1')
      document.documentElement.classList.add('lm-dark');
  } catch (e) {}

  function ensureThemeToggle() {
    if (document.getElementById('lm-theme')) return;
    var header = document.querySelector('.l-header');
    if (!header) return;

    var b = document.createElement('button');
    b.id = 'lm-theme';
    b.type = 'button';
    b.title = 'светлая / тёмная тема';
    b.textContent = isDark() ? '\u2600' : '\u263E';
    b.addEventListener('click', function (e) {
      e.preventDefault();
      setDark(!isDark());
    });

    var logo = header.querySelector('.b-logo');
    if (logo && logo.parentNode === header) header.insertBefore(b, logo);
    else header.appendChild(b);
  }

  /* ============================================================
     6. НАВИГАЦИЯ ПО КОММЕНТАРИЯМ
     ============================================================ */

  /* Кэш держится отдельно на каждый вид списка. Раньше он был один на
     обоих, и стрелки со средней кнопкой выбивали друг друга: каждый
     тап заново собирал список и дёргал offsetParent у всех
     комментариев треда, а это принудительный пересчёт раскладки. */
  var navCache = {};

  /* Значки лепры, снятые с .b-comments_navigation: сетка 40×40,
     треугольник и маска. Нижняя стрелка у лепры — тот же треугольник,
     повёрнутый в CSS. Рисуем через createElementNS, а не innerHTML. */
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var JUMP_TRIANGLE = '12,32 20,8 28,32';
  var JUMP_MASK = '29.749,20 37,14.821 27.695,14.708 30.506,6.053 ' +
    '22.904,11.198 20,3 17.096,11.198 9.494,6.053 12.305,14.708 ' +
    '3,14.821 10.252,20 3,25.179 12.305,25.292 9.494,33.947 ' +
    '17.096,28.802 20,37 22.904,28.802 30.506,33.947 27.695,25.292 ' +
    '37,25.179';

  function svgNode(name, attrs) {
    var el = document.createElementNS(SVG_NS, name);
    Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }

  function jumpIcon(kind) {
    var svg = svgNode('svg', {
      viewBox: '0 0 40 40', width: '40', height: '40',
      xmlns: SVG_NS, 'aria-hidden': 'true'
    });
    svg.appendChild(svgNode('polygon', {
      fill: CFG.jumpColor,
      points: kind === 'mine' ? JUMP_MASK : JUMP_TRIANGLE
    }));
    if (kind === 'mine') {
      /* глаза маски — красные, у лепры это единственное цветное пятно */
      svg.appendChild(svgNode('ellipse', {
        fill: CFG.jumpEye, cx: '15.842', cy: '18.441', rx: '1.195', ry: '1.173'
      }));
      svg.appendChild(svgNode('ellipse', {
        fill: CFG.jumpEye, cx: '24.573', cy: '18.442', rx: '1.195', ry: '1.172'
      }));
    }
    return svg;
  }

  /* Отступ приземления и порог отбора. Порог обязан быть БОЛЬШЕ отступа:
     иначе комментарий, только что поставленный на отметку LAND, снова
     проходит проверку, и каждый второй тап уходит впустую. */
  var LAND = 60, EDGE = LAND + 10;

  function commentsBy(kind) {
    var now = Date.now();
    var kept = navCache[kind];
    if (kept && now - kept.time < 3000) return kept.list;

    var host = document.getElementById('js-comments') || document;
    var list;
    if (kind === 'mine') list = sliceOf(host.querySelectorAll('.comment.mine'));
    else {
      list = sliceOf(host.querySelectorAll('.comment.new'));
      if (!list.length) list = sliceOf(host.querySelectorAll('.comment'));
    }

    /* Скрытые фильтром комментарии дают нулевой прямоугольник. Оставить их
       в списке нельзя: координаты перестают расти монотонно и двоичный
       поиск возвращает элемент выше экрана. */
    list = list.filter(function (el) { return el.offsetParent !== null; });

    navCache[kind] = { list: list, time: now };
    return list;
  }

  /* Счётчики «все комментарии N» и «новые N» — обычный текст в ссылках.
     После кнопки обновления лепра догружает комментарии, но числа оставляет
     прежними. Пересчитываем по документу: считаем то, что реально есть. */
  function refreshCommentCounters() {
    var host = document.getElementById('js-comments');
    var bar = document.querySelector('.b-comments_controls');
    if (!host || !bar) return;

    var total = host.querySelectorAll('.comment').length;
    var fresh = host.querySelectorAll('.comment.new').length;

    var put = function (key, value) {
      var link = bar.querySelector('a[data-key="' + key + '"]');
      if (!link) return;
      var text = link.textContent;
      if (!/\d+\s*$/.test(text)) return;          /* формат не тот — не трогаем */
      var updated = text.replace(/\d+\s*$/, value);
      if (updated !== text) link.textContent = updated;
    };

    put('all', total);
    put('unread', fresh);
  }

  /* Кнопка обновления догружает комментарии асинхронно, поэтому проверяем
     несколько раз: сразу, через полсекунды, через полторы и через три. */
  function watchRefreshButton() {
    var bar = document.querySelector('.b-comments_controls');
    if (!bar || bar.dataset.lmRefresh) return;
    bar.dataset.lmRefresh = '1';

    var link = bar.querySelector('a[data-key="refresh"]');
    if (!link) return;

    link.addEventListener('click', function () {
      navCache = {};                          /* списки комментариев устарели */
      [0, 500, 1500, 3000].forEach(function (ms) {
        setTimeout(guard('refreshCommentCounters', refreshCommentCounters), ms);
      });
    });
  }

  /* «Свои есть» — именно ПОКАЗАННЫЕ свои. В режиме «только новые» свои
     комментарии в разметке лежат, но скрыты, и прыгать по ним некуда:
     лепра в таком случае гасит маску, гасим и мы. Отсев по offsetParent
     уже сделан внутри commentsBy. */
  function hasMine() { return commentsBy('mine').length > 0; }

  /* Двоичный поиск: комментарии идут по документу сверху вниз, значит их
     координаты монотонны. Одиннадцать замеров вместо двух тысяч — линейный
     обход на длинном треде вешал страницу и грел телефон. */
  function findTarget(list, dir) {
    var lo = 0, hi = list.length - 1, found = null;

    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      var top = list[mid].getBoundingClientRect().top;
      if (dir > 0) {
        if (top > EDGE) { found = mid; hi = mid - 1; } else lo = mid + 1;
      } else {
        if (top < LAND - 10) { found = mid; lo = mid + 1; } else hi = mid - 1;
      }
    }
    if (found === null) return null;

    var el = list[found], t = el.getBoundingClientRect().top;
    if (dir > 0 && t <= EDGE) return null;
    if (dir < 0 && t >= LAND - 10) return null;
    return el;
  }

  function landOn(target) {
    var before = scrollTopNow();
    var wanted = before + target.getBoundingClientRect().top - LAND;
    wanted = Math.max(0, Math.min(wanted, Math.max(0, docHeight() - window.innerHeight)));

    scrollTopSet(wanted);

    if (scrollTopNow() === before && Math.abs(wanted - before) > 2) {
      try { target.scrollIntoView(true); } catch (e) {}
    }
    note('прыжок: было ' + Math.round(before) +
         ' стало ' + Math.round(scrollTopNow()));
  }

  /* Стрелки ходят по новым; если новых нет — по всем. Так же у лепры. */
  function jumpComment(dir) {
    var list = commentsBy('new');
    if (!list.length) return;

    var target = findTarget(list, dir);
    if (!target) return;
    landOn(target);
  }

  /* Маска ходит только по своим и только вниз, а с последнего своего
     возвращается к первому — по кругу, как на десктопе. Круг делается
     здесь, а не в findTarget: у стрелок его быть не должно, иначе
     дочитанный до конца тред начнёт перекидывать в начало сам. */
  function jumpMine() {
    var list = commentsBy('mine');
    if (!list.length) return;
    landOn(findTarget(list, 1) || list[0]);
  }

  function refreshNavState() {
    var box = document.getElementById('lm-nav');
    if (!box) return;
    /* одиночная кнопка «наверх» живёт своей жизнью: гасить её по
       отсутствию комментариев нельзя, их там и не бывает */
    if (box.classList.contains('lm-nav__top')) return;

    var mineBtn = box.querySelector('.lm-nav_mine');
    if (mineBtn) {
      var has = hasMine();
      mineBtn.disabled = !has;
      mineBtn.classList.toggle('lm-off', !has);
    }

    /* Стрелки гаснут, только когда ходить вообще не по чему. Считать на
       каждой прокрутке, есть ли цель в конкретную сторону, нельзя:
       обход DOM по прокрутке — то, из-за чего грелся телефон. */
    var empty = !commentsBy('new').length;
    sliceOf(box.querySelectorAll('.lm-nav_up, .lm-nav_down'))
      .forEach(function (b) {
        b.disabled = empty;
        b.classList.toggle('lm-off', empty);
      });
  }

  /* Кнопка «наверх» нужна на любой странице, а стрелки по комментариям —
     только там, где комментарии есть. Поэтому набор кнопок разный. */
  function ensureNav() {
    if (document.getElementById('lm-nav')) { refreshNavState(); return; }
    if (!document.body) return;

    var hasComments = !!document.getElementById('js-comments');

    var box = document.createElement('div');
    box.id = 'lm-nav';

    /* Кнопка — площадь нажатия со значком лепры внутри. Значок именно
       вложенный, а не фоновая картинка: фон пришлось бы отдавать
       отдельным файлом или data:URL, а так он остаётся разметкой и
       красится настройками. Выделение и системное меню при удержании
       запрещены стилями. */
    var makeButton = function (kind, cls, title) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = cls;
      b.appendChild(jumpIcon(kind));
      if (title) b.title = title;
      b.addEventListener('contextmenu', function (e) { e.preventDefault(); });
      return b;
    };

    var toTop = function () {
      scrollTopSet(0);
      if (window.navigator && navigator.vibrate) navigator.vibrate(10);
    };

    /* в самый низ — там форма ответа */
    var toBottom = function () {
      scrollTopSet(Math.max(0, docHeight() - window.innerHeight));
      if (window.navigator && navigator.vibrate) navigator.vibrate(10);
    };

    if (!hasComments) {
      /* страница без комментариев: одна кнопка, и та до поры скрыта */
      box.className = 'lm-nav__top';
      var top = makeButton('arrow', 'lm-nav_toTop', 'в начало страницы');
      top.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        toTop();
      });
      box.appendChild(top);
      document.body.appendChild(box);
      watchTopButton(box);
      return;
    }

    var arrow = function (dir) {
      var b = makeButton('arrow',
        dir < 0 ? 'lm-nav_up' : 'lm-nav_down',
        dir < 0 ? 'к предыдущему комментарию (удержать — в начало)'
                : 'к следующему комментарию (удержать — в конец)');

      /* Долгое нажатие: вверх — к шапке, вниз — к форме ответа. longPress
         гасит следующий click, иначе после отпускания сработал бы и прыжок. */
      var timer = null, longPress = false;

      var startHold = function () {
        longPress = false;
        clearTimeout(timer);
        timer = setTimeout(function () {
          longPress = true;
          if (dir < 0) toTop(); else toBottom();
        }, 500);
      };
      var endHold = function () { clearTimeout(timer); };

      b.addEventListener('touchstart', startHold, { passive: true });
      b.addEventListener('touchend', endHold);
      b.addEventListener('touchcancel', endHold);
      b.addEventListener('mousedown', startHold);
      b.addEventListener('mouseup', endHold);
      b.addEventListener('mouseleave', endHold);

      b.addEventListener('click', guard('jumpComment', function (e) {
        e.preventDefault(); e.stopPropagation();
        endHold();
        if (longPress) { longPress = false; return; }
        jumpComment(dir);
      }));
      return b;
    };

    /* Средняя кнопка — не переключатель режима, а самостоятельный
       прыжок по своим комментариям сверху вниз и по кругу, как на
       десктопе. Переключатель «новые / свои» был нашей выдумкой:
       со стороны он выглядел так же, но стрелки после него ходили
       не туда, куда ждёшь. */
    var mine = makeButton('mine', 'lm-nav_mine',
                          'к следующему своему комментарию');
    mine.addEventListener('click', guard('jumpMine', function (e) {
      e.preventDefault(); e.stopPropagation();
      if (!hasMine()) return;
      jumpMine();
    }));

    box.appendChild(arrow(-1));
    box.appendChild(mine);
    box.appendChild(arrow(1));
    document.body.appendChild(box);
    refreshNavState();
  }

  /* Одиночную кнопку показываем, только когда отлистан хотя бы экран.
     Слушатель дешёвый: сравнивает два числа и переключает класс, никаких
     обходов DOM. */
  function watchTopButton(box) {
    var visible = false;

    var update = function () {
      var should = scrollTopNow() > window.innerHeight;
      if (should === visible) return;
      visible = should;
      box.classList.toggle('lm-visible', should);
    };

    update();
    window.addEventListener('scroll', update, { passive: true });
  }

  /* ============================================================
     7. МЕДИА
     ============================================================ */

  /* Раньше здесь был [class*="media_player"] — поиск по подстроке в атрибуте,
     самый медленный вид селектора, и он выполнялся при каждой прокрутке
     по всему документу. Перечисляем классы явно. */
  var PLAYER_SEL = '.js-media_player, .b-media_player, .b-media_player_preview, ' +
                   '.b-media_player_preview_pic_holder';

  function isEmptyPlayer(el) {
    return !el.querySelector('video, iframe, img, canvas, embed, object');
  }

  /* Часть плееров лепра собирает только по клику. Имитируем тот же клик,
     но заранее — иначе на месте видео пустой прямоугольник. */
  function wakePlayer(el) {
    if (seen.poked.has(el) || !isEmptyPlayer(el)) return;
    seen.poked.add(el);
    var y = scrollTopNow();
    try {
      (el.firstElementChild || el).dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    } catch (e) { /* один плеер не должен ронять остальные */ }
    if (scrollTopNow() !== y) scrollTopSet(y);
  }

  /* Размеры: video сам знает свою пропорцию, iframe — нет. */
  function fixMediaSizes() {
    document.querySelectorAll('video, audio').forEach(function (el) {
      if (seen.media.has(el)) return;
      seen.media.add(el);
      el.removeAttribute('width');
      el.removeAttribute('height');
      el.style.removeProperty('aspect-ratio');
      el.style.setProperty('width', '100%', 'important');
      el.style.setProperty('height', 'auto', 'important');
      el.style.setProperty('max-height', '80vh', 'important');
    });

    document.querySelectorAll('iframe, embed, object').forEach(function (el) {
      if (seen.media.has(el)) return;
      seen.media.add(el);
      var w = parseFloat(el.getAttribute('width')) || parseFloat(el.style.width);
      var h = parseFloat(el.getAttribute('height')) || parseFloat(el.style.height);
      var ratio = (w && h) ? w / h : 16 / 9;
      el.removeAttribute('width');
      el.removeAttribute('height');
      el.style.setProperty('width', '100%', 'important');
      el.style.setProperty('height', 'auto', 'important');
      el.style.setProperty('aspect-ratio', ratio.toFixed(4), 'important');
    });

    document.querySelectorAll('.js-media_player, .b-media_player').forEach(function (el) {
      if (seen.media.has(el)) return;      /* без этого стили переписывались
                                              на каждом тике прокрутки */
      seen.media.add(el);
      el.style.removeProperty('aspect-ratio');
      el.style.setProperty('height', 'auto', 'important');
      el.style.setProperty('max-width', '100%', 'important');
    });
  }

  /* Многие хостинги кладут обложку рядом с роликом: /abc.mp4 -> /abc.jpg.
     Если такая есть — ставим постером: настоящее превью без загрузки видео. */
  function guessPoster(v, url) {
    if (!url || v.getAttribute('poster')) return;
    var clean = url.split('?')[0];
    var base = clean.replace(/\.(mp4|webm|mov|m4v|ogv)$/i, '');
    if (base === clean) return;

    var exts = ['.jpg', '.jpeg', '.png', '.webp'], i = 0;
    (function next() {
      if (i >= exts.length || v.getAttribute('poster')) return;
      var candidate = base + exts[i++];
      var probe = new Image();
      probe.onload = function () {
        if (!v.getAttribute('poster') && probe.naturalWidth > 1)
          v.setAttribute('poster', candidate);
      };
      probe.onerror = next;
      probe.src = candidate;
    })();
  }

  /* Очередь подготовки. Без неё прыжок по комментариям выводил в зону
     видимости десятки роликов разом: каждый начинал проигрываться,
     главный поток вставал, телефон грелся. */
  var primeQueue = [], primeBusy = 0;

  function primeNext() {
    while (primeBusy < CFG.maxParallelVideos && primeQueue.length) {
      var v = primeQueue.shift();
      if (!v.isConnected) continue;
      primeBusy++;
      doPrimeVideo(v);
    }
  }

  function primeDone() {
    if (primeBusy > 0) primeBusy--;
    primeNext();
  }

  function primeVideo(v) {
    if (v.dataset.lmPrimed) return;
    v.dataset.lmPrimed = '1';
    primeQueue.push(v);
    primeNext();
  }

  function doPrimeVideo(v) {
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.setAttribute('preload', CFG.videoPreload);

    var applyRatio = function () {
      if (v.videoWidth && v.videoHeight)
        v.style.setProperty('aspect-ratio',
          v.videoWidth + ' / ' + v.videoHeight, 'important');
    };

    /* lmSelfPlay отличает наше воспроизведение от пользовательского.
       Тап по системным кнопкам плеера iOS обычными событиями до страницы
       не доходит, а событие play — доходит всегда. */
    v.lmSelfPlay = false;
    v.addEventListener('play', function () {
      if (!v.lmSelfPlay) v.dataset.lmUserPlayed = '1';
    });

    var mayTouch = function () {
      return !v.dataset.lmUserPlayed && v.paused && v.currentTime < 0.5;
    };

    v.addEventListener('loadedmetadata', function () {
      applyRatio();
      if (CFG.videoPoster === 'none') return;
      if (mayTouch() && v.currentTime < 0.01) {
        try { v.currentTime = 0.05; } catch (e) {}
      }
    });
    v.addEventListener('seeked', applyRatio);
    applyRatio();

    guessPoster(v, v.currentSrc || (v.querySelector('source') || {}).src || v.src);

    /* Обработчик лепры на контейнере плеера — это и есть механизм запуска
       видео. Глушить события с элемента нельзя: воспроизведение перестаёт
       работать вовсе. Проверено. */

    if (CFG.videoPoster !== 'frame') { primeDone(); return; }

    /* Первый кадр: коротко проигрываем без звука и сразу ставим на паузу.
       Safari на iOS не грузит видео до касания и рисует пустой прямоугольник;
       в заголовке файла (preload=metadata) картинки нет. */
    setTimeout(function () {
      if (v.readyState >= 2) { primeDone(); return; }
      if (v.dataset.lmUserPlayed || !v.paused) { primeDone(); return; }

      var wasMuted = v.muted, done = false, watchdog;

      var finish = function () {
        if (done) return;
        done = true;
        clearTimeout(watchdog);
        primeDone();
        v.removeEventListener('playing', finish);
        if (v.dataset.lmUserPlayed) {
          v.muted = wasMuted; v.lmSelfPlay = false; return;
        }
        v.pause();
        try { v.currentTime = 0.05; } catch (e) {}
        v.muted = wasMuted;
        v.lmSelfPlay = false;
        applyRatio();
      };

      /* если кадр не пришёл — освобождаем место в очереди принудительно */
      watchdog = setTimeout(finish, 4000);

      v.muted = true;
      v.lmSelfPlay = true;
      /* playing наступает раньше, чем разрешается обещание play() */
      v.addEventListener('playing', finish);

      var p = v.play();
      if (p && p.then) p.then(finish, function () {
        v.muted = wasMuted;
        v.lmSelfPlay = false;
        if (!done) { done = true; clearTimeout(watchdog); primeDone(); }
      });
    }, CFG.posterFallbackDelay);
  }

  var mediaObserver = null;

  function ensureObserver() {
    if (mediaObserver || !('IntersectionObserver' in window)) return;
    mediaObserver = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        mediaObserver.unobserve(en.target);
        if (en.target.tagName === 'VIDEO') primeVideo(en.target);
        else wakePlayer(en.target);
      });
    }, { rootMargin: CFG.lookAhead + 'px 0px' });
  }

  function registerMedia() {
    ensureObserver();
    var take = function (nodes, fallback) {
      nodes.forEach(function (el) {
        if (seen.obs.has(el)) return;
        seen.obs.add(el);
        if (mediaObserver) mediaObserver.observe(el);
        else fallback(el);
      });
    };
    take(document.querySelectorAll(PLAYER_SEL), wakePlayer);
    take(document.querySelectorAll('video'), primeVideo);
  }

  /* ============================================================
     8. ТАП ПО КАРТИНКЕ
     По умолчанию не делает ничего: картинки у лепры полноразмерные,
     деталь смотрится щипком. Лепровский обработчик при этом всё равно
     глушится — он подменяет узел и сам прокручивает страницу, из-за чего
     экран улетал наверх. Режим 'zoom' в настройках возвращает разворот
     узких картинок на всю ширину по тапу.
     ============================================================ */

  function toggleImage(img) {
    /* запоминаем, где картинка была относительно окна, и возвращаем
       её туда же после изменения размера — иначе страница «прыгает» */
    var before = img.getBoundingClientRect().top;

    if (img.classList.contains('lm-zoomed')) {
      img.classList.remove('lm-zoomed');
      if (img.dataset.lmPrev !== undefined) {
        if (img.dataset.lmPrev) img.setAttribute('style', img.dataset.lmPrev);
        else img.removeAttribute('style');
      }
    } else {
      img.dataset.lmPrev = img.getAttribute('style') || '';
      img.classList.add('lm-zoomed');
    }

    var after = img.getBoundingClientRect().top;
    if (Math.abs(after - before) > 1)
      scrollTopSet(scrollTopNow() + (after - before));
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || t.tagName !== 'IMG' || !t.closest) return;
    if (!t.closest('.c_body, .p_body, .dti, .comment, .post')) return;

    /* настоящую ссылку не трогаем: картинка может вести на другую страницу */
    var a = t.closest('a');
    if (a) {
      var h = a.getAttribute('href') || '';
      if (h && h !== '#' && h.slice(-1) !== '#') return;
    }

    /* Глушим лепровский зум в любом случае — он и был причиной прыжков. */
    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();

    if (CFG.imageTap === 'zoom') toggleImage(t);
  }, true);

  /* ============================================================
     9. ДИАГНОСТИКА
     Три тапа по левому верхнему углу или #lmdebug в адресе.
     Выключается через CFG.debug.
     ============================================================ */

  function describe(el) {
    var s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    var c = el.getAttribute && el.getAttribute('class');
    if (c) s += '.' + c.trim().split(/\s+/).slice(0, 4).join('.');
    return s;
  }

  function positionedParent(el) {
    var n = el.parentElement, d = 0;
    while (n && d < 8) {
      var pos = getComputedStyle(n).position;
      if (pos !== 'static') return describe(n) + ' (' + pos + ')';
      n = n.parentElement; d++;
    }
    return '\u2014';
  }

  function reportOverflow(L) {
    L.push('--- вылезает за экран ---');
    var bad = scanOverflow(true);
    if (!bad.length) L.push('(ничего)');
    bad.slice(0, 40).forEach(function (b) {
      L.push(describe(b.el) + '  L=' + Math.round(b.r.left) +
             ' R=' + Math.round(b.r.right) + ' w=' + Math.round(b.r.width));
    });
  }

  /* Всё, что всплывает поверх страницы: подложки, модальные окна,
     подсказки. Обычные разделы отчёта их не видят: они ходят по
     содержимому страницы, а окно живёт своей жизнью — и, как выяснилось,
     не обязательно рядом с содержимым.
     Показываем цепочку предков (чьё окно — лепры, капчи, расширения),
     инлайновые стили (в них пишут ширину и координаты) и потомков,
     вышедших за края: при рамке шириной ровно в экран виновато
     содержимое, а оно статическое и в перечень слоёв не попадает. */
  function reportOverlays(L) {
    var W = document.documentElement.clientWidth, n = 0;

    L.push('ширина окна ' + W);

    eachLayer(function (el, r) {
      if (n >= 12) return;
      n++;
      var cs = getComputedStyle(el);
      L.push('');
      L.push('[' + n + '] ' + describe(el) +
             '  pos=' + cs.position + ' z=' + cs.zIndex +
             ' L=' + Math.round(r.left) + ' R=' + Math.round(r.right) +
             ' T=' + Math.round(r.top) + ' B=' + Math.round(r.bottom) +
             ' w=' + Math.round(r.width) + ' h=' + Math.round(r.height) +
             (r.right > W + 1 || r.left < -1 ? '  ЗА ЭКРАНОМ' : ''));

      var path = [], p = el.parentElement, i = 0;
      while (p && p !== document.body && i++ < 4) {
        path.push(describe(p));
        p = p.parentElement;
      }
      L.push('   в: ' + (path.length ? path.join(' < ') : 'прямо в body'));

      var st = (el.getAttribute('style') || '').replace(/\s+/g, ' ').trim();
      if (st) L.push('   style="' + st.slice(0, 200) + '"');

      var out = [];
      sliceOf(el.querySelectorAll('*')).forEach(function (k) {
        if (out.length > 12) return;
        var kr = k.getBoundingClientRect();
        if (!kr.width && !kr.height) return;
        if (kr.right <= W + 1 && kr.left >= -1) return;
        out.push('     ' + describe(k) +
                 '  L=' + Math.round(kr.left) + ' R=' + Math.round(kr.right) +
                 ' w=' + Math.round(kr.width) +
                 ' pos=' + getComputedStyle(k).position);
      });
      if (out.length) {
        L.push('   содержимое за краями экрана:');
        out.forEach(function (s) { L.push(s); });
      }

      L.push('   разметка: ' +
             el.innerHTML.replace(/ on[a-z]+="[^"]*"/g, '')
                         .replace(/\s+/g, ' ').trim().slice(0, 700));
    });

    if (!n) L.push('(слоёв нет — окно надо открыть ДО отчёта)');
  }

  /* Чем страница догружает содержимое. Понадобилось для пыни: ленту
     уведомлений строит скрипт лепры уже в браузере, и в ответе сервера
     её нет — значит, она приходит отдельным запросом, а каким именно,
     из сохранённой страницы не узнать (скрипты в MHTML не попадают).
     Хуки на fetch и XMLHttpRequest тут не годятся: скрипт может жить в
     отдельном окружении и до вызовов лепры не дотянуться. Хронология
     ресурсов общая на весь документ и видна всем. */
  function reportNetwork(L) {
    L.push('', '--- сетевые запросы ---');
    var list = [];
    try { list = performance.getEntriesByType('resource') || []; } catch (e) {}
    var n = 0;
    list.forEach(function (r) {
      if (n >= 30) return;
      if (r.initiatorType !== 'xmlhttprequest' && r.initiatorType !== 'fetch') return;
      n++;
      L.push(r.name.replace(/^https?:\/\/(www\.)?/, '').slice(0, 110) +
             '  ' + Math.round(r.duration) + 'мс' +
             (r.transferSize ? ' ' + Math.round(r.transferSize / 1024) + 'КБ' : ''));
    });
    if (!n) L.push('(запросов не было)');

    L.push('', '--- перехвачено (метод и заголовки) ---');
    if (!NET.length)
      L.push('(ничего — либо запросов не было, либо скрипт живёт',
             ' в отдельном окружении и до вызовов лепры не достаёт)');
    NET.slice(0, 30).forEach(function (s) { L.push(s); });
  }

  function reportFloats(L) {
    L.push('', '--- плавающие колонки ---');
    var n = 0;
    root().querySelectorAll('div, aside, section, ul').forEach(function (el) {
      if (n >= 10) return;
      var cs = getComputedStyle(el);
      if (cs.cssFloat === 'none') return;
      var r = el.getBoundingClientRect();
      if (r.width < 80) return;
      n++;
      L.push(describe(el) + ' float=' + cs.cssFloat +
             ' w=' + Math.round(r.width) + ' css-width=' + cs.width);
    });
    if (!n) L.push('(нет)');
  }

  /* Инлайновый элемент, текст которого перенёсся на несколько строк, отдаёт
     из getBoundingClientRect объединяющий прямоугольник: он накрывает и то,
     что стоит слева от первой строки, и то, что справа от последней. Отсюда
     ложные «наложения» на ровном месте. Поэтому сравниваем не габарит, а
     строчные фрагменты. */
  function fragments(el, r) {
    var list = el.getClientRects();
    if (!list || list.length < 2) return [r];
    var out = [];
    for (var i = 0; i < list.length && i < 16; i++) {
      if (list[i].width > 1 && list[i].height > 1) out.push(list[i]);
    }
    return out.length ? out : [r];
  }

  function lines(c) { return c.f.length > 1 ? ' (строк: ' + c.f.length + ')' : ''; }

  function rectsArea(rs) {
    var s = 0;
    for (var i = 0; i < rs.length; i++) s += rs[i].width * rs[i].height;
    return s;
  }

  /* Лепра прячет формы покупки не классом, а высотой: контейнеру ставится
     height: 0 с overflow: hidden, и содержимое обрезается. Прямоугольники
     у обрезанного содержимого остаются прежние, поэтому в отчёте оно
     исправно «перекрывало» соседей — треть страницы магазина уходила на
     наложения, которых глазом не видно. Считаем невидимым всё, что лежит
     внутри обрезающего предка нулевой высоты. */
  function insideCollapsed(el) {
    for (var p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      if (p.clientHeight > 0 && p.clientWidth > 0) continue;
      var cs = getComputedStyle(p);
      if (cs.overflow === 'hidden' || cs.overflowY === 'hidden' ||
          cs.overflowX === 'hidden') return true;
    }
    return false;
  }

  /* Скрытое прозрачностью тоже даёт ложные наложения: у лепры меню
     отписок в каждом уведомлении — это абсолютно позиционированный
     список с opacity: 0 и visibility: hidden, который раскрывается
     наведением. Прямоугольники у него настоящие, и в отчёте он
     исправно перекрывал подписи всех уведомлений подряд. */
  function insideInvisible(el) {
    if (getComputedStyle(el).visibility === 'hidden') return true;
    for (var p = el; p && p !== document.body; p = p.parentElement) {
      if (parseFloat(getComputedStyle(p).opacity) === 0) return true;
    }
    return false;
  }

  /* Наложения ищем попарно среди «листьев» — элементов без вложенных блоков.
     Самый частый вид поломки при переносе десктопной вёрстки, и на глаз
     заметен не всегда. */
  function reportOverlaps(L) {
    L.push('', '--- наложения ---');
    var cand = [];
    var all = root().querySelectorAll(
      'a, span, label, input, button, select, li, p, h1, h2, h3, strong, em, div');

    for (var i = 0; i < all.length && cand.length < 300; i++) {
      var el = all[i];
      if (el.closest('#lm-debug') || el.closest('.plupload')) continue;
      if (el.querySelector('a, span, label, input, button, select, div')) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (r.bottom < -2000 || r.top > window.innerHeight + 4000) continue;
      if (insideCollapsed(el)) continue;
      if (insideInvisible(el)) continue;
      cand.push({ el: el, r: r, f: fragments(el, r) });
    }

    var found = 0;
    for (var a = 0; a < cand.length && found < 12; a++) {
      for (var b = a + 1; b < cand.length && found < 12; b++) {
        var A = cand[a], B = cand[b];
        if (A.el.contains(B.el) || B.el.contains(A.el)) continue;
        /* дешёвая отсечка по габаритам: если не пересекаются они,
           не пересекутся и фрагменты */
        var w = Math.min(A.r.right, B.r.right) - Math.max(A.r.left, B.r.left);
        var h = Math.min(A.r.bottom, B.r.bottom) - Math.max(A.r.top, B.r.top);
        if (w <= 1 || h <= 1) continue;

        var inter = 0;
        for (var i = 0; i < A.f.length; i++) {
          for (var j = 0; j < B.f.length; j++) {
            var fw = Math.min(A.f[i].right, B.f[j].right) -
                     Math.max(A.f[i].left, B.f[j].left);
            var fh = Math.min(A.f[i].bottom, B.f[j].bottom) -
                     Math.max(A.f[i].top, B.f[j].top);
            if (fw > 1 && fh > 1) inter += fw * fh;
          }
        }
        if (inter <= 1) continue;
        var small = Math.min(rectsArea(A.f), rectsArea(B.f));
        if (inter < small * 0.3) continue;
        found++;
        L.push(describe(A.el) + lines(A) + '  [' +
               (A.el.textContent || '').trim().slice(0, 20) + ']');
        L.push('   \u2195 перекрывает \u2195');
        L.push(describe(B.el) + lines(B) + '  [' +
               (B.el.textContent || '').trim().slice(0, 20) + ']');
        L.push('   pos: ' + getComputedStyle(A.el).position + ' / ' +
               getComputedStyle(B.el).position);
        L.push('   предок A: ' + positionedParent(A.el));
        L.push('   предок B: ' + positionedParent(B.el));
        L.push('');
      }
    }
    if (!found) L.push('(наложений не найдено)');
  }

  function reportMedia(L) {
    L.push('', '--- видео ---');
    var vids = root().querySelectorAll('video');
    L.push('всего video: ' + vids.length);
    for (var i = 0; i < Math.min(vids.length, 6); i++) {
      var v = vids[i], r = v.getBoundingClientRect();
      L.push('  readyState=' + v.readyState +
             ' ' + v.videoWidth + 'x' + v.videoHeight +
             ' rect=' + Math.round(r.width) + 'x' + Math.round(r.height) +
             ' ratio=' + (v.style.aspectRatio || '-'));
      L.push('    preload=' + v.getAttribute('preload') +
             ' poster=' + (v.getAttribute('poster') || '-').slice(0, 60) +
             ' userPlayed=' + (v.dataset.lmUserPlayed || '0'));
    }

    var players = root().querySelectorAll('.js-media_player, .b-media_player');
    var empty = null;
    for (var q = 0; q < players.length; q++)
      if (isEmptyPlayer(players[q])) { empty = players[q]; break; }
    L.push('плееров: ' + players.length +
           ', пустых: ' + (empty ? 'есть' : 'нет'));
    if (empty) L.push(empty.outerHTML.slice(0, 500));
  }

  /* Панель «показывать / сортировать / только новое». Интервалы здесь
     складываются из четырёх источников: собственные поля пунктов, поля
     самих полей выбора, пробельные узлы между инлайновыми элементами и
     внутренние отступы select'а, который в Safari рисует стрелку внутри
     своей коробки. Глазом эти четыре не различить, поэтому меряем зазор
     между соседями напрямую и рядом печатаем, из чего он складывается. */
  function reportFilters(L) {
    var box = document.querySelector('.b-my_posts_feed_controls');
    if (!box) { L.push('(нет)'); return; }

    var p = box.querySelector('p') || box;
    L.push(p.outerHTML.replace(/<option[\s\S]*?<\/option>/g, '')
                      .replace(/ on[a-z]+="[^"]*"/g, '')
                      .replace(/\s+/g, ' ').slice(0, 500));

    var kids = sliceOf(p.childNodes).filter(function (n) {
      if (n.nodeType === 3) return !!n.nodeValue.replace(/\s/g, '').length ||
                                   n.nodeValue.length > 0;
      return n.nodeType === 1;
    });
    L.push('узлов в строке: ' + kids.length + ' (текстовых пробельных: ' +
           kids.filter(function (n) {
             return n.nodeType === 3 && !n.nodeValue.trim();
           }).length + ')');

    /* Всё, что реально занимает место: пункты и поля внутри них. */
    var prev = null;
    sliceOf(p.querySelectorAll(
      '.b-my_posts_feed_controls_item, select, input, label')).forEach(function (el) {
      var cs = getComputedStyle(el), r = el.getBoundingClientRect();
      if (cs.display === 'none' || (!r.width && !r.height)) return;
      var isItem = el.classList.contains('b-my_posts_feed_controls_item');
      L.push((isItem ? '' : '   ') + describe(el).slice(0, 40) +
             ' L=' + Math.round(r.left) + ' R=' + Math.round(r.right) +
             ' w=' + Math.round(r.width) +
             ' mar=' + cs.margin + ' pad=' + cs.padding +
             ' style="' + (el.getAttribute('style') || '') + '"');
      if (isItem) {
        if (prev) L.push('  ЗАЗОР между пунктами: ' +
                         Math.round(r.left - prev.right) + 'px');
        prev = r;
      }
    });

    /* Зазор, который видит человек, считается не от коробок пунктов,
       а от края нарисованного поля до края следующего. */
    var ctrls = sliceOf(p.querySelectorAll('select, input, label'))
      .filter(function (el) {
        var r = el.getBoundingClientRect();
        return getComputedStyle(el).display !== 'none' && r.width > 0;
      });
    for (var i = 1; i < ctrls.length; i++) {
      var a = ctrls[i - 1].getBoundingClientRect(),
          b = ctrls[i].getBoundingClientRect();
      if (b.left < a.left) continue;              /* перенос строки */
      L.push('ВИДИМЫЙ зазор ' + ctrls[i - 1].nodeName.toLowerCase() +
             ' \u2192 ' + ctrls[i].nodeName.toLowerCase() + ': ' +
             Math.round(b.left - a.right) + 'px');
    }
  }

  /* Профиль. Без таблицы стилей лепры под рукой ширины и отступы здесь
     приходится угадывать, а угадывание стабильно стоит трёх лишних кругов.
     Отчёт отвечает на три вопроса сразу: чем нарисована серая полоса, кто
     режет ширину заметки и откуда боковые поля у блока пользователя. */
  function reportProfile(L) {
    var block = document.querySelector('.b-user_block');
    if (!block) { L.push('(страница не профиль)'); return; }

    var W = document.documentElement.clientWidth;

    function line(pad, el) {
      var cs = getComputedStyle(el), r = el.getBoundingClientRect();
      return pad + describe(el).slice(0, 44) +
             ' disp=' + cs.display + ' pos=' + cs.position +
             ' fl=' + cs.cssFloat +
             ' w=' + cs.width + ' maxw=' + cs.maxWidth +
             ' pad=' + cs.padding + ' mar=' + cs.margin +
             ' bg=' + cs.backgroundColor +
             (cs.backgroundImage === 'none' ? '' : ' bgimg=есть') +
             ' | L=' + Math.round(r.left) + ' w=' + Math.round(r.width) +
             ' h=' + Math.round(r.height);
    }

    L.push('CSS-ширина ' + W);
    L.push(line('блок: ', block));

    L.push('', 'узлы блока (широкие или бестекстовые):');
    sliceOf(block.querySelectorAll('*')).slice(0, 120).forEach(function (el) {
      var cs = getComputedStyle(el);
      if (cs.display === 'none') return;
      var r = el.getBoundingClientRect();
      if (r.height < 8) return;
      var empty = (el.textContent || '').replace(/[\s\u00a0]/g, '') === '';
      if (!empty && r.width > W * 0.5) return;      /* нормальные широкие — не интересны */
      L.push(line('  ', el));
    });

    var n = noteEl();
    L.push('', 'заметка: ' + (n ? JSON.stringify(noteText(n).slice(0, 60)) : '(нет)'));
    if (n) {
      var el = n, d = 0;
      while (el && d < 7 && el !== document.body) {
        L.push(line('  ', el));
        el = el.parentElement; d++;
      }
    }

    /* Окно голосов: если хвостик показывает мимо счётчика или окно всё
       ещё за краем — здесь видно, к чему оно на самом деле прицеплено
       и какие у него координаты. Гадать про это дороже, чем напечатать. */
    var vp = document.querySelector('.b-votes_popup:not(.invisible)');
    L.push('', 'окно голосов: ' + (vp ? 'открыто' : '(закрыто)'));
    if (vp) {
      L.push(line('  ', vp));
      L.push('  сдвиг: ' + (vp.style.transform || '(нет)') +
             ' | предок по позиции: ' + positionedParent(vp));
      var an = popupAnchor(vp);
      if (an) L.push(line('  якорь: ', an));
      sliceOf(vp.querySelectorAll('.b-votes_popup_arrow')).forEach(function (t) {
        L.push(line('  хвостик: ', t));
      });
    }

    var pn = document.querySelector('.b-user_public_notes');
    if (pn) {
      L.push('', 'строка заметок:');
      L.push(line('  ', pn));
      sliceOf(pn.children).forEach(function (c) {
        if (getComputedStyle(c).display === 'none') return;
        L.push(line('    ', c));
      });
    }
  }

  function report() {
    var L = ['Lepra Mobile v' + VERSION,
             'URL: ' + location.pathname,
             'экран устройства: ' + screenWidth() +
               ' | окно: ' + window.innerWidth +
               ' | CSS-ширина: ' + document.documentElement.clientWidth,
             'ширина документа: ' + document.documentElement.scrollWidth,
             ''];
    reportOverflow(L);
    reportNetwork(L);
    reportFloats(L);
    reportOverlaps(L);
    reportMedia(L);

    /* Разметка подписи поста и шапки: чтобы не гадать, чем именно
       прячутся значки и что двигает приветствие. */
    L.push('', '--- подпись поста ---');
    var ddi = document.querySelector('.dd .ddi');
    if (!ddi) L.push('(нет)');
    else {
      L.push(ddi.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '[svg]')
                          .replace(/\s+/g, ' ').slice(0, 700));
      L.push('');
      sliceOf(ddi.querySelectorAll('a, span.b-post_controls, span.lm-icons')).slice(0, 18)
        .forEach(function (el) {
          var cs = getComputedStyle(el), r = el.getBoundingClientRect();
          L.push('  ' + describe(el).slice(0, 46) +
                 ' disp=' + cs.display +
                 ' va=' + cs.verticalAlign +
                 ' fs=' + cs.fontSize +
                 ' top=' + Math.round(r.top) + ' h=' + Math.round(r.height));
        });
    }

    L.push('', '--- подпись комментария ---');
    var cf = document.querySelector('#js-comments .comment .c_footer');
    if (!cf) L.push('(нет)');
    else {
      L.push(cf.outerHTML.replace(/<svg[\s\S]*?<\/svg>/g, '[svg]')
                         .replace(/\s+/g, ' ').slice(0, 700));
      L.push('');
      var cfr = cf.getBoundingClientRect(), cfs = getComputedStyle(cf);
      L.push('контейнер: disp=' + cfs.display + ' wrap=' + cfs.flexWrap +
             ' gap=' + cfs.gap + ' lh=' + cfs.lineHeight +
             ' L=' + Math.round(cfr.left) + ' w=' + Math.round(cfr.width) +
             ' h=' + Math.round(cfr.height));

      sliceOf(cf.querySelectorAll('*')).slice(0, 20).forEach(function (el) {
        var cs = getComputedStyle(el), r = el.getBoundingClientRect();
        if (cs.display === 'none') return;
        L.push('  ' + describe(el).slice(0, 44) +
               ' disp=' + cs.display +
               ' pos=' + cs.position +
               ' fs=' + cs.fontSize +
               ' L=' + Math.round(r.left) + ' top=' + Math.round(r.top) +
               ' w=' + Math.round(r.width) + ' h=' + Math.round(r.height));
      });
    }

    L.push('', '--- шапка: приветствие ---');
    var tg = document.querySelector('.l-header_tagline');
    if (!tg) L.push('(нет)');
    else {
      var hd = document.querySelector('.l-header');
      var hcs = getComputedStyle(hd), tcs = getComputedStyle(tg);
      var hr = hd.getBoundingClientRect(), tr = tg.getBoundingClientRect();
      L.push('шапка: display=' + hcs.display + ' justify=' + hcs.justifyContent +
             ' L=' + Math.round(hr.left) + ' w=' + Math.round(hr.width));
      L.push('приветствие: flex=' + tcs.flex + ' align=' + tcs.textAlign +
             ' L=' + Math.round(tr.left) + ' w=' + Math.round(tr.width));
      var inner = tg.querySelector('.b-header_tagline');
      if (inner) {
        var ir = inner.getBoundingClientRect(), ics = getComputedStyle(inner);
        L.push('текст: align=' + ics.textAlign + ' margin=' + ics.margin +
               ' L=' + Math.round(ir.left) + ' w=' + Math.round(ir.width));
      }
    }

    L.push('', '--- шапка: поиск ---');
    var sf = document.querySelector('.l-header .b-header_search form');
    if (!sf) L.push('(нет)');
    else {
      L.push(sf.outerHTML.replace(/ on[a-z]+="[^"]*"/g, '')
                         .replace(/\s+/g, ' ').slice(0, 400));
      var scs = getComputedStyle(sf), sr = sf.getBoundingClientRect();
      L.push('форма: disp=' + scs.display + ' justify=' + scs.justifyContent +
             ' gap=' + scs.gap +
             ' L=' + Math.round(sr.left) + ' R=' + Math.round(sr.right));
      sliceOf(sf.querySelectorAll('*')).slice(0, 10).forEach(function (el) {
        var cs = getComputedStyle(el), r = el.getBoundingClientRect();
        L.push('  ' + describe(el).slice(0, 40) +
               ' disp=' + cs.display + ' pos=' + cs.position +
               ' left=' + cs.left +
               ' w=' + cs.width + ' pad=' + cs.padding +
               ' mar=' + cs.margin +
               ' | L=' + Math.round(r.left) + ' R=' + Math.round(r.right) +
               ' h=' + Math.round(r.height));
        ['::before', '::after'].forEach(function (p) {
          var ps = getComputedStyle(el, p);
          if (!ps || ps.content === 'none' || ps.display === 'none') return;
          L.push('    ' + p + ' content=' + ps.content +
                 ' disp=' + ps.display + ' w=' + ps.width +
                 ' pad=' + ps.padding + ' mar=' + ps.margin);
        });
      });
    }

    L.push('', '--- профиль ---');
    reportProfile(L);

    L.push('', '--- панель фильтров ---');
    reportFilters(L);

    L.push('', '--- слои поверх страницы ---');
    reportOverlays(L);

    L.push('', '--- журнал скрипта ---');
    if (!LOG.length) L.push('(пусто — ошибок не было)');
    else LOG.forEach(function (m) { L.push(m); });

    return L.join('\n');
  }

  /* Инспектор: следующий тап показывает элемент под пальцем.
     Заменил собой десяток итераций «угадай, какой это селектор». */
  function inspectAt(el) {
    var L = ['Lepra Mobile v' + VERSION, 'ТЫК ПО ЭЛЕМЕНТУ', '',
             '--- цепочка родителей ---'];

    var chain = [], n = el, d = 0;
    while (n && n.tagName && d < 7) { chain.push(describe(n)); n = n.parentElement; d++; }
    L.push(chain.join('\n  < '));

    var r = el.getBoundingClientRect();
    L.push('', '--- сам элемент ---');
    L.push('размер ' + Math.round(r.width) + 'x' + Math.round(r.height) +
           ' pos=' + getComputedStyle(el).position);
    L.push(el.outerHTML.slice(0, 700));

    /* ближайший крупный контейнер: там обычно и лежат data-атрибуты */
    var box = el, steps = 0;
    while (box.parentElement && steps < 6) {
      var br = box.getBoundingClientRect();
      if (br.height > 80 && br.width > 80) break;
      box = box.parentElement; steps++;
    }
    if (box !== el) {
      L.push('', '--- контейнер ---');
      L.push(describe(box));
      L.push(box.outerHTML.slice(0, 900));
    }
    showPanel(L.join('\n'));
  }

  function armInspector() {
    closePanel();
    var handler = function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      document.removeEventListener('click', handler, true);
      inspectAt(e.target);
    };
    document.addEventListener('click', handler, true);
  }

  /* Ленту уведомлений лепра собирает в браузере: тянет шаблоны из
     /static/views/notifications/ и данные из /api/my/notifications/.
     Первая же проба этого адреса вернула 404 при том, что сама лепра
     ходит туда успешно, — значит, дело не в адресе, а в чём-то ещё:
     заголовке, параметрах или правах. Гадать по одному варианту в круг
     дорого, поэтому проба перебирает их сразу и показывает ответ на
     каждый. */
  function pynProbe() {
    var base = location.protocol + '//' + location.host;
    var API = '/api/my/notifications/?per_page=20&page=1';
    var tries = [
      ['GET, как у лепры', API, 'GET', {}],
      ['GET + X-Requested-With', API, 'GET',
       { 'X-Requested-With': 'XMLHttpRequest' }],
      ['POST', API, 'POST', {}],
      ['POST + X-Requested-With', API, 'POST',
       { 'X-Requested-With': 'XMLHttpRequest' }],
      ['GET замены (контроль)', '/api/replacements/', 'GET', {}],
      ['POST замены (контроль)', '/api/replacements/', 'POST', {}],
      ['GET страница пыни (контроль)', '/my/events/', 'GET', {}]
    ];

    var out = ['Проба API пыни',
               'источник: ' + base,
               'куки видны скрипту: ' +
                 (document.cookie ? document.cookie.length + ' знаков' : 'НЕТ'),
               ''];
    showPanel(out.join('\n') + '\nжду ответов…');

    var i = 0;
    var next = function () {
      if (i >= tries.length) return showPanel(out.join('\n'));
      var t = tries[i++];
      var say = function (s, body, ct) {
        out.push(t[0] + '  →  ' + s + (ct ? '  [' + ct + ']' : ''));
        out.push('   ' + t[2] + ' ' + t[1]);
        if (body) out.push('   ' + body.slice(0, 240).replace(/\s+/g, ' '));
        out.push('');
      };
      fetch(base + t[1], { method: t[2], credentials: 'same-origin', headers: t[3] })
        .then(function (r) {
          var ct = r.headers.get('content-type') || '';
          return r.text().then(function (x) {
            say('HTTP ' + r.status + '  ' + x.length + ' знаков', x, ct.slice(0, 30));
          });
        })
        .catch(function (e) { say('ошибка: ' + ((e && e.message) || e)); })
        .then(next);
    };
    next();
  }

  function closePanel() {
    var old = document.getElementById('lm-debug');
    if (old) old.remove();
  }

  function showPanel(text) {
    closePanel();

    var p = document.createElement('div');
    p.id = 'lm-debug';

    var copy = document.createElement('button');
    copy.textContent = 'скопировать';
    copy.onclick = function () {
      if (!navigator.clipboard) return;
      navigator.clipboard.writeText(text).then(
        function () { copy.textContent = 'скопировано'; },
        function () { copy.textContent = 'не вышло, выделяйте руками'; });
    };

    var close = document.createElement('button');
    close.textContent = 'закрыть';
    close.onclick = closePanel;

    var pick = document.createElement('button');
    pick.textContent = 'тык по элементу';
    pick.onclick = armInspector;

    var probe = document.createElement('button');
    probe.textContent = 'ответ пыни';
    probe.onclick = pynProbe;

    var body = document.createElement('div');
    body.textContent = text;

    p.appendChild(copy);
    p.appendChild(close);
    p.appendChild(pick);
    p.appendChild(probe);
    p.appendChild(body);
    document.body.appendChild(p);
  }

  function panel() {
    if (document.getElementById('lm-debug')) { closePanel(); return; }
    showPanel(report());
  }

  if (CFG.debug) {
    window.lmDebug = panel;

    /* три быстрых тапа по левому верхнему углу */
    var taps = [];
    document.addEventListener('touchstart', function (e) {
      var t = e.touches[0];
      if (!t || t.clientX > 60 || t.clientY > 60) return;
      var now = Date.now();
      taps = taps.filter(function (x) { return now - x < 1500; });
      taps.push(now);
      if (taps.length >= 3) { taps = []; panel(); }
    }, { passive: true });

    window.addEventListener('hashchange', function () { setTimeout(panel, 100); });
  }

  /* ============================================================
     10. ЗАПУСК
     ============================================================ */

  /* Полный проход: тяжёлые обходы DOM только здесь, не при прокрутке. */
  function fullPass() {
    guard('ensureThemeToggle', ensureThemeToggle)();
    guard('setThemeColor', setThemeColor)();
    guard('ensureNav', ensureNav)();
    guard('watchRefreshButton', watchRefreshButton)();
    guard('compactThreadToggles', compactThreadToggles)();
    guard('compactPostFooters', compactPostFooters)();
    guard('compactCommentDates', compactCommentDates)();
    /* класс страницы — до перестройки шапки: она смотрит на него */
    guard('markTabsPage', markTabsPage)();
    guard('markFraudPage', markFraudPage)();
    guard('relayoutHeader', relayoutHeader)();
    /* строго после шапки: она собирает шапку, за которой встаёт блок */
    guard('buildNavthing', buildNavthing)();
    guard('fixEventsPage', fixEventsPage)();
    guard('fixNewPost', fixNewPost)();
    guard('fixRanks', fixRanks)();
    guard('syncVeg', syncVeg)();
    guard('fitGertruda', fitGertruda)();
    /* строго после шапки: она забирает из правой колонки порог постов */
    guard('buildSubsitePince', buildSubsitePince)();
    /* после пенсне: оно забирает из-под девиза правую колонку, и до этого
       ширина у заголовка бывает другой */
    guard('fitSubsiteHeader', fitSubsiteHeader)();
    guard('markProfileArt', markProfileArt)();
    guard('fixUserNote', fixUserNote)();
    guard('moveKarmaToName', moveKarmaToName)();
    guard('watchVotesPopup', watchVotesPopup)();
    guard('fitVotesPopup', fitVotesPopup)();
    guard('fitOverlays', fitOverlays)();
    guard('groupNotesRow', groupNotesRow)();
    guard('compactCitizen', compactCitizen)();
    guard('fixUsersList', fixUsersList)();
    guard('buildUsersRows', buildUsersRows)();
    guard('watchUserCards', watchUserCards)();
    guard('fixMyThings', fixMyThings)();
    guard('shortenSubNav', shortenSubNav)();
    guard('fitSelects', fitSelects)();
    /* строку фильтров меряем ПОСЛЕ подгонки полей: до неё ширины ещё не те */
    guard('fitFiltersRow', fitFiltersRow)();
    /* строки настроек списка граждан меряем после подгонки полей */
    guard('fitUsersRows', fitUsersRows)();
    guard('shortenTabs', shortenTabs)();
    guard('unfloatWide', unfloatWide)();
    guard('registerMedia', registerMedia)();
    guard('fixMediaSizes', fixMediaSizes)();
    guard('fixOverflow', fixOverflow)();
  }

  /* Лёгкий проход при прокрутке: только поиск по конкретным селекторам.
     Полный обход здесь занимал главный поток на секунды. */
  function lightPass() {
    guard('registerMedia', registerMedia)();
    guard('fixMediaSizes', fixMediaSizes)();
    /* заметка профиля: лепра переписывает её содержимое своим скриптом */
    guard('maybeShortenNote', maybeShortenNote)();
    /* окно голосов наполняется списком после ответа сервера — переставляем
       его ещё раз, когда узлы списка уже на месте */
    guard('fitVotesPopup', fitVotesPopup)();
    guard('fitOverlays', fitOverlays)();
    guard('syncThemeColor', syncThemeColor)();
    /* комментарии могли догрузиться — числа и подписи устарели */
    guard('refreshCommentCounters', refreshCommentCounters)();
    guard('compactThreadToggles', compactThreadToggles)();
    guard('compactPostFooters', compactPostFooters)();
    guard('compactCommentDates', compactCommentDates)();
    /* список граждан догружается кнопкой «Загрузить ещё» */
    guard('fixUsersList', fixUsersList)();
    guard('buildUsersRows', buildUsersRows)();
  }

  function start() {
    fullPass();
    setTimeout(fullPass, 800);
    setTimeout(fullPass, 2500);
    if (CFG.debug && /lmdebug/.test(location.hash + location.search))
      setTimeout(panel, 400);
  }

  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', start);
  else start();

  window.addEventListener('load', function () {
    setTimeout(fullPass, 300); watchDom(); guard('watchTaps', watchTaps)();
  });
  window.addEventListener('orientationchange', function () { setTimeout(fullPass, 300); });

  /* Масштаб страницы Den меняет прямо на ходу, и CSS-ширина скачет от 462
     до 340 без поворота экрана. Пересчитывать надо только то, что подобрано
     замером; полный проход сюда вешать нельзя — resize в Safari прилетает
     и от прячущейся адресной строки, то есть при обычной прокрутке.
     Поэтому: сверяем ширину и трогаем один заголовок. */
  var resizeTimer = null;

  window.addEventListener('resize', function () {
    if (resizeTimer) return;
    resizeTimer = setTimeout(function () {
      resizeTimer = null;
      if (document.documentElement.clientWidth === titleWidth) return;
      guard('fitSubsiteHeader', fitSubsiteHeader)();
      guard('fitGertruda', fitGertruda)();
    }, 300);
  });

  /* Прокрутка сама по себе ничего не запускает: раньше каждые 150 мс шёл
     поиск по всему документу, а лента длиной в сорок тысяч пикселей делает
     это дорогим. Новые узлы (догрузка комментариев, разворот веток) ловит
     наблюдатель за изменениями — он срабатывает только когда есть что
     обрабатывать. */
  var mutationTimer = null;

  function scheduleLightPass() {
    if (mutationTimer) return;
    mutationTimer = setTimeout(function () {
      mutationTimer = null;
      lightPass();
    }, 400);
  }

  /* Модальное окно лепра рисует в ответ на нажатие. Наблюдатель за узлами
     ловит не всякое: часть окон уже лежит в разметке скрытой, и лепра
     только меняет им стиль — добавления узлов при этом нет. Поэтому после
     каждого нажатия проверяем слои отдельно, тремя заходами: разметка,
     раскладка и анимация появления доходят до конца не сразу. */
  function watchTaps() {
    document.addEventListener('click', function () {
      [60, 260, 700].forEach(function (ms) {
        setTimeout(guard('fitOverlays', fitOverlays), ms);
        setTimeout(guard('syncThemeColor', syncThemeColor), ms);
      });
    }, true);
  }

  function watchDom() {
    if (!('MutationObserver' in window) || !document.body) return;
    var target = document.getElementById('js-comments') ||
                 document.getElementById('js-posts_holder') ||
                 document.body;
    new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i++)
        if (records[i].addedNodes && records[i].addedNodes.length)
          return scheduleLightPass();
    }).observe(target, { childList: true, subtree: true });
  }
})();
