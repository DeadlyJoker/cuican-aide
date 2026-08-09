"""The in-page audit probe used by audit_design.py.

The probe loads the artifact in a fixed-size iframe, walks the rendered DOM,
collects the background layer stack behind every text node, and prints a
JSON payload between sentinel markers so the Python side can parse it out of
``--dump-dom`` output.

Kept as a module-level string (rather than an on-disk .js) so the whole skill
stays a self-contained set of files that ship with the binary.
"""

from __future__ import annotations

_PROBE_JS = r"""
function crewonAudit(doc, win) {
  var issues = [];
  var textNodes = [];

  function selectorFor(el) {
    if (!el || !el.tagName) return '?';
    var parts = [];
    var node = el;
    var depth = 0;
    while (node && node.tagName && depth < 4) {
      var part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(part + '#' + node.id); break; }
      if (node.className && typeof node.className === 'string') {
        var cls = node.className.trim().split(/\s+/).slice(0, 2).join('.');
        if (cls) part += '.' + cls;
      }
      parts.unshift(part);
      node = node.parentElement;
      depth += 1;
    }
    return parts.join(' > ');
  }

  function isVisible(el) {
    var style = win.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity || '1') < 0.05) return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  }

  /*
   * Returns the background layers behind a node, nearest first, walking up until
   * an opaque layer is found. Stopping at the first non-transparent layer would
   * measure a tinted badge such as rgba(76,183,130,.14) as if it were an opaque
   * mid-green, reporting ~1.4:1 where the composited result is ~8.6:1. The
   * caller flattens the stack.
   */
  function backgroundLayers(el) {
    var layers = [];
    var node = el;
    while (node && node.nodeType === 1) {
      var style = win.getComputedStyle(node);
      if (style.backgroundImage && style.backgroundImage !== 'none') {
        layers.push('IMAGE');
        return layers;
      }
      var bg = style.backgroundColor;
      if (bg && bg !== 'transparent' && bg.indexOf('rgba(0, 0, 0, 0)') === -1) {
        layers.push(bg);
        if (!/rgba\(/.test(bg) || /,\s*1\s*\)$/.test(bg)) return layers;
      }
      node = node.parentElement;
    }
    layers.push('rgb(255, 255, 255)');
    return layers;
  }

  function accessibleName(el) {
    var label = el.getAttribute('aria-label') || el.getAttribute('title') || '';
    if (label.trim()) return label.trim();
    var text = (el.textContent || '').trim();
    if (text) return text;
    var labelled = el.getAttribute('aria-labelledby');
    if (labelled) {
      var target = doc.getElementById(labelled);
      if (target && (target.textContent || '').trim()) return target.textContent.trim();
    }
    return '';
  }

  var SLOP_EMOJI = /[\u2190-\u21FF\u2300-\u23FF\u25A0-\u27BF\u2B00-\u2BFF\uD83C-\uD83E]/;
  var SLOP_BOX = /[\u2500-\u257F]/;
  var PLACEHOLDER = /\b(lorem ipsum|todo|tbd|placeholder|xxx|填写此处)\b/i;

  var all = doc.querySelectorAll('*');
  for (var i = 0; i < all.length; i += 1) {
    var el = all[i];
    var tag = el.tagName.toLowerCase();

    if (tag === 'img') {
      if (!el.hasAttribute('alt')) {
        issues.push({ check: 'img-alt', severity: 'error', detail: 'img without alt attribute', selector: selectorFor(el) });
      }
      continue;
    }

    if (tag === 'input' || tag === 'select' || tag === 'textarea') {
      var type = (el.getAttribute('type') || '').toLowerCase();
      if (type !== 'hidden' && type !== 'submit' && type !== 'button') {
        var named = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby');
        var hasLabel = named || (el.id && doc.querySelector('label[for="' + el.id + '"]')) || el.closest('label');
        if (!hasLabel) {
          issues.push({ check: 'input-label', severity: 'error', detail: 'form control without a label', selector: selectorFor(el) });
        }
      }
      continue;
    }

    if ((tag === 'button' || el.getAttribute('role') === 'button') && isVisible(el)) {
      if (!accessibleName(el)) {
        issues.push({ check: 'button-name', severity: 'error', detail: 'interactive control without an accessible name', selector: selectorFor(el) });
      }
    }

    if (tag === 'a' && isVisible(el) && !accessibleName(el)) {
      issues.push({ check: 'link-name', severity: 'error', detail: 'link without an accessible name', selector: selectorFor(el) });
    }
  }

  var headingLevels = [];
  var headings = doc.querySelectorAll('h1,h2,h3,h4,h5,h6');
  for (var h = 0; h < headings.length; h += 1) {
    if (isVisible(headings[h])) headingLevels.push(parseInt(headings[h].tagName.substring(1), 10));
  }
  for (var k = 1; k < headingLevels.length; k += 1) {
    if (headingLevels[k] - headingLevels[k - 1] > 1) {
      issues.push({
        check: 'heading-order',
        severity: 'warning',
        detail: 'heading level jumps from h' + headingLevels[k - 1] + ' to h' + headingLevels[k],
        selector: ''
      });
      break;
    }
  }
  if (headingLevels.length && headingLevels.indexOf(1) === -1) {
    issues.push({ check: 'heading-h1', severity: 'warning', detail: 'no visible h1 on the page', selector: '' });
  }

  if (!doc.documentElement.getAttribute('lang')) {
    issues.push({ check: 'lang', severity: 'warning', detail: '<html> has no lang attribute', selector: '' });
  }
  if (!doc.querySelector('meta[name="viewport"]')) {
    issues.push({ check: 'viewport', severity: 'warning', detail: 'no viewport meta tag', selector: '' });
  }

  var walker = doc.createTreeWalker(doc.body, win.NodeFilter.SHOW_TEXT, null, false);
  var seen = 0;
  var node;
  while ((node = walker.nextNode()) && seen < 400) {
    var text = (node.nodeValue || '').trim();
    if (text.length < 2) continue;
    var parent = node.parentElement;
    if (!parent || !isVisible(parent)) continue;
    var style = win.getComputedStyle(parent);
    textNodes.push({
      selector: selectorFor(parent),
      text: text.length > 60 ? text.substring(0, 60) + '…' : text,
      color: style.color,
      backgroundLayers: backgroundLayers(parent),
      fontSize: parseFloat(style.fontSize) || 16,
      fontWeight: parseInt(style.fontWeight, 10) || 400
    });
    if (SLOP_EMOJI.test(text) && text.length <= 4) {
      issues.push({ check: 'emoji-icon', severity: 'warning', detail: 'emoji used as an icon: ' + text, selector: selectorFor(parent) });
    }
    if (SLOP_BOX.test(text)) {
      issues.push({ check: 'box-drawing', severity: 'warning', detail: 'unicode box drawing used instead of real layout', selector: selectorFor(parent) });
    }
    if (PLACEHOLDER.test(text)) {
      issues.push({ check: 'placeholder-copy', severity: 'warning', detail: 'placeholder copy: ' + text, selector: selectorFor(parent) });
    }
    seen += 1;
  }

  var root = doc.documentElement;
  var overflow = Math.max(0, Math.ceil(root.scrollWidth - root.clientWidth));

  return {
    documentHeight: Math.ceil(Math.max(root.scrollHeight, doc.body ? doc.body.scrollHeight : 0)),
    horizontalOverflow: overflow,
    headingLevels: headingLevels,
    issues: issues,
    textNodes: textNodes
  };
}

function crewonReport() {
  var out;
  try {
    var frame = document.getElementById('frame');
    out = crewonAudit(frame.contentDocument, frame.contentWindow);
  } catch (error) {
    out = { error: String(error && error.message ? error.message : error), issues: [], textNodes: [] };
  }
  var sink = document.getElementById('sink');
  sink.textContent = 'CREWON_AUDIT_BEGIN' + JSON.stringify(out) + 'CREWON_AUDIT_END';
}

window.addEventListener('load', function () { setTimeout(crewonReport, __SETTLE_MS__); });
"""

_HARNESS_HTML = """<!doctype html><meta charset="utf-8"><title>crewon-audit</title>
<style>html,body{margin:0;padding:0}iframe{border:0;display:block}#sink{display:none}</style>
<iframe id="frame" src="__URL__" style="width:__WIDTHpx;height:__HEIGHTpx"></iframe>
<pre id="sink"></pre>
<script>__PROBE__</script>
"""


class _Template:
    """Minimal token-substitution template (avoids escaping JS braces)."""

    def format(self, *, url: str, width: int, height: int, settle_ms: int) -> str:
        probe = _PROBE_JS.replace("__SETTLE_MS__", str(settle_ms))
        return (
            _HARNESS_HTML.replace("__URL__", url)
            .replace("__WIDTHpx", f"{width}px")
            .replace("__HEIGHTpx", f"{height}px")
            .replace("__PROBE__", probe)
        )


PROBE_TEMPLATE = _Template()
