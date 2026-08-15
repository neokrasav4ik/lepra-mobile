// ==UserScript==
// @name         Lepra Mobile
// @namespace    lepra.mobile
// @version      0.9.47
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

  var VERSION = '0.9.47';

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
    toggle:  new Marks()    /* кнопка сворачивания перенесена */
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
  padding-left: 12px !important; padding-right: 12px !important;
  box-sizing: border-box !important; }

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
  text-align: center !important; line-height: 1.4 !important;
  margin: 2px 0 4px !important; }

.l-header > .b-header_counters {
  order: 5 !important; flex: 0 1 auto !important;
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
  order: 6 !important; flex: 1 1 auto !important; min-width: 0 !important;
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
  flex: 1 1 50% !important; }

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
  display: flex !important; justify-content: flex-end !important;
  align-items: center !important;
  margin: 4px 0 0 !important; padding: 0 !important;
  text-align: right !important; }

/* Опустевшие обёртки. Важно: у них нет order, а значит он равен нулю —
   такой блок встаёт в строке ПЕРЕД приветствием (order:1) и сдвигает его
   вправо на свою ширину. Именно поэтому приветствие казалось центрированным. */
.l-header_aside, .b-header_aside { order: 9 !important; }
.l-header_aside:empty, .b-header_aside:empty,
.b-index_navigation_holder:empty { display: none !important; }

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
  line-height: 1.4 !important; font-size: 13px !important; }

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
/* загрузчик файлов живёт и на полной странице создания поста:
   у него была фиксированная высота и отрицательный внешний отступ */
.b-new_post_file_uploader {
  width: 100% !important; height: auto !important; margin: 0 !important; }
.b-new_post_file_uploader .b-file_uploader { top: 0 !important; }

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

/* Серая полоса под фон профиля. Причина по all.css:
   .b-user_block { padding-top: 46px; background: ... rgb(204,204,204) }
   Под картинку фона отведено 46px высоты и серая заливка на случай, когда
   картинки нет. Убираем и то и другое; вкладка смены фона скрыта ниже.
   Данные пользователя оставляем на белом — это карточка, а не полоса. */
.b-user_block {
  padding-top: 0 !important; background: none !important;
  min-height: 0 !important; height: auto !important; }
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

/* Четыре вкладки профиля с общими полями по 12px не помещались в 369px и
   переносились. При масштабе страницы 110% ширина падает до ~333, поэтому
   считаем с запасом: кегль 11, поля 5, зазор 3 — вся четвёрка около 280. */
.b-menu__profile .b-menu_list_row { gap: 3px !important; }
.b-menu__profile .b-menu_list_link {
  padding: 6px 5px !important; font-size: 11px !important;
  white-space: nowrap !important; flex: 0 1 auto !important; }
.b-menu__profile .b-menu_list_link i { font-size: 10px !important; }

/* ============ ПОДСАЙТЫ ============ */
.l-header_subsite { padding-left: 0 !important; }
.l-content_aside_subsite { display: none !important; }
.b-subsite_header {
  padding: 8px 0 0 0 !important; margin: 0 0 8px 0 !important;
  font-size: 22px !important; line-height: 1.25 !important;
  /* заголовок часто лежит поверх фотографии */
  text-shadow: 0 1px 2px rgba(255,255,255,.9) !important; }
/* дубликат логотипа: тот, что в шапке, лепра рисует своими средствами */
.b-subsite_logo { display: none !important; }
.l-content__subsite .b-archive_heading { padding-right: 0 !important; }
.b-new_sublepra { width: auto !important; padding: 12px 0 !important; }

/* правая колонка в 330px оставляла ленте около сорока пикселей */
.b-subdomain_aside_right {
  float: none !important; width: auto !important;
  margin: 0 0 14px !important; padding-bottom: 12px !important;
  border-bottom: 1px solid rgb(226, 224, 222) !important; }
.b-subdomain_aside_subscribe {
  height: auto !important; overflow: visible !important; }
.b-subdomain_aside_subscribe .b-subscribe_button {
  float: none !important; width: auto !important; margin: 0 0 6px !important; }
.b-subdomain_aside_subscribe_additional {
  float: none !important; width: auto !important; margin-top: 4px !important; }
.b-subdomain_aside_subscribe_expand {
  position: static !important; left: auto !important; top: auto !important;
  transform: none !important; display: inline-block !important;
  margin-left: 6px !important; }
.b-subdomain_settings_button { right: 4px !important; top: 4px !important; }

