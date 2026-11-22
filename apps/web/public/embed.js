/*!
 * Scheduler embed script (Apache-2.0).
 *
 * Inline:  <div data-scheduler-url="https://cal.example.com/jane/intro" style="height:700px"></div>
 *          <script src="https://cal.example.com/embed.js" async></script>
 *
 * Popup:   <button data-scheduler-popup="https://cal.example.com/jane/intro">Book a call</button>
 *
 * JS API:  Scheduler.inline({ url, parent }) / Scheduler.popup({ url }) / Scheduler.close()
 *
 * Events are re-dispatched on window as CustomEvents:
 *   scheduler:event_scheduled  detail: { booking: { id, start, end, invitee } }
 *   scheduler:event_rescheduled, scheduler:event_canceled, scheduler:page_height
 */
(function () {
  if (window.Scheduler && window.Scheduler.__loaded) return;

  var frames = [];
  var overlay = null;

  function withEmbed(url, prefill) {
    var u = new URL(url, window.location.href);
    u.searchParams.set("embed", "1");
    if (prefill) {
      Object.keys(prefill).forEach(function (k) {
        if (prefill[k] != null) u.searchParams.set(k, String(prefill[k]));
      });
    }
    return u.toString();
  }

  function makeFrame(url, prefill) {
    var iframe = document.createElement("iframe");
    iframe.src = withEmbed(url, prefill);
    iframe.title = "Schedule a meeting";
    iframe.loading = "lazy";
    iframe.style.cssText = "width:100%;height:100%;min-height:600px;border:0;background:transparent;";
    iframe.setAttribute("allow", "clipboard-write");
    frames.push(iframe);
    return iframe;
  }

  function inline(opts) {
    var parent = typeof opts.parent === "string" ? document.querySelector(opts.parent) : opts.parent;
    if (!parent) throw new Error("Scheduler.inline: parent element not found");
    parent.innerHTML = "";
    parent.appendChild(makeFrame(opts.url, opts.prefill));
  }

  function close() {
    if (overlay) {
      overlay.remove();
      overlay = null;
      document.documentElement.style.overflow = "";
    }
  }

  function popup(opts) {
    close();
    overlay = document.createElement("div");
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483646;background:rgba(17,24,39,.55);display:flex;align-items:center;justify-content:center;padding:16px;";
    var box = document.createElement("div");
    box.style.cssText = "position:relative;width:100%;max-width:1000px;height:min(760px,92vh);background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 20px 50px rgba(0,0,0,.3);";
    var btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", "Close");
    btn.textContent = "×";
    btn.style.cssText = "position:absolute;top:8px;right:12px;z-index:1;border:0;background:transparent;font-size:28px;line-height:1;cursor:pointer;color:#374151;";
    btn.onclick = close;
    box.appendChild(btn);
    box.appendChild(makeFrame(opts.url, opts.prefill));
    overlay.appendChild(box);
    overlay.addEventListener("mousedown", function (e) {
      if (e.target === overlay) close();
    });
    document.addEventListener("keydown", function onKey(e) {
      if (e.key === "Escape") {
        close();
        document.removeEventListener("keydown", onKey);
      }
    });
    document.documentElement.style.overflow = "hidden";
    document.body.appendChild(overlay);
  }

  window.addEventListener("message", function (e) {
    var data = e.data;
    if (!data || typeof data.type !== "string" || data.type.indexOf("scheduler:") !== 0) return;
    var from = frames.filter(function (f) {
      return f.contentWindow === e.source;
    })[0];
    if (!from) return;
    if (data.type === "scheduler:page_height" && data.height && from.parentElement && from.parentElement.hasAttribute("data-scheduler-auto-height")) {
      from.style.height = data.height + "px";
    }
    window.dispatchEvent(new CustomEvent(data.type, { detail: data }));
  });

  function init() {
    document.querySelectorAll("[data-scheduler-url]").forEach(function (el) {
      if (el.__schedulerInit) return;
      el.__schedulerInit = true;
      inline({ url: el.getAttribute("data-scheduler-url"), parent: el });
    });
    document.querySelectorAll("[data-scheduler-popup]").forEach(function (el) {
      if (el.__schedulerInit) return;
      el.__schedulerInit = true;
      el.addEventListener("click", function (e) {
        e.preventDefault();
        popup({ url: el.getAttribute("data-scheduler-popup") });
      });
    });
  }

  window.Scheduler = { inline: inline, popup: popup, close: close, init: init, __loaded: true };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
