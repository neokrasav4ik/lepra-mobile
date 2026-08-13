// ==UserScript==
// @name         Lepra Mobile
// @namespace    lepra.mobile
// @version      0.3
// @description  Мобильная адаптация leprosorium.ru для iOS Safari
// @author       neokrasav4ik
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

  var VERSION = '0.6-beta';

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
    poked:   new Marks()    /* плеер разбужен */
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
  margin: 0 0 16px 0 !important; padding: 8px 0 12px !important;
  min-height: 0 !important;
  flex-wrap: wrap !important; align-items: flex-start !important;
  border-bottom: 1px solid rgb(214, 212, 212) !important; }

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
  display: inline-block !important; position: static !important;
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
  max-height: 32px !important; max-width: 32px !important;
  opacity: .85 !important; }

.l-header_nav { order: 3 !important; flex: 0 0 100% !important;
                width: auto !important; padding: 2px 6px !important;
                line-height: 2 !important; }
/* .b-header_nav — внутренняя обёртка лепры, не путать с .l-header_nav */
.b-header_nav { line-height: 2 !important; }
/* медали в навигации были absolute и ложились поверх соседнего текста */
.b-header_nav_link img { display: none !important; }
.b-header_nav_notifications { margin-right: 10px !important;
                              padding-left: 6px !important; }
.b-header_nav_fraud { margin-right: 8px !important; }

/* Две колонки: слева счётчики с поиском, справа фильтр с переключателями. */
.l-header_aside {
  order: 4 !important; flex: 1 1 46% !important;
  min-width: 0 !important; width: auto !important; padding: 0 !important; }
.b-header_counters { line-height: 1.5 !important; height: auto !important; }
.b-header_counters a { display: inline !important; }

.l-header .b-posts_threshold {
  order: 5 !important; flex: 1 1 46% !important;
  min-width: 0 !important; margin: 6px 0 0 !important; padding: 0 !important;
  text-align: right !important;
  /* переключатели режимов сверху, выпадающий список снизу */
  display: flex !important; flex-direction: column !important;
  align-items: flex-end !important; gap: 6px !important; }
.l-header .b-posts_threshold > * {
  display: flex !important; justify-content: flex-end !important;
  flex-wrap: wrap !important; }
.l-header .b-posts_threshold .b-index_slider,
.l-header .b-posts_threshold .b-index_navigation_holder { order: 1 !important; }
.l-header .b-posts_threshold form,
.l-header .b-posts_threshold select,
.l-header .b-posts_threshold .b-posts_threshold_select {
  order: 2 !important; text-align: right !important; }
.l-header .b-index_navigation_holder {
  margin: 0 !important; border: 0 !important;
  justify-content: flex-end !important; }
.l-header .b-index_slider,
.l-header .b-index_slider .b-slider_scale_icons {
  margin-left: auto !important; margin-right: 0 !important; }

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

/* ============ ЛЕНТА И ПОСТЫ ============ */
/* Белая полоса справа получалась из двух вложенных width:98%,
   плюс у поста было 270px внутреннего отступа под правую колонку. */
.b-posts_holder { width: 100% !important; padding-top: 0 !important; }
.post {
  float: none !important; width: auto !important;
  padding-right: 0 !important;
  margin-left: 0 !important; margin-right: 0 !important; }
.post .dt { padding-right: 0 !important; }
.dd { padding-right: 0 !important; }
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
#js-comments .comment { padding-bottom: 18px !important; }
${indentRules()}

/* Подпись в одну флекс-строку. div.ddi — блок, из-за него голосование
   уезжало на отдельную строку; display:contents убирает его собственный
   бокс, и ссылки попадают в общий ряд с кнопками. */
.comment .c_footer {
  display: flex !important; flex-wrap: wrap !important;
  align-items: center !important; gap: 0 7px !important;
  line-height: 1.7 !important; font-size: 13px !important; }
.comment .c_footer .ddi { display: contents !important; }
.comment .ddi { font-size: 13px !important; }
.comment .c_footer a, .comment .ddi a,
.comment .c_footer > *, .comment .ddi > * {
  display: inline-block !important;
  padding: 2px 1px !important; margin: 0 2px 0 0 !important; }

/* Сворачивание веток скрыто: занимало две строки на каждый комментарий.
   Чтобы вернуть — замените display:none на display:block. */
.b-comment_thread_collapse { display: none !important; }

/* Кнопки управления постом: у лепры height:13px с обрезкой, а подпись
   поднята на 7px вверх. Класс общий, используется не только свёрнутыми
   ветками, поэтому правило нужно и при скрытом сворачивании. */
