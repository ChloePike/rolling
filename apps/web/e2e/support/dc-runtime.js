/*
 * Minimal renderer for the design tool's `.dc.html` screens, used only by the
 * e2e suite to render the approved design as a reference in Chromium.
 *
 * Supports what the screens use: `{{ expr }}` in text and attributes,
 * <sc-for list as>, <sc-if value>, <helmet>, `sc-camel-*` attributes and
 * `onClick` handlers. A component class extends DCLogic and returns its
 * template scope from renderVals().
 *
 * Inputs (set on window before this script runs):
 *   __DC_TEMPLATE__  inner HTML of <x-dc>
 *   __DC_SCRIPT__    source of the component class
 *   __DC_PROPS__     props passed to the component
 *   __DC_NAV_LABELS__ optional { from: to } label overrides for `nav`
 */
(function () {
  class DCLogic {
    constructor(props) {
      this.props = props || {};
      this.state = {};
    }
    setState(patch) {
      Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch);
      render();
    }
  }
  window.DCLogic = DCLogic;

  const Component = new Function('DCLogic', window.__DC_SCRIPT__ + '\nreturn Component;')(DCLogic);
  const instance = new Component(window.__DC_PROPS__ || {});
  const tpl = document.createElement('template');
  tpl.innerHTML = window.__DC_TEMPLATE__;

  const evalExpr = (expr, scope) => {
    try {
      return new Function('scope', 'with (scope) { return (' + expr + '); }')(scope);
    } catch (e) {
      return undefined;
    }
  };
  const SINGLE = /^\s*\{\{([\s\S]+?)\}\}\s*$/;
  const ANY = /\{\{([\s\S]+?)\}\}/g;
  const interpolate = (text, scope) =>
    text.replace(ANY, (_, e) => {
      const v = evalExpr(e, scope);
      return v === undefined || v === null ? '' : String(v);
    });
  const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

  function renderNodes(nodes, scope, out) {
    for (const node of nodes) renderNode(node, scope, out);
  }

  function renderNode(node, scope, out) {
    if (node.nodeType === Node.TEXT_NODE) {
      out.appendChild(document.createTextNode(interpolate(node.textContent, scope)));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName.toLowerCase();
    if (tag === 'helmet') {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        if (child.tagName.toLowerCase() === 'link') continue; // remote fonts are replaced by a local @font-face
        document.head.appendChild(child.cloneNode(true));
      }
      return;
    }
    if (tag === 'sc-for') {
      const list = evalExpr(SINGLE.exec(node.getAttribute('list'))[1], scope) || [];
      const as = node.getAttribute('as');
      list.forEach((item, index) => {
        const child = Object.create(scope);
        child[as] = item;
        child.index = index;
        renderNodes(node.childNodes, child, out);
      });
      return;
    }
    if (tag === 'sc-if') {
      if (evalExpr(SINGLE.exec(node.getAttribute('value'))[1], scope)) renderNodes(node.childNodes, scope, out);
      return;
    }
    if (tag === 'dc-import') return;

    const el = node.namespaceURI === 'http://www.w3.org/2000/svg' || tag === 'svg' || node.closest?.('svg')
      ? document.createElementNS('http://www.w3.org/2000/svg', tag === 'svg' ? 'svg' : node.localName)
      : document.createElement(tag);
    for (const attr of Array.from(node.attributes)) {
      let name = attr.name;
      if (name.startsWith('hint-')) continue;
      if (name.startsWith('sc-camel-')) name = camel(name.slice('sc-camel-'.length));
      const single = SINGLE.exec(attr.value);
      if (/^on[a-z]+$/i.test(attr.name)) {
        const fn = single ? evalExpr(single[1], scope) : null;
        const ev = attr.name.slice(2).toLowerCase();
        if (typeof fn === 'function') el.addEventListener(ev === 'change' ? 'input' : ev, fn);
        continue;
      }
      if (single) {
        const v = evalExpr(single[1], scope);
        if (v === false || v === undefined || v === null) {
          if (name.startsWith('aria-')) el.setAttribute(name, 'false');
          continue;
        }
        if (name === 'value') {
          el.value = String(v);
          continue;
        }
        el.setAttribute(name, v === true ? (name.startsWith('aria-') ? 'true' : '') : String(v));
      } else {
        el.setAttribute(name, interpolate(attr.value, scope));
      }
    }
    renderNodes(node.childNodes, scope, el);
    out.appendChild(el);
  }

  function render() {
    const vals = instance.renderVals();
    const overrides = window.__DC_NAV_LABELS__ || {};
    if (Array.isArray(vals.nav)) {
      vals.nav = vals.nav.map((n) => (overrides[n.label] ? { ...n, label: overrides[n.label] } : n));
    }
    const root = document.getElementById('dc-root');
    const frag = document.createDocumentFragment();
    renderNodes(tpl.content.childNodes, vals, frag);
    root.replaceChildren(frag);
  }

  render();
  window.__DC_READY__ = true;
})();