/* ============ СПИСОК ПОДСАЙТОВ (underground) ============ */
/* Тело пункта занимало 40% ширины, описание плавало на 45%, счётчики
   стояли абсолютно на 40, 52 и 64 процентах — всё складывалось в кашу. */
.b-list_item { padding-bottom: 8px !important; }
.b-list_item_body { width: auto !important;
                    padding: 12px 0 12px 78px !important; }
.b-list_item_logo { top: 12px !important; left: 2px !important; }
.b-list_item_blog_description {
  float: none !important; width: auto !important;
  margin: 6px 0 10px !important; }
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
.b-underground_nav { padding: 0 !important; }

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
  position: fixed !important; right: 8px !important; top: 50% !important;
  transform: translateY(-50%) !important; z-index: 30 !important;
  display: flex !important; flex-direction: column !important;
  gap: 8px !important;
  /* коробка тапы не ловит — иначе перекрывала бы ссылки под собой */
  pointer-events: none !important; }
#lm-nav button, #lm-theme {
  /* при долгом удержании Safari предлагал выделить символ на кнопке */
  -webkit-user-select: none !important; user-select: none !important;
  -webkit-touch-callout: none !important;
  -webkit-tap-highlight-color: transparent !important;
  touch-action: manipulation !important; }
#lm-nav button {
  pointer-events: auto !important;
  width: 44px !important; height: 44px !important; padding: 0 !important;
  font: 20px/42px -apple-system, sans-serif !important;
  color: rgb(90,90,90) !important; text-align: center !important;
  background: rgba(255,255,255,.88) !important;
  border: 1px solid rgb(206,204,204) !important;
  border-radius: 22px !important; cursor: pointer !important; }
#lm-nav button:active { background: rgb(235,235,235) !important; }
#lm-nav .lm-nav_mine { font-size: 17px !important; }
#lm-nav .lm-nav_mine.lm-on {
  color: rgb(255,255,255) !important;
  background: rgb(120,120,120) !important;
  border-color: rgb(120,120,120) !important; }