.b-post_my_post_controls_button {
  display: block !important; height: auto !important;
  overflow: visible !important; vertical-align: baseline !important; }
.b-post_my_post_controls_button .b-button,
.b-post_my_post_controls_button .b-button_caption {
  position: static !important; top: auto !important;
  margin-left: 0 !important; }
.b-post_my_post_controls_button .b-button {
  display: inline-block !important; padding: 4px 0 !important; }
.b-post_my_post_controls_button .b-button_caption {
  white-space: normal !important; }

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
.dd .vote, .post .vote { margin: 12px 0 0 0 !important; }
.comment .c_footer .vote { margin: 0 !important; }

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

/* ============ ПРОФИЛЬ ============ */
/* Блок пользователя был жёстко 1200px с минимумом 800px, плюс шесть
   абсолютно позиционированных вставок поверх друг друга. */
.b-i-user_block, .b-user_data, .b-i-user_data,
.l-content_wrapper, .b-content_section,
.b-profile_left_col, .b-profile_right_col {
  width: auto !important; min-width: 0 !important; max-width: 100% !important;
  box-sizing: border-box !important; float: none !important;
  margin-left: 0 !important; margin-right: 0 !important; }
.b-user_data, .b-i-user_data, .b-info_block { display: block !important; }
.b-profile_left_col, .b-profile_right_col { line-height: 1.6 !important; }

.b-user_note_container {
  position: static !important; display: block !important;
  flex: 1 1 100% !important; width: 100% !important;
  max-width: 100% !important; margin: 6px 0 !important; }
.b-user_note, #js-usernote {
  position: static !important; display: block !important;
  width: 100% !important; max-width: 100% !important;
  box-sizing: border-box !important; }

/* карма: обёртка плавала вправо с отрицательными полями по всем сторонам,
   значение и кнопки висели абсолютно друг на друге */
.b-user_votes_wrapper {
  position: static !important; float: none !important;
  width: auto !important; height: auto !important; margin: 8px 0 !important; }
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
  position: static !important; width: 26px !important; height: 26px !important;
  line-height: 24px !important; font-size: 14px !important; }
/* нижний блок дублировал верхний: в потоке давал четыре кнопки вместо двух */
.b-user_karma .b-karma_controls__bot { display: none !important; }

.b-user_public_notes_logo { display: none !important; }
.b-user_public_notes_switcher, .b-user_public_notes_sorting {
  position: static !important; width: auto !important;
  display: inline-flex !important; align-items: center !important;
  gap: 8px !important; margin: 4px 10px 8px 0 !important; }
.b-user_public_notes_list, .b-user_public_notes_list ul {
  width: auto !important; margin-left: 0 !important; padding-left: 0 !important; }
.b-user_public_notes_list_note { margin-left: 0 !important; }
.b-user_public_notes_list_previous { display: none !important; }

.b-inbox_write_link {
  position: static !important; width: auto !important;
  margin: 8px 0 16px !important; }
.b-inbox_write { width: 100% !important; box-sizing: border-box !important; }

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

/* ============ ВКЛАДКИ (мои вещи, профиль, настройки) ============ */
/* Свёрстаны CSS-таблицей: ячейки таблицы не переносятся в принципе,
   строка обязана уместиться целиком. Переводим на флекс. */
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

/* Просмотрщик картинок: клик перехватывается до обработчика лепры,
   поэтому страница не перестраивается и прокрутка не сбивается. */
#lm-viewer {
  position: fixed !important; inset: 0 !important;
  z-index: 2147483646 !important;
  background: rgba(0,0,0,.92) !important;
  overflow: auto !important; -webkit-overflow-scrolling: touch !important;
  display: flex !important; align-items: center !important;
  justify-content: center !important; padding: 0 !important; }
#lm-viewer img {
  width: 100% !important; max-width: 100% !important; height: auto !important;
  margin: auto !important; display: block !important; }
#lm-viewer .lm-viewer_close {
  position: fixed !important; top: 10px; right: 10px;
  width: 44px; height: 44px; text-align: center;
  font: 24px/44px monospace; color: #fff;
  background: rgba(0,0,0,.5); border-radius: 22px; z-index: 1; }
