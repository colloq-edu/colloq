/**
 * Страница-рамка, внутри которой рисуется график plotly.
 *
 * Фигура — недоступные проверке данные (её собирает библиотека в коде любого,
 * кому разрешён запуск), а plotly.js — пять мегабайт чужого кода, который эти
 * данные разбирает: псевдо-HTML в подписях, ссылки, картинки по адресам,
 * MathJax. Рисовать это прямо в странице занятия значило бы поставить чужой
 * разбор рядом с токеном комнаты, списком участников и полосой оракула.
 *
 * Поэтому рамка, и поэтому у неё СВОЙ заголовок:
 *
 *   sandbox allow-scripts …   origin документа становится непрозрачным: ни
 *                             кук, ни localStorage, ни доступа к DOM родителя
 *                             — и всё это действует, даже если адрес открыть
 *                             прямо в отдельной вкладке. Директива работает
 *                             только из ЗАГОЛОВКА: из `<meta>` её
 *                             спецификация игнорирует, и ровно поэтому рамка —
 *                             маршрут сервера, а не файл в `web/public`.
 *   default-src 'none'        всё, о чём ниже не сказано, запрещено.
 *   script-src <hash> <url>   ровно два скрипта: наш загрузчик (по хэшу его
 *                             текста) и бандл plotly по точному адресу.
 *                             `'self'` тут не годится: origin непрозрачный, и
 *                             опираться этому слову не на что.
 *   style-src 'unsafe-inline' plotly раскладывает график инлайновыми стилями и
 *                             своим `<style>`; без этого не рисуется ничего.
 *   img-src data: blob:       панель инструментов и снимок графика. НЕ `https:`
 *                             — иначе `layout.images` с чужим адресом выдал бы
 *                             автору фигуры IP каждого, кто её открыл.
 *   connect-src 'none'        из рамки не уходит ни один запрос.
 *   frame-ancestors 'self'    встроить рамку может только сам инстанс.
 *
 * Сети у рамки нет вовсе, поэтому фигура приезжает `postMessage` от страницы —
 * см. `shared/plotly.ts`, где лежит форма сообщений, общая обеим сторонам.
 */
import { createHash } from 'node:crypto'
import {
  ORIGIN_RE,
  PLOTLY_BUNDLE_PATH,
  PLOTLY_MSG,
  PLOTLY_ORIGIN_PARAM,
} from '@shared/plotly'

/**
 * Загрузчик рамки. Инлайновый и потому — по хэшу в политике.
 *
 * Текст ниже попадает в заголовок ХЭШЕМ, байт в байт: любая правка здесь
 * меняет `sha256`, и он пересчитывается из этой же строки на загрузке модуля.
 * Разойтись им негде, и это единственная причина, по которой скрипт живёт
 * строкой, а не файлом рядом с остальным фронтендом.
 *
 * Слушатель сообщений ставится ПЕРВЫМ действием, до загрузки бандла: фигура
 * приезжает от страницы, и она вправе прислать её раньше, чем доедут пять
 * мегабайт plotly. Пришедшая раньше — ждёт в `pending`.
 *
 * Ошибок здесь не показывается словами: язык знает страница, а не рамка. Сюда
 * едет причина машинной строкой, а человеческую фразу рисует тетрадь.
 */
