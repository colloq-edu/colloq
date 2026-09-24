/**
 * A frame page inside which a plotly chart is drawn.
 *
 * The figure is data nobody can vet (the library assembles it in the code of
 * anyone allowed to run), and plotly.js is five megabytes of third-party code
 * that parses that data: pseudo-HTML in labels, links, images by address,
 * MathJax. Drawing it right in the class page would put someone else's
 * parsing next to the room token, the participant list and the Oracle strip.
 *
 * Hence a frame, and hence its OWN header:
 *
 *   sandbox allow-scripts …   the document's origin becomes opaque: no
 *                             cookies, no localStorage, no access to the
 *                             parent's DOM, and all of that holds even if the
 *                             address is opened directly in a separate tab.
 *                             The directive works only from the HEADER: the
 *                             spec ignores it in `<meta>`, and that is exactly
 *                             why the frame is a server route rather than a
 *                             file in `web/public`.
 *   default-src 'none'        everything not mentioned below is forbidden.
 *   script-src <hash> <url>   exactly two scripts: our loader (by the hash of
 *                             its text) and the plotly bundle at its exact
 *                             address. `'self'` is no good here: the origin
 *                             is opaque, and the word has nothing to rest on.
 *   style-src 'unsafe-inline' plotly lays out the chart with inline styles and
 *                             its own `<style>`; without this nothing draws.
 *   img-src data: blob:       the toolbar and the chart snapshot. NOT
 *                             `https:`, otherwise `layout.images` with a
 *                             foreign address would hand the figure's author
 *                             the IP of everyone who opened it.
 *   connect-src 'none'        not a single request leaves the frame.
 *   frame-ancestors 'self'    only the instance itself may embed the frame.
 *
 * The frame has no network at all, so the figure arrives by `postMessage`
 * from the page; see `shared/plotly.ts`, which holds the message shape shared
 * by both sides.
 */
import { createHash } from 'node:crypto'
import {
  ORIGIN_RE,
  PLOTLY_BUNDLE_PATH,
  PLOTLY_MSG,
  PLOTLY_ORIGIN_PARAM,
} from '@shared/plotly'

/**
 * The frame's loader. Inline, and therefore allowed by hash in the policy.
 *
 * The text below goes into the header as a HASH, byte for byte: any edit here
 * changes the `sha256`, and it is recomputed from this very string at module
 * load. They have nowhere to diverge, and that is the only reason the script
 * lives as a string rather than as a file next to the rest of the frontend.
 *
 * The message listener is installed as the FIRST action, before the bundle
 * loads: the figure comes from the page, and the page may send it before the
 * five megabytes of plotly arrive. One that arrives early waits in `pending`.
 *
 * No errors are shown in words here: the page knows the language, the frame
 * does not. The frame sends the reason as a machine string, and the notebook
 * draws the human sentence.
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
    // The page computes the height (shared/plotly.ts · figureHeight) and puts
    // it into layout: it reserves the space for the chart BEFORE the frame
    // loads, and these two numbers must not diverge. Our own value is only for
    // a frame that has no height at all.
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

/** The loader's hash in the form the browser reads it: sha256 of the bytes. */
const BOOT_HASH = `'sha256-${createHash('sha256').update(BOOT, 'utf8').digest('base64')}'`

/**
 * The frame's policy. The origin comes from the page; see
 * `PLOTLY_ORIGIN_PARAM`.
 *
 * `allow-downloads` in the sandbox is there for one button of the plotly
 * toolbar, the "chart snapshot": without it Chrome silently refuses and
 * writes to the console. Nothing but that button starts downloads in the
 * frame: the figure is data, not code, and plotly downloads nothing by
 * itself.
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
 * The frame's markup: an empty block for the chart and the loader above it.
 *
 * The transparent background is not decoration: the notebook draws the white
 * rounded backing AROUND the frame, in advance and at the same size, so there
 * is neither a white flash nor a jump on load. `overflow:hidden` is there for
 * a reason too: while there is nothing to scroll inside, the mouse wheel over
 * the chart scrolls the notebook, not the frame.
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
 * An origin trustworthy enough to put into the header.
 *
 * Not "any string from the client": the value goes into
 * `Content-Security-Policy`, where a newline or a semicolon is not garbage
 * but a SECOND directive. Hence not escaping but a whitelist of the shape.
 */
export function frameOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 300) return null
  return ORIGIN_RE.test(value) ? value : null
}

export { PLOTLY_ORIGIN_PARAM }