html.lm-viewer_open, body.lm-viewer_open { overflow: hidden !important; }

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

  var SKIP = 'svg,path,polygon,em,i,.comment,.b-svg-icon,#lm-debug,#lm-debug *';

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
      if (b.r.width > W) el.style.setProperty('width', 'auto', 'important');
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
     из CSS не видно, поэтому правим инлайном по цепочке предков. */
  function fixUserNote() {
    var note_ = document.querySelector('#js-usernote, .b-user_note');
    if (!note_ || note_.dataset.lmNote) return;
    note_.dataset.lmNote = '1';

    var el = note_, steps = 0;
    while (el && steps < 4) {
      if (el === document.body || el.classList.contains('l-i-wrapper')) break;
      el.style.setProperty('display', 'block', 'important');
      el.style.setProperty('position', 'static', 'important');
      el.style.setProperty('float', 'none', 'important');
      el.style.setProperty('width', '100%', 'important');
      el.style.setProperty('max-width', '100%', 'important');
      el.style.setProperty('min-width', '0', 'important');
      el.style.setProperty('box-sizing', 'border-box', 'important');
      el.style.setProperty('margin-left', '0', 'important');
      el = el.parentElement;
      steps++;
    }
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

    /* Счётчики с поиском лежат внутри .l-header, а фильтр с переключателями
       снаружи. Поставить их рядом можно только перенеся узел: CSS не умеет
       объединять элементы из разных родителей в одну флекс-строку. */
    var th = document.querySelector('.b-posts_threshold');
    if (th && !th.dataset.lmMoved && !header.contains(th)) {
      th.dataset.lmMoved = '1';
      header.appendChild(th);
    }
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
     8. ПРОСМОТРЩИК КАРТИНОК
     Лепра при увеличении подменяет узел и сама прокручивает страницу,
     из-за чего экран улетал наверх. Перехватываем клик до её обработчика:
     её логика не запускается, страница не перестраивается.
     ============================================================ */

  function closeViewer() {
    var v = document.getElementById('lm-viewer');
    if (v) v.remove();
    document.documentElement.classList.remove('lm-viewer_open');
    if (document.body) document.body.classList.remove('lm-viewer_open');
  }

  function openViewer(src) {
    closeViewer();

    var box = document.createElement('div');
    box.id = 'lm-viewer';

    var img = document.createElement('img');
    img.src = src;

    var close = document.createElement('div');
    close.className = 'lm-viewer_close';
    close.textContent = '\u00D7';

    box.appendChild(img);
    box.appendChild(close);
    box.addEventListener('click', function (e) {
      e.preventDefault();
      closeViewer();
    });

    document.body.appendChild(box);
    document.documentElement.classList.add('lm-viewer_open');
    document.body.classList.add('lm-viewer_open');
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || t.tagName !== 'IMG' || !t.closest) return;
    if (t.closest('#lm-viewer')) return;
    if (!t.closest('.c_body, .p_body, .dti, .comment, .post')) return;

    /* настоящую ссылку не трогаем: картинка может вести на другую страницу */
    var a = t.closest('a');
    if (a) {
      var h = a.getAttribute('href') || '';
      if (h && h !== '#' && h.slice(-1) !== '#') return;
    }

    var src = t.getAttribute('data-original') || t.currentSrc || t.src;
    if (!src) return;

    e.preventDefault();
    e.stopPropagation();
    if (e.stopImmediatePropagation) e.stopImmediatePropagation();
    openViewer(src);
  }, true);

  window.addEventListener('popstate', closeViewer);

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
      if (el.closest('#lm-debug')) continue;
      if (el.querySelector('a, span, label, input, button, select, div')) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (r.bottom < -2000 || r.top > window.innerHeight + 4000) continue;
      cand.push({ el: el, r: r });
    }

    var found = 0;
    for (var a = 0; a < cand.length && found < 12; a++) {
      for (var b = a + 1; b < cand.length && found < 12; b++) {
        var A = cand[a], B = cand[b];
        if (A.el.contains(B.el) || B.el.contains(A.el)) continue;
        var w = Math.min(A.r.right, B.r.right) - Math.max(A.r.left, B.r.left);
        var h = Math.min(A.r.bottom, B.r.bottom) - Math.max(A.r.top, B.r.top);
        if (w <= 1 || h <= 1) continue;
        var small = Math.min(A.r.width * A.r.height, B.r.width * B.r.height);
        if (w * h < small * 0.3) continue;
        found++;
        L.push(describe(A.el) + '  [' + (A.el.textContent || '').trim().slice(0, 20) + ']');
        L.push('   \u2195 перекрывает \u2195');
        L.push(describe(B.el) + '  [' + (B.el.textContent || '').trim().slice(0, 20) + ']');
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
    guard('relayoutHeader', relayoutHeader)();
    guard('fixUserNote', fixUserNote)();
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
    /* комментарии могли догрузиться — числа в панели фильтров устарели */
    guard('refreshCommentCounters', refreshCommentCounters)();
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