#lm-nav .lm-nav_mine.lm-off {
  color: rgb(190,190,190) !important; opacity: .55 !important; }
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
                  '.b-subscribe_button, .l-content_aside, .b-tags';

  function unfloatWide() {
    var W = document.documentElement.clientWidth;
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
     СТРАНИЦА «МОИ ВЕЩИ»
     ============================================================ */

  /* Панель фильтров — два абзаца сплошного инлайнового потока. На узком
     экране вводная фраза занимала две строки, а подпись чекбокса
     переносилась под сам чекбокс. Фразу сокращаем, чекбокс с подписью
     заворачиваем в отдельную флекс-строку: перенос подписи тогда идёт
     по её собственному краю, а не по краю колонки. */
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

    /* Та же панель стоит на инбоксе, и там в «сортировать» лежит подпись
       «по последним комментариям». Поле выбора растягивается по самой
       длинной строке списка, и вся строка панели уезжает за край экрана.
       Меняем только видимую подпись: value лепра шлёт на сервер, его не
       трогаем. */
    sliceOf(box.querySelectorAll('select option')).forEach(function (o) {
      var t = (o.textContent || '').replace(/\u00a0/g, ' ').trim();
      if (/^по\s+последним\s+комментариям$/i.test(t))
        o.textContent = 'по комментариям';
    });

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

    /* «только новые посты и комментарии» — подпись длиной в полстроки при
       том, что фильтр в этой панели ровно один и других «новых» тут нет. */
    sliceOf(box.querySelectorAll('label')).forEach(function (el) {
      if (/^только\s+новые\s+посты\s+и\s+комментарии$/i
            .test((el.textContent || '').replace(/\u00a0/g, ' ').trim())) {
        el.title = (el.textContent || '').trim();
        el.textContent = 'только новые';
      }
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
    sliceOf(document.querySelectorAll('.lm-filters_row select'))
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
    ['.b-header_nav_new_post', '.b-header_counters',
     '.b-index_slider', '.b-header_search'].forEach(function (sel) {
      var el = document.querySelector(sel);
      if (el && !el.dataset.lmMoved && el.parentElement !== header) {
        el.dataset.lmMoved = '1';
        header.appendChild(el);
      }
    });

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
     5. ТЁМНАЯ ТЕМА
     ============================================================ */

  function isDark() {
    return document.documentElement.classList.contains('lm-dark');
  }

  function setDark(on) {
    document.documentElement.classList.toggle('lm-dark', on);
    try { localStorage.setItem('lm-dark', on ? '1' : '0'); } catch (e) {}
    var b = document.getElementById('lm-theme');
    if (b) b.textContent = on ? '\u2600' : '\u263E';
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

  var navMode = 'new';                        /* 'new' | 'mine' */
  var navCache = { key: '', list: [], time: 0 };

  /* Отступ приземления и порог отбора. Порог обязан быть БОЛЬШЕ отступа:
     иначе комментарий, только что поставленный на отметку LAND, снова
     проходит проверку, и каждый второй тап уходит впустую. */
  var LAND = 60, EDGE = LAND + 10;

  function commentsBy(kind) {
    var now = Date.now();
    if (navCache.key === kind && now - navCache.time < 3000) return navCache.list;

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

    navCache = { key: kind, list: list, time: now };
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
      navCache.time = 0;                      /* список комментариев устарел */
      [0, 500, 1500, 3000].forEach(function (ms) {
        setTimeout(guard('refreshCommentCounters', refreshCommentCounters), ms);
      });
    });
  }

  function hasMine() {
    var host = document.getElementById('js-comments');
    return !!(host && host.querySelector('.comment.mine'));
  }

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

  function jumpComment(dir) {
    var list = commentsBy(navMode);
    if (!list.length) return;

    var target = findTarget(list, dir);
    if (!target) return;

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

  function refreshNavState() {
    var box = document.getElementById('lm-nav');
    if (!box) return;
    var mineBtn = box.querySelector('.lm-nav_mine');
    if (!mineBtn) return;
    var has = hasMine();
    mineBtn.disabled = !has;
    mineBtn.classList.toggle('lm-off', !has);
    mineBtn.classList.toggle('lm-on', navMode === 'mine' && has);
  }

  /* Кнопка «наверх» нужна на любой странице, а стрелки по комментариям —
     только там, где комментарии есть. Поэтому набор кнопок разный. */
  function ensureNav() {
    if (document.getElementById('lm-nav')) { refreshNavState(); return; }
    if (!document.body) return;

    var hasComments = !!document.getElementById('js-comments');

    var box = document.createElement('div');
    box.id = 'lm-nav';

    /* Кнопка, не выделяющаяся при удержании: содержимое рисуем текстом,
       но выделение и системное меню запрещены стилями. */
    var makeButton = function (label, title) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
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
      var top = makeButton('\u2191', 'в начало страницы');
      top.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        toTop();
      });
      box.appendChild(top);
      document.body.appendChild(box);
      watchTopButton(box);
      return;
    }

    var arrow = function (label, dir) {
      var b = makeButton(label, dir < 0 ? 'предыдущий (удержать — в начало)'
                                        : 'следующий (удержать — в конец)');

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

    /* средняя кнопка переключает режим «новые / свои», как на десктопе */
    var mine = makeButton('\u25C9', 'прыгать по своим комментариям');
    mine.className = 'lm-nav_mine';
    mine.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      if (!hasMine()) return;
      navMode = (navMode === 'mine') ? 'new' : 'mine';
      refreshNavState();
    });

    box.appendChild(arrow('\u2191', -1));
    box.appendChild(mine);
    box.appendChild(arrow('\u2193', 1));
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

    var body = document.createElement('div');
    body.textContent = text;

    p.appendChild(copy);
    p.appendChild(close);
    p.appendChild(pick);
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
    guard('ensureNav', ensureNav)();
    guard('watchRefreshButton', watchRefreshButton)();
    guard('compactThreadToggles', compactThreadToggles)();
    guard('compactPostFooters', compactPostFooters)();
    guard('compactCommentDates', compactCommentDates)();
    guard('relayoutHeader', relayoutHeader)();
    guard('fixUserNote', fixUserNote)();
    guard('moveKarmaToName', moveKarmaToName)();
    guard('groupNotesRow', groupNotesRow)();
    guard('compactCitizen', compactCitizen)();
    guard('fixMyThings', fixMyThings)();
    guard('fitSelects', fitSelects)();
    /* строку фильтров меряем ПОСЛЕ подгонки полей: до неё ширины ещё не те */
    guard('fitFiltersRow', fitFiltersRow)();
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
    /* комментарии могли догрузиться — числа и подписи устарели */
    guard('refreshCommentCounters', refreshCommentCounters)();
    guard('compactThreadToggles', compactThreadToggles)();
    guard('compactPostFooters', compactPostFooters)();
    guard('compactCommentDates', compactCommentDates)();
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

  window.addEventListener('load', function () { setTimeout(fullPass, 300); watchDom(); });
  window.addEventListener('orientationchange', function () { setTimeout(fullPass, 300); });

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