const BOOT = `(function(){
  "use strict";
  var TAG=${JSON.stringify(PLOTLY_MSG)},SRC=${JSON.stringify(PLOTLY_BUNDLE_PATH)};
  var host=document.getElementById("plot"),pending=null,shown=false,sent=-1;
  function send(msg){msg.colloq=TAG;try{parent.postMessage(msg,"*")}catch(e){}}
  function measure(){
    var h=Math.ceil(host.getBoundingClientRect().height);
    if(h>0&&h!==sent){sent=h;send({kind:"height",height:h})}
  }
  function fail(reason){send({kind:"failed",reason:String(reason).slice(0,300)})}
  function draw(figure){
    if(!window.Plotly){pending=figure;return}
    pending=null;
    var layout=figure.layout||{};
    delete layout.width;
    layout.autosize=true;
    // Высоту считает страница (shared/plotly.ts · figureHeight) и кладёт её в
    // layout: место под график она резервирует ДО того, как рамка загрузится,
    // и разойтись эти два числа не должны. Своё — только на случай кадра без
    // высоты вовсе.
    if(typeof layout.height!=="number"||!isFinite(layout.height))layout.height=450;
    host.style.height=layout.height+"px";
    try{
      window.Plotly.newPlot(host,figure.data,layout,{
        displaylogo:false,responsive:true,scrollZoom:false,showLink:false,
        plotlyServerURL:"",showSendToCloud:false,showEditInChartStudio:false,
        modeBarButtonsToRemove:["sendDataToCloud"]
      }).then(function(){shown=true;measure()},function(err){fail(err&&err.message||err)});
    }catch(err){fail(err&&err.message||err)}
  }
  window.addEventListener("message",function(e){
    if(e.source!==window.parent)return;
    var msg=e.data;
    if(!msg||typeof msg!=="object"||msg.colloq!==TAG)return;
    if(msg.kind==="draw"&&msg.figure&&Array.isArray(msg.figure.data))draw(msg.figure);
  });
  if(window.ResizeObserver){
    new ResizeObserver(function(){
      if(!shown)return;
      try{window.Plotly.Plots.resize(host)}catch(e){}
      measure();
    }).observe(document.documentElement);
  }
  var tag=document.createElement("script");
  tag.src=SRC;
  tag.onload=function(){send({kind:"ready"});if(pending)draw(pending)};
  tag.onerror=function(){fail("bundle")};
  document.head.appendChild(tag);
})();`

/** Хэш загрузчика в том виде, в каком его читает браузер: sha256 от байтов. */
const BOOT_HASH = `'sha256-${createHash('sha256').update(BOOT, 'utf8').digest('base64')}'`

/**
 * Политика рамки. Origin приходит от страницы — см. `PLOTLY_ORIGIN_PARAM`.
 *
 * `allow-downloads` в песочнице — ради одной кнопки панели plotly, «снимок
 * графика»: без неё Chrome отказывает молча и пишет в консоль. Ничего, кроме
 * этой кнопки, скачивания в рамке не запускает: фигура — это данные, а не код,
 * и plotly сам по себе ничего не качает.
 */
export function framePolicy(origin: string): string {
  return [
    'sandbox allow-scripts allow-downloads',
    "default-src 'none'",
    `script-src ${BOOT_HASH} ${origin}${PLOTLY_BUNDLE_PATH}`,
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    "connect-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'self'",
  ].join('; ')
}

/**
 * Разметка рамки: пустой блок под график и загрузчик над ним.
 *
 * Прозрачный фон — не украшение: белую подложку со скруглением рисует тетрадь
 * ВОКРУГ рамки, заранее и в тот же размер, так что при загрузке нет ни белой
 * вспышки, ни рывка. `overflow:hidden` тоже по делу: пока внутри нечего
 * прокручивать, колесо мыши над графиком прокручивает тетрадь, а не рамку.
 */
export const FRAME_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="light">
<title>plotly</title>
<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}
#plot{width:100%}</style>
</head><body><div id="plot"></div>
<script>${BOOT}</script>
</body></html>
`

/**
 * Origin, которому можно верить настолько, чтобы положить его в заголовок.
 *
 * Не «любая строка от клиента»: значение уезжает в `Content-Security-Policy`,
 * где перевод строки или точка с запятой — это не мусор, а ВТОРАЯ директива.
 * Поэтому не экранирование, а белый список формы.
 */
export function frameOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 300) return null
  return ORIGIN_RE.test(value) ? value : null
}

export { PLOTLY_ORIGIN_PARAM }
